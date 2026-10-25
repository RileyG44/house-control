package com.livingroom.tv.ui

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp

/** Full opacity between the clock and studio edges; fade through the 48 dp screen gutters. */
fun Modifier.homeRowFade(): Modifier = graphicsLayer {
    compositingStrategy = CompositingStrategy.Offscreen
}.drawWithCache {
    val gutter = (48.dp.toPx() / size.width.coerceAtLeast(1f)).coerceIn(0f, .5f)
    val mask = Brush.horizontalGradient(
        0f to Color.Transparent,
        gutter to Color.White,
        (1f - gutter) to Color.White,
        1f to Color.Transparent,
    )
    onDrawWithContent {
        drawContent()
        drawRect(mask, blendMode = BlendMode.DstIn)
    }
}
