package com.plugin.vpn

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.drawable.Icon
import android.net.VpnService
import android.os.Build
import android.util.Base64
import android.util.Log
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import libXray.LibXray
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

@InvokeArg
class PingArgs {
    var value: String? = null
}

@InvokeArg
class ConnectArgs {
    var configJson: String? = null
    var splitMode: String? = null
    var includePackages: ArrayList<String>? = null
    var excludePackages: ArrayList<String>? = null
    var localNetwork: Boolean = false
    var nodeLabel: String? = null
    var country: String? = null
}

@TauriPlugin
class VpnPlugin(private val activity: Activity) : Plugin(activity) {
    companion object {
        private const val TAG = "KPV_PHASE1"
        private val EXCLUDED_PACKAGES = setOf(
            "com.google.android.gms",
            "com.google.android.gsf",
            "com.android.vending",
            "com.google.android.gms.location.history"
        )
    }

    private var pendingConnect: ConnectArgs? = null

    override fun load(webView: WebView) {
        registerToggleShortcut()
        // No automatic tunnel start here. Phase 0 did this for the CI spike;
        // production connects only after an explicit UI/tile/shortcut action.
    }

    override fun onResume(activity: AppCompatActivity) {
        // Resume is allowed to finish a consent flow that the user started
        // explicitly. It never starts a tunnel on a cold app launch.
        val pending = pendingConnect ?: return
        if (VpnService.prepare(activity) != null) return
        pendingConnect = null
        startTunnel(pending)
    }

    @Command
    fun connect(invoke: Invoke) {
        val args = invoke.parseArgs(ConnectArgs::class.java)
        if (args.configJson.isNullOrBlank()) {
            invoke.reject("empty Xray configuration")
            return
        }
        KartoshkaVpnService.clearError()
        if (KartoshkaVpnService.running) {
            invoke.resolve(statusObject())
            return
        }
        val consent = VpnService.prepare(activity)
        if (consent != null) {
            pendingConnect = args
            activity.startActivity(consent)
            val result = statusObject()
            result.put("consentRequired", true)
            invoke.resolve(result)
            return
        }
        startTunnel(args)
        invoke.resolve(statusObject())
    }

    @Command
    fun disconnect(invoke: Invoke) {
        try {
            val intent = Intent(activity, KartoshkaVpnService::class.java)
                .setAction(KartoshkaVpnService.ACTION_STOP)
            activity.startService(intent)
        } catch (error: Throwable) {
            Log.w(TAG, "disconnect request failed: ${error.javaClass.simpleName}")
        }
        invoke.resolve(statusObject())
    }

    @Command
    fun status(invoke: Invoke) {
        invoke.resolve(statusObject())
    }

