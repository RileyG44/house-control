@file:OptIn(ExperimentalTvMaterial3Api::class)

package com.livingroom.tv.ui

import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.BiasAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import com.livingroom.tv.Graph
import com.livingroom.tv.catalog.Catalog
import com.livingroom.tv.catalog.CatalogTile
import com.livingroom.tv.companion.Commands
import kotlinx.coroutines.delay

/** One row of posters on Home: "For you", or one app's Popular, Trending or New. */
data class Shelf(val key: String, val title: String, val tiles: List<CatalogTile>)

/** Width the posters are decoded at: 84 dp at density 2, and a little over. */
private const val POSTER_PX = 180
/** The hero's backdrop, under the scrims. */
private const val BACKDROP_PX = 1280
private val PosterShape = RoundedCornerShape(7.dp)

/**
 * The catalog's rows for Home, without the hidden titles: "For you" first (without its Continue
 * titles, which have their own row here), then each app's rows in the hub's order.
 */
fun shelvesOf(catalog: Catalog?, hidden: Set<String>): List<Shelf> {
    if (catalog == null) return emptyList()
    val forYou = catalog.forYou.filter { it.kind != "continue" && it.id !in hidden }
    val rows = catalog.apps.flatMap { app ->
        app.rows.map { r -> Shelf("${app.id}:${r.key}", r.title, r.items.filter { it.id !in hidden }) }
    }
    return (listOf(Shelf("for-you", "For you", forYou)) + rows).filter { it.tiles.isNotEmpty() }
}

/** A catalog picture from the hub (through [com.livingroom.tv.catalog.ArtCache]), or null while it loads. */
@Composable
fun catalogArt(url: String?, maxWidth: Int, waitMs: Long = 0): ImageBitmap? {
    val art by produceState(initialValue = url?.let { Graph.art.cached(it, maxWidth) }, url, maxWidth) {
        if (url == null) {
            value = null
            return@produceState
        }
        if (value == null) {
            // A backdrop waits a moment, so scrolling along a row doesn't fetch every one.
            if (waitMs > 0) delay(waitMs)
            value = Graph.art.load(url, maxWidth)
        }
    }
    return art
}

