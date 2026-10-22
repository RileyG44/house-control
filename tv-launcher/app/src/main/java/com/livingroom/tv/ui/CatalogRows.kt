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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
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

/** One row of posters below the apps: one app's Popular, Trending or New. */
data class Shelf(val key: String, val title: String, val tiles: List<CatalogTile>)

/** Width the posters are decoded at: 107 dp at density 2, and a little over. */
private const val POSTER_PX = 230
val PosterShape = RoundedCornerShape(18.dp)
val PosterWidth = 107.dp
val PosterHeight = 160.dp

/** Today's picks for the Fresh row, without the hidden ones and the hub's own Continue copies. */
fun freshPicks(catalog: Catalog?, hidden: Set<String>): List<CatalogTile> =
    catalog?.forYou.orEmpty().filter { it.kind != "continue" && it.id !in hidden }

/** Each app's rows (Popular, Trending, New), in the hub's order, without the hidden titles. */
fun shelvesOf(catalog: Catalog?, hidden: Set<String>): List<Shelf> {
    if (catalog == null) return emptyList()
    return catalog.apps.flatMap { app ->
        app.rows.map { r -> Shelf("${app.id}:${r.key}", r.title, r.items.filter { it.id !in hidden }) }
    }.filter { it.tiles.isNotEmpty() }
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
        Text(shelf.title, fontSize = 13.sp, color = Color.White.copy(alpha = .8f), modifier = Modifier.padding(start = 48.dp, top = 4.dp))
        LazyRow(
            modifier = Modifier.fillMaxWidth().focusRestorer(),
            contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(13.dp),
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

/** "Netflix · Series · 2026": under a focused poster, instead of any blurb. */
fun captionOf(tile: CatalogTile): String = listOfNotNull(
    Graph.apps.label(tile.pkg) ?: tile.app,
    when (tile.kind) { "movie" -> "Film"; "show" -> "Series"; else -> null },
    tile.year?.toString(),
).joinToString(" · ")

/** A poster; focused, it grows a little and its title shows underneath. */
@Composable
fun PosterTile(
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
    Column(Modifier.width(PosterWidth), horizontalAlignment = Alignment.CenterHorizontally) {
        Surface(
            onClick = onClick,
            onLongClick = onLongClick,
            modifier = modifier.size(PosterWidth, PosterHeight).focusRequester(requester).onFocusChanged {
                focused = it.isFocused
                if (it.isFocused) onFocus(requester)
            },
            shape = ClickableSurfaceDefaults.shape(PosterShape),
            colors = ClickableSurfaceDefaults.colors(containerColor = Color.White.copy(alpha = .08f), focusedContainerColor = Color.White.copy(alpha = .08f)),
            scale = ClickableSurfaceDefaults.scale(focusedScale = 1.12f),
            border = ClickableSurfaceDefaults.border(
                border = Border(BorderStroke(1.dp, Color.White.copy(alpha = .10f)), shape = PosterShape),
                focusedBorder = Border(BorderStroke(2.dp, Color.White), shape = PosterShape),
            ),
        ) {
            if (art != null) {
                Image(art, tile.title, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            } else {
                // No poster yet (the Dell's Wi-Fi can be slow): a quiet tinted card with the title, on purpose.
                Box(
                    Modifier.fillMaxSize().background(
                        Brush.linearGradient(listOf(Color(app?.color ?: 0xFF51604F.toInt()).copy(alpha = .45f), Color(0xFF1B231F).copy(alpha = .6f)))
                    ).padding(12.dp),
                    contentAlignment = Alignment.BottomStart,
                ) {
                    Text(tile.title, fontSize = 12.sp, fontWeight = FontWeight.Light, color = Color.White.copy(alpha = .85f), maxLines = 4, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        // The caption keeps its height, so the row never jumps; it is only drawn under the focused poster.
        Column(
            Modifier.padding(top = 18.dp).height(34.dp).wrapContentWidth(unbounded = true),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (focused) {
                Text(tile.title, fontSize = 13.sp, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 260.dp))
                Text(captionOf(tile), fontSize = 10.sp, color = Color.White.copy(alpha = .55f), maxLines = 1)
            }
        }
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
    // What plays next in that app is probably this title: the nightly picks learn its JustWatch id.
    if (tile.id.matches(Regex("t[a-z]{1,3}\\d{1,12}"))) Graph.historySync.opened(pkg, tile.id, tile.title)
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
