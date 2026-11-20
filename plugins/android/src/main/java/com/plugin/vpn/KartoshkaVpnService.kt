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
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File

/**
 * Phase 0 spike service. It deliberately contains only the minimum needed to
 * prove that Android's VpnService TUN fd can be handed to the official Xray
 * Android binary and that the service survives the Activity going away.
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
    private var process: Process? = null
    private var outputThread: Thread? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                startForegroundNotification()
                startTunnel(intent.getStringExtra(EXTRA_CONFIG) ?: DEFAULT_CONFIG)
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

    private fun startTunnel(configJson: String) {
        if (tun != null) return
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

            // Java's process launcher may set FD_CLOEXEC. Xray receives the
            // descriptor number through XRAY_TUN_FD, so clear that flag before
            // fork/exec. The ParcelFileDescriptor remains owned by this service.
            Os.fcntlInt(pfd.fileDescriptor, OsConstants.F_SETFD, 0)

            val config = File(filesDir, "phase0-xray.json")
            config.writeText(configJson)
            val binary = File(applicationInfo.nativeLibraryDir, "libxray.so")
            if (!binary.exists()) error("libxray.so is missing from nativeLibraryDir")
            logXrayVersion(binary)

            val command = ProcessBuilder(binary.absolutePath, "run", "-c", config.absolutePath)
            command.environment()["XRAY_TUN_FD"] = pfd.fd.toString()
            command.redirectErrorStream(true)
            val child = command.start()
            process = child
            outputThread = Thread {
                try {
                    child.inputStream.bufferedReader().forEachLine { line ->
                        // The Phase 0 config contains no credentials. Keep only
                        // diagnostic lines and never dump the configuration.
                        if (line.isNotBlank()) Log.i(TAG, "xray: $line")
                    }
                } catch (error: Exception) {
                    Log.w(TAG, "xray output reader stopped: ${error.javaClass.simpleName}")
                }
            }.also { it.start() }

            running = true
            Log.i(TAG, "tunnel started fd=${pfd.fd}")
        } catch (error: Exception) {
            lastError = error.message ?: error.javaClass.simpleName
            Log.e(TAG, "tunnel start failed: $lastError")
            stopTunnel()
        }
    }

    private fun logXrayVersion(binary: File) {
        try {
            val versionProcess = ProcessBuilder(binary.absolutePath, "version")
                .redirectErrorStream(true)
                .start()
            val firstLine = versionProcess.inputStream.bufferedReader().use { reader ->
                reader.lineSequence().firstOrNull { it.isNotBlank() }
            }
            versionProcess.waitFor()
            Log.i(TAG, "xray version: ${firstLine ?: "unknown"}")
        } catch (error: Exception) {
            Log.w(TAG, "xray version check failed: ${error.javaClass.simpleName}")
        }
    }

    private fun stopTunnel() {
        running = false
        try {
            process?.destroy()
        } catch (_: Exception) {
        }
        process = null
        outputThread?.interrupt()
        outputThread = null
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
        stopTunnel()
        super.onDestroy()
    }

    private val DEFAULT_CONFIG = """
        {
          "log": { "loglevel": "warning" },
          "inbounds": [
            {
              "tag": "tun-in",
              "protocol": "tun",
              "settings": { "name": "kpv0", "mtu": 1500 }
            }
          ],
          "outbounds": [
            { "tag": "direct", "protocol": "freedom" }
          ]
        }
    """.trimIndent()
}
