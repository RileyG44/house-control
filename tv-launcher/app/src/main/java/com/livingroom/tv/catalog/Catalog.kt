package com.livingroom.tv.catalog

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Log
import android.util.LruCache
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.livingroom.tv.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** One title in a row (the hub's Tile, hub/catalog.py). [poster] and [backdrop] are the hub's addresses. */
data class CatalogTile(
    val id: String,
    val title: String,
    val year: Int?,
    /** "movie", "show", or "continue" (a title in the hub's For you that is this TV's own Continue). */
    val kind: String,
    val poster: String?,
    val backdrop: String?,
    val app: String?,
    val pkg: String?,
    /** The title's page in its app, and JustWatch's Android TV deep link; the hub checked both. */
    val link: String?,
    val tvLink: String?,
    val blurb: String?,
    val runtime: Int?,
    val rating: Double?,
    val age: String?,
) {
    /** What OK tries, in order: the deep link (as the https address it stands for), then the page. */
    val openUrls: List<String> get() = listOfNotNull(tvLink?.let(::httpsForm), link?.let(::httpsForm)).distinct()

    /** "2022 · Show · 50 min · TV-14 · IMDb 8.1", for the hero. */
    val facts: String get() = listOfNotNull(
        year?.toString(),
        when (kind) { "movie" -> "Movie"; "show" -> "Show"; else -> null },
        runtime?.let { if (it >= 60) "${it / 60} h ${it % 60} min" else "$it min" },
        age,
        rating?.let { "IMDb %.1f".format(it) },
    ).joinToString("  ·  ")
}

data class CatalogRow(val key: String, val title: String, val items: List<CatalogTile>)

data class CatalogApp(val id: String, val name: String, val pkg: String, val rows: List<CatalogRow>)

data class Catalog(val apps: List<CatalogApp>, val forYou: List<CatalogTile>, val fetchedAt: Long)

/** An Android intent link as the https address it stands for, the way the hub's tv.https_form reads it. */
fun httpsForm(url: String): String =
    if (url.startsWith("intent://")) "https://" + url.removePrefix("intent://").substringBefore("#Intent;") else url

/**
 * The streaming catalog for the Home rows (docs/streaming-catalog.md): read from House Control's
 * hub (`GET /api/tv/catalog`), never from JustWatch, so the TV's own work stays small. The hub's
 * address comes from [Prefs.hubUrl] (set at pairing, or with /api/settings {"hub"}). The last
 * answer is kept in a file, so the rows are there at once after a restart; it is read again
 * every [EVERY_MS], when Home comes back after [STALE_MS], and when the hub's address changes.
 * Titles hidden with a long press stay hidden ([Prefs.hiddenTitles]).
 */
class CatalogRepository(context: Context, private val prefs: Prefs) {
    private val file = File(context.filesDir, "catalog.json")
    private val _catalog = MutableStateFlow<Catalog?>(null)
    val catalog: StateFlow<Catalog?> = _catalog

    private val _hidden = MutableStateFlow(prefs.hiddenTitles)
    val hidden: StateFlow<Set<String>> = _hidden

    private val kick = Channel<Unit>(Channel.CONFLATED)

    fun start(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) {
            runCatching { if (file.exists()) _catalog.value = parse(JSONObject(file.readText()), file.lastModified()) }
                .onFailure { Log.w(TAG, "Couldn't read the kept catalog", it) }
            while (true) {
                val ok = runCatching { refresh() }
                    .onFailure { Log.w(TAG, "Catalog refresh failed", it) }
                    .getOrDefault(false)
                withTimeoutOrNull(if (ok) EVERY_MS else RETRY_MS) { kick.receive() }
            }
        }
    }

    /** Read the catalog again now (the hub's address changed, or Riley asked). */
    fun refreshSoon() {
        kick.trySend(Unit)
    }

    /** Home came back: read again if the rows are older than [STALE_MS]. */
    fun refreshIfOld() {
        val at = _catalog.value?.fetchedAt ?: 0L
        if (System.currentTimeMillis() - at > STALE_MS) refreshSoon()
    }

    fun hide(id: String) {
        prefs.hiddenTitles = prefs.hiddenTitles + id
        _hidden.value = prefs.hiddenTitles
    }

    private fun refresh(): Boolean {
        val hub = prefs.hubUrl
        val conn = URL("$hub/api/tv/catalog").openConnection() as HttpURLConnection
        conn.connectTimeout = 5_000
        // The hub may ask JustWatch for every row the first time.
        conn.readTimeout = 45_000
        try {
            if (conn.responseCode != 200) return false
            val text = conn.inputStream.use { it.readLimited(MAX_JSON) }?.decodeToString() ?: return false
            val now = System.currentTimeMillis()
            _catalog.value = parse(JSONObject(text), now)
            runCatching { file.writeText(text) }
            return true
        } finally {
            conn.disconnect()
        }
    }

    private fun parse(o: JSONObject, at: Long): Catalog {
        val apps = o.optJSONArray("apps").objects().mapNotNull { a ->
            val pkg = a.optString("pkg").ifBlank { return@mapNotNull null }
            val rows = a.optJSONArray("rows").objects().mapNotNull { r ->
                val items = r.optJSONArray("items").objects().mapNotNull(::tile)
                if (items.isEmpty()) null else CatalogRow(r.optString("key"), r.optString("title"), items)
            }
            if (rows.isEmpty()) null else CatalogApp(a.optString("id"), a.optString("name"), pkg, rows)
        }
        return Catalog(apps, o.optJSONArray("forYou").objects().mapNotNull(::tile), at)
    }

    private fun tile(t: JSONObject): CatalogTile? {
        val id = t.optString("id").ifBlank { return null }
        val title = t.optString("title").ifBlank { return null }
        return CatalogTile(
            id = id,
            title = title,
            year = t.optIntOrNull("year"),
            kind = t.optString("kind", "movie"),
            poster = t.optUrl("poster"),
            backdrop = t.optUrl("backdrop"),
            app = t.optStringOrNull("app"),
            pkg = t.optStringOrNull("pkg"),
            link = t.optStringOrNull("link"),
            tvLink = t.optStringOrNull("tvLink"),
            blurb = t.optStringOrNull("blurb"),
            runtime = t.optIntOrNull("runtime"),
            rating = if (t.isNull("rating") || !t.has("rating")) null else t.optDouble("rating").takeIf { !it.isNaN() },
            age = t.optStringOrNull("age"),
        )
    }

    companion object {
        private const val TAG = "LivingRoomCatalog"
        private const val EVERY_MS = 3 * 3600_000L
        private const val RETRY_MS = 5 * 60_000L
        private const val STALE_MS = 3600_000L
        private const val MAX_JSON = 6 * 1024 * 1024
    }
}

private fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

private fun JSONObject.optStringOrNull(key: String): String? =
    if (isNull(key) || !has(key)) null else optString(key).ifBlank { null }

private fun JSONObject.optIntOrNull(key: String): Int? =
    if (isNull(key) || !has(key)) null else optInt(key, Int.MIN_VALUE).takeIf { it != Int.MIN_VALUE }

private fun JSONObject.optUrl(key: String): String? =
    optStringOrNull(key)?.takeIf { it.startsWith("http://") || it.startsWith("https://") }

/** At most [limit] bytes, or null when there are more. */
private fun InputStream.readLimited(limit: Int): ByteArray? {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(16 * 1024)
    while (true) {
        val n = read(buf)
        if (n < 0) return out.toByteArray()
        out.write(buf, 0, n)
        if (out.size() > limit) return null
    }
}

/**
 * Posters and backdrops for the catalog rows, from the hub. On disk at most [DISK_BYTES]
 * (about 40 MB; the least recently used go first), and decoded small in memory: this is a
 * 2 GB, 32-bit TV, so each picture is decoded no wider than it is shown (posters about 180 px),
 * as RGB_565, and the decoded ones are held in an LRU of [MEMORY_BYTES].
 */
class ArtCache(context: Context) {
    private val dir = File(context.cacheDir, "catalog-art").apply { mkdirs() }
    private val memory = object : LruCache<String, ImageBitmap>(MEMORY_BYTES) {
        override fun sizeOf(key: String, value: ImageBitmap): Int = value.asAndroidBitmap().byteCount
    }
    private val fetches = Semaphore(3)
    private val diskLock = Any()
    private var diskBytes = -1L

