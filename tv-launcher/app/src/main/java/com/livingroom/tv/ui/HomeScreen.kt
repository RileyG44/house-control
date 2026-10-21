@file:OptIn(ExperimentalTvMaterial3Api::class, ExperimentalComposeUiApi::class)

package com.livingroom.tv.ui

import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
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
import com.livingroom.tv.apps.TvApp
import com.livingroom.tv.companion.FocusInfo
import com.livingroom.tv.history.HistoryStore
import com.livingroom.tv.history.WatchEntry
import kotlinx.coroutines.delay

sealed interface Focus {
    data class Title(val entry: WatchEntry) : Focus
    data class App(val app: TvApp) : Focus
    data object Other : Focus
}

private enum class Overlay { AllApps, Pair }

private val CardShape = RoundedCornerShape(8.dp)
private val TileShape = RoundedCornerShape(7.dp)

@Composable
fun HomeRoot() {
    val pinned by Graph.apps.pinned.collectAsState()
    val allApps by Graph.apps.all.collectAsState()
    val entries by Graph.history.entries.collectAsState()
    val continueItems = remember(entries) { HistoryStore.continueList(entries) }
    var overlay by remember { mutableStateOf<Overlay?>(null) }
    var focus by remember { mutableStateOf<Focus>(Focus.Other) }

    // Keep the focused title's progress live as history updates.
    val liveFocus = (focus as? Focus.Title)?.let { f ->
        entries.firstOrNull { it.id == f.entry.id }?.let { Focus.Title(it) }
    } ?: focus

    LaunchedEffect(liveFocus) { Graph.hub.focus.value = liveFocus.toInfo() }
    BackHandler(enabled = overlay != null) { overlay = null }

    val wallpaper by Graph.wallpaper.image.collectAsState()
    Box(Modifier.fillMaxSize().background(Palette.Bg)) {
        // A chosen wallpaper is the backdrop; without one, the focused title's art is.
        if (wallpaper != null) Wallpaper(wallpaper!!) else Backdrop(liveFocus)
        when (overlay) {
            null -> HomeContent(
                continueItems = continueItems,
                pinned = pinned,
                entries = entries,
                focus = liveFocus,
                onFocus = { focus = it },
                onOverlay = { overlay = it },
            )
            Overlay.AllApps -> AllAppsOverlay(allApps)
            Overlay.Pair -> PairOverlay(onClose = { overlay = null })
        }
    }
}

