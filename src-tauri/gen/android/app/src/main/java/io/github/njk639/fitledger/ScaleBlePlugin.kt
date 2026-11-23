package io.github.njk639.fitledger

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue

@InvokeArg
class ScanArgs {
    /** Advertised names to keep (case-insensitive prefix); empty keeps devices with a QN service. */
    var names: Array<String> = arrayOf()
    var timeoutMs: Long = 6000
}

@InvokeArg
class ConnectArgs {
    var address: String = ""
}

@InvokeArg
class WriteArgs {
    /** Frames as hex strings, written in order. */
    var frames: Array<String> = arrayOf()
}

/**
 * Bluetooth transport for body-composition scales: scan, connect, subscribe and move bytes. It knows
 * nothing about any protocol; fitledger_core::scales::qn decodes notifications and decides what to
 * write. Notifications are buffered and collected with poll(), so the Rust side drives the session.
 *
 * Services: 0xFFF0 (notify FFF1, write FFF2) or 0xFFE0 (notify FFE1, write FFE3), as used by the
 * Qingniu / QN-Scale family (Arboleaf and many others).
 */
@TauriPlugin
@SuppressLint("MissingPermission")
class ScaleBlePlugin(private val activity: Activity) : Plugin(activity) {
    private val main = Handler(Looper.getMainLooper())
    private val adapter get() = (activity.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    private var gatt: BluetoothGatt? = null
    private var writeChar: BluetoothGattCharacteristic? = null
    private val inbox = ConcurrentLinkedQueue<String>()
    private val outbox = ArrayDeque<ByteArray>()
    private var writing = false
    @Volatile private var state = "idle"
    @Volatile private var error: String? = null
    private val t0 = System.currentTimeMillis()

    private fun needed(): Array<String> =
        if (Build.VERSION.SDK_INT >= 31) arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)

    private fun missing() = needed().filter { ContextCompat.checkSelfPermission(activity, it) != PackageManager.PERMISSION_GRANTED }

    /** Rejects (after asking for permission) when Bluetooth can't be used yet. */
    private fun ready(invoke: Invoke): Boolean {
        val miss = missing()
        if (miss.isNotEmpty()) {
            activity.requestPermissions(miss.toTypedArray(), 4712)
            invoke.reject("Allow Nearby devices (Bluetooth) for FitLedger, then try again")
            return false
        }
        if (adapter?.isEnabled != true) {
            invoke.reject("Turn on Bluetooth, then try again")
            return false
        }
        return true
    }

    /** Finds scales: { devices: [{ address, name, rssi, manufacturer: hex, services }], others: [same] }.
     *  A scale is a device with a QN service (FFF0/FFE0/AE00) or company id (0xFFFF/0x01A8) in its
     *  advertisement, or one of `names`; `others` are the rest nearby, for the capture log and for
     *  connecting by hand. */
    @Command
    fun scan(invoke: Invoke) {
        val a = invoke.parseArgs(ScanArgs::class.java)
        if (!ready(invoke)) return
        val scanner = adapter.bluetoothLeScanner ?: return invoke.reject("Bluetooth scanning isn't available")
        val found = linkedMapOf<String, JSObject>()
        val others = linkedMapOf<String, JSObject>()
        var failed: Int? = null
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, r: ScanResult) {
                val name = r.scanRecord?.deviceName ?: r.device.name ?: ""
                val uuids = r.scanRecord?.serviceUuids?.map { it.uuid } ?: emptyList()
                val mfr = r.scanRecord?.manufacturerSpecificData
                val company = if (mfr != null && mfr.size() > 0) mfr.keyAt(0) else -1
                val qn = uuids.any { it == SVC_FFF0 || it == SVC_FFE0 || it == SVC_AE00 } || company == 0xffff || company == 0x01a8
                val wanted = qn || a.names.any { name.startsWith(it, ignoreCase = true) }
                val bytes = if (company >= 0) {
                    byteArrayOf((company and 0xff).toByte(), (company shr 8 and 0xff).toByte()) + mfr!!.valueAt(0)
                } else ByteArray(0)
                val o = JSObject().apply {
                    put("address", r.device.address)
                    put("name", name)
                    put("rssi", r.rssi)
                    put("manufacturer", hex(bytes))
                    put("services", uuids.joinToString(" ") { u -> u.toString().let { if (it.endsWith(BASE_UUID)) it.substring(4, 8) else it } })
                }
                if (wanted) {
                    found[r.device.address] = o
                    others.remove(r.device.address)
                } else if (r.device.address !in found) others[r.device.address] = o
            }

