package com.livingroom.tv.ui

import android.text.format.DateFormat
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import com.livingroom.tv.Graph
import com.livingroom.tv.glance.Weather
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** Text over a photo needs a little lift to stay readable on bright skies. */
private val Lift = Shadow(Color.Black.copy(alpha = .55f), Offset(0f, 1.5f), 10f)

@Composable
private fun GlanceText(
    text: String,
    size: TextUnit,
    color: Color = Palette.Text,
    weight: FontWeight = FontWeight.Normal,
    modifier: Modifier = Modifier,
) {
    Text(text, modifier = modifier, color = color, style = TextStyle(fontSize = size, fontWeight = weight, shadow = Lift))
}

/** Ticks on the minute so the clock and greeting never lag. */
@Composable
private fun rememberNow(): Date {
    val now by produceState(Date()) {
        while (true) {
            value = Date()
            delay(60_000L - System.currentTimeMillis() % 60_000L + 50)
        }
    }
    return now
}

/** "Good evening, Riley". Top left, above whatever is focused. */
@Composable
fun Greeting(modifier: Modifier = Modifier) {
    val now = rememberNow()
    val name by Graph.hub.ownerName.collectAsState()
    val hour = remember(now) { Calendar.getInstance().apply { time = now }.get(Calendar.HOUR_OF_DAY) }
    val part = when (hour) {
        in 5..11 -> "Good morning"
        in 12..16 -> "Good afternoon"
        in 17..22 -> "Good evening"
        else -> "Good night"
    }
    GlanceText(
        listOfNotNull(part, name).joinToString(", "),
        size = 15.sp,
        weight = FontWeight.SemiBold,
        color = Palette.Text.copy(alpha = .92f),
        modifier = modifier,
    )
}

/** Time, date, and today's weather at home. Top right, under the buttons. */
@Composable
fun GlancePanel(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val now = rememberNow()
    val weather by Graph.weather.weather.collectAsState()
    val is24 = remember { DateFormat.is24HourFormat(context) }
    val time = remember(now) { SimpleDateFormat(if (is24) "H:mm" else "h:mm", Locale.getDefault()).format(now) }
    val ampm = remember(now) { if (is24) "" else SimpleDateFormat("a", Locale.getDefault()).format(now) }
    val date = remember(now) { SimpleDateFormat("EEEE, MMMM d", Locale.getDefault()).format(now) }

    Column(modifier, horizontalAlignment = Alignment.End) {
        Row(verticalAlignment = Alignment.Bottom) {
            GlanceText(time, 46.sp, weight = FontWeight.Light)
            if (ampm.isNotEmpty()) {
                Spacer(Modifier.width(5.dp))
                GlanceText(ampm, 15.sp, color = Palette.Text.copy(alpha = .8f), modifier = Modifier.padding(bottom = 9.dp))
            }
        }
        GlanceText(date, 13.sp, color = Palette.Text.copy(alpha = .85f), weight = FontWeight.Medium)
        weather?.let { w ->
            Spacer(Modifier.height(16.dp))
            WeatherSummary(w)
            Spacer(Modifier.height(10.dp))
            WeatherDetails(w, is24)
        }
    }
}

@Composable
private fun WeatherSummary(w: Weather) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        WeatherIcon(w.code, w.isDay, Modifier.size(34.dp))
        Spacer(Modifier.width(10.dp))
        GlanceText("${w.temp}°", 34.sp, weight = FontWeight.Light)
        Spacer(Modifier.width(12.dp))
        Column {
            GlanceText(w.condition, 13.sp, weight = FontWeight.SemiBold)
            GlanceText("H ${w.high}°   L ${w.low}°", 12.sp, color = Palette.Text.copy(alpha = .78f))
        }
    }
}

@Composable
private fun WeatherDetails(w: Weather, is24: Boolean) {
    val clock = remember(is24) { SimpleDateFormat(if (is24) "H:mm" else "h:mm a", Locale.getDefault()) }
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Detail("Wind", "${w.wind} ${w.windUnit} now · up to ${w.windMax} ${w.windUnit} today")
        Detail("Rain", "${w.rainChance}% chance today")
        Detail("Sun", "↑ ${clock.format(Date(w.sunrise))}   ↓ ${clock.format(Date(w.sunset))}")
    }
}

@Composable
private fun Detail(label: String, value: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        GlanceText(label, 11.sp, color = Palette.Text.copy(alpha = .55f), weight = FontWeight.SemiBold)
        Spacer(Modifier.width(8.dp))
        GlanceText(value, 11.5.sp, color = Palette.Text.copy(alpha = .88f))
    }
}

// ---- Weather icons, drawn rather than shipped ----------------------------------------------

