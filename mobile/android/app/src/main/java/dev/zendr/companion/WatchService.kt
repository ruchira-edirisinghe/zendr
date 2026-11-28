package dev.zendr.companion

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * "Alert me": while on, checks every paired computer every 20 seconds and posts a notification
 * when an agent starts needing you or finishes. Android keeps it alive with a quiet notification
 * of its own (a foreground service); turning alerts off stops it.
 */
class WatchService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // computer id + terminal -> last status seen
    private val seen = HashMap<String, String?>()
    private var first = true

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        channels(this)
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val ongoing = NotificationCompat.Builder(this, CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("Watching your agents")
            .setContentText("You'll get an alert when one needs you.")
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID_WATCH, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(ID_WATCH, ongoing)
        }
        if (!running) {
            running = true
            scope.launch { loop() }
        }
        return START_STICKY
    }

    private var running = false

    private suspend fun loop() {
        val store = Store(this)
        while (scope.isActive) {
            if (!store.alerts) {
                stopSelf()
                return
            }
            for (c in store.computers()) {
                val spaces = runCatching { Api.state(store, c) }.getOrNull() ?: continue
                for (s in spaces.flatMap { it.sessions }) {
                    val key = "${c.id}/${s.terminal}"
                    val before = seen[key]
                    seen[key] = s.status
                    if (first || before == s.status) continue
                    when (s.status) {
                        "blocked" -> alert(c, s, "${s.title} needs you", "On ${c.name}. Tap to answer.")
                        "done" -> if (before == "working") alert(c, s, "${s.title} finished", "On ${c.name}.")
                    }
                }
            }
            first = false
            delay(20_000)
        }
    }

    private fun alert(c: Computer, s: Session, title: String, text: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val open = Intent(this, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_COMPUTER, c.id)
            .putExtra(MainActivity.EXTRA_TERMINAL, s.terminal)
            .putExtra(MainActivity.EXTRA_TITLE, s.title)
            .putExtra(MainActivity.EXTRA_APP, s.app)
            .putExtra(MainActivity.EXTRA_STATUS, s.status)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val id = (c.id + s.terminal).hashCode()
        val pending = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n: Notification = NotificationCompat.Builder(this, CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        NotificationManagerCompat.from(this).notify(id, n)
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL_WATCH = "watch"
        private const val CHANNEL_ALERTS = "alerts"
        private const val ID_WATCH = 1

        fun channels(context: Context) {
            if (Build.VERSION.SDK_INT < 26) return
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL_WATCH, "Watching", NotificationManager.IMPORTANCE_MIN))
            nm.createNotificationChannel(NotificationChannel(CHANNEL_ALERTS, "Agents that need you", NotificationManager.IMPORTANCE_HIGH))
        }

        fun start(context: Context) = ContextCompat.startForegroundService(context, Intent(context, WatchService::class.java))
        fun stop(context: Context) = context.stopService(Intent(context, WatchService::class.java))
    }
}
