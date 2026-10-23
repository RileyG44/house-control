package com.livingroom.tv.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.ProvideTextStyle
import androidx.tv.material3.darkColorScheme
import com.livingroom.tv.Graph
import com.livingroom.tv.R
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

/**
 * Urbanist, a geometric grotesk (SIL OFL, third_party/Urbanist-OFL.txt): one variable font,
 * named at each weight Home uses. Light and regular for nearly everything; thin numerals.
 */
@OptIn(ExperimentalTextApi::class)
val Urbanist = FontFamily(
    listOf(200, 300, 400, 500, 600, 700).map { w ->
        Font(R.font.urbanist, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))
    }
)

@Composable
fun LivingRoomTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            background = Palette.Bg,
            surface = Palette.Card,
            onSurface = Palette.Text,
            primary = Color.White,
        ),
    ) {
        CompositionLocalProvider(LocalContentColor provides Palette.Text) {
            ProvideTextStyle(TextStyle(fontFamily = Urbanist), content)
        }
    }
}

/** Home's colour field: deep teal into olive and amber, out of focus, with a little grain. */
@Composable
fun Field(modifier: Modifier = Modifier) {
    Image(painterResource(R.drawable.home_field), null, modifier.fillMaxSize(), contentScale = ContentScale.Crop)
}

/**
 * Frosted glass: a translucent fill, a hairline that is brightest along the top edge, no hard
 * border. The field behind is already out of focus, so nothing needs blurring at run time.
 */
fun Modifier.glass(shape: Shape = RoundedCornerShape(24.dp), tint: Color = Color.White, strength: Float = 1f): Modifier = this
    .clip(shape)
    .background(Brush.verticalGradient(0f to tint.copy(alpha = .13f * strength), 1f to tint.copy(alpha = .05f * strength)), shape)
    .border(
        1.dp,
        Brush.verticalGradient(0f to Color.White.copy(alpha = .30f), .18f to Color.White.copy(alpha = .07f), 1f to Color.White.copy(alpha = .03f)),
        shape,
    )

/** The squircle radius cards share (≈48 px at 1080p). */
val CardRadius: Dp = 24.dp

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

    // Thin line icons for the studio (lucide's shapes, drawn at 1.6).
    val Power = stroke("power", 1.6f, "M12 3v8", "M6.6 6.6a8 8 0 1 0 10.8 0")
    val Sun = stroke("sun", 1.6f, "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z", "M12 2v2", "M12 20v2", "M4.9 4.9l1.4 1.4", "M17.7 17.7l1.4 1.4", "M2 12h2", "M20 12h2", "M4.9 19.1l1.4-1.4", "M17.7 6.3l1.4-1.4")
    val Sofa = stroke("sofa", 1.6f, "M5 11V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3", "M3 12a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v5H3z", "M5 17v2", "M19 17v2")
    val Moon = stroke("moon", 1.6f, "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z")
    val Film = stroke("film", 1.6f, "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "M7 5v14", "M17 5v14", "M3 12h4", "M17 12h4")
    val Snow = stroke("snow", 1.6f, "M12 2v20", "M4 7l16 10", "M4 17L20 7", "M9 3.5l3 2.5 3-2.5", "M9 20.5l3-2.5 3 2.5")
    val Flame = stroke("flame", 1.6f, "M12 3c1 3 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5c0 2 1 3 2 3c0-3-1-5 1-8.5z")
    val Fan = stroke("fan", 1.6f, "M12 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0", "M12 10.5C11 6 12.5 3 15 3.5s2 4-3 7", "M13.5 12c4.5-1 7.5.5 7 3s-4 2-7-3", "M12 13.5c1 4.5-.5 7.5-3 7s-2-4 3-7", "M10.5 12C6 13 3 11.5 3.5 9s4-2 7 3")
    val Drop = stroke("drop", 1.6f, "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z")
    val Auto = stroke("auto", 1.6f, "M4 12a8 8 0 0 1 14-5.3", "M18 3v4h-4", "M20 12a8 8 0 0 1-14 5.3", "M6 21v-4h4")
    val Bulb = stroke("bulb", 1.6f, "M9 18h6", "M10 21h4", "M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z")
    val Strip = stroke("strip", 1.6f, "M3 10h18v4H3z", "M7 10v4", "M12 10v4", "M17 10v4")
    val Minus = stroke("minus", 1.8f, "M6 12h12")
    val Plus = stroke("plus", 1.8f, "M6 12h12", "M12 6v12")
    val Sparkle = stroke("sparkle", 1.6f, "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z", "M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z")
    val Play = fill("play", "M8 5.5v13l10.5-6.5z")
    val Note = stroke("note", 1.8f, "M9 17.5V6l10-2v11.5", "M9 17.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z", "M19 15.5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z")
    val Arrow = stroke("arrow", 1.8f, "M7 17L17 7", "M8 7h9v9")
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
