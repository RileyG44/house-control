package com.livingroom.tv.glance

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.util.Log
import com.livingroom.tv.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import kotlin.math.max
import kotlin.math.roundToInt

/** Today at home, as shown on the Home screen. Temperatures/wind are already in [units]. */
data class Weather(
    val place: String?,
    val temp: Int,
    val code: Int,
    val isDay: Boolean,
    val high: Int,
    val low: Int,
    val wind: Int,
    val windMax: Int,
    val rainChance: Int,
    val sunrise: Long,
    val sunset: Long,
    val imperial: Boolean,
    val updatedAt: Long,
    /** Today's temperature hour by hour (local time, 0–23), in [units]. */
    val hourly: List<Float> = emptyList(),
) {
    val condition: String get() = conditionFor(code)
    val windUnit: String get() = if (imperial) "mph" else "km/h"

    companion object {
        fun conditionFor(code: Int): String = when (code) {
            0 -> "Clear"
            1 -> "Mostly clear"
            2 -> "Partly cloudy"
            3 -> "Cloudy"
            45, 48 -> "Fog"
            51, 53, 55 -> "Drizzle"
            56, 57 -> "Freezing drizzle"
            61 -> "Light rain"
            63 -> "Rain"
            65 -> "Heavy rain"
            66, 67 -> "Freezing rain"
            71 -> "Light snow"
            73 -> "Snow"
            75 -> "Heavy snow"
            77 -> "Snow grains"
            80, 81 -> "Showers"
            82 -> "Heavy showers"
            85, 86 -> "Snow showers"
            95 -> "Thunderstorms"
            96, 99 -> "Storms with hail"
            else -> "—"
        }
    }
}

/**
 * Where the TV is (from its internet address, or set from the phone) and today's forecast from
 * Open-Meteo. No account, no key. Refreshes every 15 minutes.
 */
class WeatherRepository(private val prefs: Prefs) {
    private val _weather = MutableStateFlow<Weather?>(null)
    val weather: StateFlow<Weather?> = _weather

    fun start(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) {
            while (true) {
                val ok = runCatching { refresh() }
                    .onFailure { Log.w(TAG, "Weather refresh failed", it) }
                    .getOrDefault(false)
                delay(if (ok) 15 * 60_000L else 2 * 60_000L)
            }
        }
    }

    fun refreshSoon(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) { runCatching { refresh() } }
    }

    private fun refresh(): Boolean {
        val loc = location() ?: return false
        val url = "https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}" +
            "&current=temperature_2m,weather_code,wind_speed_10m,is_day" +
            "&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,wind_speed_10m_max,precipitation_probability_max" +
            "&hourly=temperature_2m" +
            "&timezone=auto&timeformat=unixtime&forecast_days=1" +
            if (loc.imperial) "&temperature_unit=fahrenheit&wind_speed_unit=mph" else ""
        val o = JSONObject(get(url))
        val current = o.getJSONObject("current")
        val daily = o.getJSONObject("daily")
        fun day(key: String) = daily.getJSONArray(key).optDouble(0, Double.NaN)
        _weather.value = Weather(
            place = loc.place,
            temp = current.getDouble("temperature_2m").roundToInt(),
            code = current.getInt("weather_code"),
            isDay = current.optInt("is_day", 1) == 1,
            high = day("temperature_2m_max").roundToInt(),
            low = day("temperature_2m_min").roundToInt(),
            wind = current.getDouble("wind_speed_10m").roundToInt(),
            windMax = day("wind_speed_10m_max").roundToInt(),
            rainChance = day("precipitation_probability_max").let { if (it.isNaN()) 0 else it.roundToInt() },
            sunrise = daily.getJSONArray("sunrise").getLong(0) * 1000,
            sunset = daily.getJSONArray("sunset").getLong(0) * 1000,
            imperial = loc.imperial,
            updatedAt = System.currentTimeMillis(),
            hourly = o.optJSONObject("hourly")?.optJSONArray("temperature_2m")?.let { a ->
                (0 until minOf(a.length(), 24)).map { a.optDouble(it, Double.NaN).toFloat() }.filter { !it.isNaN() }
            }.orEmpty(),
        )
        return true
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
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 6000
        conn.readTimeout = 8000
        return conn.inputStream.use { it.readBytes().decodeToString() }
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
