package com.livingroom.tv.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.darkColorScheme
import com.livingroom.tv.Graph
import com.livingroom.tv.history.WatchEntry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 10-foot palette. Sizes elsewhere are in dp on a 960×540 dp canvas (1080p at density 2). */
object Palette {
    val Bg = Color(0xFF07080B)
    val Text = Color(0xFFF5F5F7)
    val Secondary = Color(0x9EFFFFFF)
    val Tertiary = Color(0x6BFFFFFF)
    val Card = Color(0xFF15181E)
    val Good = Color(0xFF9FE3B0)
}

@Composable
fun LivingRoomTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            background = Palette.Bg,
            surface = Palette.Card,
            onSurface = Palette.Text,
            primary = Color.White,
        ),
        content = content,
    )
}

object Glyphs {
    private fun stroke(name: String, width: Float, vararg paths: String) =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            paths.forEach {
                addPath(
                    pathData = addPathNodes(it),
                    stroke = SolidColor(Color.White),
                    strokeLineWidth = width,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    private fun fill(name: String, vararg paths: String) =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            paths.forEach { addPath(pathData = addPathNodes(it), fill = SolidColor(Color.White)) }
        }.build()

    val Search = stroke("search", 2.1f, "M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13z", "M15.4 15.4l5 5")
    val Gear = stroke(
        "gear", 1.8f, "M12 8.8a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4z",
        "M12 2.8l1.6 2.3 2.7-.7.6 2.7 2.7.6-.7 2.7 2.3 1.6-2.3 1.6.7 2.7-2.7.6-.6 2.7-2.7-.7L12 21.2l-1.6-2.3-2.7.7-.6-2.7-2.7-.6.7-2.7L2.8 12l2.3-1.6-.7-2.7 2.7-.6.6-2.7 2.7.7z",
    )
    val Phone = stroke("phone", 1.8f, "M8.5 2.5h7a2 2 0 0 1 2 2v15a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z", "M10.5 18.3h3")
    val Grid = fill(
        "grid",
        "M5.5 3.5h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z",
        "M15.5 3.5h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z",
        "M5.5 13.5h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z",
        "M15.5 13.5h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z",
    )
    val Pin = fill("pin", "M12 3.5l2.6 5.3 5.9.9-4.3 4.2 1 5.8L12 17l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z")
}

@Composable
fun Glyph(icon: ImageVector, tint: Color, modifier: Modifier = Modifier) =
    Image(icon, contentDescription = null, colorFilter = ColorFilter.tint(tint), modifier = modifier)

/** Small decoded-image cache so focus changes never decode on the main thread twice. */
object Images {
    private val cache = LruCache<String, ImageBitmap>(32)

    fun cached(key: String): ImageBitmap? = cache.get(key)

    suspend fun load(key: String, decode: () -> Bitmap?): ImageBitmap? =
        cache.get(key) ?: withContext(Dispatchers.IO) {
            runCatching { decode() }.getOrNull()?.asImageBitmap()?.also { cache.put(key, it) }
        }

    fun decodeFile(path: String, maxWidth: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxWidth) sample *= 2
        return BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}

/** Artwork recorded for a history entry, or null while loading / when the app published none. */
@Composable
fun historyArt(entry: WatchEntry?, maxWidth: Int = 960): ImageBitmap? {
    val name = entry?.artFile
    val key = "h:$name:$maxWidth"
    val art by produceState(initialValue = name?.let { Images.cached(key) }, key) {
        value = name?.let { n ->
            Images.load(key) { Graph.history.artFile(n)?.let { Images.decodeFile(it.path, maxWidth) } }
        }
    }
    return art
}
