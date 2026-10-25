@file:OptIn(androidx.tv.material3.ExperimentalTvMaterial3Api::class)

package com.livingroom.tv.ui

import android.text.format.DateFormat
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import com.livingroom.tv.Graph
import com.livingroom.tv.glance.Weather
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

internal fun forecastTime(at: Long?, zone: ZoneId, clock24: Boolean): String = at?.let {
    DateTimeFormatter.ofPattern(if (clock24) "HH:mm" else "h:mm a", Locale.getDefault())
        .withZone(zone).format(Instant.ofEpochMilli(it))
} ?: "—"

private fun forecastDate(at: Long, zone: ZoneId, pattern: String) =
    DateTimeFormatter.ofPattern(pattern, Locale.getDefault()).withZone(zone).format(Instant.ofEpochMilli(at))

@Composable
fun WeatherOverlay(onClose: () -> Unit) {
    val weather by Graph.weather.weather.collectAsState()
    val error by Graph.weather.error.collectAsState()
    val refreshing by Graph.weather.refreshing.collectAsState()
    val clock24 = DateFormat.is24HourFormat(LocalContext.current)
    var selected by remember { mutableStateOf<Long?>(null) }
    val back = remember { FocusRequester() }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    BackHandler(onBack = onClose)
    LaunchedEffect(Unit) { back.requestFocus() }

    LazyColumn(state = list, modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(48.dp, 32.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(weather?.place ?: "Weather", fontSize = 30.sp, fontWeight = FontWeight.Light)
                    Text("Your forecast", fontSize = 13.sp, color = Color.White.copy(alpha = .55f))
                }
                WeatherButton(if (refreshing) "Refreshing…" else "Refresh", enabled = !refreshing) {
                    Graph.weather.refreshSoon()
                }
                Spacer(Modifier.width(14.dp))
                WeatherButton("Back", Modifier.focusRequester(back), onClick = onClose)
            }
        }
        if (error != null) item {
            Text(if (weather == null) "Weather is unavailable. Try Refresh." else error.orEmpty(),
                fontSize = 14.sp, color = Color.White.copy(alpha = .7f))
        }
        val w = weather
        if (w == null) {
            item { Text(if (refreshing) "Loading the forecast…" else "No forecast available yet.", fontSize = 20.sp) }
        } else {
            val day = w.days.firstOrNull { it.at == selected } ?: w.today
            val today = day.at == w.today.at
            item {
                Column(Modifier.fillMaxWidth().glass(RoundedCornerShape(26.dp)).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        WeatherIcon(if (today) w.code else day.code ?: -1, if (today) w.isDay else true, Modifier.size(64.dp))
                        Spacer(Modifier.width(22.dp))
                        Column(Modifier.weight(1f)) {
                            Text(if (today) "Today" else forecastDate(day.at, w.zone, "EEEE, MMM d"), fontSize = 17.sp)
                            Text(if (today) w.condition else Weather.conditionFor(day.code), fontSize = 26.sp, fontWeight = FontWeight.Light)
                            Text("High ${day.high ?: "—"}° · Low ${day.low ?: "—"}°", fontSize = 14.sp, color = Color.White.copy(alpha = .65f))
                        }
                        Column(horizontalAlignment = Alignment.End) {
                            Text("${if (today) w.temp else day.high ?: "—"}°", fontSize = 68.sp, fontWeight = FontWeight.ExtraLight)
                            Text(if (today) "Now · ${if (w.imperial) "°F" else "°C"}" else "Daytime high", fontSize = 12.sp, color = Color.White.copy(alpha = .55f))
                        }
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        WeatherMetric("Sunrise", forecastTime(day.sunrise, w.zone, clock24))
                        WeatherMetric("Sunset", forecastTime(day.sunset, w.zone, clock24))
                        WeatherMetric("High wind", "${day.windMax ?: "—"} ${w.windUnit}")
                        WeatherMetric("Gusts", "${day.gustMax ?: "—"} ${w.windUnit}")
                        WeatherMetric("Rain chance", "${day.rainChance ?: "—"}%")
                    }
                    if (today) Text("Feels like ${w.feelsLike ?: "—"}° · Humidity ${w.humidity ?: "—"}% · Wind now ${w.wind ?: "—"} ${w.windUnit}",
                        fontSize = 13.sp, color = Color.White.copy(alpha = .65f))
                }
            }
            item {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(if (today) "Today, hour by hour" else "Hour by hour", fontSize = 20.sp, fontWeight = FontWeight.Light)
                    val hours = w.hours(day)
                    if (hours.isEmpty()) Text("Hourly forecast is unavailable for this day.", fontSize = 13.sp)
                    key(day.at) {
                        val hoursList = rememberLazyListState(initialFirstVisibleItemIndex =
                            if (today) hours.indexOfLast { it.at <= System.currentTimeMillis() }.coerceAtLeast(0) else 0)
                        LazyRow(state = hoursList, contentPadding = PaddingValues(4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            items(hours, key = { it.at }) { hour ->
                                var focused by remember { mutableStateOf(false) }
                                Column(Modifier.width(102.dp).background(Color.White.copy(alpha = .07f), RoundedCornerShape(20.dp))
                                    .border(1.dp, Color.White.copy(alpha = if (focused) .9f else .07f), RoundedCornerShape(20.dp))
                                    .onFocusChanged { focused = it.isFocused }.focusable().padding(12.dp),
                                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(forecastTime(hour.at, w.zone, clock24), fontSize = 12.sp)
                                    WeatherIcon(hour.code ?: -1, hour.isDay, Modifier.size(28.dp))
                                    Text("${hour.temp?.roundToInt() ?: "—"}°", fontSize = 22.sp)
                                    Text("${hour.rainChance ?: "—"}% rain", fontSize = 10.sp, color = Color.White.copy(alpha = .6f))
                                    Text("${hour.wind ?: "—"} ${w.windUnit}", fontSize = 10.sp, color = Color.White.copy(alpha = .6f))
                                }
                            }
                        }
                    }
                }
            }
            item {
                Column {
                    Text("10-day forecast", fontSize = 24.sp, fontWeight = FontWeight.Light)
                    Text("Select a day for its hourly forecast", fontSize = 12.sp, color = Color.White.copy(alpha = .55f))
                }
            }
            items(w.days, key = { it.at }) { forecast ->
                Surface(onClick = {
                    selected = forecast.at
                    scope.launch {
                        list.scrollToItem(0)
                        withFrameNanos { }
                        runCatching { back.requestFocus() }
                    }
                }, shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(20.dp)),
                    colors = ClickableSurfaceDefaults.colors(containerColor = Color.White.copy(alpha = if (forecast.at == day.at) .14f else .06f),
                        focusedContainerColor = Color.White.copy(alpha = .25f)),
                    scale = ClickableSurfaceDefaults.scale(focusedScale = 1f)) {
                    Row(Modifier.fillMaxWidth().padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(if (forecast.at == w.today.at) "Today" else forecastDate(forecast.at, w.zone, "EEE, MMM d"), fontSize = 16.sp, modifier = Modifier.width(145.dp))
                        WeatherIcon(forecast.code ?: -1, true, Modifier.size(28.dp))
                        Spacer(Modifier.width(18.dp))
                        Text(Weather.conditionFor(forecast.code), fontSize = 14.sp, modifier = Modifier.weight(1f))
                        Text("${forecast.high ?: "—"}° / ${forecast.low ?: "—"}°", fontSize = 18.sp, modifier = Modifier.width(110.dp))
                        Text("${forecast.rainChance ?: "—"}% rain", fontSize = 12.sp, modifier = Modifier.width(100.dp))
                        Text("${forecast.windMax ?: "—"} ${w.windUnit} max", fontSize = 12.sp)
                    }
                }
            }
            item { Text("Forecast by Open-Meteo · Updated ${forecastTime(w.updatedAt, w.zone, clock24)}", fontSize = 11.sp, color = Color.White.copy(alpha = .45f)) }
        }
    }
}

@Composable
private fun WeatherMetric(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, fontSize = 11.sp, color = Color.White.copy(alpha = .55f))
        Text(value, fontSize = 17.sp)
    }
}

@Composable
private fun WeatherButton(label: String, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Surface(onClick = onClick, enabled = enabled, modifier = modifier,
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
        colors = ClickableSurfaceDefaults.colors(containerColor = Color.White.copy(alpha = .1f), focusedContainerColor = Color.White.copy(alpha = .3f))) {
        Text(label, fontSize = 14.sp, modifier = Modifier.padding(16.dp, 10.dp))
    }
}
