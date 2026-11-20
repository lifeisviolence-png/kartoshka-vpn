package com.plugin.vpn

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Build
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
import org.json.JSONObject

@InvokeArg
class PingArgs {
    var value: String? = null
}

@TauriPlugin
class VpnPlugin(private val activity: Activity) : Plugin(activity) {
    private val tag = "KPV_PHASE0"

    override fun load(webView: WebView) {
        // Phase 0 spike: the CI emulator grants ACTIVATE_VPN before launch.
        // On a normal phone this opens Android's VPN consent dialog once.
        maybeStartTunnel()
    }

    override fun onResume(activity: AppCompatActivity) {
        maybeStartTunnel()
    }

    private fun maybeStartTunnel() {
        if (KartoshkaVpnService.running) return
        try {
            val consent = VpnService.prepare(activity)
            if (consent != null) {
                Log.i(tag, "VPN consent required")
                activity.startActivity(consent)
                return
            }
            val intent = Intent(activity, KartoshkaVpnService::class.java)
                .setAction(KartoshkaVpnService.ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
            Log.i(tag, "VpnService start requested")
        } catch (error: Exception) {
            Log.e(tag, "VpnService start request failed: ${error.javaClass.simpleName}")
        }
    }

    @Command
    fun ping(invoke: Invoke) {
        val args = invoke.parseArgs(PingArgs::class.java)
        val result = JSObject()
        result.put("value", args.value ?: "kartoshka-android-phase0")
        invoke.resolve(result)
    }

    @Command
    fun startTest(invoke: Invoke) {
        maybeStartTunnel()
        invoke.resolve(statusObject())
    }

    @Command
    fun stopTest(invoke: Invoke) {
        activity.stopService(Intent(activity, KartoshkaVpnService::class.java))
        val result = statusObject()
        invoke.resolve(result)
    }

    @Command
    fun status(invoke: Invoke) {
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

    private fun statusObject(): JSObject {
        val result = JSObject()
        result.put("running", KartoshkaVpnService.running)
        result.put("message", KartoshkaVpnService.lastError)
        return result
    }
}
