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
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
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
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
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
import com.livingroom.tv.catalog.CatalogTile
import com.livingroom.tv.companion.FocusInfo
import com.livingroom.tv.history.HistoryStore
import com.livingroom.tv.history.WatchEntry
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

sealed interface Focus {
    data class Title(val entry: WatchEntry) : Focus
    data class App(val app: TvApp) : Focus
    /** A title in the Fresh row or one of the catalog's rows ([row] is the row's name). */
    data class Tile(val tile: CatalogTile, val row: String) : Focus
    data object Other : Focus
}

private enum class Overlay { AllApps, Pair, Studio }

private val CardShape = RoundedCornerShape(CardRadius)
private val TileShape = RoundedCornerShape(16.dp)

@Composable
fun HomeRoot() {
    val pinned by Graph.apps.pinned.collectAsState()
    val allApps by Graph.apps.all.collectAsState()
    val entries by Graph.history.entries.collectAsState()
    // What's being watched leads Fresh today: the three most recent, past the first few minutes.
    val continueItems = remember(entries) { HistoryStore.continueList(entries).filter { it.progress < 0f || it.progress >= .03f }.take(3) }
    var overlay by remember { mutableStateOf<Overlay?>(null) }
    var focus by remember { mutableStateOf<Focus>(Focus.Other) }
    val catalog by Graph.catalog.catalog.collectAsState()
    val hiddenTitles by Graph.catalog.hidden.collectAsState()
    val fresh = remember(catalog, hiddenTitles) { freshPicks(catalog, hiddenTitles) }
    val shelves = remember(catalog, hiddenTitles) { shelvesOf(catalog, hiddenTitles) }
    // Hold OK on a poster: its menu, and the poster to come back to when it closes.
    var menuFor by remember { mutableStateOf<CatalogTile?>(null) }
    var lastPoster by remember { mutableStateOf<FocusRequester?>(null) }
    val studio = remember { FocusRequester() }
    var backToStudio by remember { mutableStateOf(false) }

    // Keep the focused title's progress live as history updates.
    val liveFocus = (focus as? Focus.Title)?.let { f ->
        entries.firstOrNull { it.id == f.entry.id }?.let { Focus.Title(it) }
    } ?: focus

    LaunchedEffect(liveFocus) { Graph.hub.focus.value = liveFocus.toInfo() }
    BackHandler(enabled = overlay != null && overlay != Overlay.Studio) { overlay = null }
    LaunchedEffect(menuFor) {
        if (menuFor == null) lastPoster?.let { delay(80); runCatching { it.requestFocus() } }
    }
    LaunchedEffect(overlay, backToStudio) {
        if (overlay == null && backToStudio) {
            delay(80)
            runCatching { studio.requestFocus() }
            backToStudio = false
        }
    }

    Box(Modifier.fillMaxSize().background(Palette.Bg)) {
        Field()
        when (overlay) {
            null -> HomeContent(
                continueItems = continueItems,
                fresh = fresh,
                pinned = pinned,
                shelves = shelves,
                studio = studio,
                focusFirst = !backToStudio,
                onFocus = { focus = it },
                onPoster = { lastPoster = it },
                onMenu = { menuFor = it },
                onOverlay = { overlay = it },
            )
            Overlay.AllApps -> AllAppsOverlay(allApps)
            Overlay.Pair -> PairOverlay(onClose = { overlay = null })
            Overlay.Studio -> StudioController(onClose = { overlay = null; backToStudio = true })
        }
        menuFor?.let { TileMenu(it, onClose = { menuFor = null }) }
    }
}

