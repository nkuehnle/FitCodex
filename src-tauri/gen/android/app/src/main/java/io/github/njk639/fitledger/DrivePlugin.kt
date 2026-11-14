package io.github.njk639.fitledger

import android.app.Activity
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject

@InvokeArg
class DriveUploadArgs {
    var path: String = ""
    var name: String = ""
    var prefix: String = ""
    var keep: Int = 4
}

private class Unauthorized : Exception("Google Drive rejected the sign-in")

/**
 * Optional backups to the user's Google Drive, in a visible "FitLedger" folder. Uses the
 * drive.file scope, so the app only ever sees files it created. Nothing here runs unless the user
 * turns Drive backup on.
 */
@TauriPlugin
class DrivePlugin(private val activity: Activity) : Plugin(activity) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val request = AuthorizationRequest.builder()
        .setRequestedScopes(listOf(Scope("https://www.googleapis.com/auth/drive.file")))
        .build()
    private var pending: Invoke? = null
    private var launcher: ActivityResultLauncher<IntentSenderRequest>? = null

    private fun client() = Identity.getAuthorizationClient(activity)

    /** Asks for Drive access, showing Google's consent screen the first time. */
    @Command
    fun connect(invoke: Invoke) {
        client().authorize(request)
            .addOnSuccessListener { r ->
                val intent = r.pendingIntent
                if (!r.hasResolution() || intent == null) {
                    invoke.resolve()
                    return@addOnSuccessListener
                }
                pending = invoke
                val l = launcher ?: (activity as ComponentActivity).activityResultRegistry.register(
                    "drive-authorize",
                    ActivityResultContracts.StartIntentSenderForResult(),
                ) { result ->
                    val waiting = pending
                    pending = null
                    try {
                        client().getAuthorizationResultFromIntent(result.data)
                        waiting?.resolve()
                    } catch (e: Exception) {
                        waiting?.reject("Google Drive access wasn't granted")
                    }
                }.also { launcher = it }
                l.launch(IntentSenderRequest.Builder(intent.intentSender).build())
            }
            .addOnFailureListener { e -> invoke.reject(e.message ?: e.toString()) }
    }

    /** Uploads the file at `path` as `name`, then keeps only the newest `keep` with `prefix`. */
    @Command
    fun upload(invoke: Invoke) {
        val a = invoke.parseArgs(DriveUploadArgs::class.java)
        scope.launch {
            try {
                val token = token()
                try {
                    uploadAndPrune(token, a)
                } catch (e: Unauthorized) {
                    // A cached token that Google no longer accepts: drop it and try once more.
                    Tasks.await(client().clearToken(ClearTokenRequest.builder().setToken(token).build()))
                    uploadAndPrune(token(), a)
                }
                invoke.resolve()
            } catch (e: Exception) {
                invoke.reject(e.message ?: e.toString())
            }
        }
    }

    private fun token(): String {
        val r = Tasks.await(client().authorize(request))
        val t = r.accessToken
        if (r.hasResolution() || t == null) {
            throw Exception("Google Drive needs you to sign in again: turn Drive backup off and on")
        }
        return t
    }

    private fun uploadAndPrune(token: String, a: DriveUploadArgs) {
        val folder = folder(token)
        // Resumable upload: metadata first, then the bytes to the session it returns.
        val meta = JSONObject().put("name", a.name).put("parents", org.json.JSONArray().put(folder)).toString().toByteArray()
        val start = open("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", token)
        start.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
        start.setRequestProperty("X-Upload-Content-Type", "application/octet-stream")
        start.setFixedLengthStreamingMode(meta.size)
        start.outputStream.use { it.write(meta) }
        read(start)
        val session = start.getHeaderField("Location") ?: throw Exception("Google Drive didn't start the upload")

        val file = File(a.path)
        val put = open("PUT", session, token)
        put.setRequestProperty("Content-Type", "application/octet-stream")
        put.setFixedLengthStreamingMode(file.length())
        put.outputStream.use { out -> file.inputStream().use { it.copyTo(out) } }
        val id = JSONObject(read(put)).getString("id")

        // Same-day copies replace each other; then only the newest `keep` names stay.
        val q = "'$folder' in parents and trashed = false and name contains '${a.prefix}'"
        val list = read(open("GET", "https://www.googleapis.com/drive/v3/files?pageSize=200&fields=files(id,name)&q=" + enc(q), token))
        val files = JSONObject(list).getJSONArray("files")
        val others = (0 until files.length()).map { files.getJSONObject(it) }
            .map { it.getString("id") to it.getString("name") }
            .filter { it.first != id && it.second.startsWith(a.prefix) }
        val (same, older) = others.partition { it.second == a.name }
        (same + older.sortedByDescending { it.second }.drop(maxOf(a.keep - 1, 0))).forEach { (old, _) ->
            read(open("DELETE", "https://www.googleapis.com/drive/v3/files/$old", token))
        }
    }

    /** The app's "FitLedger" folder (wherever the user has moved it), created on first use. */
    private fun folder(token: String): String {
        val type = "application/vnd.google-apps.folder"
        val q = "name = 'FitLedger' and mimeType = '$type' and trashed = false"
        val found = JSONObject(read(open("GET", "https://www.googleapis.com/drive/v3/files?fields=files(id)&q=" + enc(q), token))).getJSONArray("files")
        if (found.length() > 0) return found.getJSONObject(0).getString("id")
        val body = JSONObject().put("name", "FitLedger").put("mimeType", type).toString().toByteArray()
        val c = open("POST", "https://www.googleapis.com/drive/v3/files?fields=id", token)
        c.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
        c.setFixedLengthStreamingMode(body.size)
        c.outputStream.use { it.write(body) }
        return JSONObject(read(c)).getString("id")
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun open(method: String, url: String, token: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 20_000
        c.readTimeout = 120_000
        c.setRequestProperty("Authorization", "Bearer $token")
        if (method != "GET" && method != "DELETE") c.doOutput = true
        return c
    }

    /** The response body; a failure becomes an exception carrying Google's message. */
    private fun read(c: HttpURLConnection): String {
        val code = c.responseCode
        val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code == 401) throw Unauthorized()
        if (code >= 400) {
            val message = try {
                JSONObject(text).getJSONObject("error").getString("message")
            } catch (e: Exception) {
                text.take(200)
            }
            throw Exception("Google Drive error $code: $message")
        }
        return text
    }
}
