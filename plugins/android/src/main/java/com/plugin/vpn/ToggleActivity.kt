package com.plugin.vpn

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.Bundle

/**
 * Invisible activity behind the dynamic app shortcut. It performs one explicit
 * toggle and finishes; it never shows UI and is not exported.
 */
class ToggleActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            if (KartoshkaVpnService.running) {
                stopService(Intent(this, KartoshkaVpnService::class.java))
            } else if (VpnService.prepare(this) == null && SecureConfigStore(this).hasConfig()) {
                val intent = Intent(this, KartoshkaVpnService::class.java)
                    .setAction(KartoshkaVpnService.ACTION_START)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(intent)
                } else {
                    startService(intent)
                }
            } else {
                packageManager.getLaunchIntentForPackage(packageName)?.let {
                    it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(it)
                }
            }
        } catch (_: Throwable) {
            // A shortcut must never crash the app; the main screen remains the
            // place where the user sees the actual error.
        }
        finish()
    }
}
