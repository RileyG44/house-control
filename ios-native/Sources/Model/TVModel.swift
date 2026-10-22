import Foundation

/// The TV as the hub reports it (`GET /api/tv` and `{"tv": …}` events; hub/tv.py).
struct TVApp: Sendable, Equatable {
    var id: String
    var name: String
    var package: String?

    init(id: String, name: String, package: String? = nil) {
        self.id = id; self.name = name; self.package = package
    }

    init?(json: JSON?) {
        guard let j = json, let id = j["id"]?.string else { return nil }
        self.init(id: id, name: j["name"]?.string ?? id, package: j["package"]?.string)
    }
}

struct NowPlaying: Sendable, Equatable {
    var title: String
    var subtitle: String?
    var state: String             // playing, paused, buffering
    var position: Double?
    var duration: Double?
    var seekable: Bool
    var artwork: URL?
    var app: String?
    var at: Double?               // unix time of the position sample

    init?(json: JSON?) {
        guard let j = json, let title = j["title"]?.string else { return nil }
        self.title = title
        subtitle = j["subtitle"]?.string
        state = j["state"]?.string ?? "playing"
        position = j["position"]?.double
        duration = j["duration"]?.double
        seekable = j["seekable"]?.bool ?? false
        artwork = j["artwork"]?.string.flatMap(URL.init(string:))
        app = j["app"]?.string
        at = j["at"]?.double
    }

    /// Where the title is at time `t`: its last position, moved on while it plays.
    func position(at t: Double = Date().timeIntervalSince1970) -> Double? {
        guard let position else { return nil }
        let p = position + (state == "playing" ? max(0, t - (at ?? t)) : 0)
        if let duration, duration > 0 { return min(max(0, p), duration) }
        return max(0, p)
    }
}

/// Where the TV's own launcher answers on the house Wi-Fi (`direct`, which the hub adds when it
/// drives the TV through the launcher): its address, and its own id when the hub knows it.
struct TVDirect: Sendable, Equatable {
    var url: URL
    var id: String?

    init?(json: JSON?) {
        guard let j = json, let s = j["url"]?.string, let url = URL(string: s), url.scheme == "http" || url.scheme == "https" else { return nil }
        self.url = url
        id = j["id"]?.string.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The Keychain accounts this phone's token for it is kept under: the launcher's id first,
    /// then its address (all there is when the hub doesn't know the id).
    var accounts: [String] { [id.map { "id:\($0)" }, "url:\(url.absoluteString)"].compactMap { $0 } }
}

struct TVDevice: Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var online: Bool
    var on: Bool
    var app: TVApp?
    var volume: Int?
    var volumeMax: Int?
    var muted: Bool
    var nowPlaying: NowPlaying?
    var direct: TVDirect?

    init?(json: JSON) {
        guard let id = json["id"]?.string else { return nil }
        self.id = id
        name = json["name"]?.string ?? "TV"
        online = json["online"]?.bool ?? false
        on = json["on"]?.bool ?? false
        app = TVApp(json: json["app"])
        volume = json["volume"]?.int
        volumeMax = json["volumeMax"]?.int
        muted = json["muted"]?.bool ?? false
        nowPlaying = NowPlaying(json: json["nowPlaying"])
        direct = TVDirect(json: json["direct"])
    }

    /// "Netflix", "Google TV home", "Off", "Not reachable".
    func status(available: Bool) -> String {
        if !available || !online { return "Not reachable" }
        if !on { return "Off" }
        guard let app else { return "On" }
        if app.id == "home" { return "Google TV home" }
        if app.id == "other" { return "On" }
        return app.name
    }
}

struct TVState: Sendable, Equatable {
    var available = false
    var error = ""
    var devices: [TVDevice] = []

    init() {}

    init(json: JSON) {
        available = json["available"]?.bool ?? false
        error = json["error"]?.string ?? ""
        devices = (json["devices"]?.array ?? []).compactMap(TVDevice.init(json:))
    }
}

/// One title from `GET /api/tv/search`.
struct SearchResult: Sendable, Identifiable {
    struct Offer: Sendable, Identifiable {
        var app: String
        var name: String
        var how: String
        var link: String
        var id: String { app }
    }
    var id = UUID()
    var title: String
    var year: Int?
    var type: String
    var poster: URL?
    var offers: [Offer]
    var rentOrBuy: [String]

    init?(json: JSON) {
        guard let title = json["title"]?.string else { return nil }
        self.title = title
        year = json["year"]?.int
        type = json["type"]?.string ?? "movie"
        poster = json["poster"]?.string.flatMap(URL.init(string:))
        offers = (json["offers"]?.array ?? []).compactMap { o in
            guard let app = o["app"]?.string, let link = o["link"]?.string else { return nil }
            return Offer(app: app, name: o["name"]?.string ?? app, how: o["how"]?.string ?? "", link: link)
        }
        rentOrBuy = (json["rentOrBuy"]?.array ?? []).compactMap(\.string)
    }
}

/// One title of the streaming catalog (`GET /api/tv/catalog`, hub/catalog.py's tile). Its
/// pictures are the hub's own addresses. A title from the launcher's Continue has kind
/// "continue" and `resume`; one of the apps' own picks has kind "recommendation" and
/// `recommendation`.
struct BrowseTile: Sendable, Identifiable, Equatable {
    var id: String
    var title: String
    var year: Int?
    var kind: String              // movie, show, continue, recommendation
    var poster: URL?
    var backdrop: URL?
    var app: String?
    var link: String?
    var tvLink: String?
    var blurb: String?
    var runtime: Int?
    var rating: Double?
    var age: String?
    var genres: [String]
    var subtitle: String?
    var progress: Double?
    var resume: String?
    var recommendation: String?

