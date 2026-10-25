package com.livingroom.tv

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.provider.Settings
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.Inet4Address

/**
 * Opt-in maintenance recovery. Android still enforces its trusted-Wi-Fi and paired-host checks.
 *
 * The Wi-Fi network is looked up explicitly instead of through `activeNetwork`: with a VPN up
 * (Tailscale on this TV) the default network is `tun1`, so the old check never matched Wi-Fi and
 * recovery silently did nothing.
 */
class WirelessDebugging(private val context: Context, private val prefs: Prefs) {
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val attempted = mutableSetOf<Network>()

    private val permitted: Boolean get() = context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    /** Record the current Wi-Fi subnet/gateway, never enable recovery on arbitrary networks. */
    fun configure(enabled: Boolean): Boolean {
        if (!enabled) { prefs.debugRecoveryNetwork = null; return true }
        if (!permitted) return false
        val network = wifiNetwork() ?: return false
        val key = networkKey(network) ?: return false
        prefs.debugRecoveryNetwork = key
        recover(network)
        return true
    }

    fun status() = JSONObject().put("recovery", prefs.debugRecoveryNetwork != null)
        .put("permission", permitted).put("enabled", Settings.Global.getInt(context.contentResolver, "adb_wifi_enabled", 0) == 1)
        .put("network", prefs.debugRecoveryNetwork ?: JSONObject.NULL)

    fun start(scope: CoroutineScope) {
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return
                synchronized(attempted) { if (!attempted.add(network)) return }
                scope.launch {
                    // Let Android finish processing its disconnect/reconnect and debug-server shutdown.
                    delay(3_000)
                    recover(network)
                }
            }
            override fun onLost(network: Network) { synchronized(attempted) { attempted.remove(network) } }
        }
        runCatching { connectivity?.registerNetworkCallback(request, callback) }
            .onFailure { Log.w("LivingRoomADB", "Wireless debugging callback failed", it) }
    }

    private fun recover(network: Network) {
        if (!permitted) return
        val saved = prefs.debugRecoveryNetwork ?: return
        if (networkKey(network) != saved) return
        // Respect the Developer options master switch; never change pairing/authorization settings.
        if (Settings.Global.getInt(context.contentResolver, Settings.Global.DEVELOPMENT_SETTINGS_ENABLED, 0) != 1) return
        if (Settings.Global.getInt(context.contentResolver, "adb_wifi_enabled", 0) == 1) return
        runCatching { Settings.Global.putInt(context.contentResolver, "adb_wifi_enabled", 1) }
            .onFailure { Log.w("LivingRoomADB", "Wireless debugging recovery failed", it) }
    }

    /** The Wi-Fi network carrying the home LAN, whether or not it is the default route. */
    private fun wifiNetwork(): Network? = (connectivity?.allNetworks ?: emptyArray()).firstOrNull {
        networkKey(it) != null
    }

    private fun networkKey(network: Network): String? {
        val caps = connectivity?.getNetworkCapabilities(network) ?: return null
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return null
        val links = connectivity.getLinkProperties(network) ?: return null
        val address = links.linkAddresses.firstOrNull { it.address is Inet4Address } ?: return null
        val bytes = address.address.address
        val prefix = address.prefixLength
        val subnet = bytes.mapIndexed { index, value ->
            val bits = (prefix - index * 8).coerceIn(0, 8)
            (value.toInt() and 255) and (255 shl (8 - bits))
        }.joinToString(".")
        // Subnet only: with a VPN up the Wi-Fi route isn't the default one, so a gateway lookup
        // could differ between the save and the reconnect and never match.
        return "$subnet/$prefix"
    }
}
