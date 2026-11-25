package io.github.njk639.fitledger

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

/**
 * Home-screen widget: weight and goal pace, this week's workouts, the streak, and one-tap Start and
 * Weigh in. It never opens the database: the app sends a snapshot (widget.ts) whenever it's open,
 * with a Start button for each of the next 7 days, so the widget picks today's itself and rolls over
 * at midnight on its own.
 */
class HomeWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) = redraw(ctx)

    override fun onReceive(ctx: Context, intent: Intent) {
        super.onReceive(ctx, intent)
        when (intent.action) {
            ACTION_MIDNIGHT, Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_DATE_CHANGED -> redraw(ctx)
        }
    }

    companion object {
        private const val ACTION_MIDNIGHT = "io.github.njk639.fitledger.WIDGET_MIDNIGHT"
        private const val EXTRA_ACTION = "widget_action"
        private const val EXTRA_TEMPLATE = "widget_template"

        private fun prefs(ctx: Context) = ctx.getSharedPreferences("home_widget", Context.MODE_PRIVATE)

        fun save(ctx: Context, json: String) {
            prefs(ctx).edit().putString("snapshot", json).apply()
            redraw(ctx)
        }

        /** Remembers a widget tap that opened (or came back to) the app, for the web UI to take. */
        fun takeIntent(ctx: Context, intent: Intent?) {
            val action = intent?.getStringExtra(EXTRA_ACTION) ?: return
            prefs(ctx).edit().putString("action", action).putInt("template", intent.getIntExtra(EXTRA_TEMPLATE, -1)).apply()
            intent.removeExtra(EXTRA_ACTION)
        }

        /** The last tap as (action, template id), cleared; null when there's none. */
        fun takeAction(ctx: Context): Pair<String, Int>? {
            val p = prefs(ctx)
            val action = p.getString("action", null) ?: return null
            val template = p.getInt("template", -1)
            p.edit().remove("action").remove("template").apply()
            return action to template
        }

        private fun open(ctx: Context, request: Int, action: String?, template: Int = -1): PendingIntent {
            val i = Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (action != null) i.putExtra(EXTRA_ACTION, action).putExtra(EXTRA_TEMPLATE, template)
            return PendingIntent.getActivity(ctx, request, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }

        fun redraw(ctx: Context) {
            val manager = AppWidgetManager.getInstance(ctx)
            val ids = manager.getAppWidgetIds(ComponentName(ctx, HomeWidget::class.java))
            if (ids.isEmpty()) return
            val v = RemoteViews(ctx.packageName, R.layout.widget_home)
            val today = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Calendar.getInstance().time)
            val snap = prefs(ctx).getString("snapshot", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
            var template = -1
            if (snap == null) {
                v.setTextViewText(R.id.widget_weight, "—")
                v.setViewVisibility(R.id.widget_rate, View.GONE)
                v.setTextViewText(R.id.widget_streak, "")
                v.setTextViewText(R.id.widget_week, "Open the app once to fill this in")
                v.setTextViewText(R.id.widget_start, "▶ Start a workout")
            } else {
                v.setTextViewText(R.id.widget_weight, snap.optString("weight"))
                val rate = snap.optString("rate")
                v.setViewVisibility(R.id.widget_rate, if (rate.isEmpty()) View.GONE else View.VISIBLE)
                v.setTextViewText(R.id.widget_rate, rate)
                val color = when {
                    snap.isNull("rateOk") -> R.color.widget_muted
                    snap.optBoolean("rateOk") -> R.color.widget_ok
                    else -> R.color.widget_warn
                }
                v.setTextColor(R.id.widget_rate, ContextCompat.getColor(ctx, color))
                v.setTextViewText(R.id.widget_streak, snap.optString("streak"))
                val week = if (today >= snap.optString("weekEnd", "9999")) snap.optString("nextWeek") else snap.optString("week")
                v.setTextViewText(R.id.widget_week, week)
                val days = snap.optJSONArray("days")
                val day = (0 until (days?.length() ?: 0)).map { days!!.getJSONObject(it) }.firstOrNull { it.optString("date") == today }
                v.setTextViewText(R.id.widget_start, day?.optString("text") ?: "▶ Start a workout")
                template = day?.optInt("templateId", -1) ?: -1
            }
            v.setOnClickPendingIntent(R.id.widget_info, open(ctx, 20, null))
            v.setOnClickPendingIntent(R.id.widget_start, open(ctx, 21, "start", template))
            v.setOnClickPendingIntent(R.id.widget_weigh, open(ctx, 22, "weigh_in"))
            manager.updateAppWidget(ids, v)
            armMidnight(ctx)
        }

        /** Redraws just after midnight so the Start button shows the new day's workout. */
        private fun armMidnight(ctx: Context) {
            val at = Calendar.getInstance().apply {
                add(Calendar.DAY_OF_YEAR, 1)
                set(Calendar.HOUR_OF_DAY, 0)
                set(Calendar.MINUTE, 1)
                set(Calendar.SECOND, 0)
            }
            val i = Intent(ctx, HomeWidget::class.java).setAction(ACTION_MIDNIGHT)
            val pi = PendingIntent.getBroadcast(ctx, 23, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            ctx.getSystemService(AlarmManager::class.java).set(AlarmManager.RTC, at.timeInMillis, pi)
        }
    }
}
