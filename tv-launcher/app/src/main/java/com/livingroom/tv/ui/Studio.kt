@file:OptIn(ExperimentalTvMaterial3Api::class)

package com.livingroom.tv.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import com.livingroom.tv.Graph
import com.livingroom.tv.R
import com.livingroom.tv.house.AcState
import com.livingroom.tv.house.House
import com.livingroom.tv.house.HouseAc
import com.livingroom.tv.house.HouseLight
import com.livingroom.tv.house.HouseState
import com.livingroom.tv.house.LightState
import com.livingroom.tv.house.Scene
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/**
 * The 3D studio (res/drawable-nodpi/studio_render.webp, made by tools/studio-render.py from the
 * hub's own 3D view) and where a point of the plan lands on it: the panel's camera (azimuth 22°,
 * elevation 52°), close enough to orthographic at its distance. Plan metres → fractions of the
 * picture. Render it again, and refit these, when the plan's camera or walls change.
 */
object StudioRender {
    const val ASPECT = 1100f / 960f
    private const val RX = 0.927184
    private const val RZ = -0.374607
    private const val UX = -0.295194
    private const val UY = 0.615661
    private const val UZ = -0.730631
    private const val SX = 0.094655
    private const val SY = 0.108458
    private const val CX = 0.337055
    private const val CY = 0.068469

    fun project(x: Double, y: Double, z: Double): Offset = Offset(
        (CX + SX * (x * RX + z * RZ)).toFloat(),
        (CY - SY * (x * UX + y * UY + z * UZ)).toFloat(),
    )
}

/** A light's colour as it glows: its colour, else its white temperature, warm to cool. */
fun glowOf(s: LightState?): Color {
    if (s == null) return Color(0xFFFFC98A)
    s.color?.let { hex -> runCatching { return Color(android.graphics.Color.parseColor(hex)) } }
    val t = (((s.temp ?: 2700) - 2200) / 4300f).coerceIn(0f, 1f)
    return lerp(Color(0xFFFFB36B), Color(0xFFEAF0FF), t)
}

private val CoolBlue = Color(0xFF7CC4FF)
private val HeatOrange = Color(0xFFFF9A5A)

fun acColor(a: AcState?): Color = when {
    a == null || !a.on -> Color.White.copy(alpha = .5f)
    a.mode == "heat" -> HeatOrange
    a.mode == "fan" || a.mode == "dry" -> Color(0xFFB8F0D8)
    else -> CoolBlue
}

