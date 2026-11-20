package com.plugin.vpn

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Bundle
import android.util.Log

/**
 * Debug-only entry point used by the emulator test.
 *
 * The production service is intentionally not exported, so `adb shell am
 * start-foreground-service` cannot start it. This activity exists only in the
 * debug manifest and refuses to do anything when the APK is not debuggable.
 * It never ships in a release build.
 */
class KpvTestStartActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            Log.w("KPV_PHASE1", "test start rejected: application is not debuggable")
            finish()
            return
        }

        val service = Intent(this, KartoshkaVpnService::class.java)
        when {
            intent.getBooleanExtra("stop", false) -> {
                service.action = KartoshkaVpnService.ACTION_STOP
                startService(service)
            }
            intent.getBooleanExtra("nullStart", false) -> {
                // No action: exercises the same branch as Android's always-on
                // null-intent start and loads the Keystore-protected bundle.
                startServiceCompat(service)
            }
            else -> {
                val config = intent.getStringExtra(KartoshkaVpnService.EXTRA_CONFIG)
                if (config.isNullOrBlank()) {
                    Log.w("KPV_PHASE1", "test start rejected: missing config")
                    finish()
                    return
                }
                service.action = KartoshkaVpnService.ACTION_START
                service.putExtra(KartoshkaVpnService.EXTRA_CONFIG, config)
                startServiceCompat(service)
            }
        }
        finish()
    }

    private fun startServiceCompat(service: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service)
        } else {
            startService(service)
        }
    }
}
