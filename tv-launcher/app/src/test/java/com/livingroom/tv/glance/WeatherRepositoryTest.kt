package com.livingroom.tv.glance

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WeatherRepositoryTest {
    private class MemoryPrefs : WeatherPreferences {
        override var location: JSONObject? = JSONObject().put("lat", 34).put("lon", -118).put("country", "US").put("place", "Home")
        override var ipLocation: JSONObject? = null
        override var forecast: JSONObject? = null
    }

    private fun forecast() = JSONObject().put("timezone", "America/Los_Angeles")
        .put("current", JSONObject().put("temperature_2m", 70).put("weather_code", 0).put("is_day", 1))
        .put("daily", JSONObject().put("time", JSONArray().put(1792886400))
            .put("temperature_2m_max", JSONArray().put(75)).put("temperature_2m_min", JSONArray().put(60)))

    @Test fun bootWithoutNetworkRetriesQuicklyAndCachesSuccess() = runTest {
        val prefs = MemoryPrefs()
        var attempts = 0
        val repo = WeatherRepository(prefs, fetch = {
            attempts++
            if (attempts < 3) error("Wi-Fi is still connecting")
            forecast().toString()
        }, dispatcher = StandardTestDispatcher(testScheduler), logFailure = {})
        repo.start(backgroundScope)
        runCurrent()
        assertNull(repo.weather.value)
        advanceTimeBy(10_000); runCurrent()
        assertEquals(2, attempts)
        advanceTimeBy(20_000); runCurrent()
        assertEquals(70, repo.weather.value?.temp)
        assertNull(repo.error.value)
        assertNotNull(prefs.forecast)
        advanceTimeBy(899_999); runCurrent()
        assertEquals(3, attempts)
    }

    @Test fun restartKeepsForecastOfflineAndNetworkRecoveryRefreshesImmediately() = runTest {
        val prefs = MemoryPrefs()
        prefs.forecast = JSONObject().put("data", forecast()).put("place", "Home").put("imperial", true).put("at", 1L)
        var online = false
        var attempts = 0
        val repo = WeatherRepository(prefs, fetch = {
            attempts++
            check(online) { "Offline" }
            forecast().toString()
        }, dispatcher = StandardTestDispatcher(testScheduler), logFailure = {})
        repo.start(backgroundScope)
        runCurrent()
        assertEquals(70, repo.weather.value?.temp)
        assertEquals(1L, repo.weather.value?.updatedAt)
        assertNotNull(repo.error.value)
        online = true
        repo.refreshIfOld()
        runCurrent()
        assertEquals(2, attempts)
        assertNull(repo.error.value)
        assertTrue(repo.weather.value!!.updatedAt > 1)
    }
}
