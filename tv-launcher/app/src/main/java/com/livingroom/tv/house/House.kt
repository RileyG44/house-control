package com.livingroom.tv.house

import android.util.Log
import com.livingroom.tv.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** A light in the hub's plan. [y] is the height of its glow in metres, for the studio render. */
data class HouseLight(
    val id: String,
    val name: String,
    val room: String,
    val type: String,
    val caps: Set<String>,
    val x: Double,
    val y: Double,
    val z: Double,
)

data class HouseAc(
    val id: String,
    val name: String,
    val room: String,
    val unit: String,
    val min: Int,
    val max: Int,
    val x: Double,
    val y: Double,
    val z: Double,
)

/** A scene from the plan: a patch per light ("*" for every light) and per AC. */
data class Scene(
    val id: String,
    val name: String,
    val icon: String,
    val lights: Map<String, JSONObject>,
    val acs: Map<String, JSONObject>,
    val tvs: Map<String, JSONObject> = emptyMap(),
)

data class LightState(val on: Boolean, val brightness: Float, val temp: Int?, val color: String?)

data class AcState(val on: Boolean, val mode: String, val target: Int, val fan: String?, val roomTemp: Double?)

data class AcFeatures(val modes: List<String>, val fans: List<String>)

/** The home as the hub's plan draws it (the panel's tiles, in their order), and its scenes. */
data class House(
    val name: String,
    val lights: List<HouseLight>,
    val acs: List<HouseAc>,
    val scenes: List<Scene>,
    val rooms: Map<String, String>,
)

data class HouseState(
    val lights: Map<String, LightState> = emptyMap(),
    val acs: Map<String, AcState> = emptyMap(),
    val features: Map<String, AcFeatures> = emptyMap(),
) {
    fun lightsOn(house: House): Int = house.lights.count { lights[it.id]?.on == true }
}

/**
 * The house through House Control's hub ([Prefs.hubUrl]): the plan from `GET /api/plan`, the
 * devices' state from the server-sent events of `GET /api/events` (only while Home is on screen),
 * and changes as `POST /api/call {type: "command"}`, exactly as the web panel sends them
 * (web/src/store.js): optimistic, one request per device in flight, later changes merged into a
 * single follow-up, and a change the hub refuses rolled back.
 */
class HouseRepository(private val prefs: Prefs) {
    private val _house = MutableStateFlow<House?>(null)
    val house: StateFlow<House?> = _house

    private val _state = MutableStateFlow(HouseState())
    val state: StateFlow<HouseState> = _state

    /** The scene last applied from this TV, until a device is changed by hand. */
    private val _scene = MutableStateFlow<String?>(null)
    val scene: StateFlow<String?> = _scene

    private val _errors = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val errors: SharedFlow<String> = _errors

    private lateinit var scope: CoroutineScope
    private val outbox = HashMap<String, Slot>()

    private class Slot(var pending: JSONObject? = null, var before: JSONObject? = null)

    fun start(scope: CoroutineScope, visible: StateFlow<Boolean>) {
        this.scope = scope
        scope.launch(Dispatchers.IO) {
            visible.collectLatest { shown ->
                if (!shown) return@collectLatest
                if (_house.value == null) runCatching { loadPlan() }.onFailure { Log.w(TAG, "No plan yet", it) }
                follow()
            }
        }
    }

    // ---------- reading ----------

    private fun loadPlan() {
        val plan = JSONObject(get("/api/plan"))
        val limits = runCatching { acLimits(JSONObject(get("/api/devices"))) }.getOrDefault(emptyMap())
        _house.value = parsePlan(plan, limits)
    }

    /** Each linked AC's range and unit, from /api/devices (the plan doesn't carry them). */
    private fun acLimits(devices: JSONObject): Map<String, Triple<Int, Int, String>> {
        val out = HashMap<String, Triple<Int, Int, String>>()
        devices.optJSONArray("acs").objects().forEach { a ->
            val limit = Triple(a.optInt("min", 61), a.optInt("max", 86), a.optString("unit", "F"))
            a.optJSONArray("linked")?.let { ids -> for (i in 0 until ids.length()) out[ids.getString(i)] = limit }
        }
        return out
    }

