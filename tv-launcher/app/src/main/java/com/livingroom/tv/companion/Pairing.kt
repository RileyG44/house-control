package com.livingroom.tv.companion

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.livingroom.tv.Graph
import com.livingroom.tv.Prefs
import com.livingroom.tv.input.RemoteInputService
import java.security.SecureRandom

/**
 * Apple TV-style pairing for the iPhone app: the phone asks, the TV shows a 4-digit code
 * over whatever is on screen, and the phone trades that code for the token.
 */
class Pairing(private val prefs: Prefs) {
    private class Pending(val code: String, val expiresAt: Long, var attempts: Int = 0)

    private val random = SecureRandom()
    private val main = Handler(Looper.getMainLooper())
    private var pending: Pending? = null
    private val expire = Runnable { cancel() }

    /** Shows a code on the TV (reusing one that's still live). False if the overlay can't be drawn. */
    @Synchronized
    fun start(): Boolean {
        val now = SystemClock.elapsedRealtime()
        val p = pending?.takeIf { it.expiresAt > now }
            ?: Pending("%04d".format(random.nextInt(10_000)), now + TTL_MS).also { pending = it }
        main.removeCallbacks(expire)
        main.postDelayed(expire, p.expiresAt - now)
        return RemoteInputService.showPairCode(p.code)
    }

    /** The token if [code] matches the one on screen. Five wrong guesses and the code is gone. */
    @Synchronized
    fun finish(code: String): String? {
        val p = pending ?: return null
        if (p.expiresAt < SystemClock.elapsedRealtime()) { cancel(); return null }
        if (code.trim() != p.code) {
            if (++p.attempts >= MAX_ATTEMPTS) cancel()
            return null
        }
        cancel()
        return prefs.token
    }

    @Synchronized
    fun cancel() {
        pending = null
        main.removeCallbacks(expire)
        RemoteInputService.showPairCode(null)
    }

    private companion object {
        const val TTL_MS = 120_000L
        const val MAX_ATTEMPTS = 5
    }
}

/**
 * Announces the TV on the local network as _livingroom._tcp so the iPhone app finds it without typing an address.
 * The TV moves between the router and the extender (and 2.4/5 GHz), so the announcement is redone
 * whenever its address changes. The phone also scans the subnet, for networks that don't pass Bonjour.
 */
class Advertiser(private val context: Context, private val prefs: Prefs) {
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private val main = Handler(Looper.getMainLooper())
    private var registered: NsdManager.RegistrationListener? = null
    private var advertisedIp: String? = null
    private var watching = false

    fun start() {
        register()
        if (!watching && connectivity != null) {
            watching = true
            connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) = changed()
                override fun onAvailable(network: Network) = changed()
            }, main)
        }
    }

    /** Waits a moment for DHCP to settle, then re-announces if the address moved. */
    private fun changed() {
        main.removeCallbacks(recheck)
        main.postDelayed(recheck, 1_500)
    }

    private val recheck = Runnable {
        val ip = CompanionServer.localIp()
        if (ip != null && ip != advertisedIp) {
            Log.i(TAG, "Address changed: $advertisedIp → $ip")
            unregister()
            register()
            Graph.server.writePairingFile()
        }
    }

    private fun register() {
        if (nsd == null || registered != null) return
        val ip = CompanionServer.localIp()
        val info = NsdServiceInfo().apply {
            serviceName = prefs.tvName
            serviceType = SERVICE_TYPE
            port = CompanionServer.PORT
            setAttribute("id", prefs.deviceId)
            setAttribute("v", "1")
            ip?.let { setAttribute("ip", it) }
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) { Log.i(TAG, "Advertising as ${info.serviceName} at $ip") }
            override fun onRegistrationFailed(info: NsdServiceInfo, error: Int) {
                Log.w(TAG, "Bonjour registration failed: $error")
                if (registered === this) registered = null
            }
            override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(info: NsdServiceInfo, error: Int) = Unit
        }
        registered = listener
        advertisedIp = ip
        runCatching { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener) }
            .onFailure { Log.w(TAG, "Bonjour unavailable", it); registered = null }
    }

    private fun unregister() {
        val listener = registered ?: return
        registered = null
        runCatching { nsd?.unregisterService(listener) }
    }

    companion object {
        private const val TAG = "LivingRoomBonjour"
        const val SERVICE_TYPE = "_livingroom._tcp"
    }
}
