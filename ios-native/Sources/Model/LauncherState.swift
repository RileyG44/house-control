import Foundation

/// The launcher's `/api/state` as the hub's TV state for that TV, so the remote page shows the
/// same thing whichever way the state came. A port of `from_launcher`, `launcher_playing` and
/// `app_of` in hub/tv.py: keep them in step.
enum LauncherState {
    struct Known: Sendable {
        let id: String
        let name: String
        init(_ id: String, _ name: String) { self.id = id; self.name = name }
    }

    /// The Android packages of the TV's apps as the panel's ids and names (hub/tv.py `APPS`,
    /// `APP_IDS` and `SYSTEM`).
    static let packages: [String: Known] = [
        "com.google.android.youtube.tv": Known("youtube", "YouTube"),
        "com.netflix.ninja": Known("netflix", "Netflix"),
        "com.amazon.amazonvideo.livingroom": Known("prime", "Prime Video"),
        "com.disney.disneyplus": Known("disney", "Disney+"),
        "com.hulu.livingroomplus": Known("hulu", "Hulu"),
        "com.wbd.stream": Known("max", "Max"),
        "com.peacocktv.peacockandroid": Known("peacock", "Peacock"),
        "com.cbs.ott": Known("paramount", "Paramount+"),
        "com.apple.atve.androidtv.appletv": Known("appletv", "Apple TV"),
        "com.tubitv": Known("tubi", "Tubi"),
        "tv.pluto.android": Known("pluto", "Pluto TV"),
        "com.plexapp.android": Known("plex", "Plex"),
        "com.crunchyroll.crunchyroid": Known("crunchyroll", "Crunchyroll"),
        "com.google.android.apps.tv.launcherx": Known("home", "Google TV"),
        "com.google.android.tvrecommendations": Known("home", "Google TV"),
        "com.google.android.tvlauncher": Known("home", "Google TV"),
        "com.google.android.backdrop": Known("ambient", "Ambient"),
        "com.android.tv.settings": Known("settings", "Settings"),
        "com.livingroom.tv": Known("home", "Living Room"),
    ]

    /// A package as the panel's app: a known one by its id, anything else as "other".
    static func appOf(_ package: String?) -> JSON? {
        guard let package, !package.isEmpty else { return nil }
        let known = packages[package]
        return .object(["id": .string(known?.id ?? "other"), "name": .string(known?.name ?? package), "package": .string(package)])
    }

    /// The TV `id` (the hub's name for it) from the launcher's state `st`. `at` is this phone's
    /// clock when the state came; `picture` makes one of the launcher's picture paths a URL.
    static func device(_ st: JSON, id: String, name: String?, at: Double, picture: (String) -> URL?) -> TVDevice? {
        let t = st["tv"] ?? .null
        let on = t["awake"]?.bool ?? false
        let app = on ? appOf(t["foreground"]?["pkg"]?.string) : nil
        var volume = JSON.null
        if on, let level = t["volume"]?.int { volume = .number(Double(level)) }
        let top = t["volumeMax"]?.int ?? 0
        var d: [String: JSON] = [
            "id": .string(id), "name": .string(name ?? t["name"]?.string ?? "TV"),
            "online": .bool(true), "on": .bool(on), "app": app ?? .null,
            "volume": volume,
            "volumeMax": .number(Double(top > 0 ? top : 100)),
            "muted": .bool(t["muted"]?.bool ?? false),
        ]
        if on, let np = playing(st, app: app, at: at, picture: picture) { d["nowPlaying"] = np }
        return TVDevice(json: .object(d))
    }

    /// The launcher's `now` (the media session it follows) as the panel's nowPlaying, or nil. A
    /// paused session of an app that is no longer on the screen isn't what's on. The position
    /// was measured a little before the state was sent, by the TV's own clock
    /// (serverTime - measuredAt).
    static func playing(_ st: JSON, app: JSON?, at: Double, picture: (String) -> URL?) -> JSON? {
        guard let n = st["now"], let title = n["title"]?.string, !title.isEmpty,
              let state = n["state"]?.string, ["playing", "paused", "buffering"].contains(state) else { return nil }
        let pkg = n["pkg"]?.string
        if state == "paused", app?["package"]?.string != pkg { return nil }
        let tenth = { (x: Double) in (x * 10).rounded() / 10 }
        let duration = n["durationMs"]?.double.flatMap { $0 > 0 ? tenth($0 / 1000) : nil }
        var position = n["positionMs"]?.double.map { tenth(max(0, $0) / 1000) }
        if let duration, let p = position { position = min(p, duration) }
        var since = 0.0
        if let measured = n["measuredAt"]?.double, let told = st["serverTime"]?.double, told - measured >= 0, told - measured < 600_000 {
            since = (told - measured) / 1000
        }
        var artwork: JSON = .null
        if let art = n["art"]?.string, art.hasPrefix("art/now") {
            let version = art.components(separatedBy: "?v=").dropFirst().first ?? ""
            let hex = !version.isEmpty && version.count <= 16 && version.allSatisfy(\.isHexDigit) && version == version.lowercased()
            if let url = picture(hex ? "art/now?v=\(version)" : "art/now") { artwork = .string(url.absoluteString) }
        }
        let appID: JSON = appOf(pkg)?["id"] ?? app?["id"] ?? .null
        var subtitle = JSON.null
        if let s = n["subtitle"]?.string, !s.isEmpty { subtitle = .string(s) }
        let seekable = (n["canSeek"]?.bool ?? false) && duration != nil && position != nil
        return .object([
            "title": .string(title),
            "subtitle": subtitle,
            "state": .string(state),
            "position": position.map { JSON.number($0) } ?? JSON.null,
            "duration": duration.map { JSON.number($0) } ?? JSON.null,
            "seekable": .bool(seekable),
            "artwork": artwork,
            "app": appID,
            "at": .number(((at - since) * 1000).rounded() / 1000),
        ])
    }
}
