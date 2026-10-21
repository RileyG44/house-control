package com.livingroom.tv.apps

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.drawable.Drawable
import android.util.Log
import androidx.core.graphics.drawable.toBitmap
import androidx.palette.graphics.Palette
import com.livingroom.tv.Prefs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

data class TvApp(
    val pkg: String,
    val label: String,
    val component: ComponentName,
    val banner: Bitmap?,
    val icon: Bitmap?,
    /** Brand colour sampled from the banner, used for the app hero glow. */
    val color: Int,
)

/** Installed TV apps, the user's pinned order, and launching. */
class AppsRepository(private val context: Context, private val prefs: Prefs) {
    private val _all = MutableStateFlow<List<TvApp>>(emptyList())
    val all: StateFlow<List<TvApp>> = _all

    private val _pinned = MutableStateFlow<List<TvApp>>(emptyList())
    val pinned: StateFlow<List<TvApp>> = _pinned

    private val pngCache = ConcurrentHashMap<String, ByteArray>()

    fun refresh() {
        val pm = context.packageManager
        val query = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
        val apps = pm.queryIntentActivities(query, 0)
            .filter { it.activityInfo.packageName != context.packageName }
            .distinctBy { it.activityInfo.packageName }
            .mapNotNull { ri ->
                runCatching {
                    val ai = ri.activityInfo
                    val banner = (ai.loadBanner(pm) ?: ai.applicationInfo.loadBanner(pm))?.safeBitmap(320, 180)
                    val icon = ri.loadIcon(pm)?.safeBitmap(144, 144)
                    TvApp(
                        pkg = ai.packageName,
                        label = ri.loadLabel(pm).toString(),
                        component = ComponentName(ai.packageName, ai.name),
                        banner = banner,
                        icon = icon,
                        color = brandColor(banner ?: icon),
                    )
                }.onFailure { Log.w(TAG, "Skipping ${ri.activityInfo.packageName}", it) }.getOrNull()
            }
            .sortedBy { it.label.lowercase() }
        pngCache.clear()
        _all.value = apps
        applyPinned()
    }

    private fun applyPinned() {
        val byPkg = _all.value.associateBy { it.pkg }
        val order = prefs.pinned ?: DEFAULT_PINNED
        _pinned.value = order.mapNotNull { byPkg[it] }
    }

    fun isPinned(pkg: String) = _pinned.value.any { it.pkg == pkg }

    fun togglePinned(pkg: String): Boolean {
        val current = (prefs.pinned ?: _pinned.value.map { it.pkg }).toMutableList()
        val nowPinned = if (current.remove(pkg)) false else { current.add(pkg); true }
        prefs.pinned = current
        applyPinned()
        return nowPinned
    }

    fun label(pkg: String?): String? = _all.value.firstOrNull { it.pkg == pkg }?.label
    fun find(pkg: String?): TvApp? = _all.value.firstOrNull { it.pkg == pkg }

    fun launch(pkg: String): Boolean {
        val pm = context.packageManager
        val intent = pm.getLeanbackLaunchIntentForPackage(pkg) ?: pm.getLaunchIntentForPackage(pkg) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(intent) }
            .onFailure { Log.w(TAG, "Launch failed for $pkg", it) }
            .isSuccess
    }

    /** PNG bytes for the phone remote. */
    fun png(pkg: String, banner: Boolean): ByteArray? {
        val key = (if (banner) "b:" else "i:") + pkg
        pngCache[key]?.let { return it }
        val app = find(pkg) ?: return null
        val bmp = (if (banner) app.banner else app.icon) ?: return null
        val bytes = ByteArrayOutputStream().use { out ->
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out); out.toByteArray()
        }
        pngCache[key] = bytes
        return bytes
    }

    fun watchPackageChanges() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addAction(Intent.ACTION_PACKAGE_CHANGED)
            addDataScheme("package")
        }
        context.registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) {
                Thread { refresh() }.start()
            }
        }, filter, Context.RECEIVER_NOT_EXPORTED)
    }

    private fun Drawable.safeBitmap(w: Int, h: Int): Bitmap = toBitmap(w, h, Bitmap.Config.ARGB_8888)

    private fun brandColor(bmp: Bitmap?): Int {
        if (bmp == null) return 0xFF2A3A4A.toInt()
        val p = Palette.from(bmp).maximumColorCount(16).generate()
        return p.vibrantSwatch?.rgb ?: p.darkVibrantSwatch?.rgb ?: p.lightVibrantSwatch?.rgb
            ?: p.dominantSwatch?.rgb ?: 0xFF2A3A4A.toInt()
    }

    companion object {
        private const val TAG = "LivingRoomApps"

        /** First-run Home order; only installed apps appear. */
        val DEFAULT_PINNED = listOf(
            "com.google.android.youtube.tv",
            "com.netflix.ninja",
            "com.apple.atve.androidtv.appletv",
            "com.wbd.stream",
            "com.hulu.livingroomplus",
            "com.disney.disneyplus",
            "com.amazon.amazonvideo.livingroom",
            "com.peacocktv.peacockandroid",
            "com.spotify.tv.android",
        )
    }
}
