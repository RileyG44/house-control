package com.livingroom.tv

import android.app.Application
import android.content.Context
import android.net.Uri
import com.livingroom.tv.apps.AppsRepository
import com.livingroom.tv.catalog.ArtCache
import com.livingroom.tv.catalog.CatalogRepository
import com.livingroom.tv.catalog.TvRecommendations
import com.livingroom.tv.companion.Advertiser
import com.livingroom.tv.companion.CompanionServer
import com.livingroom.tv.companion.Pairing
import com.livingroom.tv.companion.StateHub
import com.livingroom.tv.glance.WallpaperStore
import com.livingroom.tv.glance.WeatherRepository
import com.livingroom.tv.glance.WeatherPreferences
import com.livingroom.tv.history.HistoryStore
import com.livingroom.tv.history.HistorySync
import com.livingroom.tv.house.HouseRepository
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
    lateinit var debugging: WirelessDebugging
        private set
    lateinit var wallpaper: WallpaperStore
        private set
    lateinit var catalog: CatalogRepository
        private set
    lateinit var art: ArtCache
        private set
    lateinit var recommendations: TvRecommendations
        private set
    lateinit var house: HouseRepository
        private set
    lateinit var historySync: HistorySync
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
        debugging = WirelessDebugging(app, prefs)
        wallpaper = WallpaperStore(app)
        catalog = CatalogRepository(app, prefs)
        art = ArtCache(app)
        recommendations = TvRecommendations(app)
        house = HouseRepository(prefs)
        historySync = HistorySync(app, prefs)
        history.onRecord = { e -> historySync.note(e, apps.label(e.pkg)) }
        hub = StateHub()
        hub.ownerName.value = prefs.ownerName
        server = CompanionServer(app, prefs, hub, Pairing(prefs))
        advertiser = Advertiser(app, prefs)
        scope.launch(Dispatchers.IO) {
            history.load()
            wallpaper.load()
            apps.refresh()
            historySync.backfill(history.entries.value) { apps.label(it) }
        }
        apps.watchPackageChanges()
        hub.start(app, scope)
        weather.start(scope, app)
        debugging.start(scope)
        catalog.start(scope)
        recommendations.start(scope)
        house.start(scope, hub.homeVisible)
        historySync.start(scope)
        server.startSafely()
        advertiser.start()
    }
}

class Prefs(context: Context) : WeatherPreferences {
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
    override var location: JSONObject?
        get() = sp.getString("location", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        set(value) = sp.edit().putString("location", value?.toString()).apply()

    /** Where the internet address says the TV is, cached for a day. */
    override var ipLocation: JSONObject?
        get() = sp.getString("ipLocation", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        set(value) = sp.edit().putString("ipLocation", value?.toString()).apply()

    /** Last successful forecast, so a restart doesn't blank the weather while Wi-Fi connects. */
    override var forecast: JSONObject?
        get() = sp.getString("forecast", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        set(value) = sp.edit().putString("forecast", value?.toString()).apply()

    var debugRecoveryNetwork: String?
        get() = sp.getString("debugRecoveryNetwork", null)
        set(value) = sp.edit().putString("debugRecoveryNetwork", value).apply()

    /** The profile chosen on apps' "Who's watching?" screens (input/ProfilePicker.kt). Set from the phone or hub. */
    var profile: String
        get() = sp.getString("profile", null) ?: "Riley"
        set(value) = sp.edit().putString("profile", value.trim().ifBlank { null }).apply()

    /** Press OK once on YouTube's and Netflix's profile screen after a cold launch (ProfilePicker). */
    var profileOk: Boolean
        get() = sp.getBoolean("profileOk", true)
        set(value) = sp.edit().putBoolean("profileOk", value).apply()

    val tvName: String get() = sp.getString("tvName", null) ?: "Living Room"

    /**
     * House Control's hub (its panel, and the streaming catalog for the Home rows): set by the
     * hub when it pairs (/api/settings {"hub"}), else the Dell's. Only an http(s) address with
     * no path is kept.
     */
    var hubUrl: String
        get() = sp.getString("hubUrl", null) ?: DEFAULT_HUB
        set(value) = sp.edit().putString("hubUrl", cleanHubUrl(value)).apply()

    /** Catalog titles hidden from Home with a long press (their JustWatch ids). */
    var hiddenTitles: Set<String>
        get() = sp.getStringSet("hiddenTitles", null)?.toSet() ?: emptySet()
        set(value) = sp.edit().putStringSet("hiddenTitles", value.toSet()).apply()

    companion object {
        /** House Control's hub on the Dell server. */
        const val DEFAULT_HUB = "http://192.168.0.127:8766"

        /** "http://192.168.0.127:8766/" as "http://192.168.0.127:8766"; null for anything else. */
        fun cleanHubUrl(value: String?): String? {
            val uri = runCatching { Uri.parse(value?.trim().orEmpty()) }.getOrNull() ?: return null
            if (uri.scheme != "http" && uri.scheme != "https") return null
            if (uri.host.isNullOrBlank() || !uri.userInfo.isNullOrEmpty()) return null
            if (!uri.path.isNullOrEmpty() && uri.path != "/") return null
            return "${uri.scheme}://${uri.encodedAuthority}"
        }
    }
}
