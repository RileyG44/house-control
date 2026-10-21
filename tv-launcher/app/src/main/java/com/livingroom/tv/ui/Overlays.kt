@file:OptIn(ExperimentalTvMaterial3Api::class)

package com.livingroom.tv.ui

import android.graphics.Bitmap
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.ClickableSurfaceDefaults
import androidx.tv.material3.ExperimentalTvMaterial3Api
import androidx.tv.material3.Surface
import androidx.tv.material3.Text
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.livingroom.tv.Graph
import com.livingroom.tv.apps.TvApp
import kotlinx.coroutines.delay

/** Every installed TV app. Hold OK to pin or unpin from the Home row. */
@Composable
fun AllAppsOverlay(apps: List<TvApp>) {
    val context = LocalContext.current
    val pinned by Graph.apps.pinned.collectAsState()
    val first = remember { FocusRequester() }
    LaunchedEffect(apps.isNotEmpty()) {
        delay(80)
        runCatching { first.requestFocus() }
    }
    Box(Modifier.fillMaxSize().background(Palette.Bg.copy(alpha = .95f))) {
        Column(Modifier.padding(start = 48.dp, end = 48.dp, top = 30.dp)) {
            Text("All apps", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Color.White)
            Spacer(Modifier.height(4.dp))
            Text("OK opens  ·  Hold OK to pin or unpin from Home", fontSize = 11.sp, color = Palette.Secondary)
            Spacer(Modifier.height(14.dp))
            LazyVerticalGrid(
                columns = GridCells.Fixed(6),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                contentPadding = PaddingValues(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 40.dp),
            ) {
                itemsIndexed(apps, key = { _, a -> a.pkg }) { i, app ->
                    Column {
                        AppTile(
                            app = app,
                            width = 126.dp,
                            modifier = if (i == 0) Modifier.focusRequester(first) else Modifier,
                            pinnedBadge = pinned.any { it.pkg == app.pkg },
                            onClick = { Graph.apps.launch(app.pkg) },
                            onLongClick = {
                                val nowPinned = Graph.apps.togglePinned(app.pkg)
                                Toast.makeText(context, if (nowPinned) "Pinned to Home" else "Removed from Home", Toast.LENGTH_SHORT).show()
                            },
                        )
                        Spacer(Modifier.height(5.dp))
                        Text(app.label, fontSize = 9.sp, color = Palette.Secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/** House Control's panel on the Dell hub. The QR code opens it on the phone. */
private const val HOUSE_CONTROL_URL = "http://192.168.0.127:8766"

/** Points the phone at House Control, whose remote drives this TV. */
@Composable
fun PairOverlay(onClose: () -> Unit) {
    val url = HOUSE_CONTROL_URL
    val qr = remember(url) { qrBitmap(url, 480).asImageBitmap() }
    val done = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(80)
        runCatching { done.requestFocus() }
    }
    Box(Modifier.fillMaxSize().background(Palette.Bg.copy(alpha = .96f)), contentAlignment = Alignment.Center) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(44.dp)) {
            Box(Modifier.size(220.dp).clip(RoundedCornerShape(18.dp)).background(Color.White).padding(14.dp)) {
                Image(qr, "House Control link", Modifier.fillMaxSize(), filterQuality = FilterQuality.None)
            }
            Column(Modifier.width(360.dp)) {
                Text("Control this TV from House Control", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = Color.White)
                Spacer(Modifier.height(16.dp))
                listOf(
                    "Open your phone’s camera and point it at this code.",
                    "Tap the link to open House Control’s panel.",
                    "Open the TV remote there, or use the House Control app.",
                ).forEachIndexed { i, step ->
                    Row(Modifier.padding(bottom = 10.dp)) {
                        Text("${i + 1}", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = Color(0xFFA0D7FF), modifier = Modifier.width(20.dp))
                        Text(step, fontSize = 14.sp, color = Palette.Text.copy(alpha = .86f), lineHeight = 19.sp)
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(url, fontSize = 10.sp, color = Palette.Tertiary)
                Spacer(Modifier.height(22.dp))
                Surface(
                    onClick = onClose,
                    modifier = Modifier.focusRequester(done),
                    shape = ClickableSurfaceDefaults.shape(RoundedCornerShape(50)),
                    colors = ClickableSurfaceDefaults.colors(
                        containerColor = Color.White.copy(alpha = .12f), contentColor = Color.White,
                        focusedContainerColor = Color.White, focusedContentColor = Color.Black,
                    ),
                    scale = ClickableSurfaceDefaults.scale(focusedScale = 1.06f),
                ) {
                    Text("Done", fontSize = 14.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(horizontal = 28.dp, vertical = 10.dp))
                }
            }
        }
    }
}

private fun qrBitmap(text: String, size: Int): Bitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 0))
    val pixels = IntArray(matrix.width * matrix.height) { i ->
        if (matrix.get(i % matrix.width, i / matrix.width)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
    }
    return Bitmap.createBitmap(pixels, matrix.width, matrix.height, Bitmap.Config.ARGB_8888)
}