/** The studio with a glowing spot on each light and the AC, from their state. */
@Composable
fun StudioScene(
    house: House?,
    state: HouseState,
    modifier: Modifier = Modifier,
    spot: Dp = 12.dp,
    focusedId: String? = null,
    labels: Boolean = false,
) {
    BoxWithConstraints(modifier.aspectRatio(StudioRender.ASPECT)) {
        val w = maxWidth
        val h = maxHeight
        Image(painterResource(R.drawable.studio_render), null, Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
        house?.lights?.forEach { l ->
            val s = state.lights[l.id]
            val at = StudioRender.project(l.x, l.y, l.z)
            Spot(at, w, h, spot, if (s?.on == true) glowOf(s) else null, s?.brightness ?: 1f, focusedId == l.id)
            if (labels || focusedId == l.id) SpotLabel(l.name, at, w, h, spot, focusedId == l.id)
        }
        house?.acs?.forEach { a ->
            val s = state.acs[a.id]
            val at = StudioRender.project(a.x, a.y, a.z)
            Spot(at, w, h, spot, if (s?.on == true) acColor(s) else null, 1f, focusedId == a.id)
            if (labels || focusedId == a.id) SpotLabel(a.name, at, w, h, spot, focusedId == a.id)
        }
    }
}

@Composable
private fun Spot(at: Offset, w: Dp, h: Dp, size: Dp, color: Color?, strength: Float, focused: Boolean) {
    val box = size * 4
    Box(
        Modifier.offset(w * at.x - box / 2, h * at.y - box / 2).size(box),
        contentAlignment = Alignment.Center,
    ) {
        // The glow: a soft halo in the light's own colour, stronger the brighter it is.
        if (color != null) {
            Box(Modifier.fillMaxSize().drawBehind {
                drawCircle(
                    Brush.radialGradient(
                        0f to color.copy(alpha = .55f * (.45f + .55f * strength)),
                        .45f to color.copy(alpha = .18f * (.45f + .55f * strength)),
                        1f to Color.Transparent,
                    ),
                    radius = this.size.minDimension / 2,
                )
            })
        }
        Box(
            Modifier.size(size).clip(CircleShape)
                .background(if (color != null) color.copy(alpha = .45f) else Color.White.copy(alpha = .14f))
                .then(if (focused) Modifier.background(Color.White.copy(alpha = .25f)) else Modifier),
            contentAlignment = Alignment.Center,
        ) {
            Box(Modifier.size(size * .38f).clip(CircleShape).background(
                if (color != null) lerp(color, Color.White, .65f) else Color.White.copy(alpha = .45f)
            ))
        }
        if (focused) {
            Box(Modifier.size(size + 8.dp).clip(CircleShape).drawBehind {
                drawCircle(Color.White, radius = this.size.minDimension / 2 - 1.dp.toPx(), style = androidx.compose.ui.graphics.drawscope.Stroke(2.dp.toPx()))
            })
        }
    }
}

/** The device's name just right of its spot. */
@Composable
private fun SpotLabel(name: String, at: Offset, w: Dp, h: Dp, size: Dp, focused: Boolean) {
    Text(
        name,
        fontSize = if (focused) 11.sp else 9.sp,
        color = Color.White.copy(alpha = if (focused) 1f else .8f),
        maxLines = 1,
        modifier = Modifier.offset(w * at.x + size * .9f, h * at.y - (if (focused) 10.dp else 8.dp))
            .wrapContentSize(unbounded = true)
            .clip(RoundedCornerShape(10.dp))
            .background(Color.Black.copy(alpha = if (focused) .62f else .36f))
            .padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

fun lightsLine(house: House?, state: HouseState): String {
    if (house == null) return "Connecting…"
    val on = state.lightsOn(house)
    val n = house.lights.size
    return when (on) {
        0 -> "All $n lights off"
        n -> "All $n lights on"
        else -> "$on of $n lights on"
    }
}

/** On Home: the studio in a glass tile with the AC beside it. OK opens [StudioController]. */
@Composable
fun StudioTile(modifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    val house by Graph.house.house.collectAsState()
    val state by Graph.house.state.collectAsState()
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(CardRadius)
    Surface(
        onClick = onClick,
        modifier = modifier.onFocusChanged {
            focused = it.isFocused
            if (it.isFocused) onFocus()
        },
        shape = ClickableSurfaceDefaults.shape(shape),
        colors = ClickableSurfaceDefaults.colors(containerColor = Color.Transparent, focusedContainerColor = Color.Transparent),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.03f),
        border = ClickableSurfaceDefaults.border(focusedBorder = Border(BorderStroke(2.dp, Color.White.copy(alpha = .9f)), shape = shape)),
    ) {
        Box(
            Modifier.fillMaxSize()
                .background(Brush.radialGradient(
                    0f to Color(0xFF14211E).copy(alpha = .92f), .65f to Color(0xFF0E1715).copy(alpha = .78f), 1f to Color(0xFF1D3A33).copy(alpha = .6f),
                    center = Offset.Unspecified,
                ))
                .glass(shape, strength = if (focused) 1.6f else 1f),
        ) {
            StudioScene(house, state, Modifier.align(Alignment.CenterEnd).padding(end = 6.dp).fillMaxHeight(), spot = 9.dp)
            Column(Modifier.align(Alignment.TopStart).padding(start = 18.dp, top = 16.dp)) {
                Text(house?.name ?: "Studio", fontSize = 15.sp, fontWeight = FontWeight.Normal, color = Color.White)
                Spacer(Modifier.height(2.dp))
                Text(lightsLine(house, state), fontSize = 10.sp, color = Color.White.copy(alpha = .55f))
            }
            house?.acs?.firstOrNull()?.let { ac ->
                val a = state.acs[ac.id]
                Column(Modifier.align(Alignment.BottomStart).padding(start = 18.dp, bottom = 14.dp)) {
                    Row(verticalAlignment = Alignment.Top) {
                        Text(a?.target?.toString() ?: "–", fontSize = 32.sp, fontWeight = FontWeight.ExtraLight, letterSpacing = (-1).sp, color = Color.White)
                        Text("°${ac.unit}", fontSize = 10.sp, color = Color.White.copy(alpha = .6f), modifier = Modifier.padding(top = 5.dp, start = 2.dp))
                    }
                    Text(acLine(a), fontSize = 9.5.sp, color = Color.White.copy(alpha = .55f))
                }
            }
            // The way in: a glass circle that turns solid white on focus.
            Box(
                Modifier.align(Alignment.TopEnd).padding(12.dp).size(30.dp).clip(CircleShape)
                    .background(if (focused) Color.White else Color.White.copy(alpha = .12f)),
                contentAlignment = Alignment.Center,
            ) {
                Glyph(Glyphs.Arrow, if (focused) Color(0xFF111111) else Color.White, Modifier.size(13.dp))
            }
        }
    }
}

private fun acLine(a: AcState?): String = when {
    a == null -> "AC"
    !a.on -> "AC off" + (a.roomTemp?.let { " · ${it.roundToInt()}° inside" } ?: "")
    else -> "AC · ${a.mode.replaceFirstChar { it.uppercase() }}" + (a.roomTemp?.let { " · ${it.roundToInt()}° inside" } ?: "")
}

internal fun sceneIcon(icon: String): ImageVector = when (icon) {
    "sun" -> Glyphs.Sun
    "sofa" -> Glyphs.Sofa
    "moon" -> Glyphs.Moon
    "power" -> Glyphs.Power
    "cool", "snow" -> Glyphs.Snow
    "film", "movie" -> Glyphs.Film
    else -> Glyphs.Sparkle
}

private fun modeIcon(mode: String): ImageVector = when (mode) {
    "heat" -> Glyphs.Flame
    "fan" -> Glyphs.Fan
    "dry" -> Glyphs.Drop
    "auto" -> Glyphs.Auto
    else -> Glyphs.Snow
}

/**
 * The studio, big: every light and the AC, live. Scenes along the top; OK switches a light or
 * the AC on and off, ◀ ▶ dims a light or sets the AC's temperature. Back returns to Home.
 */
@Composable
fun StudioController(onClose: () -> Unit) {
    val context = LocalContext.current
    val house by Graph.house.house.collectAsState()
    val state by Graph.house.state.collectAsState()
    val activeScene by Graph.house.scene.collectAsState()
    var focusedId by remember { mutableStateOf<String?>(null) }
    val first = remember { FocusRequester() }
    BackHandler(onBack = onClose)
    LaunchedEffect(house != null) {
        delay(80)
        runCatching { first.requestFocus() }
    }
    LaunchedEffect(Unit) {
        Graph.house.errors.collect { Toast.makeText(context, "The hub said: $it", Toast.LENGTH_SHORT).show() }
    }

    Box(Modifier.fillMaxSize()) {
        Field()
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0f to Color.Black.copy(alpha = .25f), 1f to Color.Black.copy(alpha = .55f))))

        // The studio itself, in a tall glass well on the left.
        val well = RoundedCornerShape(32.dp)
        Box(
            Modifier.padding(start = 40.dp, top = 36.dp, bottom = 36.dp).width(530.dp).fillMaxHeight()
                .background(Brush.radialGradient(0f to Color(0xFF15231F).copy(alpha = .9f), 1f to Color(0xFF0B1210).copy(alpha = .75f)), well)
                .glass(well),
        ) {
            Column(Modifier.padding(start = 26.dp, top = 22.dp)) {
                Text(house?.name ?: "Studio", fontSize = 24.sp, fontWeight = FontWeight.Light, color = Color.White)
                Spacer(Modifier.height(2.dp))
                Text(lightsLine(house, state), fontSize = 12.sp, color = Color.White.copy(alpha = .55f))
            }
            StudioScene(
                house, state,
                Modifier.align(Alignment.Center).padding(top = 44.dp, start = 8.dp, end = 8.dp, bottom = 6.dp).fillMaxWidth(),
                spot = 13.dp, focusedId = focusedId, labels = true,
            )
            Text(
                "OK switches on and off  ·  ◀ ▶ adjusts  ·  Back returns Home",
                fontSize = 10.sp, color = Color.White.copy(alpha = .4f),
                modifier = Modifier.align(Alignment.BottomStart).padding(start = 26.dp, bottom = 16.dp),
            )
        }

        // Everything you can change, on the right.
        LazyColumn(
            modifier = Modifier.align(Alignment.TopEnd).padding(top = 30.dp, end = 34.dp).width(352.dp).fillMaxHeight(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(top = 6.dp, bottom = 40.dp, start = 6.dp, end = 6.dp),
        ) {
            val h = house
            if (h == null) {
                item { Text("Connecting to the hub…", fontSize = 14.sp, color = Color.White.copy(alpha = .6f), modifier = Modifier.padding(top = 20.dp)) }
                return@LazyColumn
            }
            if (h.scenes.isNotEmpty()) {
                item(key = "scenes-label") { Label("Scenes") }
                item(key = "scenes") {
                    LazyRow(
                        modifier = Modifier.fillMaxWidth().focusRestorer(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        contentPadding = PaddingValues(vertical = 6.dp, horizontal = 2.dp),
                    ) {
                        itemsIndexed(h.scenes, key = { _, s -> s.id }) { i, scene ->
                            SceneButton(
                                scene, active = activeScene == scene.id,
                                modifier = if (i == 0) Modifier.focusRequester(first) else Modifier,
                                onFocus = { focusedId = null },
                            ) { Graph.house.applyScene(scene) }
                        }
                    }
                }
            }
            h.acs.forEach { ac ->
                val a = state.acs[ac.id]
                item(key = "ac-label-${ac.id}") { Label("Climate") }
                item(key = "ac-${ac.id}") { AcRow(ac, a, onFocus = { focusedId = ac.id }) }
                val features = state.features[ac.id]
                val modes = features?.modes?.ifEmpty { null } ?: listOf("cool", "heat", "fan", "dry", "auto")
                item(key = "ac-modes-${ac.id}") {
                    ChipRow(modes, selected = a?.mode, label = { it.replaceFirstChar { c -> c.uppercase() } }, onFocus = { focusedId = ac.id }) {
                        Graph.house.setAc(ac, org.json.JSONObject().put("mode", it))
                    }
                }
                val fans = features?.fans?.ifEmpty { null }
                if (fans != null) item(key = "ac-fans-${ac.id}") {
                    ChipRow(fans, selected = a?.fan, label = { "Fan " + it }, onFocus = { focusedId = ac.id }) {
                        Graph.house.setAc(ac, org.json.JSONObject().put("fan", it))
                    }
                }
            }
            if (h.lights.isNotEmpty()) {
                item(key = "lights-label") { Label("Lights") }
                items(h.lights, key = { "light-" + it.id }) { light ->
                    LightRow(light, state.lights[light.id], onFocus = { focusedId = light.id })
                }
            }
        }
    }
}

@Composable
private fun Label(text: String) {
    Text(text, fontSize = 12.sp, color = Color.White.copy(alpha = .55f), modifier = Modifier.padding(start = 6.dp, top = 10.dp, bottom = 2.dp))
}

@Composable
private fun SceneButton(scene: Scene, active: Boolean, modifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(62.dp)) {
        Surface(
            onClick = onClick,
            modifier = modifier.size(54.dp).onFocusChanged {
                focused = it.isFocused
                if (it.isFocused) onFocus()
            },
            shape = ClickableSurfaceDefaults.shape(CircleShape),
            colors = ClickableSurfaceDefaults.colors(
                containerColor = if (active) Color.White else Color.White.copy(alpha = .10f),
                contentColor = if (active) Color(0xFF111111) else Color.White,
                focusedContainerColor = Color.White, focusedContentColor = Color(0xFF111111),
            ),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
        ) {
            Glyph(sceneIcon(scene.icon), LocalContentColor.current, Modifier.align(Alignment.Center).size(22.dp))
        }
        Spacer(Modifier.height(6.dp))
        Text(
            scene.name, fontSize = 10.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center,
            color = Color.White.copy(alpha = if (focused || active) 1f else .6f),
        )
    }
}

