package com.livingroom.tv.companion

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import com.livingroom.tv.Graph
import com.livingroom.tv.MainActivity
import com.livingroom.tv.input.ProfilePicker
import com.livingroom.tv.input.RemoteInputService
import com.livingroom.tv.media.MediaWatcher
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/** Phone → TV commands. Each one is an intent ("open Netflix"), never a scripted chain of key presses. */
object Commands {
    private val main = Handler(Looper.getMainLooper())
    private const val NETFLIX = "com.netflix.ninja"

    fun run(context: Context, cmd: JSONObject): JSONObject {
        val ok = when (cmd.optString("type")) {
            "key" -> when (val key = cmd.optString("key")) {
                "home" -> showHome(context)
                else -> RemoteInputService.key(key)
            }
            // The big play button: control the session if there is one, otherwise press OK.
            "primary" -> if (Graph.hub.homeVisible.value || !MediaWatcher.hasSession()) RemoteInputService.key("center")
                         else MediaWatcher.command("toggle")
            "media" -> onMain { MediaWatcher.command(cmd.optString("action"), cmd.optLong("ms", 10_000)) }
            "seek" -> cmd.has("positionMs") && onMain { MediaWatcher.seekTo(cmd.optLong("positionMs")) }
            "launch" -> onMain { Graph.apps.launch(cmd.optString("pkg")) }
            "open" -> onMain { open(context, cmd.optString("url"), cmd.optString("pkg")) }
            // One of the apps' own recommendations this launcher read from the TV provider.
            "recommendation" -> onMain { Graph.recommendations.open(context, cmd.optString("id")) }
            "resume" -> {
                val entry = Graph.history.entries.value.firstOrNull { it.id == cmd.optString("id") }
                entry != null && onMain { Graph.apps.launch(entry.pkg) }
            }
            "text" -> RemoteInputService.setText(cmd.optString("text"))
            "submit" -> RemoteInputService.submit()
            "volume" -> if (cmd.has("level")) volumeTo(context, cmd.optInt("level", -1)) else volume(context, cmd.optInt("delta"))
            "mute" -> mute(context)
            "power" -> power(context)
            "wake" -> if (awake(context)) true else showHome(context)
            "sleep" -> if (awake(context)) RemoteInputService.sleep() else true
            else -> false
        }
        return JSONObject().put("ok", ok)
    }

    private fun showHome(context: Context): Boolean = onMain {
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java)
                    .setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            )
        }.isSuccess
    }

    /**
     * Relative volume. On a Chromecast with HDMI-CEC volume control, Android forwards
     * stream volume changes to the TV or soundbar.
     */
    private fun volume(context: Context, delta: Int): Boolean {
        if (delta == 0) return true
        val am = context.getSystemService(AudioManager::class.java) ?: return false
        val direction = if (delta > 0) AudioManager.ADJUST_RAISE else AudioManager.ADJUST_LOWER
        repeat(abs(delta).coerceAtMost(10)) {
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, AudioManager.FLAG_SHOW_UI)
        }
        return true
    }

    /**
     * Absolute volume, from 0 to the stream's maximum (the state's `volumeMax`). Where the
     * Chromecast's own volume is fixed and every change goes to the TV over HDMI-CEC, there is
     * no level to set, so this says no and the caller steps with [volume] instead.
     */
    private fun volumeTo(context: Context, level: Int): Boolean {
        val am = context.getSystemService(AudioManager::class.java) ?: return false
        if (level < 0 || am.isVolumeFixed) return false
        val stream = AudioManager.STREAM_MUSIC
        am.setStreamVolume(stream, level.coerceIn(am.getStreamMinVolume(stream), am.getStreamMaxVolume(stream)), AudioManager.FLAG_SHOW_UI)
        return true
    }

    /** Mutes, or unmutes when muted. Like the volume, CEC passes it on to the TV. */
    private fun mute(context: Context): Boolean {
        val am = context.getSystemService(AudioManager::class.java) ?: return false
        am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI)
        return true
    }

    private fun awake(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)?.isInteractive ?: true

    /** Sleep if awake; if the screen is off, open Home with turnScreenOn so CEC wakes the TV. */
    private fun power(context: Context): Boolean =
        if (awake(context)) RemoteInputService.sleep() else showHome(context)

    /**
     * Opens [url] (a title's page, from House Control's search or the Home catalog rows) in the
     * app [pkg] and nowhere else. The hub checks the link belongs to that app before it asks.
     * False when the app has nothing that opens it. Started like
     * [com.livingroom.tv.apps.AppsRepository.launch]: the accessibility service lets the launcher
     * start activities while it is in the background. Call on the main thread.
     */
    fun open(context: Context, url: String, pkg: String): Boolean {
        if (url.isBlank() || pkg.isBlank()) return false
        val uri = runCatching { Uri.parse(url) }.getOrNull()?.takeIf { it.scheme == "https" || it.scheme == "http" } ?: return false
        val intent = Intent(Intent.ACTION_VIEW, uri).setPackage(pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (pkg == NETFLIX) {
            // What Netflix's own Android TV links carry (JustWatch's deeplinkURL, and ~/tv-remote):
            // without source=30 a title link can land on the catalog instead of the title. Fixed
            // values, never extras taken from a link.
            intent.putExtra("source", "30").addFlags(Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS)
        }
        if (intent.resolveActivity(context.packageManager) == null) return false
        ProfilePicker.arm(pkg, launched = true, title = true)
        return runCatching { context.startActivity(intent) }.isSuccess
    }

    private fun onMain(block: () -> Boolean): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        var result = false
        val latch = CountDownLatch(1)
        main.post { result = runCatching(block).getOrDefault(false); latch.countDown() }
        latch.await(3, TimeUnit.SECONDS)
        return result
    }
}