    @Command
    fun listApps(invoke: Invoke) {
        val result = JSObject()
        val apps = JSONArray()
        try {
            val manager = activity.packageManager
            val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            val seen = HashSet<String>()
            for (info in manager.queryIntentActivities(launcher, 0)) {
                val packageName = info.activityInfo.packageName
                if (packageName == activity.packageName) continue
                if (EXCLUDED_PACKAGES.contains(packageName)) continue
                if (!seen.add(packageName)) continue
                val appInfo = info.activityInfo.applicationInfo
                if (!appInfo.enabled) continue
                val entry = JSONObject()
                    .put("package", packageName)
                    .put("label", info.loadLabel(manager).toString())
                    .put("system", (appInfo.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0)
                iconBase64(info.loadIcon(manager))?.let { entry.put("icon", it) }
                apps.put(entry)
            }
        } catch (error: Throwable) {
            Log.w(TAG, "list apps failed: ${error.javaClass.simpleName}")
        }
        result.put("apps", apps)
        invoke.resolve(result)
    }

    @Command
    fun requestNotificationPermission(invoke: Invoke) {
        val result = JSObject()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            result.put("granted", true)
            invoke.resolve(result)
            return
        }
        val granted = activity.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) {
            activity.requestPermissions(
                arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
                KartoshkaVpnService.PERMISSION_REQUEST_CODE
            )
        }
        result.put("granted", granted)
        invoke.resolve(result)
    }

    @Command
    fun ping(invoke: Invoke) {
        val args = invoke.parseArgs(PingArgs::class.java)
        val result = JSObject()
        result.put("value", args.value ?: "kartoshka-android-phase1")
        invoke.resolve(result)
    }

    @Command
    fun startTest(invoke: Invoke) {
        val args = ConnectArgs().apply {
            configJson = KartoshkaVpnService.DEFAULT_CONFIG
            splitMode = "off"
        }
        startTunnel(args)
        invoke.resolve(statusObject())
    }

    @Command
    fun stopTest(invoke: Invoke) {
        try {
            activity.startService(
                Intent(activity, KartoshkaVpnService::class.java)
                    .setAction(KartoshkaVpnService.ACTION_STOP)
            )
        } catch (error: Throwable) {
            Log.w(TAG, "stopTest failed: ${error.javaClass.simpleName}")
        }
        invoke.resolve(statusObject())
    }

    @Command
    fun xrayVersion(invoke: Invoke) {
        val result = JSObject()
        try {
            val request = JSONObject()
                .put("apiVersion", 3)
                .put("method", "xrayVersion")
            val response = JSONObject(LibXray.invoke(request.toString()))
            if (response.optBoolean("success")) {
                result.put("output", response.optJSONObject("data")?.optString("version") ?: "")
                result.put("exitCode", 0)
            } else {
                result.put("output", "")
                result.put("error", response.optString("error", "xrayVersion failed"))
            }
        } catch (error: Throwable) {
            result.put("output", "")
            result.put("error", error.message ?: error.javaClass.simpleName)
        }
        invoke.resolve(result)
    }

    private fun startTunnel(args: ConnectArgs) {
        try {
            val intent = Intent(activity, KartoshkaVpnService::class.java)
                .setAction(KartoshkaVpnService.ACTION_START)
                .putExtra(KartoshkaVpnService.EXTRA_CONFIG, args.configJson)
                .putExtra(KartoshkaVpnService.EXTRA_SPLIT_MODE, args.splitMode ?: "off")
                .putStringArrayListExtra(
                    KartoshkaVpnService.EXTRA_INCLUDE,
                    ArrayList(args.includePackages ?: emptyList())
                )
                .putStringArrayListExtra(
                    KartoshkaVpnService.EXTRA_EXCLUDE,
                    ArrayList(args.excludePackages ?: emptyList())
                )
                .putExtra(KartoshkaVpnService.EXTRA_LOCAL_NETWORK, args.localNetwork)
                .putExtra(KartoshkaVpnService.EXTRA_NODE_LABEL, args.nodeLabel ?: "")
                .putExtra(KartoshkaVpnService.EXTRA_COUNTRY, args.country ?: "")
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
            Log.i(TAG, "VpnService start requested")
        } catch (error: Throwable) {
            KartoshkaVpnService.setError(error.message ?: error.javaClass.simpleName)
            Log.e(TAG, "VpnService start request failed: ${error.javaClass.simpleName}")
        }
    }

    private fun statusObject(): JSObject {
        val result = JSObject()
        result.put("running", KartoshkaVpnService.running)
        result.put("message", KartoshkaVpnService.lastError)
        result.put("startedAt", KartoshkaVpnService.startedAt)
        result.put("country", KartoshkaVpnService.activeCountry ?: "")
        result.put("nodeLabel", KartoshkaVpnService.activeNodeLabel ?: "")
        result.put("configAvailable", KartoshkaVpnService.configAvailable || SecureConfigStore(activity).hasConfig())
        result.put("consentRequired", false)
        return result
    }

    private fun iconBase64(drawable: android.graphics.drawable.Drawable): String? {
        return try {
            val size = 96
            val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bitmap)
            drawable.setBounds(0, 0, size, size)
            drawable.draw(canvas)
            val output = ByteArrayOutputStream()
            bitmap.compress(Bitmap.CompressFormat.PNG, 80, output)
            Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
        } catch (error: Throwable) {
            Log.w(TAG, "icon conversion failed: ${error.javaClass.simpleName}")
            null
        }
    }

    private fun registerToggleShortcut() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return
        try {
            val manager = activity.getSystemService(ShortcutManager::class.java) ?: return
            val intent = Intent(activity, ToggleActivity::class.java)
                .setAction(KartoshkaVpnService.ACTION_TOGGLE)
            val shortcut = ShortcutInfo.Builder(activity, "kpv_toggle")
                .setShortLabel(activity.getString(R.string.kpv_shortcut_short))
                .setLongLabel(activity.getString(R.string.kpv_shortcut_long))
                .setIcon(Icon.createWithResource(activity, R.drawable.ic_vpn_notification))
                .setIntent(intent)
                .build()
            manager.dynamicShortcuts = listOf(shortcut)
        } catch (error: Throwable) {
            Log.w(TAG, "shortcut registration failed: ${error.javaClass.simpleName}")
        }
    }
}
