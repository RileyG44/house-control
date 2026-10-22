package com.livingroom.tv.companion

import android.content.Context
import android.util.Log
import com.livingroom.tv.Graph
import com.livingroom.tv.Prefs
import com.livingroom.tv.media.MediaWatcher
import fi.iki.elonen.NanoHTTPD
import org.json.JSONObject
import kotlinx.coroutines.runBlocking
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * The launcher's API on port 8686, for House Control's hub and its iPhone app.
 * GET /api/state   long-poll for TV state (?since=rev)
 * POST /api/cmd    {type: key|primary|media|seek|launch|open|resume|text|submit|volume|mute|power|wake|sleep}
 * POST /api/wallpaper        raw image bytes (JPEG/PNG/HEIC); /api/wallpaper/clear removes it
 * POST /api/settings         {name?, profile?, location?: {lat, lon, place?, country?} | null}
 * Every /api call must carry the pairing token (?k= or X-LR-Key).
 *
 * The iPhone app pairs without the QR code:
 * GET /pair/hello    who this TV is, and whether the caller's token is still good
 * POST /pair/start   shows a 4-digit code on the TV
 * POST /pair/finish  {code} → {token}
 * POST /pair/cancel  hides the code
 */
class CompanionServer(
    private val context: Context,
    private val prefs: Prefs,
    private val hub: StateHub,
    private val pairing: Pairing,
) : NanoHTTPD(PORT) {

    fun startSafely() {
        runCatching { start(SOCKET_READ_TIMEOUT, false) }
            .onSuccess {
                Log.i(TAG, "Remote at ${pairingUrl()}")
                writePairingFile()
            }
            .onFailure { Log.w(TAG, "Couldn't start companion server", it) }
    }

    /** For tools/tv-install.sh: readable over ADB without run-as. */
    fun writePairingFile() {
        runCatching { context.getExternalFilesDir(null)?.resolve("pairing.txt")?.writeText(pairingUrl()) }
    }

    override fun serve(session: IHTTPSession): Response = try {
        val uri = session.uri
        when {
            uri.startsWith("/icon/") -> image(Graph.apps.png(uri.removePrefix("/icon/"), banner = false), "image/png")
            uri.startsWith("/banner/") -> image(Graph.apps.png(uri.removePrefix("/banner/"), banner = true), "image/png")
            uri == "/art/now" -> image(MediaWatcher.nowArtJpeg, "image/jpeg")
            uri.startsWith("/art/h/") -> historyArt(uri.removePrefix("/art/h/"))
            uri.startsWith("/pair/") -> pair(session)
            uri.startsWith("/api/") -> if (authorized(session)) api(session) else json(JSONObject().put("error", "pair"), Response.Status.UNAUTHORIZED)
            else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found")
        }
    } catch (e: Exception) {
        Log.w(TAG, "Request failed: ${session.uri}", e)
        newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Error")
    }

    private fun authorized(session: IHTTPSession): Boolean {
        val key = session.headers["x-lr-key"] ?: session.parameters["k"]?.firstOrNull()
        return key == prefs.token
    }

    private fun api(session: IHTTPSession): Response = when (session.uri) {
        "/api/state" -> {
            val since = session.parameters["since"]?.firstOrNull()?.toLongOrNull() ?: -1L
            hub.awaitChange(since, 25_000)
            json(hub.stateJson(context))
        }
        "/api/wallpaper" -> {
            val length = session.headers["content-length"]?.toIntOrNull() ?: 0
            if (length <= 0 || length > MAX_UPLOAD) {
                json(JSONObject().put("ok", false).put("error", "size"), Response.Status.BAD_REQUEST)
            } else {
                val bytes = ByteArray(length)
                DataInputStream(session.inputStream).readFully(bytes)
                json(JSONObject().put("ok", runBlocking { Graph.wallpaper.set(bytes) }))
            }
        }
        "/api/wallpaper/clear" -> { Graph.wallpaper.clear(); json(JSONObject().put("ok", true)) }
        "/api/settings" -> {
            val files = HashMap<String, String>()
            session.parseBody(files)
            val body = JSONObject(files["postData"] ?: "{}")
            if (body.has("name")) {
                prefs.ownerName = body.optString("name")
                hub.ownerName.value = prefs.ownerName
            }
            if (body.has("profile")) prefs.profile = body.optString("profile")
            if (body.has("location")) {
                prefs.location = body.optJSONObject("location")
                Graph.weather.refreshSoon(Graph.scope)
            }
            hub.bump()
            json(JSONObject().put("ok", true))
        }
        "/api/cmd" -> {
            val files = HashMap<String, String>()
            session.parseBody(files)
            val body = files["postData"] ?: session.queryParameterString ?: "{}"
            json(Commands.run(context, JSONObject(body)))
        }
        else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found")
    }

    private fun pair(session: IHTTPSession): Response = when (session.uri) {
        "/pair/hello" -> json(JSONObject()
            .put("name", prefs.tvName).put("id", prefs.deviceId).put("v", 1)
            .put("paired", authorized(session))
            .put("tailnet", tailnetIp()))
        "/pair/start" -> json(JSONObject().put("ok", pairing.start()))
        "/pair/finish" -> {
            val files = HashMap<String, String>()
            session.parseBody(files)
            val code = runCatching { JSONObject(files["postData"] ?: "{}").optString("code") }.getOrDefault("")
            pairing.finish(code)
                ?.let { json(JSONObject().put("token", it).put("name", prefs.tvName).put("id", prefs.deviceId)) }
                ?: json(JSONObject().put("error", "code"), Response.Status.FORBIDDEN)
        }
        "/pair/cancel" -> { pairing.cancel(); json(JSONObject().put("ok", true)) }
        else -> newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found")
    }

    private fun image(bytes: ByteArray?, mime: String): Response =
        if (bytes == null) newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "No image")
        else newFixedLengthResponse(Response.Status.OK, mime, ByteArrayInputStream(bytes), bytes.size.toLong())
            .apply { addHeader("Cache-Control", "max-age=300") }

    private fun historyArt(id: String): Response {
        val entry = Graph.history.entries.value.firstOrNull { it.id == id }
        val file = entry?.artFile?.let { Graph.history.artFile(it) }
        return image(file?.readBytes(), "image/jpeg")
    }

    private fun json(o: JSONObject, status: Response.Status = Response.Status.OK): Response =
        newFixedLengthResponse(status, "application/json", o.toString())
            .apply { addHeader("Cache-Control", "no-store") }

    fun pairingUrl(): String = "http://${localIp() ?: "tv.local"}:$PORT/?k=${prefs.token}"

    companion object {
        private const val TAG = "LivingRoomServer"
        const val PORT = 8686
        private const val MAX_UPLOAD = 40 * 1024 * 1024

        /** This TV's Tailscale address (100.64.0.0/10), if Tailscale is connected. */
        fun tailnetIp(): String? = runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .firstOrNull { val b = it.address; (b[0].toInt() and 0xFF) == 100 && (b[1].toInt() and 0xC0) == 64 }
                ?.hostAddress
        }.getOrNull()

        fun localIp(): String? = runCatching {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .firstOrNull { it.isSiteLocalAddress }?.hostAddress
        }.getOrNull()
    }
}
