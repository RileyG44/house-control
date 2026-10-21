package com.livingroom.tv.media

import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.util.Log
import com.livingroom.tv.Graph
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import kotlin.math.max

data class NowPlaying(
    val pkg: String,
    val title: String,
    val subtitle: String?,
    /** playing | paused | buffering | stopped */
    val state: String,
    val positionMs: Long,
    val durationMs: Long,
    val speed: Float,
    /** Wall-clock time positionMs was measured, so the phone can extrapolate. */
    val measuredAt: Long,
    val canSeek: Boolean,
    val artKey: String?,
)

/** Granted with: adb shell cmd notification allow_listener com.livingroom.tv/.media.MediaListenerService */
class MediaListenerService : NotificationListenerService() {
    override fun onListenerConnected() {
        Graph.init(application)
        MediaWatcher.attach(this)
    }

    override fun onListenerDisconnected() {
        MediaWatcher.detach()
        requestRebind(ComponentName(this, MediaListenerService::class.java))
    }
}

/**
 * Watches every app's media session. This is how the launcher knows what you're
 * watching (for Continue) and how the phone gets play/pause/seek, without root.
 */
object MediaWatcher {
    private const val TAG = "LivingRoomMedia"
    private val IGNORED = setOf("com.google.android.bluetooth", "android")

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var manager: MediaSessionManager? = null
    private val tracked = ConcurrentHashMap<MediaSession.Token, Tracked>()

    private val _now = MutableStateFlow<NowPlaying?>(null)
    val now: StateFlow<NowPlaying?> = _now

    private val _granted = MutableStateFlow(false)
    val granted: StateFlow<Boolean> = _granted

    /** Encoded art for the current session, served to the phone. */
    @Volatile var nowArtJpeg: ByteArray? = null
        private set
    @Volatile private var nowArtBitmap: Bitmap? = null
    private val uriArt = ConcurrentHashMap<String, Bitmap>()

    private class Tracked(val controller: MediaController) {
        var lastRecorded = 0L
        val callback = object : MediaController.Callback() {
            override fun onMetadataChanged(metadata: MediaMetadata?) = publish()
            override fun onPlaybackStateChanged(state: PlaybackState?) {
                val s = state?.state
                if (s == PlaybackState.STATE_PAUSED || s == PlaybackState.STATE_STOPPED) record(this@Tracked, force = true)
                publish()
            }
            override fun onSessionDestroyed() {
                record(this@Tracked, force = true)
                tracked.remove(controller.sessionToken)
                publish()
            }
        }
    }

