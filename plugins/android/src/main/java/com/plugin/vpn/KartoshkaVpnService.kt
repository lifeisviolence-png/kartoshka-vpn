package com.plugin.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.IpPrefix
import android.net.Network
import android.net.VpnService
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
import libXray.LibXray
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetAddress

/**
 * Production Android tunnel service.
 *
 * The service receives a complete Xray JSON configuration from the UI, creates
 * a TUN interface, passes its fd through `env.xray.tun.fd` and runs the
 * official libXray 26.10.31 in this process. It never opens HTTP/SOCKS TCP
 * listeners; the only inbound is the TUN.
 *
 * The last bundle is encrypted with Android Keystore so a null-intent start
 * (always-on VPN, tile) can reconnect without the WebView. No wake lock is
 * held; the watchdog uses the main looper and therefore respects Doze.
 */
class KartoshkaVpnService : VpnService() {
    companion object {
        private const val TAG = "KPV_PHASE1"
        const val ACTION_START = "com.plugin.vpn.action.START"
        const val ACTION_STOP = "com.plugin.vpn.action.STOP"
        const val ACTION_TOGGLE = "com.plugin.vpn.action.TOGGLE"
        const val EXTRA_CONFIG = "config"
        const val EXTRA_SPLIT_MODE = "splitMode"
        const val EXTRA_INCLUDE = "includePackages"
        const val EXTRA_EXCLUDE = "excludePackages"
        const val EXTRA_LOCAL_NETWORK = "localNetwork"
        const val EXTRA_NODE_LABEL = "nodeLabel"
        const val EXTRA_COUNTRY = "country"
        const val CHANNEL_ID = "kartoshka_vpn"
        const val STATUS_CHANNEL_ID = "kartoshka_vpn_status"
        const val NOTIFICATION_ID = 7301
        const val PROBLEM_NOTIFICATION_ID = 7302
        const val PERMISSION_REQUEST_CODE = 7303

        @Volatile
        var running: Boolean = false
            private set

        @Volatile
        var lastError: String? = null
            private set

        @Volatile
        var startedAt: Long = 0L
            private set

        @Volatile
        var activeCountry: String? = null
            private set

        @Volatile
        var activeNodeLabel: String? = null
            private set

        @Volatile
        var configAvailable: Boolean = false
            private set

        fun clearError() {
            lastError = null
        }

        fun setError(message: String?) {
            lastError = message
        }

        // Kept for the phase-0 smoke test and for a deliberately explicit test
        // start. It is never used by VpnPlugin.load().
        val DEFAULT_CONFIG = """
            {
              "log": { "loglevel": "warning" },
              "inbounds": [
                { "tag": "tun-in", "protocol": "tun", "settings": { "name": "kpv0", "mtu": 1500 } }
              ],
              "outbounds": [
                { "tag": "test-out", "protocol": "freedom", "settings": { "redirect": "127.0.0.1:8081" } }
              ]
            }
        """.trimIndent()
    }

    private var tun: ParcelFileDescriptor? = null
    private var coreStarted = false
    private var destroying = false
    private var restarting = false
    private var restartAttempts = 0
    private var lastBundleJson: String? = null
    private var underlyingNetwork: Network? = null
    private var connectivity: ConnectivityManager? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private val handler = Handler(Looper.getMainLooper())

