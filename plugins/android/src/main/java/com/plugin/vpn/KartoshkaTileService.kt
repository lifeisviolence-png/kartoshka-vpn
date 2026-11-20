package com.plugin.vpn

import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.util.Log

/**
 * Quick Settings tile. A tile tap is an explicit user action, so it may start
 * the foreground service. If VPN consent is missing or no bundle was saved,
 * the main app is opened instead of silently failing.
 */
class KartoshkaTileService : TileService() {
    companion object {
        private const val TAG = "KPV_PHASE1"
    }

    override fun onStartListening() {
        super.onStartListening()
        updateTile()
    }

    override fun onClick() {
        super.onClick()
        if (KartoshkaVpnService.running) {
            stopService(Intent(this, KartoshkaVpnService::class.java))
            updateTile()
            return
        }
        if (VpnService.prepare(this) != null || !SecureConfigStore(this).hasConfig()) {
            openApp()
            return
        }
        val intent = Intent(this, KartoshkaVpnService::class.java)
            .setAction(KartoshkaVpnService.ACTION_START)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
        updateTile()
    }

    private fun updateTile() {
        val tile = qsTile ?: return
        tile.state = if (KartoshkaVpnService.running) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        tile.label = getString(R.string.kpv_tile_label)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.subtitle = if (KartoshkaVpnService.running) "Подключено" else "Отключено"
        }
        tile.updateTile()
    }

    private fun openApp() {
        try {
            val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startActivityAndCollapse(
                    android.app.PendingIntent.getActivity(
                        this,
                        0,
                        launch,
                        android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
                    )
                )
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(launch)
            }
        } catch (error: Throwable) {
            Log.w(TAG, "tile open app failed: ${error.javaClass.simpleName}")
        }
    }
}