    private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list ->
        onSessions(list ?: emptyList())
    }

    private val ticker = object : Runnable {
        override fun run() {
            tracked.values.forEach { t ->
                if (t.controller.playbackState?.state == PlaybackState.STATE_PLAYING) record(t, force = false)
            }
            publish()
            main.postDelayed(this, 15_000)
        }
    }

    fun attach(context: Context) {
        val msm = context.getSystemService(MediaSessionManager::class.java) ?: return
        val component = ComponentName(context, MediaListenerService::class.java)
        runCatching {
            msm.addOnActiveSessionsChangedListener(sessionsListener, component, main)
            manager = msm
            _granted.value = true
            onSessions(msm.getActiveSessions(component))
            main.removeCallbacks(ticker)
            main.post(ticker)
        }.onFailure { Log.w(TAG, "Media sessions unavailable (listener not granted?)", it) }
    }

    fun detach() {
        manager?.removeOnActiveSessionsChangedListener(sessionsListener)
        tracked.values.forEach { it.controller.unregisterCallback(it.callback) }
        tracked.clear()
        main.removeCallbacks(ticker)
        _granted.value = false
        publish()
    }

    private fun onSessions(list: List<MediaController>) {
        val tokens = list.map { it.sessionToken }.toSet()
        tracked.keys.filter { it !in tokens }.forEach { token ->
            tracked.remove(token)?.let { it.controller.unregisterCallback(it.callback) }
        }
        list.filter { !tracked.containsKey(it.sessionToken) && it.packageName !in IGNORED }.forEach { c ->
            val t = Tracked(c)
            c.registerCallback(t.callback, main)
            tracked[c.sessionToken] = t
            record(t, force = true) // something paused before we started still belongs in Continue
        }
        publish()
    }

    /** The session the phone should control: whatever is playing, else the most recently paused. */
    private fun primary(): MediaController? {
        val cs = tracked.values.map { it.controller }.filter { it.metadata != null }
        return cs.firstOrNull { it.playbackState?.state.let { s -> s == PlaybackState.STATE_PLAYING || s == PlaybackState.STATE_BUFFERING } }
            ?: cs.filter { it.playbackState?.state == PlaybackState.STATE_PAUSED }
                .maxByOrNull { it.playbackState?.lastPositionUpdateTime ?: 0L }
    }

    private fun publish() {
        val c = primary()
        if (c == null) {
            if (_now.value != null) { _now.value = null; nowArtJpeg = null; nowArtBitmap = null }
            return
        }
        val md = c.metadata ?: return
        val st = c.playbackState
        val title = md.text(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, MediaMetadata.METADATA_KEY_TITLE) ?: return
        val subtitle = md.text(
            MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, MediaMetadata.METADATA_KEY_ARTIST,
            MediaMetadata.METADATA_KEY_ALBUM_ARTIST, MediaMetadata.METADATA_KEY_ALBUM,
        )?.takeIf { it != title }
        val art = artFor(md)
        val artKey = "${c.packageName}|$title|${art?.generationId ?: 0}"
        if (art !== nowArtBitmap) {
            nowArtBitmap = art
            nowArtJpeg = art?.let { bmp ->
                ByteArrayOutputStream().use { out -> bmp.compress(Bitmap.CompressFormat.JPEG, 86, out); out.toByteArray() }
            }
        }
        _now.value = NowPlaying(
            pkg = c.packageName,
            title = title,
            subtitle = subtitle,
            state = when (st?.state) {
                PlaybackState.STATE_PLAYING -> "playing"
                PlaybackState.STATE_PAUSED -> "paused"
                PlaybackState.STATE_BUFFERING, PlaybackState.STATE_CONNECTING -> "buffering"
                else -> "stopped"
            },
            positionMs = position(c),
            durationMs = max(0L, md.getLong(MediaMetadata.METADATA_KEY_DURATION)),
            speed = st?.playbackSpeed ?: 0f,
            measuredAt = System.currentTimeMillis(),
            canSeek = (st?.actions ?: 0L) and PlaybackState.ACTION_SEEK_TO != 0L,
            artKey = if (art != null) artKey.hashCode().toUInt().toString(16) else null,
        )
    }

    private fun record(t: Tracked, force: Boolean) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - t.lastRecorded < 30_000) return
        val c = t.controller
        val md = c.metadata ?: return
        val title = md.text(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, MediaMetadata.METADATA_KEY_TITLE) ?: return
        val subtitle = md.text(
            MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, MediaMetadata.METADATA_KEY_ARTIST, MediaMetadata.METADATA_KEY_ALBUM,
        )?.takeIf { it != title }
        val pos = position(c)
        if (pos < 5_000) return // ignore sessions that never really started
        t.lastRecorded = now
        val art = artFor(md)
        val duration = max(0L, md.getLong(MediaMetadata.METADATA_KEY_DURATION))
        io.execute { Graph.history.record(c.packageName, title, subtitle, pos, duration, art) }
    }

    private fun position(c: MediaController): Long {
        val st = c.playbackState ?: return 0L
        var pos = st.position
        if (st.state == PlaybackState.STATE_PLAYING && st.lastPositionUpdateTime > 0) {
            pos += ((SystemClock.elapsedRealtime() - st.lastPositionUpdateTime) * st.playbackSpeed).toLong()
        }
        return max(0L, pos)
    }

    private fun artFor(md: MediaMetadata): Bitmap? {
        md.getBitmap(MediaMetadata.METADATA_KEY_ART)?.let { return it }
        md.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART)?.let { return it }
        md.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON)?.let { return it }
        val uri = md.text(
            MediaMetadata.METADATA_KEY_ART_URI, MediaMetadata.METADATA_KEY_ALBUM_ART_URI, MediaMetadata.METADATA_KEY_DISPLAY_ICON_URI,
        ) ?: return null
        uriArt[uri]?.let { return it }
        if (uri.startsWith("http")) {
            io.execute {
                runCatching {
                    val conn = URL(uri).openConnection() as HttpURLConnection
                    conn.connectTimeout = 4000; conn.readTimeout = 6000
                    conn.inputStream.use { BitmapFactory.decodeStream(it) }
                }.getOrNull()?.let { uriArt[uri] = it; main.post { publish() } }
            }
        }
        return null
    }

    private fun MediaMetadata.text(vararg keys: String): String? =
        keys.firstNotNullOfOrNull { key -> getString(key)?.trim()?.takeIf { it.isNotEmpty() } }

    // Commands from the phone -------------------------------------------------------------

    fun hasSession(): Boolean = primary() != null

    fun command(action: String, ms: Long = 10_000): Boolean {
        val c = primary() ?: return false
        val tc = c.transportControls
        val st = c.playbackState
        when (action) {
            "toggle" -> if (st?.state == PlaybackState.STATE_PLAYING) tc.pause() else tc.play()
            "play" -> tc.play()
            "pause" -> tc.pause()
            "seekBy" -> {
                if ((st?.actions ?: 0L) and PlaybackState.ACTION_SEEK_TO != 0L) tc.seekTo(max(0L, position(c) + ms))
                else if (ms < 0) tc.rewind() else tc.fastForward()
            }
            "seekTo" -> tc.seekTo(max(0L, ms))
            "next" -> tc.skipToNext()
            else -> return false
        }
        return true
    }
}
