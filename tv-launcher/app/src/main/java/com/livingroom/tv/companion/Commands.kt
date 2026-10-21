package com.livingroom.tv.companion

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import com.livingroom.tv.Graph
import com.livingroom.tv.MainActivity
import com.livingroom.tv.input.RemoteInputService
import com.livingroom.tv.media.MediaWatcher
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/** Phone → TV commands. Each one is an intent ("open Netflix"), never a scripted chain of key presses. */
object Commands {
    private val main = Handler(Looper.getMainLooper())

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
            "launch" -> onMain { Graph.apps.launch(cmd.optString("pkg")) }
            "resume" -> {
                val entry = Graph.history.entries.value.firstOrNull { it.id == cmd.optString("id") }
                entry != null && onMain { Graph.apps.launch(entry.pkg) }
            }
            "text" -> RemoteInputService.setText(cmd.optString("text"))
            "submit" -> RemoteInputService.submit()
            "volume" -> volume(context, cmd.optInt("delta"))
            "power" -> power(context)
            else -> false
        }
        return JSONObject().put("ok", ok)
    }

    private fun showHome(context: Context): Boolean = onMain {
        runCatching {
            context.startActivity(
                Intent(context, MainActivity::class.java)
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

    /** Sleep if awake; if the screen is off, open Home with turnScreenOn so CEC wakes the TV. */
    private fun power(context: Context): Boolean {
        val awake = context.getSystemService(PowerManager::class.java)?.isInteractive ?: true
        return if (awake) RemoteInputService.sleep() else showHome(context)
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
