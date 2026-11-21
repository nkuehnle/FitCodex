package io.github.njk639.fitledger

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Daily reminders that repeat over a cycle of days: weigh-ins (a week, from a Sunday) and workout
 * days (the active schedule's cycle). Day i of the cycle has its own time (or none), title and
 * text. The plan lives in SharedPreferences so the receiver can re-arm the next alarm (and after
 * a reboot) without the app running. A day already marked done (weighed in, workout started) is
 * skipped.
 */
object DayReminder {
    const val ACTION = "io.github.njk639.fitledger.DAY_REMINDER"
    private const val SEP = "\u001f"

    private class Kind(val name: String, val id: Int, val request: Int, val channel: String, val channelName: String, val about: String)

    private val KINDS = listOf(
        // Request code and channel of the old weigh-in reminder, so its pending alarm is replaced.
        Kind("weigh_in", 1003, 1, "weigh_in", "Weigh-in reminder", "Reminder on your weigh-in days"),
        Kind("workout", 1004, 3, "workout_day", "Workout reminder", "Reminder on your scheduled workout days"),
    )

    private fun kind(name: String) = KINDS.first { it.name == name }
    private fun prefs(ctx: Context, k: Kind) = ctx.getSharedPreferences("day_reminder_${k.name}", Context.MODE_PRIVATE)
    private fun iso(c: Calendar) = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(c.time)
    private fun midnight(c: Calendar) = c.apply {
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }

    fun configure(ctx: Context, name: String, from: String, minutes: IntArray, titles: Array<String>, texts: Array<String>) {
        val k = kind(name)
        prefs(ctx, k).edit()
            .putString("from", from)
            .putString("minutes", minutes.joinToString(","))
            .putString("titles", titles.joinToString(SEP))
            .putString("texts", texts.joinToString(SEP))
            .apply()
        schedule(ctx, k)
    }

    fun done(ctx: Context, name: String, date: String) {
        val k = kind(name)
        prefs(ctx, k).edit().putString("last", date).apply()
        if (date == iso(Calendar.getInstance())) NotificationManagerCompat.from(ctx).cancel(k.id)
    }

    fun scheduleAll(ctx: Context) = KINDS.forEach { schedule(ctx, it) }

    private fun pending(ctx: Context, k: Kind): PendingIntent {
        val i = Intent(ctx, DayReminderReceiver::class.java).setAction(ACTION).putExtra("kind", k.name)
        return PendingIntent.getBroadcast(ctx, k.request, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun minutes(ctx: Context, k: Kind) =
        prefs(ctx, k).getString("minutes", "")!!.split(",").map { it.trim().toIntOrNull() ?: -1 }

    /** Cycle day of the calendar day [c] (null before the plan starts or without a plan). */
    private fun cycleDay(ctx: Context, k: Kind, c: Calendar): Int? {
        val len = minutes(ctx, k).size
        val from = prefs(ctx, k).getString("from", "") ?: ""
        if (len == 0 || from.isEmpty()) return null
        val start = midnight(Calendar.getInstance().apply { time = SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(from)!! })
        // Rounded: a daylight saving change makes a day 23 or 25 hours long.
        val days = Math.round((midnight(c.clone() as Calendar).timeInMillis - start.timeInMillis) / TimeUnit.DAYS.toMillis(1).toDouble())
        return if (days < 0) null else (days % len).toInt()
    }

    /** Arms the alarm for the next reminder strictly in the future. */
    private fun schedule(ctx: Context, k: Kind) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        am.cancel(pending(ctx, k))
        val mins = minutes(ctx, k)
        if (mins.none { it >= 0 }) return
        val now = System.currentTimeMillis()
        val c = midnight(Calendar.getInstance())
        for (i in 0..mins.size + 400) {
            val m = cycleDay(ctx, k, c)?.let { mins[it] } ?: -1
            if (m >= 0) {
                val at = (c.clone() as Calendar).apply { add(Calendar.MINUTE, m) }.timeInMillis
                if (at > now) {
                    if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(ctx, k))
                    } else {
                        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending(ctx, k))
                    }
                    return
                }
            }
            c.add(Calendar.DAY_OF_MONTH, 1)
        }
    }

    fun remind(ctx: Context, name: String) {
        val k = kind(name)
        val p = prefs(ctx, k)
        val today = Calendar.getInstance()
        if (p.getString("last", "") == iso(today)) return
        val day = cycleDay(ctx, k, today) ?: return
        val title = p.getString("titles", "")!!.split(SEP).getOrNull(day).orEmpty()
        val text = p.getString("texts", "")!!.split(SEP).getOrNull(day).orEmpty()
        if (title.isEmpty()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(k.channel, k.channelName, NotificationManager.IMPORTANCE_DEFAULT).apply { description = k.about },
            )
        }
        val open = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)!!
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val n = NotificationCompat.Builder(ctx, k.channel)
            .setSmallIcon(ctx.applicationInfo.icon)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(ctx, 2, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .build()
        try {
            NotificationManagerCompat.from(ctx).notify(k.id, n)
        } catch (e: SecurityException) {
            // Notifications not allowed.
        }
    }

    fun onAlarm(ctx: Context, name: String) {
        remind(ctx, name)
        schedule(ctx, kind(name))
    }
}

class DayReminderReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            DayReminder.ACTION -> DayReminder.onAlarm(ctx, intent.getStringExtra("kind") ?: return)
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIMEZONE_CHANGED ->
                DayReminder.scheduleAll(ctx)
        }
    }
}