    private val watchdog = object : Runnable {
        override fun run() {
            if (!running) return
            if (!xrayRunning()) restartCore("watchdog")
            handler.postDelayed(this, 15_000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        ensureChannels()
        configAvailable = SecureConfigStore(this).hasConfig()
        Log.i(TAG, "service onCreate")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "service onStartCommand action=${intent?.action ?: "null"}")
        if (destroying) {
            stopSelf()
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_START -> {
                startForegroundNotification("Подключение…", null)
                val config = intent.getStringExtra(EXTRA_CONFIG)
                if (config.isNullOrBlank()) {
                    startFromSaved()
                } else {
                    val bundle = bundleFromIntent(intent, config)
                    lastBundleJson = bundle
                    Thread({ startTunnel(bundle) }, "kpv-start").start()
                }
            }
            ACTION_STOP -> stopTunnel()
            else -> {
                // Always-on VPN starts the service with a null intent. This is
                // not an automatic start from the UI: the user enabled it in
                // Android settings, and it reconnects only to the last bundle.
                startForegroundNotification("Подключение…", null)
                startFromSaved()
            }
        }
        // Do not let the system silently reconnect after a process kill: the
        // user must either enable Android's always-on VPN (null intent) or tap
        // Connect. This keeps the "explicit action" rule honest.
        return START_NOT_STICKY
    }

    private fun startFromSaved() {
        Thread({
            val store = SecureConfigStore(this)
            val saved = store.load()
            configAvailable = saved != null
            if (saved == null) {
                lastError = store.lastError ?: "Нет сохранённого конфига. Подключитесь в приложении."
                Log.w(TAG, "always-on start without a usable config")
                // A missing key or a corrupted record is actionable for the
                // user, unlike a cold boot with no saved config at all.
                stopTunnelInternal(notifyProblem = store.lastError != null)
                return@Thread
            }
            lastBundleJson = saved
            startTunnel(saved)
        }, "kpv-always-on").start()
    }

    private fun bundleFromIntent(intent: Intent, config: String): String {
        val bundle = JSONObject()
            .put("config", config)
            .put("splitMode", intent.getStringExtra(EXTRA_SPLIT_MODE) ?: "off")
            .put("includePackages", JSONArray(intent.getStringArrayListExtra(EXTRA_INCLUDE) ?: emptyList<String>()))
            .put("excludePackages", JSONArray(intent.getStringArrayListExtra(EXTRA_EXCLUDE) ?: emptyList<String>()))
            .put("localNetwork", intent.getBooleanExtra(EXTRA_LOCAL_NETWORK, false))
            .put("nodeLabel", intent.getStringExtra(EXTRA_NODE_LABEL) ?: "")
            .put("country", intent.getStringExtra(EXTRA_COUNTRY) ?: "")
        return bundle.toString()
    }

    @Synchronized
    private fun startTunnel(bundleJson: String) {
        if (destroying) return
        if (tun != null || coreStarted) {
            Log.i(TAG, "tunnel already running")
            return
        }
        lastError = null
        try {
            val (pfd, xrayConfig) = establishTun(bundleJson)
            tun = pfd

            if (!startCore(xrayConfig, pfd)) error(lastError ?: "runXray failed")
            running = true
            startedAt = System.currentTimeMillis()
            restartAttempts = 0
            SecureConfigStore(this).save(bundleJson)
            configAvailable = SecureConfigStore(this).hasConfig()
            registerNetworkCallback()
            startWatchdog()
            updateNotification("Подключено", activeCountry)
            Log.i(TAG, "tunnel started fd=${pfd.fd}")
            Log.i(TAG, "xray version: ${xrayVersion()}")
            Log.i(TAG, "xray state: ${xrayRunning()}")
        } catch (error: Throwable) {
            lastError = error.message ?: error.javaClass.simpleName
            Log.e(TAG, "tunnel start failed: $lastError", error)
            stopTunnelInternal(notifyProblem = true)
        }
    }

    /**
     * Creates a fresh TUN interface from the saved bundle. libXray owns the
     * fd while the core runs and closes it when the core stops, so a core
     * restart must establish a new interface instead of reusing the old fd.
     */
    @Synchronized
    private fun establishTun(bundleJson: String): Pair<ParcelFileDescriptor, JSONObject> {
        val bundle = JSONObject(bundleJson)
        val configJson = bundle.optString("config")
        if (configJson.isBlank()) error("empty Xray configuration")
        val xrayConfig = JSONObject(configJson)
        val mtu = xrayConfig.optJSONArray("inbounds")
            ?.optJSONObject(0)
            ?.optJSONObject("settings")
            ?.optInt("mtu", 1500)
            ?.coerceIn(1280, 1500) ?: 1500

        val builder = Builder()
            .setSession("KartoshkaVPN")
            .setMtu(mtu)
            .addAddress("10.8.0.2", 32)
            .addRoute("0.0.0.0", 0)
            .addAddress("fd00::2", 128)
            .addRoute("::", 0)
            .addDnsServer("1.1.1.1")
            .addDnsServer("2606:4700:4700::1111")
            .setBlocking(true)

        applySplitTunnelling(builder, bundle)
        if (bundle.optBoolean("localNetwork", false)) addLocalNetworkExclusions(builder)

        val pfd = builder.establish() ?: error("VpnService.establish() returned null")
        lastBundleJson = bundleJson
        activeCountry = bundle.optString("country").ifBlank { null }
        activeNodeLabel = bundle.optString("nodeLabel").ifBlank { null }
        return pfd to xrayConfig
    }

    private fun applySplitTunnelling(builder: Builder, bundle: JSONObject) {
        val self = packageName
        val mode = bundle.optString("splitMode", "off")
        val include = stringList(bundle.optJSONArray("includePackages"))
            .filter { it != self }
            .filter { isInstalled(it) }
        if (mode == "include" && include.isNotEmpty()) {
            include.forEach { builder.addAllowedApplication(it) }
            // The app itself is not in the allowed list, so its own sockets
            // bypass the TUN without addDisallowedApplication (the two calls
            // are mutually exclusive on VpnService.Builder).
            return
        }
        builder.addDisallowedApplication(self)
        if (mode == "exclude") {
            stringList(bundle.optJSONArray("excludePackages"))
                .filter { it != self && isInstalled(it) }
                .forEach { builder.addDisallowedApplication(it) }
        }
    }

    private fun addLocalNetworkExclusions(builder: Builder) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // excludeRoute() exists from API 33. On 26–32 a local-network
            // bypass cannot be expressed together with 0.0.0.0/0; the UI
            // disables the switch there and the report says so.
            Log.i(TAG, "local-network exclusion requires API 33")
            return
        }
        for (prefix in listOf("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "fc00::/7", "fe80::/10")) {
            val parts = prefix.split('/')
            builder.excludeRoute(IpPrefix(InetAddress.getByName(parts[0]), parts[1].toInt()))
        }
    }

