package com.livingroom.tv.history

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

data class WatchEntry(
    val id: String,
    val pkg: String,
    val title: String,
    val subtitle: String?,
    val positionMs: Long,
    val durationMs: Long,
    val updatedAt: Long,
    val artFile: String?,
) {
    /** 0..1, or -1 when the app doesn't publish a duration. */
    val progress: Float get() = if (durationMs > 0) (positionMs.toFloat() / durationMs).coerceIn(0f, 1f) else -1f
    val remainingMin: Int get() = if (durationMs > 0) ((durationMs - positionMs).coerceAtLeast(0) / 60_000).toInt() else -1
}

/**
 * What this TV actually played, recorded from each app's media session.
 * Lives on the TV; the phone only reads it.
 */
class HistoryStore(context: Context) {
    private val file = File(context.filesDir, "history.json")
    private val artDir = File(context.filesDir, "art").apply { mkdirs() }

    private val _entries = MutableStateFlow<List<WatchEntry>>(emptyList())
    val entries: StateFlow<List<WatchEntry>> = _entries

    @Synchronized
    fun load() {
        if (!file.exists()) return
        runCatching {
            val arr = JSONArray(file.readText())
            _entries.value = (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                WatchEntry(
                    id = o.getString("id"),
                    pkg = o.getString("pkg"),
                    title = o.getString("title"),
                    subtitle = o.optString("subtitle").ifBlank { null },
                    positionMs = o.optLong("positionMs"),
                    durationMs = o.optLong("durationMs"),
                    updatedAt = o.optLong("updatedAt"),
                    artFile = o.optString("artFile").ifBlank { null },
                )
            }
        }.onFailure { Log.w(TAG, "Couldn't read history", it) }
    }

    @Synchronized
    fun record(pkg: String, title: String, subtitle: String?, positionMs: Long, durationMs: Long, art: Bitmap?) {
        if (title.isBlank()) return
        val id = idFor(pkg, title)
        val existing = _entries.value.firstOrNull { it.id == id }
        var artFile = existing?.artFile?.takeIf { File(artDir, it).exists() }
        if (artFile == null && art != null) {
            artFile = "$id.jpg"
            runCatching {
                File(artDir, artFile).outputStream().use { art.compress(Bitmap.CompressFormat.JPEG, 88, it) }
            }.onFailure { artFile = null }
        }
        val entry = WatchEntry(id, pkg, title, subtitle, positionMs, durationMs, System.currentTimeMillis(), artFile)
        _entries.value = (listOf(entry) + _entries.value.filter { it.id != id }).take(MAX_ENTRIES)
        persist()
    }

    @Synchronized
    fun remove(id: String) {
        _entries.value.firstOrNull { it.id == id }?.artFile?.let { File(artDir, it).delete() }
        _entries.value = _entries.value.filter { it.id != id }
        persist()
    }

    fun artFile(name: String): File? = File(artDir, name).takeIf { it.exists() && it.parentFile == artDir }

    private fun persist() {
        val arr = JSONArray()
        _entries.value.forEach { e ->
            arr.put(
                JSONObject()
                    .put("id", e.id).put("pkg", e.pkg).put("title", e.title).put("subtitle", e.subtitle ?: "")
                    .put("positionMs", e.positionMs).put("durationMs", e.durationMs)
                    .put("updatedAt", e.updatedAt).put("artFile", e.artFile ?: "")
            )
        }
        runCatching { file.writeText(arr.toString()) }.onFailure { Log.w(TAG, "Couldn't save history", it) }
    }

    companion object {
        private const val TAG = "LivingRoomHistory"
        private const val MAX_ENTRIES = 40
        private const val THREE_WEEKS = 21L * 24 * 60 * 60 * 1000

        fun idFor(pkg: String, title: String): String =
            MessageDigest.getInstance("SHA-1").digest("$pkg|$title".toByteArray())
                .take(8).joinToString("") { "%02x".format(it) }

        /** Continue row: unfinished things watched in the last three weeks, most recent first. */
        fun continueList(entries: List<WatchEntry>, now: Long = System.currentTimeMillis()): List<WatchEntry> =
            entries.filter { (it.progress < 0f || it.progress < 0.95f) && now - it.updatedAt < THREE_WEEKS }.take(12)
    }
}
