package com.livingroom.tv.history

import android.content.Context
import android.util.Log
import com.livingroom.tv.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Sends what this TV plays to House Control's hub (`POST /api/tv/history`, hub/history.py), for
 * the nightly picks. One entry per title, app and day, the latest position winning; sent a batch
 * at a time, at most once a minute, and kept in a file until the hub has taken it, so nothing is
 * lost while the hub or the Wi-Fi is down. [opened] notes the catalog title OK just opened, so
 * what plays next in that app can carry its JustWatch id.
 */
class HistorySync(context: Context, private val prefs: Prefs) {
    private val file = File(context.filesDir, "history-outbox.json")
    private val pending = LinkedHashMap<String, JSONObject>()
    private val kick = Channel<Unit>(Channel.CONFLATED)
    private val day = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    private data class Opened(val pkg: String, val id: String, val title: String, val at: Long)
    @Volatile private var lastOpened: Opened? = null

    fun start(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) {
            load()
            while (true) {
                withTimeoutOrNull(EVERY_MS) { kick.receive() }
                runCatching { flush() }.onFailure { Log.i(TAG, "Not sent yet: ${it.message}") }
            }
        }
    }

    /** The catalog title OK opened in [pkg] (its JustWatch [id]). */
    fun opened(pkg: String, id: String, title: String) {
        lastOpened = Opened(pkg, id, title, System.currentTimeMillis())
    }

    /** A title just recorded from an app's Now Playing ([HistoryStore.record]). */
    fun note(e: WatchEntry, app: String?) {
        val today = day.format(Date(e.updatedAt))
        val key = "${e.pkg}|${e.title.lowercase(Locale.ROOT)}|$today"
        synchronized(pending) {
            val first = pending[key]?.optLong("first")?.takeIf { it > 0 } ?: e.updatedAt
            val o = JSONObject()
                .put("pkg", e.pkg).put("app", app ?: JSONObject.NULL)
                .put("title", e.title).put("subtitle", e.subtitle ?: JSONObject.NULL)
                .put("positionMs", e.positionMs).put("durationMs", e.durationMs)
                .put("day", today).put("first", first).put("at", e.updatedAt)
            jwFor(e)?.let { o.put("jw", it) }
            pending[key] = o
            save()
        }
    }

    /** The title opened from the catalog when what plays is plainly it: same app, soon after. */
    private fun jwFor(e: WatchEntry): String? {
        val o = lastOpened ?: return null
        if (o.pkg != e.pkg || e.updatedAt - o.at > 4 * 3600_000L) return null
        val named = listOfNotNull(e.title, e.subtitle).any { it.contains(o.title, ignoreCase = true) }
        return if (named || e.updatedAt - o.at < 15 * 60_000L) o.id else null
    }

    private fun flush() {
        val batch = synchronized(pending) { pending.entries.take(BATCH).map { it.key to it.value } }
        if (batch.isEmpty()) return
        val body = JSONObject().put("entries", JSONArray(batch.map { it.second })).toString()
        val conn = URL(prefs.hubUrl + "/api/tv/history").openConnection() as HttpURLConnection
        conn.connectTimeout = 5_000
        conn.readTimeout = 15_000
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        try {
            conn.outputStream.use { it.write(body.toByteArray()) }
            if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")
            conn.inputStream.use { it.readBytes() }
        } finally {
            conn.disconnect()
        }
        synchronized(pending) {
            // Only what was sent goes: an entry updated meanwhile is sent again next time.
            batch.forEach { (k, v) -> if (pending[k] === v) pending.remove(k) }
            save()
        }
        if (synchronized(pending) { pending.isNotEmpty() }) kick.trySend(Unit)
    }

    private fun load() {
        runCatching {
            if (!file.exists()) return
            val arr = JSONArray(file.readText())
            synchronized(pending) {
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val key = "${o.optString("pkg")}|${o.optString("title").lowercase(Locale.ROOT)}|${o.optString("day")}"
                    pending[key] = o
                }
            }
        }.onFailure { Log.w(TAG, "Couldn't read the outbox", it) }
    }

    private fun save() {
        // Called holding the lock. A week offline is still a small file; the oldest go past MAX.
        while (pending.size > MAX) pending.remove(pending.keys.first())
        runCatching { file.writeText(JSONArray(pending.values.toList()).toString()) }
            .onFailure { Log.w(TAG, "Couldn't keep the outbox", it) }
    }

    private companion object {
        const val TAG = "LivingRoomHistorySync"
        const val EVERY_MS = 60_000L
        const val BATCH = 100
        const val MAX = 2_000
    }
}
