package com.livingroom.tv.glance

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

class ForecastTest {
    private val zone = ZoneId.of("America/Los_Angeles")
    private fun sample(): JSONObject {
        val first = LocalDate.of(2026, 10, 31)
        val midnight = first.atStartOfDay(zone).toEpochSecond()
        val daily = JSONObject().put("time", JSONArray((0 until 10).map { midnight + it * 86400L }))
        for ((key, value) in mapOf("weather_code" to 2, "temperature_2m_max" to 66,
            "temperature_2m_min" to 40, "wind_speed_10m_max" to 18, "wind_gusts_10m_max" to 31,
            "precipitation_probability_max" to 60)) daily.put(key, JSONArray(List(10) { value }))
        daily.put("sunrise", JSONArray(List(10) { JSONObject.NULL })).put("sunset", JSONArray(List(10) { JSONObject.NULL }))
        val hourly = JSONObject().put("time", JSONArray((0..240).map { midnight + it * 3600L }))
            .put("temperature_2m", JSONArray(List(241) { 52.5 }))
            .put("is_day", JSONArray(List(241) { 1 }))
        return JSONObject().put("timezone", zone.id).put("utc_offset_seconds", -7 * 3600)
            .put("current", JSONObject().put("temperature_2m", 54.2).put("weather_code", 2).put("is_day", 1))
            .put("daily", daily).put("hourly", hourly)
    }

    @Test fun tenDaysKeepWeatherAndDailyWindMaximum() {
        val w = parseForecast(sample(), "Home", true, 1000)
        assertEquals(10, w.days.size)
        assertEquals(18, w.windMax)
        assertEquals(31, w.today.gustMax)
        assertEquals(60, w.today.rainChance)
        assertEquals("mph", w.windUnit)
        assertEquals("km/h", parseForecast(sample(), null, false).windUnit)
        assertEquals(1000L, w.updatedAt)
    }

    @Test fun missingSolarAndHourlyValuesStayMissingWithoutShiftingHours() {
        val data = sample()
        data.getJSONObject("hourly").getJSONArray("temperature_2m").put(1, JSONObject.NULL)
        val w = parseForecast(data, "Home", true)
        assertNull(w.sunrise)
        assertNull(w.sunset)
        assertNull(w.hourly[1].temp)
        assertEquals(3600_000L, w.hourly[2].at - w.hourly[1].at)
        assertNull(w.hourly[1].rainChance)
    }

    @Test fun calendarDatesAndHourlyBucketsSurviveFallBack() {
        val w = parseForecast(sample(), null, false)
        assertEquals(LocalDate.of(2026, 11, 2), java.time.Instant.ofEpochMilli(w.days[2].at).atZone(zone).toLocalDate())
        assertEquals(25, w.hours(w.days[1]).size)
        val repeated = w.hours(w.days[1]).filter { java.time.Instant.ofEpochMilli(it.at).atZone(zone).hour == 1 }
        assertEquals(2, repeated.size)
        assertNotEquals(repeated[0].at, repeated[1].at)
        assertEquals(ZoneOffset.ofHours(-8), java.time.Instant.ofEpochMilli(w.days[2].at).atZone(zone).offset)
    }
}
