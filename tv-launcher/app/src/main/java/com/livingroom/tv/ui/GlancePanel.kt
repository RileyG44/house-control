package com.livingroom.tv.ui

import android.text.format.DateFormat
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import com.livingroom.tv.Graph
import com.livingroom.tv.companion.Commands
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

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

/** "Good evening, Riley", the time in thin numerals, and the date. Top left of Home. */
@Composable
@OptIn(ExperimentalTvMaterial3Api::class)
fun HelloBlock(modifier: Modifier = Modifier, onSettingsFocus: () -> Unit = {}) {
    val context = LocalContext.current
    val now = rememberNow()
    val name by Graph.hub.ownerName.collectAsState()
    val is24 = remember { DateFormat.is24HourFormat(context) }
    val hour = remember(now) { Calendar.getInstance().apply { time = now }.get(Calendar.HOUR_OF_DAY) }
    val part = when (hour) {
        in 5..11 -> "Good morning"
        in 12..16 -> "Good afternoon"
        in 17..22 -> "Good evening"
        else -> "Good night"
    }
    val time = remember(now) { SimpleDateFormat(if (is24) "H:mm" else "h:mm", Locale.getDefault()).format(now) }
    val ampm = remember(now) { if (is24) "" else SimpleDateFormat("a", Locale.getDefault()).format(now) }
    val date = remember(now) { SimpleDateFormat("EEEE, MMMM d", Locale.getDefault()).format(now) }
    Column(modifier) {
        Text(listOfNotNull(part, name).joinToString(", "), fontSize = 18.sp, fontWeight = FontWeight.Light, color = Color.White.copy(alpha = .72f))
        Row(verticalAlignment = Alignment.Top) {
            Text(time, fontSize = 116.sp, lineHeight = 112.sp, fontWeight = FontWeight.ExtraLight, letterSpacing = (-4).sp, color = Color.White)
            if (ampm.isNotEmpty()) {
                Text(ampm, fontSize = 17.sp, fontWeight = FontWeight.Light, color = Color.White.copy(alpha = .6f), modifier = Modifier.padding(start = 6.dp, top = 22.dp))
            }
        }
        Row(Modifier.width(316.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(date, fontSize = 14.sp, fontWeight = FontWeight.Light, color = Color.White.copy(alpha = .58f),
                maxLines = 1, modifier = Modifier.weight(1f))
            Surface(
                onClick = { Commands.settings(context) },
                modifier = Modifier.onFocusChanged { if (it.isFocused) onSettingsFocus() }
                    .semantics { contentDescription = "Chromecast Settings" },
                shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
                colors = ClickableSurfaceDefaults.colors(containerColor = Color.White.copy(alpha = .09f), focusedContainerColor = Color.White.copy(alpha = .25f)),
            ) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                    Glyph(Glyphs.Gear, LocalContentColor.current, Modifier.size(14.dp))
                    Spacer(Modifier.width(6.dp))
                    Text("Settings", fontSize = 12.sp)
                }
            }
        }
    }
}

