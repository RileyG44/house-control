package com.livingroom.tv.catalog

import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.media.tv.TvContract
import android.net.Uri
import android.util.Log
import com.livingroom.tv.input.ProfilePicker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.security.MessageDigest

/** One of an app's own picks for this TV: a Watch Next program or a preview channel's program. */
data class Recommendation(
    /** Stable for the same app and link, so the hub can ask for it to be opened ({"type": "recommendation", id}). */
    val id: String,
    val pkg: String,
    val title: String,
    /** As the app gave it: often an https address, sometimes a content:// one only the TV can read. */
    val poster: String?,
    val intentUri: String,
    /** "watchNext" or "preview". */
    val source: String,
)

/**
 * The apps' own recommendations (docs/streaming-catalog.md, source 2): what Google TV apps publish
 * to the system TV provider as Watch Next programs and preview channels (Netflix's "Top Picks",
 * YouTube's recommendations). It needs READ_EPG_DATA, which is a normal permission on this TV,
 * but whether the provider shows other apps' programs to a launcher that isn't the default Home
 * is unknown, so every query is guarded and a refusal just leaves the list empty. What is found
 * goes to /api/state as `recommendations` (at most [MAX]); the hub puts it into "For you".
 */
class TvRecommendations(private val context: Context) {
    private val _items = MutableStateFlow<List<Recommendation>>(emptyList())
    val items: StateFlow<List<Recommendation>> = _items

    fun start(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) {
            while (true) {
                runCatching { refresh() }.onFailure { Log.w(TAG, "Reading the TV provider failed", it) }
                delay(EVERY_MS)
            }
        }
    }

    fun refreshSoon(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) { runCatching { refresh() } }
    }

    private fun refresh() {
        val channels = query(TvContract.Channels.CONTENT_URI, arrayOf(PACKAGE, "display_name")) { c ->
            "${c.text(PACKAGE)}: ${c.text("display_name")}"
        }
        val watchNext = query(TvContract.WatchNextPrograms.CONTENT_URI, PROGRAM) { it.program("watchNext") }
        val preview = query(TvContract.PreviewPrograms.CONTENT_URI, PROGRAM) { it.program("preview") }
        Log.i(
            TAG,
            "TV provider: channels ${channels?.size ?: "unreadable"}, watch next ${watchNext?.size ?: "unreadable"}, " +
                "preview programs ${preview?.size ?: "unreadable"}" +
                (channels?.takeIf { it.isNotEmpty() }?.joinToString(prefix = " (", postfix = ")", limit = 12) ?: ""),
        )
        _items.value = (watchNext.orEmpty() + preview.orEmpty())
            .filter { it.pkg != context.packageName }
            .distinctBy { it.id }
            .take(MAX)
    }

    /** The rows of [uri], or null when the provider says no (or isn't there). */
    private fun <T> query(uri: Uri, projection: Array<String>, map: (Cursor) -> T?): List<T>? = try {
        context.contentResolver.query(uri, projection, null, null, null)?.use { c ->
            val out = ArrayList<T>()
            while (out.size < READ_MAX && c.moveToNext()) map(c)?.let { out += it }
            out
        } ?: emptyList()
    } catch (e: SecurityException) {
        Log.i(TAG, "Not allowed to read $uri: ${e.message}")
        null
    } catch (e: Exception) {
        Log.w(TAG, "Couldn't read $uri", e)
        null
    }

    private fun Cursor.text(column: String): String? {
        val i = getColumnIndex(column)
        return if (i < 0 || isNull(i)) null else getString(i)?.trim()?.ifBlank { null }
    }

    private fun Cursor.program(source: String): Recommendation? {
        val pkg = text(PACKAGE) ?: return null
        val title = text("title") ?: return null
        val intentUri = text("intent_uri") ?: return null
        val id = MessageDigest.getInstance("SHA-1").digest("$pkg|$intentUri".toByteArray())
            .take(8).joinToString("") { "%02x".format(it) }
        return Recommendation(id, pkg, title, text("poster_art_uri"), intentUri, source)
    }

    /**
     * Opens the recommendation [id] in its own app and nowhere else (the intent is kept to that
     * package), then watches for the app's profile picker. Call on the main thread.
     */
    fun open(context: Context, id: String): Boolean {
        val r = _items.value.firstOrNull { it.id == id } ?: return false
        val intent = runCatching { Intent.parseUri(r.intentUri, Intent.URI_INTENT_SCHEME) }.getOrNull() ?: return false
        if (intent.component?.packageName?.let { it != r.pkg } == true) intent.component = null
        intent.selector = null
        intent.setPackage(r.pkg).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(context.packageManager) == null) return false
        ProfilePicker.arm(r.pkg)
        return runCatching { context.startActivity(intent) }.isSuccess
    }

    private companion object {
        const val TAG = "LivingRoomRecs"
        const val PACKAGE = "package_name"
        val PROGRAM = arrayOf(PACKAGE, "title", "poster_art_uri", "intent_uri")
        const val MAX = 50
        const val READ_MAX = 200
        const val EVERY_MS = 30 * 60_000L
    }
}
