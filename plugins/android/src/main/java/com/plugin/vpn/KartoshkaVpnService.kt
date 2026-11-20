package com.plugin.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import libXray.LibXray
import org.json.JSONObject
import java.io.File

/**
 * Phase 0 spike service. It deliberately contains only the minimum needed to
 * prove that Android's VpnService TUN fd can be handed to the official Xray
 * core and that the service survives the Activity going away.
 *
 * The official Xray Android library (XTLS/libXray, built from Xray-core
 * 26.10.31) runs in this process. The fd is passed in the root `env` object as
 * `xray.tun.fd`, so there is no fork/exec and Android's process launcher cannot
 * close the descriptor. The previous binary + ProcessBuilder variant failed
 * with `bad file descriptor` because AOSP's childProcess() closes every fd
 * except stdio before exec.
 *
 * This is not the production tunnel: the real service will receive an encrypted
 * configuration and will add split tunneling, network callbacks, health checks,
 * and an authenticated local control channel in later phases.
 */
class KartoshkaVpnService : VpnService() {
    companion object {
        private const val TAG = "KPV_PHASE0"
        const val ACTION_START = "com.plugin.vpn.action.START"
        const val ACTION_STOP = "com.plugin.vpn.action.STOP"
        const val EXTRA_CONFIG = "config"
        const val CHANNEL_ID = "kartoshka_vpn"
        const val NOTIFICATION_ID = 7301

        @Volatile
        var running: Boolean = false
            private set

        @Volatile
        var lastError: String? = null
            private set
    }

    private var tun: ParcelFileDescriptor? = null
    private var coreStarted: Boolean = false

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "service onCreate")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "service onStartCommand action=${intent?.action ?: "null"}")
        when (intent?.action) {
            ACTION_START -> {
                startForegroundNotification()
                val config = intent.getStringExtra(EXTRA_CONFIG) ?: DEFAULT_CONFIG
                // Starting Xray can take longer than the main-thread budget on
                // a slow emulator. Keep onStartCommand quick and let the
                // foreground notification cover the startup window.
                Thread({ startTunnel(config) }, "kpv-start").start()
            }
            ACTION_STOP -> stopTunnel()
            else -> {
                // A sticky restart has no extras. Keep the service alive but do
                // not guess a configuration; the UI must reconnect explicitly.
                Log.i(TAG, "service restarted without a start action")
            }
        }
        return START_STICKY
    }

    private fun startForegroundNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "KartoshkaVPN",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "VPN connection status"
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
        }
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle("KartoshkaVPN")
            .setContentText("VPN-туннель запущен")
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                } else {
                    0
                }
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @Synchronized
    private fun startTunnel(configJson: String) {
        if (tun != null || coreStarted) return
        lastError = null
        try {
            val builder = Builder()
                .setSession("KartoshkaVPN Phase 0")
                .setMtu(1500)
                .addAddress("10.8.0.2", 32)
                .addRoute("0.0.0.0", 0)
                .addAddress("fd00::2", 128)
                .addRoute("::", 0)
                .addDnsServer("1.1.1.1")
                .setBlocking(true)
            // Xray's own outbound sockets must not be routed back into the TUN.
            builder.addDisallowedApplication(packageName)
            val pfd = builder.establish() ?: error("VpnService.establish() returned null")
            tun = pfd

            Log.i(TAG, "xray version: ${xrayVersion()}")
            val xrayConfig = JSONObject(configJson)
            xrayConfig.put("env", JSONObject().put("xray.tun.fd", pfd.fd.toString()))
            // Phase 0 diagnostic only: keep Xray's access log inside the app
            // sandbox so CI can prove that the TUN inbound accepted a
            // connection. Production configurations must not log destinations.
            xrayConfig.optJSONObject("log")?.put(
                "access",
                File(filesDir, "access.log").absolutePath
            )
            val request = JSONObject()
                .put("apiVersion", 3)
                .put("method", "runXray")
                .put("payload", JSONObject().put("xrayJson", xrayConfig.toString()))
            val response = JSONObject(LibXray.invoke(request.toString()))
            if (!response.optBoolean("success")) {
                error("runXray failed: ${response.optString("error", "unknown error")}")
            }
            coreStarted = true
            running = true
            Log.i(TAG, "tunnel started fd=${pfd.fd}")
            Log.i(TAG, "xray state: ${xrayRunning()}")
        } catch (error: Throwable) {
            lastError = error.message ?: error.javaClass.simpleName
            Log.e(TAG, "tunnel start failed: $lastError", error)
            stopTunnel()
        }
    }

    private fun xrayVersion(): String {
        return try {
            val request = JSONObject()
                .put("apiVersion", 3)
                .put("method", "xrayVersion")
            val response = JSONObject(LibXray.invoke(request.toString()))
            if (response.optBoolean("success")) {
                response.optJSONObject("data")?.optString("version") ?: "unknown"
            } else {
                "unknown"
            }
        } catch (error: Throwable) {
            Log.w(TAG, "xray version check failed: ${error.javaClass.simpleName}")
            "unknown"
        }
    }

    private fun xrayRunning(): Boolean {
        return try {
            val request = JSONObject()
                .put("apiVersion", 3)
                .put("method", "getXrayState")
            val response = JSONObject(LibXray.invoke(request.toString()))
            response.optBoolean("success") &&
                (response.optJSONObject("data")?.optBoolean("running") == true)
        } catch (error: Throwable) {
            Log.w(TAG, "xray state check failed: ${error.javaClass.simpleName}")
            false
        }
    }

    @Synchronized
    private fun stopTunnel() {
        running = false
        if (coreStarted) {
            try {
                val request = JSONObject()
                    .put("apiVersion", 3)
                    .put("method", "stopXray")
                val response = JSONObject(LibXray.invoke(request.toString()))
                if (!response.optBoolean("success")) {
                    Log.w(TAG, "stopXray failed: ${response.optString("error", "unknown error")}")
                }
            } catch (error: Throwable) {
                Log.w(TAG, "stopXray failed: ${error.javaClass.simpleName}")
            }
            coreStarted = false
        }
        try {
            tun?.close()
        } catch (_: Exception) {
        }
        tun = null
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (_: Exception) {
        }
        stopSelf()
        Log.i(TAG, "tunnel stopped")
    }

    override fun onRevoke() {
        Log.i(TAG, "VPN permission revoked")
        stopTunnel()
        super.onRevoke()
    }

    override fun onDestroy() {
        Log.i(TAG, "service onDestroy")
        stopTunnel()
        super.onDestroy()
    }

    // Phase 0 test config only. `access` is enabled so CI can see that Xray
    // accepted the redirected test connection. Production configs must set
    // access to "none" and must not log destinations or credentials.
    private val DEFAULT_CONFIG = """
        {
          "log": { "logLevel": "info", "access": "" },
          "inbounds": [
            {
              "tag": "tun-in",
              "protocol": "tun",
              // AndroidTun ignores this value and reads the real name from
              // the fd. It must be non-empty: an empty name makes the generic
              // config builder call net.Interfaces(), which Android denies
              // with "netlinkrib: permission denied".
              "settings": { "name": "kpv0", "mtu": 1500 }
            }
          ],
          "outbounds": [
            {
              "tag": "test-out",
              "protocol": "freedom",
              "settings": { "redirect": "10.0.2.2:8081" }
            }
          ]
        }
    """.trimIndent()
}
