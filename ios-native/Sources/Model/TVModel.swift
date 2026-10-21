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