    private fun isInstalled(packageName: String): Boolean {
        return try {
            packageManager.getApplicationInfo(packageName, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }
    }

    private fun stringList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { index ->
            array.optString(index).takeIf { it.isNotBlank() }
        }
    }

    @Synchronized
    private fun startCore(xrayConfig: JSONObject, pfd: ParcelFileDescriptor): Boolean {
        xrayConfig.put("env", JSONObject().put("xray.tun.fd", pfd.fd.toString()))
        // No access log in production: destinations and credentials must not
        // land in app-private files. The phase-0 access log is not used here.
        xrayConfig.optJSONObject("log")?.remove("access")
        val request = JSONObject()
            .put("apiVersion", 3)
            .put("method", "runXray")
            .put("payload", JSONObject().put("xrayJson", xrayConfig.toString()))
        val response = JSONObject(LibXray.invoke(request.toString()))
        if (!response.optBoolean("success")) {
            lastError = "runXray failed: ${response.optString("error", "unknown error")}"
            return false
        }
        coreStarted = true
        return true
    }

    @Synchronized
    private fun stopCore() {
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

    private fun restartCore(reason: String) {
        if (restarting || !running) return
        restarting = true
        Thread({
            try {
                if (restartAttempts >= 3) {
                    lastError = "Ядро не запускается после трёх попыток."
                    Log.e(TAG, "watchdog gave up: $lastError")
                    stopTunnelInternal(notifyProblem = true)
                    return@Thread
                }
                restartAttempts += 1
                Log.i(TAG, "restarting core ($reason), attempt $restartAttempts")
                stopCore()
                val bundleJson = lastBundleJson ?: error("configuration is gone")
                try {
                    tun?.close()
                } catch (_: Throwable) {
                }
                val (pfd, xrayConfig) = establishTun(bundleJson)
                tun = pfd
                if (!startCore(xrayConfig, pfd)) error(lastError ?: "runXray failed")
                updateNotification("Подключено", activeCountry)
                Log.i(TAG, "core restarted: ${xrayRunning()}")
                // Three attempts are a budget for one failure episode, not for
                // the whole lifetime of the service. After a minute of a
                // healthy core the next failure starts with a fresh budget.
                handler.postDelayed({
                    if (running && xrayRunning()) restartAttempts = 0
                }, 60_000)
            } catch (error: Throwable) {
                lastError = error.message ?: error.javaClass.simpleName
                Log.e(TAG, "core restart failed: $lastError", error)
            } finally {
                restarting = false
            }
        }, "kpv-restart").start()
    }

    private fun startWatchdog() {
        handler.removeCallbacks(watchdog)
        handler.postDelayed(watchdog, 15_000)
    }

    private fun registerNetworkCallback() {
        try {
            val manager = getSystemService(ConnectivityManager::class.java)
            connectivity = manager
            underlyingNetwork = manager.activeNetwork
            manager.activeNetwork?.let { setUnderlyingNetworks(arrayOf(it)) }
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    val previous = underlyingNetwork
                    underlyingNetwork = network
                    setUnderlyingNetworks(arrayOf(network))
                    if (previous != null && previous != network && running) {
                        // Keep the existing TUN and core. Android routes new
                        // outbound sockets through the updated underlying
                        // network; tearing down the core here would close the
                        // libXray-owned TUN fd and leave the interface gone.
                        Log.i(TAG, "underlying network changed; core kept running")
                    }
                }

                override fun onLost(network: Network) {
                    if (underlyingNetwork == network) {
                        underlyingNetwork = null
                        setUnderlyingNetworks(null)
                        Log.i(TAG, "underlying network lost")
                    }
                }
            }
            manager.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (error: Throwable) {
            Log.w(TAG, "network callback failed: ${error.javaClass.simpleName}")
        }
    }