    /** Reads the events until the connection drops or Home goes away; then tries again shortly. */
    private suspend fun follow() {
        var wait = 2_000L
        while (kotlin.coroutines.coroutineContext.isActive) {
            val ok = runCatching { stream() }.onFailure { Log.i(TAG, "Events: ${it.message}") }.isSuccess
            if (!kotlin.coroutines.coroutineContext.isActive) return
            delay(if (ok) 1_000L else wait)
            wait = (wait * 2).coerceAtMost(30_000L)
        }
    }

    private suspend fun stream() = withContext(Dispatchers.IO) {
        val conn = URL(prefs.hubUrl + "/api/events").openConnection() as HttpURLConnection
        conn.connectTimeout = 5_000
        conn.readTimeout = 45_000 // the hub writes a keep-alive every 20 s
        try {
            val reader = conn.inputStream.bufferedReader()
            while (isActive) {
                val line = reader.readLine() ?: break
                if (!line.startsWith("data: ")) continue
                val msg = runCatching { JSONObject(line.removePrefix("data: ")) }.getOrNull() ?: continue
                if (msg.optBoolean("reload")) runCatching { loadPlan() }
                if (msg.has("lights") || msg.has("acs") || msg.has("features")) merge(msg)
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun busy(id: String) = synchronized(outbox) { outbox[id] != null }

    private fun merge(msg: JSONObject) = _state.update { cur ->
        val lights = cur.lights.toMutableMap()
        msg.optJSONObject("lights")?.let { o ->
            o.keys().forEach { id ->
                val s = o.optJSONObject(id) ?: return@forEach
                // A device's report never overrides a change still on its way to it.
                if (!busy(id)) lights[id] = lightState(s)
            }
        }
        val acs = cur.acs.toMutableMap()
        msg.optJSONObject("acs")?.let { o ->
            o.keys().forEach { id ->
                val s = o.optJSONObject(id) ?: return@forEach
                if (!busy(id)) acs[id] = acState(s)
            }
        }
        val features = cur.features.toMutableMap()
        msg.optJSONObject("features")?.let { o ->
            o.keys().forEach { id ->
                val f = o.optJSONObject(id) ?: return@forEach
                features[id] = AcFeatures(f.optJSONArray("modes").strings(), f.optJSONArray("fans").strings())
            }
        }
        HouseState(lights, acs, features)
    }

    // ---------- changing ----------

    fun toggle(light: HouseLight) {
        val on = _state.value.lights[light.id]?.on ?: false
        setLight(light, JSONObject().put("on", !on))
    }

    /** Brightness up or down a step; up from off turns the light on at the lowest step. */
    fun stepBrightness(light: HouseLight, up: Boolean) {
        if ("brightness" !in light.caps) return
        val s = _state.value.lights[light.id] ?: return
        if (!s.on) {
            if (up) setLight(light, JSONObject().put("on", true).put("brightness", .1))
            return
        }
        val next = ((Math.round(s.brightness * 10) + if (up) 1 else -1) / 10.0).coerceIn(.1, 1.0)
        if (next != s.brightness.toDouble()) setLight(light, JSONObject().put("brightness", next))
    }

    fun setLight(light: HouseLight, raw: JSONObject, byScene: Boolean = false) {
        val patch = sanitize(light, raw)
        val cur = _state.value.lights[light.id] ?: LightState(false, 1f, null, null)
        val next = cur.copy(
            on = if (patch.has("on")) patch.getBoolean("on") else cur.on,
            brightness = if (patch.has("brightness")) patch.getDouble("brightness").toFloat() else cur.brightness,
            temp = if (patch.has("temp")) patch.getInt("temp") else cur.temp,
            color = if (patch.has("color")) patch.optString("color").takeIf { !patch.isNull("color") } else cur.color,
        )
        if (next == cur) return
        val before = lightJson(cur)
        _state.update { it.copy(lights = it.lights + (light.id to next)) }
        if (!byScene) _scene.value = null
        dispatch("light", light.id, patch, before)
    }

    fun stepAc(ac: HouseAc, up: Boolean) {
        val s = _state.value.acs[ac.id] ?: return
        setAc(ac, JSONObject().put("target", (s.target + if (up) 1 else -1).coerceIn(ac.min, ac.max)))
    }

    fun toggleAc(ac: HouseAc) {
        val s = _state.value.acs[ac.id] ?: return
        setAc(ac, JSONObject().put("on", !s.on))
    }

    fun setAc(ac: HouseAc, patch: JSONObject, byScene: Boolean = false) {
        val cur = _state.value.acs[ac.id] ?: return
        if (patch.has("target")) patch.put("target", patch.getInt("target").coerceIn(ac.min, ac.max))
        val next = cur.copy(
            on = if (patch.has("on")) patch.getBoolean("on") else cur.on,
            mode = patch.optString("mode", cur.mode),
            target = if (patch.has("target")) patch.getInt("target") else cur.target,
            fan = if (patch.has("fan")) patch.optString("fan") else cur.fan,
        )
        if (next == cur) return
        val before = JSONObject().put("on", cur.on).put("mode", cur.mode).put("target", cur.target).put("fan", cur.fan ?: JSONObject.NULL)
        _state.update { it.copy(acs = it.acs + (ac.id to next)) }
        if (!byScene) _scene.value = null
        dispatch("ac", ac.id, patch, before)
    }

    /** As the panel's applyScene: "*" then the light's own patch; a white temperature drops the colour. */
    fun applyScene(scene: Scene) {
        val house = _house.value ?: return
        for (light in house.lights) {
            val patch = JSONObject()
            listOf(scene.lights["*"], scene.lights[light.id]).forEach { p -> p?.keys()?.forEach { k -> patch.put(k, p.get(k)) } }
            if (!patch.has("color") && patch.has("temp")) patch.put("color", JSONObject.NULL)
            if (patch.length() > 0) setLight(light, patch, byScene = true)
        }
        for (ac in house.acs) {
            val patch = JSONObject()
            listOf(scene.acs["*"], scene.acs[ac.id]).forEach { p -> p?.keys()?.forEach { k -> patch.put(k, p.get(k)) } }
            if (patch.length() > 0) setAc(ac, patch, byScene = true)
        }
        _scene.value = scene.id
        for ((id, action) in scene.tvs) {
            val app = action.optString("app").takeIf { it.isNotBlank() } ?: continue
            scope.launch(Dispatchers.IO) {
                runCatching {
                    val reply = JSONObject(post("/api/tv/${java.net.URLEncoder.encode(id, "UTF-8")}",
                        JSONObject().put("action", "open").put("app", app).put("name", action.optString("name", app))))
                    reply.optString("error").takeIf { it.isNotBlank() }?.let { _errors.tryEmit(it) }
                }.onFailure { _errors.tryEmit("The TV app could not be opened.") }
            }
        }
    }

    private fun sanitize(light: HouseLight, p: JSONObject): JSONObject {
        val out = JSONObject()
        if (p.has("on")) out.put("on", p.optBoolean("on"))
        if (p.has("brightness") && "brightness" in light.caps) out.put("brightness", p.getDouble("brightness").coerceIn(.05, 1.0))
        if (p.has("temp") && !p.isNull("temp") && "temp" in light.caps) {
            out.put("temp", p.getInt("temp").coerceIn(2200, 6500))
            out.put("color", JSONObject.NULL)
        }
        if (p.has("color") && "color" in light.caps) out.put("color", if (p.isNull("color")) JSONObject.NULL else p.getString("color"))
        return out
    }

    // One command per device in flight; changes made meanwhile go as one follow-up (store.js).
    private fun dispatch(kind: String, id: String, patch: JSONObject, before: JSONObject) {
        synchronized(outbox) {
            outbox[id]?.let { slot ->
                val pending = slot.pending ?: JSONObject()
                patch.keys().forEach { pending.put(it, patch.get(it)) }
                slot.pending = pending
                val oldest = slot.before ?: JSONObject()
                before.keys().forEach { if (!oldest.has(it)) oldest.put(it, before.get(it)) }
                slot.before = oldest
                return
            }
            outbox[id] = Slot()
        }
        scope.launch(Dispatchers.IO) { run(kind, id, patch, before) }
    }

    private suspend fun run(kind: String, id: String, patch: JSONObject, before: JSONObject) {
        var (p, b) = patch to before
        while (true) {
            val started = System.currentTimeMillis()
            val error = send(kind, id, p)
            if (error != null) rollback(kind, id, p, b, error)
            delay(((if (kind == "light") 300L else 900L) - (System.currentTimeMillis() - started)).coerceAtLeast(0))
            synchronized(outbox) {
                val slot = outbox[id]
                val next = slot?.pending
                if (slot == null || next == null) {
                    outbox.remove(id)
                    return
                }
                p = next
                b = slot.before ?: JSONObject()
                slot.pending = null
                slot.before = null
            }
        }
    }

    /** null when the hub took it, else what went wrong. */
    private fun send(kind: String, id: String, patch: JSONObject): String? = runCatching {
        val state = when (kind) {
            "light" -> _state.value.lights[id]?.let(::lightJson)
            else -> _state.value.acs[id]?.let { JSONObject().put("on", it.on).put("mode", it.mode).put("target", it.target).put("fan", it.fan ?: JSONObject.NULL) }
        } ?: JSONObject()
        val body = JSONObject().put("type", "command").put("kind", kind).put("id", id).put("patch", patch).put("state", state)
        val reply = JSONObject(post("/api/call", body))
        reply.optString("error").ifBlank { null }
    }.getOrElse { it.message ?: "The hub didn't answer" }

    private fun rollback(kind: String, id: String, patch: JSONObject, before: JSONObject, error: String) {
        Log.w(TAG, "$id refused $patch: $error")
        _state.update { cur ->
            if (kind == "light") {
                val s = cur.lights[id] ?: return@update cur
                var next = s
                if (patch.has("on") && before.has("on")) next = next.copy(on = before.getBoolean("on"))
                if (patch.has("brightness") && before.has("brightness")) next = next.copy(brightness = before.getDouble("brightness").toFloat())
                cur.copy(lights = cur.lights + (id to next))
            } else {
                val s = cur.acs[id] ?: return@update cur
                var next = s
                if (patch.has("on") && before.has("on")) next = next.copy(on = before.getBoolean("on"))
                if (patch.has("target") && before.has("target")) next = next.copy(target = before.getInt("target"))
                if (patch.has("mode") && before.has("mode")) next = next.copy(mode = before.getString("mode"))
                if (patch.has("fan") && before.has("fan")) next = next.copy(fan = before.optString("fan").ifBlank { null })
                cur.copy(acs = cur.acs + (id to next))
            }
        }
        _errors.tryEmit(error)
    }

    // ---------- HTTP ----------

    private fun get(path: String): String {
        val conn = URL(prefs.hubUrl + path).openConnection() as HttpURLConnection
        conn.connectTimeout = 5_000
        conn.readTimeout = 15_000
        try {
            if (conn.responseCode != 200) error("HTTP ${conn.responseCode} for $path")
            return conn.inputStream.use { it.readBytes().decodeToString() }
        } finally {
            conn.disconnect()
        }
    }

    private fun post(path: String, body: JSONObject): String {
        val conn = URL(prefs.hubUrl + path).openConnection() as HttpURLConnection
        conn.connectTimeout = 5_000
        conn.readTimeout = 20_000 // the AC's cloud can be slow
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        try {
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val stream = if (conn.responseCode < 400) conn.inputStream else conn.errorStream
            return stream?.use { it.readBytes().decodeToString() } ?: "{}"
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        private const val TAG = "LivingRoomHouse"

        fun parsePlan(plan: JSONObject, limits: Map<String, Triple<Int, Int, String>> = emptyMap()): House {
            val h = plan.optDouble("wallHeight", 2.5).takeIf { !it.isNaN() } ?: 2.5
            val rooms = plan.optJSONArray("rooms").objects().associate { it.optString("id") to it.optString("name", it.optString("id")) }
            val order = plan.optJSONArray("tileOrder").strings()
            fun rank(id: String) = order.indexOf(id).let { if (it < 0) Int.MAX_VALUE else it }
            val lights = plan.optJSONArray("lights").objects().mapNotNull { l ->
                val id = l.optString("id").ifBlank { return@mapNotNull null }
                val pos = l.optJSONArray("pos")
                val type = l.optString("type", "ceiling")
                val y = l.optDoubleOrNull("y")
                HouseLight(
                    id = id,
                    name = l.optString("name", id),
                    room = rooms[l.optString("room")] ?: l.optString("room"),
                    type = type,
                    caps = l.optJSONArray("capabilities").strings().toSet(),
                    x = pos?.optDouble(0) ?: 0.0,
                    z = pos?.optDouble(1) ?: 0.0,
                    // Where each fixture's glow sits (web/src/three/lights.js).
                    y = when (type) {
                        "table" -> (y ?: 0.5) + 0.27
                        "ceiling" -> y ?: (h - 0.14)
                        "spots" -> (y ?: (h - 0.16)) - 0.06
                        "pendant" -> y ?: 1.8
                        "floor" -> 1.28
                        "strip" -> y ?: 1.0
                        else -> y ?: 1.0
                    },
                )
            }.sortedBy { rank(it.id) }
            val acs = plan.optJSONArray("acs").objects().mapNotNull { a ->
                val id = a.optString("id").ifBlank { return@mapNotNull null }
                val pos = a.optJSONArray("pos")
                val limit = limits[id]
                HouseAc(
                    id = id,
                    name = a.optString("name", id),
                    room = rooms[a.optString("room")] ?: a.optString("room"),
                    unit = limit?.third ?: a.optString("unit", "F"),
                    min = limit?.first ?: 61,
                    max = limit?.second ?: 86,
                    x = pos?.optDouble(0) ?: 0.0,
                    z = pos?.optDouble(1) ?: 0.0,
                    y = a.optDoubleOrNull("y") ?: 2.15,
                )
            }.sortedBy { rank(it.id) }
            val scenes = plan.optJSONArray("scenes").objects().mapNotNull { s ->
                val id = s.optString("id").ifBlank { return@mapNotNull null }
                Scene(
                    id = id,
                    name = s.optString("name", id),
                    icon = s.optString("icon"),
                    lights = s.optJSONObject("lights").children(),
                    acs = s.optJSONObject("acs").children(),
                    tvs = s.optJSONObject("tvs").children(),
                )
            }
            return House(plan.optString("name", "Home"), lights, acs, scenes, rooms)
        }

        fun lightState(s: JSONObject) = LightState(
            on = s.optBoolean("on"),
            brightness = s.optDouble("brightness", 1.0).toFloat(),
            temp = if (s.isNull("temp") || !s.has("temp")) null else s.optInt("temp"),
            color = if (s.isNull("color") || !s.has("color")) null else s.optString("color").ifBlank { null },
        )

        fun acState(s: JSONObject) = AcState(
            on = s.optBoolean("on"),
            mode = s.optString("mode", "cool"),
            target = s.optInt("target", 72),
            fan = s.optString("fan").ifBlank { null },
            roomTemp = s.optDoubleOrNull("roomTemp"),
        )

        fun lightJson(s: LightState): JSONObject = JSONObject()
            .put("on", s.on).put("brightness", s.brightness.toDouble())
            .put("temp", s.temp ?: JSONObject.NULL).put("color", s.color ?: JSONObject.NULL)
    }
}

private fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it).ifBlank { null } }

private fun JSONObject?.children(): Map<String, JSONObject> =
    if (this == null) emptyMap() else keys().asSequence().mapNotNull { k -> optJSONObject(k)?.let { k to it } }.toMap()

private fun JSONObject.optDoubleOrNull(key: String): Double? =
    if (!has(key) || isNull(key)) null else optDouble(key).takeIf { !it.isNaN() }
