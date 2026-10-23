package com.livingroom.tv.glance

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.math.roundToInt

data class ForecastDay(
    val at: Long, val code: Int?, val high: Int?, val low: Int?,
    val windMax: Int?, val gustMax: Int?, val rainChance: Int?,
    val sunrise: Long?, val sunset: Long?,
)

data class ForecastHour(
    val at: Long, val temp: Float?, val code: Int?, val wind: Int?,
    val rainChance: Int?, val isDay: Boolean,
)

/** Forecast values are already in the selected location's temperature and wind units. */
data class Weather(
    val place: String?, val temp: Int, val code: Int, val isDay: Boolean,
    val wind: Int?, val feelsLike: Int?, val humidity: Int?, val imperial: Boolean,
    val timezone: String, val updatedAt: Long,
    val days: List<ForecastDay>, val hourly: List<ForecastHour>,
) {
    val today get() = days.first()
    val high get() = today.high
    val low get() = today.low
    val windMax get() = today.windMax
    val sunrise get() = today.sunrise
    val sunset get() = today.sunset
    val condition get() = conditionFor(code)
    val windUnit get() = if (imperial) "mph" else "km/h"
    val zone: ZoneId get() = runCatching { ZoneId.of(timezone) }.getOrDefault(ZoneId.of("UTC"))

    fun hours(day: ForecastDay): List<ForecastHour> {
        val date = Instant.ofEpochMilli(day.at).atZone(zone).toLocalDate()
        return hourly.filter { Instant.ofEpochMilli(it.at).atZone(zone).toLocalDate() == date }
    }

    companion object {
        fun conditionFor(code: Int?): String = when (code) {
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

private fun JSONArray?.number(index: Int): Double? = this?.optDouble(index, Double.NaN)?.takeIf { it.isFinite() }
private fun JSONArray?.integer(index: Int): Int? = number(index)?.roundToInt()
private fun JSONArray?.stamp(index: Int): Long? = number(index)?.takeIf { it > 0 && it < Long.MAX_VALUE / 1000.0 }?.let { (it * 1000).toLong() }
private fun JSONObject.integer(key: String): Int? = optDouble(key, Double.NaN).takeIf { it.isFinite() }?.roundToInt()

/** Missing values stay missing. Unix timestamps are UTC; format them in the forecast's IANA zone. */
internal fun parseForecast(data: JSONObject, place: String?, imperial: Boolean, now: Long = System.currentTimeMillis()): Weather {
    val current = data.getJSONObject("current")
    val daily = data.getJSONObject("daily")
    val times = daily.getJSONArray("time")
    val zone = runCatching { ZoneId.of(data.optString("timezone", "UTC")) }.getOrDefault(ZoneId.of("UTC"))
    val offset = runCatching { ZoneOffset.ofTotalSeconds(data.optInt("utc_offset_seconds", 0)) }.getOrDefault(ZoneOffset.UTC)
    val days = (0 until minOf(10, times.length())).mapNotNull { i ->
        times.stamp(i)?.let { at ->
            // Daily boundaries use the request's fixed offset, even across DST. Keep the API's
            // calendar date, then anchor it at real local midnight for labels and hourly grouping.
            val midnight = Instant.ofEpochMilli(at).atOffset(offset).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
            ForecastDay(midnight, daily.optJSONArray("weather_code").integer(i),
                daily.optJSONArray("temperature_2m_max").integer(i), daily.optJSONArray("temperature_2m_min").integer(i),
                daily.optJSONArray("wind_speed_10m_max").integer(i), daily.optJSONArray("wind_gusts_10m_max").integer(i),
                daily.optJSONArray("precipitation_probability_max").integer(i),
                daily.optJSONArray("sunrise").stamp(i), daily.optJSONArray("sunset").stamp(i))
        }
    }
    require(days.isNotEmpty()) { "No daily forecast" }
    val hourly = data.optJSONObject("hourly")
    val hours = hourly?.optJSONArray("time")
    val forecastHours = (0 until (hours?.length() ?: 0)).mapNotNull { i ->
        hours.stamp(i)?.let { at ->
            ForecastHour(at, hourly?.optJSONArray("temperature_2m").number(i)?.toFloat(),
                hourly?.optJSONArray("weather_code").integer(i), hourly?.optJSONArray("wind_speed_10m").integer(i),
                hourly?.optJSONArray("precipitation_probability").integer(i), hourly?.optJSONArray("is_day").integer(i) != 0)
        }
    }
    return Weather(place, requireNotNull(current.integer("temperature_2m")) { "No current temperature" },
        current.integer("weather_code") ?: -1, current.optInt("is_day", 1) == 1,
        current.integer("wind_speed_10m"), current.integer("apparent_temperature"), current.integer("relative_humidity_2m"),
        imperial, data.optString("timezone", "UTC"), now, days, forecastHours)
}
