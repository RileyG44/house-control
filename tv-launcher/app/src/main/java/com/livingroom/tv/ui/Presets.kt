@file:OptIn(ExperimentalTvMaterial3Api::class)

package com.livingroom.tv.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRestorer
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Border
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import com.livingroom.tv.house.Scene

private val PillShape = RoundedCornerShape(50)

/**
 * The plan's presets on Home, under the greeting and the studio: OK runs one here exactly as the
 * studio's Scenes row does (lights, the AC, and the app it opens on a TV, if any). They are made
 * and arranged on the phone or the computer; the hub's plan brings every change here.
 */
@Composable
fun HomePresets(
    scenes: List<Scene>,
    active: String?,
    onFocus: () -> Unit,
    edges: (first: Boolean, last: Boolean) -> Modifier,
    onRun: (Scene) -> Unit,
) {
    LazyRow(
        modifier = Modifier.fillMaxWidth().focusRestorer(),
        contentPadding = PaddingValues(start = 48.dp, end = 48.dp, top = 2.dp, bottom = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        itemsIndexed(scenes, key = { _, s -> s.id }) { i, scene ->
            PresetPill(
                scene = scene,
                active = scene.id == active,
                modifier = edges(i == 0, i == scenes.lastIndex),
                onFocus = onFocus,
                onClick = { onRun(scene) },
            )
        }
    }
}

/** A glass pill: the preset's icon and name, and the app it opens. Focused, it turns solid white. */
@Composable
private fun PresetPill(scene: Scene, active: Boolean, modifier: Modifier, onFocus: () -> Unit, onClick: () -> Unit) {
    var focused by remember { mutableStateOf(false) }
    val app = scene.tvs.values.firstNotNullOfOrNull { a ->
        a.optString("name").ifBlank { a.optString("app") }.ifBlank { null }
    }
    Surface(
        onClick = onClick,
        modifier = modifier.height(40.dp).onFocusChanged {
            focused = it.isFocused
            if (it.isFocused) onFocus()
        },
        shape = ClickableSurfaceDefaults.shape(PillShape),
        colors = ClickableSurfaceDefaults.colors(
            containerColor = Color.White.copy(alpha = if (active) .2f else .1f), contentColor = Color.White,
            focusedContainerColor = Color.White, focusedContentColor = Color(0xFF111111),
        ),
        scale = ClickableSurfaceDefaults.scale(focusedScale = 1.08f),
        border = ClickableSurfaceDefaults.border(
            border = Border(BorderStroke(1.dp, Color.White.copy(alpha = if (active) .7f else .1f)), shape = PillShape),
            focusedBorder = Border(BorderStroke(0.dp, Color.Transparent), shape = PillShape),
        ),
    ) {
        Row(Modifier.padding(start = 14.dp, end = 18.dp).align(Alignment.Center), verticalAlignment = Alignment.CenterVertically) {
            Glyph(sceneIcon(scene.icon), LocalContentColor.current, Modifier.size(17.dp))
            Spacer(Modifier.width(9.dp))
            Text(scene.name, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 180.dp))
            val faint = LocalContentColor.current.copy(alpha = if (focused) .6f else .5f)
            if (app != null) {
                Spacer(Modifier.width(10.dp))
                Glyph(Glyphs.Play, faint, Modifier.size(9.dp))
                Spacer(Modifier.width(4.dp))
                Text(app, fontSize = 11.sp, color = faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 110.dp))
            }
            val playlist = scene.spotify?.optString("name")?.ifBlank { null }
            if (playlist != null) {
                Spacer(Modifier.width(10.dp))
                Glyph(Glyphs.Note, faint, Modifier.size(11.dp))
                Spacer(Modifier.width(4.dp))
                Text(playlist, fontSize = 11.sp, color = faint, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 110.dp))
            }
        }
    }
}
