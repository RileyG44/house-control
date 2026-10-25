package com.livingroom.tv.glance

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.util.Log
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Where the TV is (from its internet address, or set from the phone) and today's forecast from
 * Open-Meteo. No account, no key. Refreshes every 15 minutes.
 */
interface WeatherPreferences {
    var location: JSONObject?
    var ipLocation: JSONObject?
    var forecast: JSONObject?
}

class WeatherRepository(
    private val prefs: WeatherPreferences,
    private val fetch: ((String) -> String)? = null,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val logFailure: (Exception) -> Unit = { Log.w(TAG, "Weather refresh failed: ${it.message}"); Unit },
) {
    private val _weather = MutableStateFlow<Weather?>(null)
    val weather: StateFlow<Weather?> = _weather
    private val lock = Mutex()
    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error
    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing
    private val requests = Channel<Unit>(Channel.CONFLATED)

    fun start(scope: CoroutineScope, context: Context? = null) {
        scope.launch(dispatcher) {
            prefs.forecast?.let { cached ->
                runCatching {
                    _weather.value = parseForecast(cached.getJSONObject("data"), cached.optString("place").ifBlank { null },
                        cached.getBoolean("imperial"), cached.getLong("at"))
                }
            }
            var failures = 0
            while (true) {
                val ok = refreshSafely()
                failures = if (ok) 0 else (failures + 1).coerceAtMost(6)
                // Recover quickly from boot's missing network, without hammering a failing service.
                withTimeoutOrNull(if (ok) 15 * 60_000L else failures * 10_000L) { requests.receive() }
            }
        }
        context?.getSystemService(ConnectivityManager::class.java)?.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) refreshIfOld()
                }
            }
        )
    }

    fun refreshSoon() {
        requests.trySend(Unit)
    }

    fun refreshIfOld() {
        if (_weather.value == null || System.currentTimeMillis() - (_weather.value?.updatedAt ?: 0) >= 15 * 60_000L) {
            requests.trySend(Unit)
        }
    }

    private suspend fun refreshSafely(): Boolean = lock.withLock {
        _refreshing.value = true
        try {
            val loc = requireNotNull(location()) { "No weather location" }
            val url = "https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}" +
                "&current=temperature_2m,weather_code,wind_speed_10m,is_day,apparent_temperature,relative_humidity_2m" +
                "&daily=weather_code,sunrise,sunset,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,wind_gusts_10m_max,precipitation_probability_max" +
                "&hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m,is_day" +
                "&timezone=auto&timeformat=unixtime&forecast_days=10" +
                if (loc.imperial) "&temperature_unit=fahrenheit&wind_speed_unit=mph" else ""
            val data = JSONObject(get(url))
            val next = parseForecast(data, loc.place, loc.imperial)
            kotlin.coroutines.coroutineContext.ensureActive()
            _weather.value = next
            prefs.forecast = JSONObject().put("data", data).put("place", loc.place.orEmpty())
                .put("imperial", loc.imperial).put("at", next.updatedAt)
            _error.value = null
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            logFailure(e)
            _error.value = if (_weather.value == null) "Waiting for weather. Retrying automatically…"
                else "Weather could not refresh. Showing the last available forecast."
            false
        } finally {
            _refreshing.value = false
        }
    }

    private data class Location(val lat: Double, val lon: Double, val place: String?, val imperial: Boolean)

    /** A location set from the phone wins; otherwise look up the internet address once a day. */
    private fun location(): Location? {
        prefs.location?.let { return it.toLocation() }
        prefs.ipLocation?.takeIf { System.currentTimeMillis() - it.optLong("at") < 24 * 3600_000L }?.let { return it.toLocation() }
        val o = JSONObject(get("http://ip-api.com/json/?fields=status,city,regionName,countryCode,lat,lon"))
        if (o.optString("status") != "success") return prefs.ipLocation?.toLocation()
        val saved = JSONObject()
            .put("lat", o.getDouble("lat")).put("lon", o.getDouble("lon"))
            .put("place", o.optString("city")).put("country", o.optString("countryCode"))
            .put("at", System.currentTimeMillis())
        prefs.ipLocation = saved
        return saved.toLocation()
    }

    private fun JSONObject.toLocation() = Location(
        lat = getDouble("lat"),
        lon = getDouble("lon"),
        place = optString("place").ifBlank { null },
        imperial = optString("country", "US") in setOf("US", "LR", "MM"),
    )

    private fun get(url: String): String {
        fetch?.let { return it(url) }
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 6000
        conn.readTimeout = 8000
        return try { conn.inputStream.use { it.readBytes().decodeToString() } } finally { conn.disconnect() }
    }

    private companion object {
        const val TAG = "LivingRoomWeather"
    }
}

/** The Home wallpaper: one photo, stored in the app's private files, set from the phone or tools/tv-wallpaper.sh. */
class WallpaperStore(context: Context) {
    private val file = File(context.filesDir, "wallpaper.jpg")
    private val _image = MutableStateFlow<Bitmap?>(null)
    val image: StateFlow<Bitmap?> = _image

    fun load() {
        if (file.exists()) _image.value = BitmapFactory.decodeFile(file.path)
    }

    /** Decodes any photo Android can read (JPEG, PNG, HEIC), honoring its rotation, sized for a 1080p screen. */
    suspend fun set(bytes: ByteArray): Boolean = withContext(Dispatchers.IO) {
        val bitmap = runCatching {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                val longSide = max(info.size.width, info.size.height)
                if (longSide > MAX_SIDE) {
                    val scale = MAX_SIDE.toFloat() / longSide
                    decoder.setTargetSize((info.size.width * scale).roundToInt(), (info.size.height * scale).roundToInt())
                }
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        }.getOrNull() ?: return@withContext false
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        _image.value = bitmap
        true
    }

    fun clear() {
        file.delete()
        _image.value = null
    }

    private companion object {
        const val MAX_SIDE = 2560
    }
}