            override fun onScanFailed(errorCode: Int) {
                failed = errorCode
            }
        }
        scanner.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
        main.postDelayed({
            scanner.stopScan(cb)
            if (failed != null && found.isEmpty() && others.isEmpty()) return@postDelayed invoke.reject("Bluetooth scan failed ($failed); turn Bluetooth off and on, then try again")
            invoke.resolve(JSObject().apply {
                put("devices", JSArray().apply { found.values.forEach { put(it) } })
                put("others", JSArray().apply { others.values.sortedByDescending { it.getInteger("rssi") ?: -200 }.forEach { put(it) } })
            })
        }, a.timeoutMs.coerceIn(1000, 20000))
    }

    /** Connects and subscribes; resolves at once, then poll() reports "connecting" -> "ready". */
    @Command
    fun connect(invoke: Invoke) {
        val a = invoke.parseArgs(ConnectArgs::class.java)
        if (!ready(invoke)) return
        close()
        inbox.clear()
        error = null
        state = "connecting"
        val device: BluetoothDevice = adapter.getRemoteDevice(a.address)
        gatt = device.connectGatt(activity, false, callback, BluetoothDevice.TRANSPORT_LE)
        invoke.resolve()
    }

    /** { state: idle|connecting|ready|closed, error?, notifications: ["<ms> <hex>", ...] }. */
    @Command
    fun poll(invoke: Invoke) {
        val list = JSArray()
        while (true) list.put(inbox.poll() ?: break)
        invoke.resolve(JSObject().apply {
            put("state", state)
            put("error", error)
            put("notifications", list)
        })
    }

    @Command
    fun write(invoke: Invoke) {
        val a = invoke.parseArgs(WriteArgs::class.java)
        if (writeChar == null) return invoke.reject("not connected")
        main.post {
            a.frames.forEach { outbox.addLast(unhex(it)) }
            pump()
        }
        invoke.resolve()
    }

    @Command
    fun disconnect(invoke: Invoke) {
        close()
        invoke.resolve()
    }

    private fun close() {
        gatt?.let {
            it.disconnect()
            it.close()
        }
        gatt = null
        writeChar = null
        outbox.clear()
        writing = false
        if (state != "idle") state = "closed"
    }

    /** Writes one queued frame; the next goes when Android reports this one written. */
    private fun pump() {
        val g = gatt ?: return
        val ch = writeChar ?: return
        if (writing) return
        val frame = outbox.removeFirstOrNull() ?: return
        writing = true
        val type = if (ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE != 0) {
            BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        } else BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
        val ok = if (Build.VERSION.SDK_INT >= 33) {
            g.writeCharacteristic(ch, frame, type) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            ch.writeType = type
            @Suppress("DEPRECATION")
            ch.value = frame
            @Suppress("DEPRECATION")
            g.writeCharacteristic(ch)
        }
        inbox.add("${System.currentTimeMillis() - t0} > ${hex(frame)}")
        if (!ok) {
            writing = false
            main.postDelayed({ outbox.addFirst(frame); pump() }, 50)
        }
    }

    private val callback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            main.post {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                    g.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    if (status != BluetoothGatt.GATT_SUCCESS && state == "connecting") error = "couldn't connect ($status)"
                    state = "closed"
                    writeChar = null
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            main.post {
                val (svc, notify, write) = listOf(Triple(SVC_FFF0, CHR_FFF1, CHR_FFF2), Triple(SVC_FFE0, CHR_FFE1, CHR_FFE3))
                    .firstOrNull { g.getService(it.first) != null } ?: run {
                        error = "this doesn't look like a QN-Scale (no FFF0/FFE0 service; it has ${g.services.joinToString(" ") { it.uuid.toString().substring(4, 8) }})"
                        state = "closed"
                        return@post
                    }
                val service = g.getService(svc)
                val n = service.getCharacteristic(notify)
                writeChar = service.getCharacteristic(write)
                if (n == null || writeChar == null) {
                    error = "scale service is missing its characteristics"
                    state = "closed"
                    return@post
                }
                g.setCharacteristicNotification(n, true)
                val cccd = n.getDescriptor(CCCD)
                val value = if (n.properties and BluetoothGattCharacteristic.PROPERTY_INDICATE != 0) {
                    BluetoothGattDescriptor.ENABLE_INDICATION_VALUE
                } else BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                if (cccd != null) {
                    if (Build.VERSION.SDK_INT >= 33) {
                        g.writeDescriptor(cccd, value)
                    } else {
                        @Suppress("DEPRECATION")
                        cccd.value = value
                        @Suppress("DEPRECATION")
                        g.writeDescriptor(cccd)
                    }
                } else {
                    state = "ready"
                }
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            main.post { state = if (status == BluetoothGatt.GATT_SUCCESS) "ready" else "closed".also { error = "couldn't subscribe ($status)" } }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, c: BluetoothGattCharacteristic, status: Int) {
            main.post {
                writing = false
                pump()
            }
        }

        // Android 13+.
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic, value: ByteArray) {
            inbox.add("${System.currentTimeMillis() - t0} < ${hex(value)}")
        }

        @Deprecated("Android 12 and older")
        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(g: BluetoothGatt, c: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT < 33) inbox.add("${System.currentTimeMillis() - t0} < ${hex(c.value)}")
        }
    }

    companion object {
        private fun uuid16(v: Int) = UUID.fromString(String.format("0000%04x-0000-1000-8000-00805f9b34fb", v))
        val SVC_FFF0: UUID = uuid16(0xfff0)
        val CHR_FFF1: UUID = uuid16(0xfff1)
        val CHR_FFF2: UUID = uuid16(0xfff2)
        val SVC_FFE0: UUID = uuid16(0xffe0)
        val CHR_FFE1: UUID = uuid16(0xffe1)
        val CHR_FFE3: UUID = uuid16(0xffe3)
        val SVC_AE00: UUID = uuid16(0xae00)
        val CCCD: UUID = uuid16(0x2902)
        const val BASE_UUID = "-0000-1000-8000-00805f9b34fb"

        fun hex(b: ByteArray) = b.joinToString(" ") { String.format("%02x", it) }
        fun unhex(s: String): ByteArray {
            val t = s.filter { !it.isWhitespace() }
            return ByteArray(t.length / 2) { t.substring(2 * it, 2 * it + 2).toInt(16).toByte() }
        }
    }
}