    fun cached(url: String, maxWidth: Int): ImageBitmap? = memory.get("$maxWidth|$url")

    suspend fun load(url: String, maxWidth: Int): ImageBitmap? {
        val key = "$maxWidth|$url"
        memory.get(key)?.let { return it }
        return withContext(Dispatchers.IO) {
            val file = File(dir, name(url))
            if (file.exists()) {
                file.setLastModified(System.currentTimeMillis())
            } else {
                fetches.withPermit { if (!file.exists()) download(url, file) }
            }
            if (!file.exists()) return@withContext null
            runCatching { decode(file, maxWidth) }
                .onFailure { file.delete() }
                .getOrNull()
                ?.asImageBitmap()
                ?.also { memory.put(key, it) }
        }
    }

    /** The file is named for the picture's path on the hub, so a hub that moved keeps its pictures. */
    private fun name(url: String): String {
        val path = runCatching { URL(url).let { it.path + "?" + (it.query ?: "") } }.getOrDefault(url)
        return MessageDigest.getInstance("SHA-1").digest(path.toByteArray()).joinToString("") { "%02x".format(it) } + ".img"
    }

    private fun download(url: String, file: File) {
        runCatching {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 5_000
            conn.readTimeout = 15_000
            try {
                if (conn.responseCode != 200 || conn.contentType?.startsWith("image/") != true) return
                val bytes = conn.inputStream.use { it.readLimited(MAX_PICTURE) } ?: return
                val tmp = File(dir, file.name + ".tmp")
                tmp.writeBytes(bytes)
                if (tmp.renameTo(file)) kept(bytes.size.toLong()) else tmp.delete()
            } finally {
                conn.disconnect()
            }
        }.onFailure { Log.i(TAG, "No picture at $url: ${it.message}") }
    }

    /** Counts a new file; past [DISK_BYTES], the least recently used go until 80% is left. */
    private fun kept(added: Long) {
        synchronized(diskLock) {
            val files = dir.listFiles { f -> f.name.endsWith(".img") }?.toList() ?: return
            diskBytes = if (diskBytes < 0) files.sumOf { it.length() } else diskBytes + added
            if (diskBytes <= DISK_BYTES) return
            var total = files.sumOf { it.length() }
            for (f in files.sortedBy { it.lastModified() }) {
                if (total <= DISK_BYTES * 8 / 10) break
                val size = f.length()
                if (f.delete()) total -= size
            }
            diskBytes = total
        }
    }

    /** Decoded no wider than [maxWidth] (a power-of-two sample, then scaled), without alpha. */
    private fun decode(file: File, maxWidth: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.path, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxWidth) sample *= 2
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.RGB_565
        }
        val bitmap = BitmapFactory.decodeFile(file.path, opts) ?: return null
        if (bitmap.width <= maxWidth * 5 / 4) return bitmap
        val height = (bitmap.height.toLong() * maxWidth / bitmap.width).toInt().coerceAtLeast(1)
        val scaled = Bitmap.createScaledBitmap(bitmap, maxWidth, height, true)
        if (scaled !== bitmap) bitmap.recycle()
        return scaled
    }

    companion object {
        private const val TAG = "LivingRoomArt"
        private const val DISK_BYTES = 40L * 1024 * 1024
        private const val MEMORY_BYTES = 16 * 1024 * 1024
        private const val MAX_PICTURE = 3 * 1024 * 1024
    }
}