@Composable
fun ShelfRow(
    shelf: Shelf,
    onFocus: (CatalogTile, FocusRequester) -> Unit,
    onMenu: (CatalogTile) -> Unit,
    edges: (first: Boolean, last: Boolean) -> Modifier,
) {
    val context = LocalContext.current
    Column {
        Spacer(Modifier.height(6.dp))
        Text(
            shelf.title, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Palette.Secondary,
            modifier = Modifier.padding(start = 50.dp),
        )
        LazyRow(
            modifier = Modifier.fillMaxWidth().focusRestorer(),
            contentPadding = PaddingValues(horizontal = 48.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(11.dp),
        ) {
            itemsIndexed(shelf.tiles, key = { _, t -> t.id }) { i, t ->
                PosterTile(
                    tile = t,
                    modifier = edges(i == 0, i == shelf.tiles.lastIndex),
                    onFocus = { onFocus(t, it) },
                    onClick = { openTile(context, t) },
                    onLongClick = { onMenu(t) },
                )
            }
        }
    }
}

@Composable
private fun PosterTile(
    tile: CatalogTile,
    modifier: Modifier,
    onFocus: (FocusRequester) -> Unit,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val requester = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    val art = catalogArt(tile.poster, POSTER_PX)
    val app = Graph.apps.find(tile.pkg)
    Surface(
        onClick = onClick,
        onLongClick = onLongClick,
        modifier = modifier.size(84.dp, 126.dp).focusRequester(requester).onFocusChanged {
            focused = it.isFocused
            if (it.isFocused) onFocus(requester)
        },
        shape = ClickableSurfaceDefaults.shape(PosterShape),
        colors = ClickableSurfaceDefaults.colors(containerColor = Palette.Card, focusedContainerColor = Palette.Card),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.1f),
        border = ClickableSurfaceDefaults.border(
            border = Border(BorderStroke(0.5.dp, Color.White.copy(alpha = .08f)), shape = PosterShape),
            focusedBorder = Border(BorderStroke(2.dp, Color.White), shape = PosterShape),
        ),
    ) {
        if (art != null) {
            Image(art, tile.title, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
        } else {
            // No poster (yet): the app's colour and the title.
            Box(
                Modifier.fillMaxSize().background(Color(app?.color ?: 0xFF2A3A4A.toInt()).copy(alpha = .35f)).padding(8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    tile.title, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, color = Color.White,
                    textAlign = TextAlign.Center, maxLines = 4, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (!focused) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = .14f)))
    }
}

/** The top half for a focused catalog title: its app and row, title, year and the rest, and its blurb. */
@Composable
fun TileHero(tile: CatalogTile, row: String) {
    val app = Graph.apps.label(tile.pkg) ?: tile.app.orEmpty()
    Column {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(app, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = Palette.Text.copy(alpha = .9f))
            if (row.isNotEmpty()) Text("  ·  $row", fontSize = 12.sp, color = Palette.Secondary)
        }
        Spacer(Modifier.height(12.dp))
        Text(
            tile.title,
            fontSize = if (tile.title.length > 26) 32.sp else 46.sp,
            lineHeight = if (tile.title.length > 26) 36.sp else 48.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = (-0.4).sp,
            color = Color.White,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        val facts = tile.facts
        if (facts.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Text(facts, fontSize = 13.sp, fontWeight = FontWeight.Medium, color = Palette.Text.copy(alpha = .78f), maxLines = 1)
        }
        tile.blurb?.let {
            Spacer(Modifier.height(10.dp))
            Text(it, fontSize = 13.sp, lineHeight = 18.sp, color = Palette.Text.copy(alpha = .82f), maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        Spacer(Modifier.height(12.dp))
        Text("OK opens it in $app  ·  Hold OK for more", fontSize = 10.5.sp, color = Palette.Secondary)
    }
}

/** Full-bleed backdrop of the focused catalog title, or its app's glow while there is none. */
@Composable
fun TileBackdrop(url: String?, glow: @Composable () -> Unit) {
    val art = catalogArt(url, BACKDROP_PX, waitMs = 160)
    if (art != null) {
        Image(
            bitmap = art,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            alignment = BiasAlignment(0.6f, -0.3f),
            modifier = Modifier.fillMaxSize(),
        )
    } else {
        glow()
    }
}

/**
 * Opens [tile] in its app: the deep link, else the title's page, kept to the app's package; the
 * profile picker is armed by [Commands.open]. When the app takes neither, the app itself opens.
 * A For you pick of the app's own (a TV provider recommendation) opens its own intent.
 */
fun openTile(context: Context, tile: CatalogTile) {
    val pkg = tile.pkg ?: return
    val label = Graph.apps.label(pkg) ?: tile.app ?: "the app"
    val opened = if (tile.kind == "recommendation") Graph.recommendations.open(context, tile.id.removePrefix("r:"))
                 else tile.openUrls.any { Commands.open(context, it, pkg) }
    if (opened) return
    if (Graph.apps.launch(pkg)) {
        Toast.makeText(context, "Opened $label: it didn't take the title’s link", Toast.LENGTH_SHORT).show()
    } else {
        Toast.makeText(context, "$label isn't on this TV", Toast.LENGTH_SHORT).show()
    }
}

/** Hold OK on a poster: open it, open its app, or hide it from Home. */
@Composable
fun TileMenu(tile: CatalogTile, onClose: () -> Unit) {
    val context = LocalContext.current
    val first = remember { FocusRequester() }
    val label = Graph.apps.label(tile.pkg) ?: tile.app.orEmpty()
    LaunchedEffect(Unit) {
        delay(60)
        runCatching { first.requestFocus() }
    }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            Modifier.width(380.dp).background(
                Brush.verticalGradient(listOf(Palette.Card, Palette.Bg)), RoundedCornerShape(18.dp),
            ).padding(26.dp),
        ) {
            Column {
                Text(tile.title, fontSize = 22.sp, fontWeight = FontWeight.Bold, color = Color.White, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (tile.facts.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(tile.facts, fontSize = 11.sp, color = Palette.Secondary, maxLines = 1)
                }
                Spacer(Modifier.height(18.dp))
                MenuButton("Open", Modifier.focusRequester(first)) { onClose(); openTile(context, tile) }
                if (tile.pkg != null) {
                    MenuButton("Open $label") { onClose(); tile.pkg?.let { Graph.apps.launch(it) } }
                }
                MenuButton("Hide from Home") {
                    onClose()
                    Graph.catalog.hide(tile.id)
                    Toast.makeText(context, "Hidden. It won’t show on Home again.", Toast.LENGTH_SHORT).show()
                }
                MenuButton("Cancel", onClick = onClose)
            }
        }
    }
}

@Composable
private fun MenuButton(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().padding(vertical = 4.dp),
        shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.White.copy(alpha = .08f), contentColor = Color.White,
            focusedContainerColor = Color.White, focusedContentColor = Color.Black,
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.04f),
    ) {
        Text(text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 22.dp, vertical = 10.dp))
    }
}