    init?(json: JSON) {
        guard let id = json["id"]?.string, !id.isEmpty, let title = json["title"]?.string, !title.isEmpty else { return nil }
        self.id = id
        self.title = title
        year = json["year"]?.int
        kind = json["kind"]?.string ?? "movie"
        poster = json["poster"]?.string.flatMap(URL.init(string:))
        backdrop = json["backdrop"]?.string.flatMap(URL.init(string:))
        app = json["app"]?.string
        link = json["link"]?.string
        tvLink = json["tvLink"]?.string
        blurb = json["blurb"]?.string
        runtime = json["runtime"]?.int
        rating = json["rating"]?.double
        age = json["age"]?.string
        genres = (json["genres"]?.array ?? []).compactMap(\.string)
        subtitle = json["subtitle"]?.string
        progress = json["progress"]?.double
        resume = json["resume"]?.string
        recommendation = json["recommendation"]?.string
    }

    /// What Play on TV sends as the title's link: the Android TV deep link when there is one,
    /// else its page (the hub checks either against the app, as for a search result).
    var playLink: String? { tvLink ?? link }

    /// Whether the TV can be asked to play it at all.
    var playable: Bool { resume != nil || recommendation != nil || (app != nil && playLink != nil) }

    /// "2022 · Show · 50 min · TV-14 · IMDb 8.1".
    var facts: String {
        let what: String? = kind == "movie" ? "Movie" : kind == "show" ? "Show" : nil
        let length = runtime.map { $0 >= 60 ? "\($0 / 60) h \($0 % 60) min" : "\($0) min" }
        return [year.map(String.init), what, length, age, rating.map { String(format: "IMDb %.1f", $0) }]
            .compactMap { $0 }.joined(separator: " · ")
    }
}

/// One of an app's rows: Popular, Trending or New.
struct BrowseRow: Sendable, Identifiable, Equatable {
    var key: String
    var label: String
    var title: String
    var items: [BrowseTile]
    var id: String { key }

    init?(json: JSON) {
        guard let key = json["key"]?.string else { return nil }
        self.key = key
        label = json["label"]?.string ?? key.capitalized
        title = json["title"]?.string ?? label
        items = (json["items"]?.array ?? []).compactMap(BrowseTile.init(json:))
        if items.isEmpty { return nil }
    }
}

struct BrowseApp: Sendable, Identifiable, Equatable {
    var id: String
    var name: String
    var rows: [BrowseRow]

    init?(json: JSON) {
        guard let id = json["id"]?.string else { return nil }
        self.id = id
        name = json["name"]?.string ?? id
        rows = (json["rows"]?.array ?? []).compactMap(BrowseRow.init(json:))
        if rows.isEmpty { return nil }
    }
}

/// The whole catalog: each of the TV's apps with its rows, and For you.
struct BrowseCatalog: Sendable, Equatable {
    var apps: [BrowseApp]
    var forYou: [BrowseTile]

    init(json: JSON) {
        apps = (json["apps"]?.array ?? []).compactMap(BrowseApp.init(json:))
        forYou = (json["forYou"]?.array ?? []).compactMap(BrowseTile.init(json:))
    }
}

/// `GET /api/tv/title/{id}`: the title, and which of the TV's apps include it.
struct TitleDetails: Sendable, Equatable {
    struct Offer: Sendable, Identifiable, Equatable {
        var app: String
        var name: String
        var how: String
        var link: String
        var tvLink: String?
        var id: String { app }
        var playLink: String { tvLink ?? link }
    }
    var tile: BrowseTile
    var offers: [Offer]
    var rentOrBuy: [String]

    init?(json: JSON) {
        guard let tile = BrowseTile(json: json) else { return nil }
        self.tile = tile
        offers = (json["offers"]?.array ?? []).compactMap { o in
            guard let app = o["app"]?.string, let link = o["link"]?.string else { return nil }
            return Offer(app: app, name: o["name"]?.string ?? app, how: o["how"]?.string ?? "", link: link, tvLink: o["tvLink"]?.string)
        }
        rentOrBuy = (json["rentOrBuy"]?.array ?? []).compactMap(\.string)
    }
}

/// Which real TV each tv / tvCabinet piece of the plan shows: its `device`, or (no `device`)
/// the one TV there is when the plan has one TV piece. `"device": "none"` leaves it unlinked.
func tvLinks(_ furniture: [Furniture], _ state: TVState) -> [(furniture: Furniture, id: String?)] {
    let pieces = furniture.filter { $0.type == "tv" || $0.type == "tvCabinet" }
    let auto = pieces.filter { $0.props["device"] == nil || $0.props["device"]?.isNull == true }
    return pieces.map { item in
        if let d = item.device, !d.isEmpty, d != "none" { return (item, d) }
        if (item.props["device"] == nil || item.props["device"]?.isNull == true), pieces.count == 1, auto.count == 1, state.devices.count == 1 {
            return (item, state.devices[0].id)
        }
        return (item, nil)
    }
}