private enum class Sky { Clear, Partly, Cloud, Fog, Rain, Snow, Storm }

private fun skyFor(code: Int): Sky = when (code) {
    0, 1 -> Sky.Clear
    2 -> Sky.Partly
    3 -> Sky.Cloud
    45, 48 -> Sky.Fog
    in 51..67, in 80..82 -> Sky.Rain
    in 71..77, 85, 86 -> Sky.Snow
    in 95..99 -> Sky.Storm
    else -> Sky.Cloud
}

@Composable
fun WeatherIcon(code: Int, isDay: Boolean, modifier: Modifier) {
    val sky = skyFor(code)
    Canvas(modifier) {
        val u = size.minDimension
        val sunColor = Color(0xFFFFD36B)
        val moonColor = Color(0xFFE8ECF5)
        val cloudColor = Color(0xFFEFF3F8)
        when (sky) {
            Sky.Clear -> if (isDay) sun(Offset(u * .5f, u * .5f), u * .2f, sunColor) else moon(Offset(u * .5f, u * .5f), u * .3f, moonColor)
            Sky.Partly -> {
                if (isDay) sun(Offset(u * .36f, u * .36f), u * .15f, sunColor) else moon(Offset(u * .38f, u * .36f), u * .2f, moonColor)
                cloud(Offset(u * .58f, u * .64f), u * .78f, cloudColor)
            }
            Sky.Cloud -> cloud(Offset(u * .5f, u * .56f), u, cloudColor)
            Sky.Fog -> {
                cloud(Offset(u * .5f, u * .42f), u * .86f, cloudColor.copy(alpha = .9f))
                for (i in 0..1) {
                    val y = u * (.78f + i * .12f)
                    drawLine(cloudColor.copy(alpha = .75f), Offset(u * .18f, y), Offset(u * .82f, y), u * .06f, StrokeCap.Round)
                }
            }
            Sky.Rain -> {
                cloud(Offset(u * .5f, u * .42f), u * .9f, cloudColor)
                for (i in 0..2) {
                    val x = u * (.32f + i * .18f)
                    drawLine(Color(0xFF8FC8FF), Offset(x, u * .72f), Offset(x - u * .06f, u * .92f), u * .06f, StrokeCap.Round)
                }
            }
            Sky.Snow -> {
                cloud(Offset(u * .5f, u * .42f), u * .9f, cloudColor)
                for (i in 0..2) drawCircle(Color.White, u * .045f, Offset(u * (.32f + i * .18f), u * (.8f + (i % 2) * .08f)))
            }
            Sky.Storm -> {
                cloud(Offset(u * .5f, u * .4f), u * .9f, Color(0xFFC9D1DC))
                val bolt = Path().apply {
                    moveTo(u * .54f, u * .6f); lineTo(u * .4f, u * .8f); lineTo(u * .51f, u * .8f)
                    lineTo(u * .44f, u * .98f); lineTo(u * .64f, u * .74f); lineTo(u * .53f, u * .74f); close()
                }
                drawPath(bolt, sunColor)
            }
        }
    }
}

private fun DrawScope.sun(c: Offset, r: Float, color: Color) {
    drawCircle(color, r, c)
    for (i in 0 until 8) {
        val a = Math.toRadians(i * 45.0)
        val dx = Math.cos(a).toFloat()
        val dy = Math.sin(a).toFloat()
        drawLine(color, Offset(c.x + dx * r * 1.45f, c.y + dy * r * 1.45f), Offset(c.x + dx * r * 1.9f, c.y + dy * r * 1.9f), r * .28f, StrokeCap.Round)
    }
}

private fun DrawScope.moon(c: Offset, r: Float, color: Color) {
    val full = Path().apply { addOval(Rect(c, r)) }
    val bite = Path().apply { addOval(Rect(Offset(c.x + r * .45f, c.y - r * .35f), r * .85f)) }
    drawPath(Path.combine(PathOperation.Difference, full, bite), color)
}

/** A cloud [w] wide, centered on [c]. */
private fun DrawScope.cloud(c: Offset, w: Float, color: Color) {
    val h = w * .42f
    val left = c.x - w / 2
    val bottom = c.y + h / 2
    val shape = Path().apply {
        addRoundRect(androidx.compose.ui.geometry.RoundRect(left, bottom - h * .55f, left + w, bottom, h * .28f, h * .28f))
    }
    val puffs = Path().apply {
        addOval(Rect(Offset(left + w * .34f, bottom - h * .5f), h * .42f))
        addOval(Rect(Offset(left + w * .6f, bottom - h * .62f), h * .55f))
    }
    drawPath(Path.combine(PathOperation.Union, shape, puffs), color)
}
