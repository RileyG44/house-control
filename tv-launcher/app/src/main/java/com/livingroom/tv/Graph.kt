package com.livingroom.tv

import android.app.Application
import android.content.Context
import com.livingroom.tv.apps.AppsRepository
import com.livingroom.tv.companion.Advertiser
import com.livingroom.tv.companion.CompanionServer
import com.livingroom.tv.companion.Pairing
import com.livingroom.tv.companion.StateHub
import com.livingroom.tv.glance.WallpaperStore
import com.livingroom.tv.glance.WeatherRepository
import com.livingroom.tv.history.HistoryStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.security.SecureRandom

class LivingRoomApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Graph.init(this)
    }
}

/** Process-wide singletons. Activities and system-bound services all share one instance. */
object Graph {
    lateinit var app: Application
        private set
    lateinit var prefs: Prefs
        private set
    lateinit var apps: AppsRepository
        private set
    lateinit var history: HistoryStore
        private set
    lateinit var hub: StateHub
        private set
    lateinit var server: CompanionServer
        private set
    lateinit var advertiser: Advertiser
        private set
    lateinit var weather: WeatherRepository
        private set
    lateinit var wallpaper: WallpaperStore
        private set

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Synchronized
    fun init(app: Application) {
        if (::hub.isInitialized) return
        this.app = app
        prefs = Prefs(app)
        apps = AppsRepository(app, prefs)
        history = HistoryStore(app)
        weather = WeatherRepository(prefs)
        wallpaper = WallpaperStore(app)
        hub = StateHub()
        hub.ownerName.value = prefs.ownerName
        server = CompanionServer(app, prefs, hub, Pairing(prefs))
        advertiser = Advertiser(app, prefs)
        scope.launch(Dispatchers.IO) {
            history.load()
            wallpaper.load()
            apps.refresh()
        }
        apps.watchPackageChanges()
        hub.start(scope)
        weather.start(scope)
        server.startSafely()
        advertiser.start()
    }
}

class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("livingroom", Context.MODE_PRIVATE)

    /** Shared secret in the pairing QR code. Every phone request must carry it. */
    val token: String by lazy {
        sp.getString("token", null) ?: ByteArray(12).also { SecureRandom().nextBytes(it) }
            .joinToString("") { "%02x".format(it) }
            .also { sp.edit().putString("token", it).apply() }
    }

    var pinned: List<String>?
        get() = sp.getString("pinned", null)?.split(',')?.filter { it.isNotBlank() }
        set(value) = sp.edit().putString("pinned", value?.joinToString(",")).apply()

    var hidden: Set<String>
        get() = sp.getStringSet("hidden", emptySet()) ?: emptySet()
        set(value) = sp.edit().putStringSet("hidden", value).apply()

    /** Stable id for this TV, so the phone recognizes it after its IP address changes. */
    val deviceId: String by lazy {
        sp.getString("deviceId", null) ?: ByteArray(6).also { SecureRandom().nextBytes(it) }
            .joinToString("") { "%02x".format(it) }
            .also { sp.edit().putString("deviceId", it).apply() }
    }

    /** For the Home greeting ("Good evening, Riley"). Set from the phone. */
    var ownerName: String?
        get() = sp.getString("ownerName", null)
        set(value) = sp.edit().putString("ownerName", value?.trim()?.ifBlank { null }).apply()

    /** Weather location chosen on the phone: {lat, lon, place, country}. Wins over [ipLocation]. */
    var location: JSONObject?
        get() = sp.getString("location", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        set(value) = sp.edit().putString("location", value?.toString()).apply()

    /** Where the internet address says the TV is, cached for a day. */
    var ipLocation: JSONObject?
        get() = sp.getString("ipLocation", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        set(value) = sp.edit().putString("ipLocation", value?.toString()).apply()

    val tvName: String get() = sp.getString("tvName", null) ?: "Living Room"
}