/** Scrolls only as far as needed to show what has focus (no pivot), so the top stays put. */
@OptIn(ExperimentalFoundationApi::class)
private object JustEnough : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val end = offset + size
        return when {
            offset >= 0 && end <= containerSize -> 0f
            offset < 0 && end > containerSize -> 0f
            kotlin.math.abs(offset) < kotlin.math.abs(end - containerSize) -> offset
            else -> end - containerSize
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeContent(
    continueItems: List<WatchEntry>,
    fresh: List<CatalogTile>,
    pinned: List<TvApp>,
    shelves: List<Shelf>,
    studio: FocusRequester,
    /** False when coming back from the studio, whose tile takes the focus again instead. */
    focusFirst: Boolean,
    onFocus: (Focus) -> Unit,
    onPoster: (FocusRequester) -> Unit,
    onMenu: (CatalogTile) -> Unit,
    onOverlay: (Overlay) -> Unit,
) {
    val context = LocalContext.current
    val first = remember { FocusRequester() }
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val hasFresh = continueItems.isNotEmpty() || fresh.isNotEmpty()
    val ready = hasFresh || pinned.isNotEmpty()
    LaunchedEffect(ready) {
        if (ready && focusFirst) {
            delay(80)
            runCatching { first.requestFocus() }
        }
    }
    // Back at the top rows, the greeting, clock and studio come back into view.
    val toTop: () -> Unit = { if (list.firstVisibleItemIndex != 0 || list.firstVisibleItemScrollOffset != 0) scope.launch { list.animateScrollToItem(0) } }

    CompositionLocalProvider(LocalBringIntoViewSpec provides JustEnough) {
        LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
            item(key = "top") {
                Box(Modifier.fillMaxWidth().height(250.dp)) {
                    HelloBlock(Modifier.padding(start = 48.dp, top = 34.dp))
                    WeatherCard(Modifier.padding(start = 380.dp, top = 36.dp).size(170.dp, 200.dp))
                    StudioTile(
                        modifier = Modifier.padding(start = 562.dp, top = 36.dp).size(350.dp, 200.dp).focusRequester(studio),
                        onFocus = { onFocus(Focus.Other); toTop() },
                        onClick = { onOverlay(Overlay.Studio) },
                    )
                }
            }
            if (hasFresh) item(key = "fresh") { Column {
                Text("Fresh today", fontSize = 13.sp, color = Color.White.copy(alpha = .85f), modifier = Modifier.padding(start = 48.dp, top = 4.dp))
                // What's being watched can arrive after the picks: the row starts at its start again then.
                val freshRow = rememberLazyListState()
                LaunchedEffect(continueItems.firstOrNull()?.id, fresh.firstOrNull()?.id) {
                    if (freshRow.firstVisibleItemIndex != 0) freshRow.scrollToItem(0)
                }
                LazyRow(
                    state = freshRow,
                    modifier = Modifier.fillMaxWidth().focusRestorer(),
                    contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = 14.dp),
                    horizontalArrangement = Arrangement.spacedBy(13.dp),
                ) {
                    itemsIndexed(continueItems, key = { _, e -> "h:" + e.id }) { i, e ->
                        ContinueCard(
                            entry = e,
                            modifier = (if (i == 0) Modifier.focusRequester(first) else Modifier)
                                .rowEdges(first = i == 0, last = fresh.isEmpty() && i == continueItems.lastIndex),
                            onFocus = { onFocus(Focus.Title(e)); toTop() },
                            onClick = { Graph.apps.launch(e.pkg) },
                            onLongClick = {
                                Graph.history.remove(e.id)
                                Toast.makeText(context, "Removed from Fresh today", Toast.LENGTH_SHORT).show()
                            },
                        )
                    }
                    itemsIndexed(fresh, key = { _, t -> "c:" + t.id }) { i, t ->
                        PosterTile(
                            tile = t,
                            modifier = (if (continueItems.isEmpty() && i == 0) Modifier.focusRequester(first) else Modifier)
                                .rowEdges(first = continueItems.isEmpty() && i == 0, last = i == fresh.lastIndex),
                            onFocus = { requester ->
                                onFocus(Focus.Tile(t, "Fresh today"))
                                onPoster(requester)
                                toTop()
                            },
                            onClick = { openTile(context, t) },
                            onLongClick = { onMenu(t) },
                        )
                    }
                }
            } }
            // Keyed on the apps, so a row first drawn with only its buttons doesn't stay scrolled to them.
            item(key = "apps") { key(pinned.map { it.pkg }) { LazyRow(
                modifier = Modifier.fillMaxWidth().focusRestorer(),
                contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = 6.dp, bottom = 22.dp),
                horizontalArrangement = Arrangement.spacedBy(13.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                itemsIndexed(pinned, key = { _, a -> a.pkg }) { i, app ->
                    AppTile(
                        app = app,
                        width = 144.dp,
                        modifier = (if (!hasFresh && i == 0) Modifier.focusRequester(first) else Modifier)
                            .rowEdges(first = i == 0, last = false),
                        onFocus = { onFocus(Focus.App(app)) },
                        onClick = { Graph.apps.launch(app.pkg) },
                    )
                }
                item(key = "all-apps") { CircleButton(Glyphs.Grid, Modifier.rowEdges(first = pinned.isEmpty(), last = false), { onFocus(Focus.Other) }) { onOverlay(Overlay.AllApps) } }
                item(key = "search") { CircleButton(Glyphs.Search, Modifier, { onFocus(Focus.Other) }) { openSearch(context) } }
                item(key = "pair") { CircleButton(Glyphs.Phone, Modifier, { onFocus(Focus.Other) }) { onOverlay(Overlay.Pair) } }
                item(key = "settings") { CircleButton(Glyphs.Gear, Modifier.rowEdges(first = false, last = true), { onFocus(Focus.Other) }) { context.startSafely(Intent(Settings.ACTION_SETTINGS)) } }
            } } }
            items(shelves, key = { it.key }) { shelf ->
                ShelfRow(
                    shelf = shelf,
                    onFocus = { tile, requester ->
                        onFocus(Focus.Tile(tile, shelf.title))
                        onPoster(requester)
                    },
                    onMenu = onMenu,
                    edges = { first, last -> Modifier.rowEdges(first, last) },
                )
            }
            item(key = "end") { Spacer(Modifier.height(40.dp)) }
        }
    }
}