/** ◀ ▶ while focused: [onStep] (false for down). The arrows go no further, so focus stays put. */
private fun Modifier.steps(onStep: (Boolean) -> Unit): Modifier = onPreviewKeyEvent {
    if (it.key != Key.DirectionLeft && it.key != Key.DirectionRight) return@onPreviewKeyEvent false
    if (it.type == KeyEventType.KeyDown) onStep(it.key == Key.DirectionRight)
    true
}

private val RowShape = RoundedCornerShape(24.dp)

@Composable
private fun DeviceRow(
    modifier: Modifier,
    onFocus: () -> Unit,
    onClick: () -> Unit,
    content: @Composable BoxScope.(focused: Boolean) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().height(60.dp).onFocusChanged {
            focused = it.isFocused
            if (it.isFocused) onFocus()
        },
        shape = ClickableSurfaceDefaults.shape(RowShape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.White.copy(alpha = .07f), contentColor = Color.White,
            focusedContainerColor = Color.White.copy(alpha = .17f), focusedContentColor = Color.White,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.03f),
        border = ClickableSurfaceDefaults.border(
            border = Border(BorderStroke(1.dp, Color.White.copy(alpha = .06f)), shape = RowShape),
            focusedBorder = Border(BorderStroke(1.5.dp, Color.White.copy(alpha = .9f)), shape = RowShape),
        ),
    ) { content(focused) }
}