    private fun unregisterNetworkCallback() {
        try {
            networkCallback?.let { connectivity?.unregisterNetworkCallback(it) }
        } catch (_: Throwable) {
        }
        networkCallback = null
    }

    @Synchronized
    private fun stopTunnelInternal(notifyProblem: Boolean) {
        if (destroying) return
        destroying = true
        running = false
        startedAt = 0L
        handler.removeCallbacks(watchdog)
        unregisterNetworkCallback()
        stopCore()
        try {
            tun?.close()
        } catch (_: Throwable) {
        }
        tun = null
        if (notifyProblem) notifyProblem(lastError ?: "VPN остановлен")
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (_: Throwable) {
        }
        stopSelf()
        Log.i(TAG, "tunnel stopped")
    }

    private fun stopTunnel() {
        lastError = null
        stopTunnelInternal(notifyProblem = false)
    }

    private fun xrayVersion(): String {
        return try {
            val request = JSONObject()
                .put("apiVersion", 3)
                .put("method", "xrayVersion")
            val response = JSONObject(LibXray.invoke(request.toString()))
            if (response.optBoolean("success")) {
                response.optJSONObject("data")?.optString("version") ?: "unknown"
            } else "unknown"
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

    override fun onRevoke() {
        lastError = "VPN отключён другим приложением или пользователем."
        Log.i(TAG, "VPN permission revoked")
        notifyProblem(lastError!!)
        stopTunnelInternal(notifyProblem = false)
        super.onRevoke()
    }

    override fun onDestroy() {
        Log.i(TAG, "service onDestroy")
        stopTunnelInternal(notifyProblem = false)
        super.onDestroy()
    }

    private fun ensureChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val tunnel = NotificationChannel(
                CHANNEL_ID,
                "KartoshkaVPN",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Состояние VPN-подключения"
                setShowBadge(false)
            }
            manager.createNotificationChannel(tunnel)
            val status = NotificationChannel(
                STATUS_CHANNEL_ID,
                "Состояние KartoshkaVPN",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Отключение VPN и ошибки"
                setShowBadge(true)
            }
            manager.createNotificationChannel(status)
        }
    }

    private fun startForegroundNotification(text: String, country: String?) {
        ensureChannels()
        val notification = buildNotification(text, country)
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

    private fun updateNotification(text: String, country: String?) {
        try {
            getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, buildNotification(text, country))
        } catch (error: Throwable) {
            Log.w(TAG, "notification update failed: ${error.javaClass.simpleName}")
        }
    }

    private fun buildNotification(text: String, country: String?): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, KartoshkaVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val countryText = country?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""
        val notification = builder
            .setContentTitle("KartoshkaVPN")
            .setContentText("$text$countryText")
            .setSmallIcon(R.drawable.ic_vpn_notification)
            .setColor(Color.rgb(124, 58, 237))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(contentIntent)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, R.drawable.ic_vpn_notification),
                    "Отключить",
                    stopIntent
                ).build()
            )
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            val publicBuilder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }
            notification.publicVersion = publicBuilder
                .setContentTitle("KartoshkaVPN")
                .setContentText("VPN активен")
                .setSmallIcon(R.drawable.ic_vpn_notification)
                .setColor(Color.rgb(124, 58, 237))
                .setOngoing(true)
                .setShowWhen(false)
                .build()
        }
        return notification
    }

    private fun notifyProblem(message: String) {
        try {
            ensureChannels()
            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            val contentIntent = launchIntent?.let {
                PendingIntent.getActivity(
                    this,
                    2,
                    it,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, STATUS_CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
            }
            val notification = builder
                .setContentTitle("KartoshkaVPN")
                .setContentText(message)
                .setSmallIcon(R.drawable.ic_vpn_notification)
                .setColor(Color.rgb(124, 58, 237))
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .build()
            getSystemService(NotificationManager::class.java)
                .notify(PROBLEM_NOTIFICATION_ID, notification)
        } catch (error: Throwable) {
            Log.w(TAG, "problem notification failed: ${error.javaClass.simpleName}")
        }
    }
}
