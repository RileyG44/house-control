package com.livingroom.tv.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.PowerManager
import com.livingroom.tv.Graph
import com.livingroom.tv.history.HistoryStore
import com.livingroom.tv.media.MediaWatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** What the Home screen has focused, mirrored to the phone's card. */
data class FocusInfo(
    val kind: String, // "continue" | "app"
    val title: String,
    val subtitle: String?,
    val pkg: String?,
    val progress: Float,
    val remainingMin: Int,
    val historyId: String?,
)

/**
 * Single source of truth for the phone remote. The TV owns all of it; the phone
 * long-polls [stateJson] and re-renders.
 */
class StateHub {
    val homeVisible = MutableStateFlow(false)
    val foreground = MutableStateFlow<String?>(null)
    val focus = MutableStateFlow<FocusInfo?>(null)
    val textField = MutableStateFlow(false)
    val keysEnabled = MutableStateFlow(false)
    val ownerName = MutableStateFlow<String?>(null)

    private companion object {
        /** AudioManager's own broadcasts; not in the public SDK as constants, but sent on every TV. */
        const val VOLUME_CHANGED = "android.media.VOLUME_CHANGED_ACTION"
        const val MUTE_CHANGED = "android.media.STREAM_MUTE_CHANGED_ACTION"
    }

    private val lock = Object()
    @Volatile var rev = 0L
        private set

    fun start(context: Context, scope: CoroutineScope) {
        scope.launch {
            merge(
                Graph.apps.pinned, Graph.history.entries, MediaWatcher.now, MediaWatcher.granted, Graph.wallpaper.image,
                homeVisible, foreground, focus, textField, keysEnabled,
            ).collect { bump() }
        }
        // The volume and mute live in AudioManager, not in a flow: the system says when they move
        // (from the phone, the hub or the physical remote), and so does the screen going on or off.
        val filter = IntentFilter().apply {
            addAction(VOLUME_CHANGED)
            addAction(MUTE_CHANGED)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        context.registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) = bump()
        }, filter, Context.RECEIVER_NOT_EXPORTED)
    }

    fun bump() = synchronized(lock) { rev++; lock.notifyAll() }

    /** Blocks until something changes after [since], or the timeout passes. */
    fun awaitChange(since: Long, timeoutMs: Long): Long = synchronized(lock) {
        val end = System.currentTimeMillis() + timeoutMs
        while (rev <= since) {
            val left = end - System.currentTimeMillis()
            if (left <= 0) break
            lock.wait(left)
        }
        rev
    }

    fun stateJson(context: Context): JSONObject {
        val apps = Graph.apps
        val now = MediaWatcher.now.value
        val fg = if (homeVisible.value) context.packageName else foreground.value
        val power = context.getSystemService(PowerManager::class.java)
        val audio = context.getSystemService(AudioManager::class.java)
        val stream = AudioManager.STREAM_MUSIC

        val o = JSONObject()
            .put("rev", rev)
            .put("serverTime", System.currentTimeMillis())
            .put("tv", JSONObject()
                .put("name", Graph.prefs.tvName)
                .put("awake", power?.isInteractive ?: true)
                .put("screen", if (homeVisible.value) "home" else "app")
                .put("foreground", fg?.let { JSONObject().put("pkg", it).put("label", apps.label(it) ?: "") })
                // STREAM_MUSIC. Where the volume is fixed (HDMI-CEC sends every change to the TV),
                // these say nothing about the TV's own level; volumeFixed tells the caller so.
                .put("volume", audio?.getStreamVolume(stream))
                .put("volumeMax", audio?.getStreamMaxVolume(stream))
                .put("muted", audio?.isStreamMute(stream) ?: false)
                .put("volumeFixed", audio?.isVolumeFixed ?: false))
            .put("caps", JSONObject()
                .put("keys", keysEnabled.value)
                .put("media", MediaWatcher.granted.value))
            .put("textField", textField.value)
            .put("owner", ownerName.value ?: "")
            .put("wallpaper", Graph.wallpaper.image.value != null)
            .put("tailnet", CompanionServer.tailnetIp())

        focus.value?.takeIf { homeVisible.value }?.let { f ->
            o.put("focus", JSONObject()
                .put("kind", f.kind).put("title", f.title).put("subtitle", f.subtitle ?: "")
                .put("pkg", f.pkg ?: "").put("app", apps.label(f.pkg) ?: "")
                .put("progress", f.progress.toDouble()).put("remainingMin", f.remainingMin)
                .put("art", when {
                    f.historyId != null && Graph.history.entries.value.any { it.id == f.historyId && it.artFile != null } -> "art/h/${f.historyId}"
                    f.pkg != null -> "banner/${f.pkg}"
                    else -> ""
                }))
        }

        now?.let { n ->
            o.put("now", JSONObject()
                .put("pkg", n.pkg).put("app", apps.label(n.pkg) ?: "")
                .put("title", n.title).put("subtitle", n.subtitle ?: "")
                .put("state", n.state).put("positionMs", n.positionMs).put("durationMs", n.durationMs)
                .put("speed", n.speed.toDouble()).put("measuredAt", n.measuredAt).put("canSeek", n.canSeek)
                .put("art", if (n.artKey != null) "art/now?v=${n.artKey}" else "banner/${n.pkg}"))
        }

        o.put("apps", JSONArray().apply {
            apps.pinned.value.forEach { a ->
                put(JSONObject().put("pkg", a.pkg).put("label", a.label).put("color", "#%06x".format(a.color and 0xFFFFFF)))
            }
        })

        o.put("continue", JSONArray().apply {
            HistoryStore.continueList(Graph.history.entries.value).take(8).forEach { e ->
                put(JSONObject()
                    .put("id", e.id).put("pkg", e.pkg).put("app", apps.label(e.pkg) ?: "")
                    .put("title", e.title).put("subtitle", e.subtitle ?: "")
                    .put("progress", e.progress.toDouble()).put("remainingMin", e.remainingMin)
                    .put("art", if (e.artFile != null) "art/h/${e.id}" else "banner/${e.pkg}"))
            }
        })
        return o
    }
}