/** Something on this TV still being watched: its own picture, a hairline of progress. */
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
    Column(Modifier.width(214.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            onClick = onClick,
            onLongClick = onLongClick,
            modifier = modifier.size(214.dp, 160.dp).onFocusChanged {
                focused = it.isFocused || it.hasFocus
                if (focused) onFocus()
            },
            shape = ClickableSurfaceDefaults.shape(CardShape),
            colors = ClickableSurfaceDefaults.colors(containerColor = Color.White.copy(alpha = .09f), focusedContainerColor = Color.White.copy(alpha = .16f)),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
            border = ClickableSurfaceDefaults.border(
                border = Border(BorderStroke(1.dp, Color.White.copy(alpha = .10f)), shape = CardShape),
                focusedBorder = Border(BorderStroke(2.dp, Color.White), shape = CardShape),
            ),
        ) {
            Column {
                Box(Modifier.fillMaxWidth().height(118.dp).clip(RoundedCornerShape(topStart = CardRadius, topEnd = CardRadius))) {
                    if (art != null) Image(art, null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                    else BannerFill(app)
                }
                Column(Modifier.padding(start = 14.dp, end = 14.dp, top = 9.dp)) {
                    Text(entry.title, fontSize = 11.sp, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Spacer(Modifier.height(7.dp))
                    if (entry.progress >= 0f) ProgressBar(entry.progress, Modifier.fillMaxWidth())
                    else Text(listOfNotNull(app?.label, entry.subtitle).joinToString(" · "), fontSize = 9.sp, color = Color.White.copy(alpha = .55f), maxLines = 1)
                }
            }
        }
        // Same caption height as the posters, so the row lines up.
        Column(Modifier.padding(top = 18.dp).height(34.dp).wrapContentWidth(unbounded = true), horizontalAlignment = Alignment.CenterHorizontally) {
            if (focused) {
                Text(listOfNotNull(app?.label, entry.subtitle?.takeIf { it != app?.label }).joinToString(" · "), fontSize = 10.sp, color = Color.White.copy(alpha = .55f), maxLines = 1)
                if (entry.remainingMin >= 0) Text(remainingText(entry.remainingMin), fontSize = 10.sp, color = Color.White.copy(alpha = .55f))
            }
        }
    }
}

@Composable
private fun BannerFill(app: TvApp?) {
    val banner = remember(app?.banner) { app?.banner?.asImageBitmap() }
    Box(Modifier.fillMaxSize().background(Color(app?.color ?: 0xFF2A3A4A.toInt()).copy(alpha = .35f)), contentAlignment = Alignment.Center) {
        if (banner != null) Image(banner, null, Modifier.size(112.dp, 63.dp).clip(RoundedCornerShape(10.dp)))
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
        colors = ClickableSurfaceDefaults.colors(containerColor = Color.White.copy(alpha = .08f), focusedContainerColor = Color.White.copy(alpha = .08f)),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
        border = ClickableSurfaceDefaults.border(
            border = Border(BorderStroke(1.dp, Color.White.copy(alpha = .10f)), shape = TileShape),
            focusedBorder = Border(BorderStroke(2.dp, Color.White), shape = TileShape),
        ),
    ) {
        if (banner != null) {
            Image(banner, app.label, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            Text(app.label, fontSize = 12.sp, color = Color.White, modifier = Modifier.align(Alignment.Center))
        }
        if (pinnedBadge) {
            Glyph(Glyphs.Pin, Color.White, Modifier.align(Alignment.TopEnd).padding(6.dp).size(10.dp))
        }
    }
}

/** A round glass button; focused, it turns solid white with a dark icon. */
@Composable
private fun CircleButton(icon: androidx.compose.ui.graphics.vector.ImageVector, modifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = modifier.size(52.dp).onFocusChanged { if (it.isFocused) onFocus() },
        shape = ClickableSurfaceDefaults.shape(CircleShape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.White.copy(alpha = .10f), contentColor = Color.White.copy(alpha = .85f),
            focusedContainerColor = Color.White, focusedContentColor = Color(0xFF111111),
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.12f),
    ) {
        Glyph(icon, LocalContentColor.current, Modifier.align(Alignment.Center).size(18.dp))
    }
}

@Composable
fun ProgressBar(progress: Float, modifier: Modifier, height: Dp = 3.dp, rounded: Boolean = true) {
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
    is Focus.Tile -> FocusInfo("title", tile.title, tile.facts.ifEmpty { null }, tile.pkg, -1f, -1, null)
    Focus.Other -> null
}

private fun openSearch(context: Context) {
    val global = Intent("android.search.action.GLOBAL_SEARCH")
    if (!context.startSafely(global)) context.startSafely(Intent(Intent.ACTION_ASSIST))
}

fun Context.startSafely(intent: Intent): Boolean =
    runCatching { startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