@Composable
private fun LightRow(light: HouseLight, s: LightState?, onFocus: () -> Unit) {
    val on = s?.on == true
    val glow = glowOf(s)
    DeviceRow(
        modifier = Modifier.steps { up -> Graph.house.stepBrightness(light, up) },
        onFocus = onFocus,
        onClick = { Graph.house.toggle(light) },
    ) { focused ->
        Row(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(38.dp).clip(CircleShape).background(if (on) glow else Color.White.copy(alpha = .10f)),
                contentAlignment = Alignment.Center,
            ) {
                Glyph(if (light.type == "strip") Glyphs.Strip else Glyphs.Bulb, if (on) Color(0xFF1A1410) else Color.White.copy(alpha = .7f), Modifier.size(18.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(light.name, fontSize = 14.sp, fontWeight = FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOf(if (on) "On" else "Off", light.room).joinToString(" · "),
                    fontSize = 10.5.sp, color = Color.White.copy(alpha = .55f), maxLines = 1,
                )
            }
            if (on && "brightness" in light.caps) {
                if (focused) Glyph(Glyphs.Minus, Color.White.copy(alpha = .6f), Modifier.size(14.dp))
                Text(
                    "${((s?.brightness ?: 1f) * 100).roundToInt()}%",
                    fontSize = 20.sp, fontWeight = FontWeight.ExtraLight,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
                if (focused) Glyph(Glyphs.Plus, Color.White.copy(alpha = .6f), Modifier.size(14.dp))
            }
        }
        if (on) {
            // How bright, as a hairline along the bottom.
            Box(Modifier.align(Alignment.BottomStart).padding(start = 62.dp, end = 22.dp, bottom = 7.dp).fillMaxWidth().height(2.dp)
                .clip(RoundedCornerShape(1.dp)).background(Color.White.copy(alpha = .12f))) {
                Box(Modifier.fillMaxWidth(s?.brightness ?: 1f).fillMaxHeight().background(glow.copy(alpha = .9f)))
            }
        }
    }
}

@Composable
private fun AcRow(ac: HouseAc, a: AcState?, onFocus: () -> Unit) {
    val on = a?.on == true
    DeviceRow(
        modifier = Modifier.steps { up -> Graph.house.stepAc(ac, up) },
        onFocus = onFocus,
        onClick = { Graph.house.toggleAc(ac) },
    ) { focused ->
        Row(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.size(38.dp).clip(CircleShape).background(if (on) acColor(a) else Color.White.copy(alpha = .10f)),
                contentAlignment = Alignment.Center,
            ) {
                Glyph(modeIcon(a?.mode ?: "cool"), if (on) Color(0xFF0F1418) else Color.White.copy(alpha = .7f), Modifier.size(18.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(ac.name, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(
                        if (on) a?.mode?.replaceFirstChar { it.uppercase() } else "Off",
                        a?.roomTemp?.let { "${it.roundToInt()}° inside" },
                    ).joinToString(" · "),
                    fontSize = 10.5.sp, color = Color.White.copy(alpha = .55f), maxLines = 1,
                )
            }
            if (focused) Glyph(Glyphs.Minus, Color.White.copy(alpha = .6f), Modifier.size(14.dp))
            Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.Top) {
                Text(a?.target?.toString() ?: "–", fontSize = 26.sp, fontWeight = FontWeight.ExtraLight, color = Color.White.copy(alpha = if (on) 1f else .5f))
                Text("°${ac.unit}", fontSize = 9.sp, color = Color.White.copy(alpha = .55f), modifier = Modifier.padding(top = 4.dp))
            }
            if (focused) Glyph(Glyphs.Plus, Color.White.copy(alpha = .6f), Modifier.size(14.dp))
        }
    }
}

@Composable
private fun ChipRow(options: List<String>, selected: String?, label: (String) -> String, onFocus: () -> Unit, onPick: (String) -> Unit) {
    LazyRow(
        modifier = Modifier.fillMaxWidth().focusRestorer(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        contentPadding = PaddingValues(vertical = 4.dp, horizontal = 2.dp),
    ) {
        items(options, key = { it }) { o ->
            val on = o == selected
            Surface(
                onClick = { onPick(o) },
                modifier = Modifier.height(34.dp).onFocusChanged { if (it.isFocused) onFocus() },
                shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
                colors = ClickableSurfaceDefaults.colors(
                    containerColor = if (on) Color.White else Color.White.copy(alpha = .09f),
                    contentColor = if (on) Color(0xFF111111) else Color.White.copy(alpha = .85f),
                    focusedContainerColor = if (on) Color.White else Color.White.copy(alpha = .22f),
                    focusedContentColor = if (on) Color(0xFF111111) else Color.White,
                ),
                border = ClickableSurfaceDefaults.border(focusedBorder = Border(BorderStroke(1.5.dp, Color.White), shape = RoundedCornerShape(50))),
                scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
            ) {
                Text(label(o), fontSize = 12.sp, modifier = Modifier.align(Alignment.Center).padding(horizontal = 16.dp))
            }
        }
    }
}