@Composable
private fun HomeContent(
    continueItems: List<WatchEntry>,
    pinned: List<TvApp>,
    entries: List<WatchEntry>,
    focus: Focus,
    onFocus: (Focus) -> Unit,
    onOverlay: (Overlay) -> Unit,
) {
    val context = LocalContext.current
    val first = remember { FocusRequester() }
    val ready = continueItems.isNotEmpty() || pinned.isNotEmpty()
    LaunchedEffect(ready) {
        if (ready) {
            delay(80)
            runCatching { first.requestFocus() }
        }
    }

    Box(Modifier.fillMaxSize()) {
        Scrims()
        TopBar(
            modifier = Modifier.align(Alignment.TopEnd),
            onFocus = { onFocus(Focus.Other) },
            onSearch = { openSearch(context) },
            onPair = { onOverlay(Overlay.Pair) },
            onSettings = { context.startSafely(Intent(Settings.ACTION_SETTINGS)) },
        )
        Greeting(Modifier.align(Alignment.TopStart).padding(start = 60.dp, top = 28.dp))
        GlancePanel(Modifier.align(Alignment.TopEnd).padding(top = 62.dp, end = 50.dp))
        Hero(focus, entries, Modifier.align(Alignment.TopStart))

        Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(bottom = 18.dp)) {
            if (continueItems.isNotEmpty()) {
                RowLabel("Continue")
                LazyRow(
                    modifier = Modifier.fillMaxWidth().focusRestorer(),
                    contentPadding = PaddingValues(horizontal = 48.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.spacedBy(15.dp),
                ) {
                    itemsIndexed(continueItems, key = { _, e -> e.id }) { i, e ->
                        ContinueCard(
                            entry = e,
                            modifier = (if (i == 0) Modifier.focusRequester(first) else Modifier)
                                .rowEdges(first = i == 0, last = i == continueItems.lastIndex),
                            onFocus = { onFocus(Focus.Title(e)) },
                            onClick = { Graph.apps.launch(e.pkg) },
                            onLongClick = {
                                Graph.history.remove(e.id)
                                Toast.makeText(context, "Removed from Continue", Toast.LENGTH_SHORT).show()
                            },
                        )
                    }
                }
                Spacer(Modifier.height(4.dp))
            }
            LazyRow(
                modifier = Modifier.fillMaxWidth().focusRestorer(),
                contentPadding = PaddingValues(horizontal = 48.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(11.dp),
            ) {
                itemsIndexed(pinned, key = { _, a -> a.pkg }) { i, app ->
                    AppTile(
                        app = app,
                        modifier = (if (continueItems.isEmpty() && i == 0) Modifier.focusRequester(first) else Modifier)
                            .rowEdges(first = i == 0, last = false),
                        onFocus = { onFocus(Focus.App(app)) },
                        onClick = { Graph.apps.launch(app.pkg) },
                    )
                }
                item(key = "all-apps") {
                    IconTile(
                        Glyphs.Grid,
                        modifier = Modifier.rowEdges(first = pinned.isEmpty(), last = true),
                        onFocus = { onFocus(Focus.Other) },
                        onClick = { onOverlay(Overlay.AllApps) },
                    )
                }
            }
        }
    }
}

@Composable
private fun Scrims() {
    Box(
        Modifier.fillMaxSize().background(
            Brush.horizontalGradient(
                0f to Palette.Bg.copy(alpha = .93f), .30f to Palette.Bg.copy(alpha = .74f),
                .58f to Palette.Bg.copy(alpha = .2f), .80f to Color.Transparent,
            )
        )
    )
    Box(
        Modifier.fillMaxSize().background(
            Brush.verticalGradient(
                .34f to Color.Transparent, .52f to Palette.Bg.copy(alpha = .45f),
                .72f to Palette.Bg.copy(alpha = .94f), 1f to Palette.Bg,
            )
        )
    )
    // Keeps the clock and weather readable over a bright photo.
    Box(
        Modifier.fillMaxSize().drawBehind {
            drawRect(
                Brush.radialGradient(
                    0f to Palette.Bg.copy(alpha = .55f), .6f to Palette.Bg.copy(alpha = .2f), 1f to Color.Transparent,
                    center = Offset(size.width * .9f, size.height * .2f),
                    radius = size.width * .4f,
                )
            )
        }
    )
}

@Composable
private fun Wallpaper(bitmap: android.graphics.Bitmap) {
    val image = remember(bitmap) { bitmap.asImageBitmap() }
    Image(image, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
}

private fun Focus.backdropKey(): String = when (this) {
    is Focus.Title -> "t:" + entry.id
    is Focus.App -> "a:" + app.pkg
    Focus.Other -> "none"
}

/** Full-bleed art of the focused title, or the focused app's brand glow. Crossfades on focus moves. */
@Composable
private fun Backdrop(focus: Focus) {
    Crossfade(targetState = focus.backdropKey(), animationSpec = tween(450), label = "backdrop") { key ->
        when {
            key.startsWith("t:") -> {
                val entry = Graph.history.entries.value.firstOrNull { it.id == key.removePrefix("t:") }
                val art = historyArt(entry, 1280)
                if (art != null) {
                    Image(
                        bitmap = art,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        alignment = BiasAlignment(0.6f, -0.3f),
                        modifier = Modifier.fillMaxSize().then(if (art.width < 1000) Modifier.blur(8.dp) else Modifier),
                    )
                } else {
                    AppGlow(Graph.apps.find(entry?.pkg)?.color)
                }
            }
            key.startsWith("a:") -> AppGlow(Graph.apps.find(key.removePrefix("a:"))?.color)
            else -> Box(Modifier.fillMaxSize())
        }
    }
}

@Composable
private fun AppGlow(color: Int?) {
    val c = Color(color ?: 0xFF2A3A4A.toInt())
    Box(
        Modifier.fillMaxSize().drawBehind {
            drawRect(
                Brush.radialGradient(
                    0f to c.copy(alpha = .40f), .45f to c.copy(alpha = .13f), 1f to Color.Transparent,
                    center = Offset(size.width * .78f, size.height * .3f),
                    radius = size.width * .62f,
                )
            )
        }
    )
}

@Composable
private fun Hero(focus: Focus, entries: List<WatchEntry>, modifier: Modifier) {
    Box(modifier.padding(start = 60.dp, top = 66.dp).width(540.dp)) {
        when (focus) {
            is Focus.Title -> TitleHero(focus.entry)
            is Focus.App -> AppHero(focus.app, entries.filter { it.pkg == focus.app.pkg }.take(3))
            Focus.Other -> Unit
        }
    }
}

@Composable
private fun TitleHero(entry: WatchEntry) {
    val app = Graph.apps.label(entry.pkg).orEmpty()
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(app, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Palette.Text.copy(alpha = .9f))
            Text("  ·  Continue", fontSize = 12.sp, color = Palette.Secondary)
        }
        Spacer(Modifier.height(12.dp))
        Text(
            entry.title,
            fontSize = if (entry.title.length > 26) 32.sp else 46.sp,
            lineHeight = if (entry.title.length > 26) 36.sp else 48.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = (-0.4).sp,
            color = Color.White,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        entry.subtitle?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = Palette.Text.copy(alpha = .88f), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (entry.progress >= 0f) {
            Spacer(Modifier.height(16.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                ProgressBar(entry.progress, Modifier.width(110.dp))
                Spacer(Modifier.width(10.dp))
                Text(remainingText(entry.remainingMin), fontSize = 11.sp, color = Palette.Secondary)
            }
        }
    }
}

@Composable
private fun AppHero(app: TvApp, items: List<WatchEntry>) {
    val banner = remember(app.banner) { app.banner?.asImageBitmap() }
    Column {
        if (banner != null) {
            Image(banner, app.label, Modifier.size(128.dp, 72.dp).clip(RoundedCornerShape(9.dp)), contentScale = ContentScale.Crop)
        } else {
            Text(app.label, fontSize = 40.sp, fontWeight = FontWeight.Bold, color = Color.White)
        }
        Spacer(Modifier.height(14.dp))
        if (items.isEmpty()) {
            Text("Press OK to open ${app.label}", fontSize = 13.sp, color = Palette.Secondary)
        } else {
            Text("Waiting for you in ${app.label}", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = Palette.Text.copy(alpha = .7f))
            Spacer(Modifier.height(9.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(11.dp)) { items.forEach { MiniCard(it) } }
            Spacer(Modifier.height(10.dp))
            Text("OK opens ${app.label}", fontSize = 10.5.sp, color = Palette.Secondary)
        }
    }
}

@Composable
private fun MiniCard(entry: WatchEntry) {
    val art = historyArt(entry, 320)
    Column(Modifier.width(118.dp)) {
        Box(Modifier.size(118.dp, 66.dp).clip(RoundedCornerShape(6.dp)).background(Palette.Card)) {
            if (art != null) Image(art, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            if (entry.progress >= 0f) ProgressBar(entry.progress, Modifier.align(Alignment.BottomStart).fillMaxWidth(), height = 2.dp, rounded = false)
        }
        Spacer(Modifier.height(5.dp))
        Text(entry.title, fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val sub = if (entry.remainingMin >= 0) remainingText(entry.remainingMin) else entry.subtitle.orEmpty()
        Text(sub, fontSize = 9.sp, color = Palette.Secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun RowLabel(text: String) {
    Text(text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Palette.Secondary, modifier = Modifier.padding(start = 50.dp))
}

@Composable
private fun ContinueCard(
    entry: WatchEntry,
    modifier: Modifier,
    onFocus: () -> Unit,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val art = historyArt(entry, 480)
    val app = Graph.apps.find(entry.pkg)
    Surface(
        onClick = onClick,
        onLongClick = onLongClick,
        modifier = modifier.size(192.dp, 108.dp).onFocusChanged {
            focused = it.isFocused || it.hasFocus
            if (focused) onFocus()
        },
        shape = ClickableSurfaceDefaults.shape(CardShape),
        colors = ClickableSurfaceDefaults.colors(containerColor = Palette.Card, focusedContainerColor = Palette.Card),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
        border = ClickableSurfaceDefaults.border(focusedBorder = Border(BorderStroke(2.dp, Color.White), shape = CardShape)),
    ) {
        if (art != null) Image(art, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        else BannerFill(app)
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(.35f to Color.Transparent, 1f to Color.Black.copy(alpha = .8f))))
        Column(Modifier.align(Alignment.BottomStart).padding(start = 10.dp, end = 10.dp, bottom = 10.dp)) {
            Text(entry.title, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                listOfNotNull(app?.label, entry.subtitle).joinToString(" · "),
                fontSize = 8.sp, color = Color.White.copy(alpha = .72f), maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        if (entry.progress >= 0f) ProgressBar(entry.progress, Modifier.align(Alignment.BottomStart).fillMaxWidth(), height = 2.5.dp, rounded = false)
        if (!focused) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .18f)))
    }
}

@Composable
private fun BannerFill(app: TvApp?) {
    val banner = remember(app?.banner) { app?.banner?.asImageBitmap() }
    Box(Modifier.fillMaxSize().background(Color(app?.color ?: 0xFF2A3A4A.toInt()).copy(alpha = .35f)), contentAlignment = Alignment.Center) {
        if (banner != null) Image(banner, null, Modifier.size(112.dp, 63.dp).clip(RoundedCornerShape(6.dp)))
    }
}

@Composable
fun AppTile(
    app: TvApp,
    modifier: Modifier = Modifier,
    width: Dp = 98.dp,
    pinnedBadge: Boolean = false,
    onFocus: () -> Unit = {},
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
) {
    val banner = remember(app.banner) { app.banner?.asImageBitmap() }
    Surface(
        onClick = onClick,
        onLongClick = onLongClick,
        modifier = modifier.size(width, width * 9 / 16).onFocusChanged { if (it.isFocused) onFocus() },
        shape = ClickableSurfaceDefaults.shape(TileShape),
        colors = ClickableSurfaceDefaults.colors(containerColor = Palette.Card, focusedContainerColor = Palette.Card),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.12f),
        border = ClickableSurfaceDefaults.border(
            border = Border(BorderStroke(0.5.dp, Color.White.copy(alpha = .08f)), shape = TileShape),
            focusedBorder = Border(BorderStroke(2.dp, Color.White), shape = TileShape),
        ),
    ) {
        if (banner != null) {
            Image(banner, app.label, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            Text(app.label, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = Color.White, modifier = Modifier.align(Alignment.Center))
        }
        if (pinnedBadge) {
            Glyph(Glyphs.Pin, Color.White, Modifier.align(Alignment.TopEnd).padding(5.dp).size(10.dp))
        }
    }
}

@Composable
private fun IconTile(icon: androidx.compose.ui.graphics.vector.ImageVector, modifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = modifier.size(55.dp).onFocusChanged { if (it.isFocused) onFocus() },
        shape = ClickableSurfaceDefaults.shape(TileShape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.White.copy(alpha = .07f), contentColor = Palette.Secondary,
            focusedContainerColor = Color.White, focusedContentColor = Color.Black,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.12f),
    ) {
        Glyph(icon, LocalContentColor.current, Modifier.align(Alignment.Center).size(17.dp))
    }
}

@Composable
private fun TopBar(
    modifier: Modifier,
    onFocus: () -> Unit,
    onSearch: () -> Unit,
    onPair: () -> Unit,
    onSettings: () -> Unit,
) {
    Row(
        modifier.padding(top = 24.dp, end = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        TopButton(Glyphs.Search, onSearch, onFocus)
        TopButton(Glyphs.Phone, onPair, onFocus)
        TopButton(Glyphs.Gear, onSettings, onFocus)
    }
}

@Composable
private fun TopButton(icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit, onFocus: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = Modifier.size(28.dp).onFocusChanged { if (it.isFocused) onFocus() },
        shape = ClickableSurfaceDefaults.shape(CircleShape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.White.copy(alpha = .06f), contentColor = Palette.Secondary,
            focusedContainerColor = Color.White, focusedContentColor = Color.Black,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.15f),
    ) {
        Glyph(icon, LocalContentColor.current, Modifier.align(Alignment.Center).size(14.dp))
    }
}

@Composable
fun ProgressBar(progress: Float, modifier: Modifier, height: Dp = 2.dp, rounded: Boolean = true) {
    val shape = if (rounded) RoundedCornerShape(50) else RoundedCornerShape(0)
    Box(modifier.height(height).clip(shape).background(Color.White.copy(alpha = .25f))) {
        Box(Modifier.fillMaxWidth(progress.coerceIn(0f, 1f)).fillMaxHeight().background(Color.White))
    }
}

fun remainingText(min: Int): String = when {
    min < 0 -> ""
    min == 0 -> "Almost done"
    min < 60 -> "$min min left"
    else -> "${min / 60} h ${min % 60} m left"
}

/** Left on the first item and Right on the last stay put, so focus never jumps to the top bar. */
private fun Modifier.rowEdges(first: Boolean, last: Boolean): Modifier = onPreviewKeyEvent {
    it.type == KeyEventType.KeyDown && ((first && it.key == Key.DirectionLeft) || (last && it.key == Key.DirectionRight))
}

private fun Focus.toInfo(): FocusInfo? = when (this) {
    is Focus.Title -> FocusInfo("continue", entry.title, entry.subtitle, entry.pkg, entry.progress, entry.remainingMin, entry.id)
    is Focus.App -> FocusInfo("app", app.label, null, app.pkg, -1f, -1, null)
    Focus.Other -> null
}

private fun openSearch(context: Context) {
    val global = Intent("android.search.action.GLOBAL_SEARCH")
    if (!context.startSafely(global)) context.startSafely(Intent(Intent.ACTION_ASSIST))
}

fun Context.startSafely(intent: Intent): Boolean =
    runCatching { startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