/** Today's essentials; OK opens the full forecast without leaving the launcher. */
@OptIn(ExperimentalTvMaterial3Api::class)
@Composable
fun WeatherCard(modifier: Modifier = Modifier, onFocus: () -> Unit = {}, onClick: () -> Unit = {}) {
    val weather by Graph.weather.weather.collectAsState()
    val now = rememberNow()
    val clock24 = DateFormat.is24HourFormat(LocalContext.current)
    val shape = RoundedCornerShape(CardRadius)
    Surface(onClick = onClick, modifier = modifier.onFocusChanged { if (it.isFocused) onFocus() }.glass(shape),
        shape = ClickableSurfaceDefaults.shape(shape),
        colors = ClickableSurfaceDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.White.copy(alpha = .06f)),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.025f),
        border = ClickableSurfaceDefaults.border(focusedBorder = Border(BorderStroke(1.dp, Color.White.copy(alpha = .85f)), shape = shape))) {
        val w = weather
        Column(Modifier.padding(start = 18.dp, top = 14.dp, end = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(w?.place ?: "Weather", fontSize = 11.sp, color = Color.White.copy(alpha = .55f), maxLines = 1, modifier = Modifier.weight(1f))
                if (w != null) WeatherIcon(w.code, w.isDay, Modifier.size(18.dp))
            }
            if (w == null) {
                Spacer(Modifier.height(24.dp))
                Text("–", fontSize = 48.sp, fontWeight = FontWeight.ExtraLight, color = Color.White.copy(alpha = .5f))
                Text("Open forecast", fontSize = 11.sp)
                return@Column
            }
            Spacer(Modifier.height(3.dp))
            Row(verticalAlignment = Alignment.Top) {
                Text("${w.temp}", fontSize = 48.sp, lineHeight = 48.sp, fontWeight = FontWeight.ExtraLight, letterSpacing = (-2).sp, color = Color.White)
                Text("°" + if (w.imperial) "F" else "C", fontSize = 12.sp, color = Color.White.copy(alpha = .6f), modifier = Modifier.padding(top = 6.dp, start = 2.dp))
            }
            Text(w.condition, fontSize = 12.sp, lineHeight = 14.sp, color = Color.White)
            Text("High ${w.high ?: "—"}° · Low ${w.low ?: "—"}°", fontSize = 10.sp, lineHeight = 13.sp, color = Color.White.copy(alpha = .6f))
            Text("High wind ${w.windMax ?: "—"} ${w.windUnit}", fontSize = 10.sp, lineHeight = 13.sp, color = Color.White.copy(alpha = .7f))
            Text("Sunrise ${forecastTime(w.sunrise, w.zone, clock24)}", fontSize = 10.sp, lineHeight = 13.sp, color = Color.White.copy(alpha = .7f))
            Text("Sunset ${forecastTime(w.sunset, w.zone, clock24)}", fontSize = 10.sp, lineHeight = 13.sp, color = Color.White.copy(alpha = .7f))
        }
        weather?.let { w ->
            val hours = w.hours(w.today)
            if (hours.size >= 2) {
                val index = hours.indexOfLast { it.at <= now.time }.coerceAtLeast(0)
                val cursor = index + (now.time - hours[index].at) / 3600_000f
                Sparkline(hours.map { it.temp }, cursor, Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(24.dp).padding(start = 18.dp, end = 18.dp, bottom = 8.dp))
            }
        }
    }
}

/** A thin line through the day's temperatures, a solid dot at now and a ring at the high. */
@Composable
private fun Sparkline(temps: List<Float?>, hour: Float, modifier: Modifier) {
    Canvas(modifier) {
        val values = temps.filterNotNull()
        if (values.isEmpty()) return@Canvas
        val lo = values.min()
        val hi = values.max()
        val span = (hi - lo).coerceAtLeast(1f)
        fun at(i: Float, t: Float) = Offset(size.width * i / (temps.size - 1), size.height - 3.dp.toPx() - (t - lo) / span * (size.height - 8.dp.toPx()))
        val path = Path()
        temps.forEachIndexed { i, t ->
            if (t == null) return@forEachIndexed
            val p = at(i.toFloat(), t)
            val previous = temps.getOrNull(i - 1)
            if (previous == null) path.moveTo(p.x, p.y) else {
                val q = at(i - 1f, previous)
                val mx = (q.x + p.x) / 2
                path.cubicTo(mx, q.y, mx, p.y, p.x, p.y)
            }
        }
        drawPath(path, Color.White.copy(alpha = .45f), style = Stroke(1.2.dp.toPx(), cap = StrokeCap.Round))
        val hiAt = temps.indexOf(hi)
        drawCircle(Color.White, 2.6.dp.toPx(), at(hiAt.toFloat(), hi), style = Stroke(1.2.dp.toPx()))
        val i = hour.coerceIn(0f, temps.size - 1f)
        val left = temps[i.toInt()]
        val right = temps[minOf(i.toInt() + 1, temps.size - 1)]
        if (left != null && right != null) drawCircle(Color.White, 3.6.dp.toPx(), at(i, left + (right - left) * (i - i.toInt())))
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
