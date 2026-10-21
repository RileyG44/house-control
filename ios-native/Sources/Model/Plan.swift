import Foundation

/// The floor plan: everything the 3D model and the card know about the home. Read from the hub's
/// `GET /api/plan` (or the bundled riley.json), normalised like web/src/config.js. The JSON as it
/// came is kept (`raw`) so a save writes back every key the app doesn't know about.
struct Room: Sendable, Equatable, Identifiable {
    var id: String
    var name: String
    var points: [P2]
    var area: Double
    var floor: String
    var minX: Double, minZ: Double, maxX: Double, maxZ: Double
}

struct Opening: Sendable, Equatable {
    var index: Int
    var type: String          // door, window, open
    var from: P2
    var to: P2
    var sill: Double
    var head: Double
    var hinge: String
    var swing: String?
    var curtain: Bool
}

struct Furniture: Sendable {
    var index: Int
    var type: String
    var pos: P2
    var rot: Double
    var y: Double?
    var props: [String: JSON]

    func num(_ key: String, _ fallback: Double) -> Double { props[key]?.double ?? fallback }
    func str(_ key: String, _ fallback: String) -> String { props[key]?.string ?? fallback }
    func bool(_ key: String, _ fallback: Bool) -> Bool { props[key]?.bool ?? fallback }
    var size: (Double, Double)? {
        guard let a = props["size"]?.array, a.count == 2, let w = a[0].double, let d = a[1].double else { return nil }
        return (w, d)
    }
    /// The real TV a `tv` / `tvCabinet` shows: its id, "none", or nil for automatic.
    var device: String? { props["device"]?.string }
}

struct LightConfig: Sendable, Identifiable {
    var id: String
    var name: String
    var room: String
    var type: String          // ceiling, pendant, spots, floor, table, strip
    var pos: P2
    var rot: Double
    var y: Double?
    var length: Double?
    var intensity: Double?
    var capabilities: [String]
    var color: String?
    var linked: Bool

    var dimmable: Bool { capabilities.contains("brightness") }
    var hasTemp: Bool { capabilities.contains("temp") }
    var hasColor: Bool { capabilities.contains("color") }
}

struct ACConfig: Sendable, Identifiable {
    var id: String
    var name: String
    var room: String
    var wall: String
    var pos: P2
    var y: Double
    var unit: String          // C or F
    var min: Int
    var max: Int
}

struct LightPatch: Sendable, Equatable {
    var on: Bool?
    var brightness: Double?
    var temp: Double?
    var color: String??       // .some(nil): back to white

    init(on: Bool? = nil, brightness: Double? = nil, temp: Double? = nil, color: String?? = nil) {
        self.on = on; self.brightness = brightness; self.temp = temp; self.color = color
    }

    init(json: JSON?) {
        on = json?["on"]?.bool
        brightness = json?["brightness"]?.double
        temp = json?["temp"]?.double
        // A colour as "#rrggbb", or as [r, g, b] (0…255).
        if let c = json?["color"] {
            if let a = c.array?.compactMap(\.double), a.count >= 3 {
                color = .some(RGB(a[0] / 255, a[1] / 255, a[2] / 255).hex)
            } else {
                color = .some(c.string)
            }
        } else { color = nil }
    }

    func merged(over base: LightPatch) -> LightPatch {
        LightPatch(on: on ?? base.on, brightness: brightness ?? base.brightness, temp: temp ?? base.temp,
                   color: color ?? base.color)
    }
}

struct SceneConfig: Sendable, Identifiable {
    var id: String
    var name: String
    var icon: String
    var lights: [String: LightPatch]
    var acs: [String: JSON]
}

struct Plan: Sendable {
    var raw: JSON
    var name: String
    var wallHeight: Double
    var interiorWallHeight: Double
    var azimuth: Double
    var elevation: Double
    var outdoorTemp: Double
    var rooms: [Room]
    var openings: [Opening]
    var furniture: [Furniture]
    var lights: [LightConfig]
    var acs: [ACConfig]
    var scenes: [SceneConfig]
    var tileOrder: [String]
    var minX: Double, minZ: Double, maxX: Double, maxZ: Double

    struct Problem: Error, LocalizedError {
        var message: String
        var errorDescription: String? { message }
    }

    init(json: JSON) throws {
        guard case .object(let o) = json else { throw Problem(message: "The plan isn't a JSON object") }
        raw = json
        name = o["name"]?.string ?? "Home"
        wallHeight = o["wallHeight"]?.double ?? 2.6
        interiorWallHeight = o["interiorWallHeight"]?.double ?? 1.25
        azimuth = o["camera"]?["azimuth"]?.double ?? 34
        elevation = o["camera"]?["elevation"]?.double ?? 47
        outdoorTemp = o["outdoorTemp"]?.double ?? 27

        var rooms: [Room] = []
        for r in o["rooms"]?.array ?? [] {
            guard let id = r["id"]?.string else { continue }
            var pts: [P2]
            if let poly = r["poly"]?.array {
                pts = poly.compactMap(\.point)
                if pts.count > 3, pts.first == pts.last { pts.removeLast() }
            } else if let rect = r["rect"]?.array?.compactMap(\.double), rect.count == 4 {
                let (x, z, w, d) = (rect[0], rect[1], rect[2], rect[3])
                pts = [P2(x, z), P2(x + w, z), P2(x + w, z + d), P2(x, z + d)]
            } else { continue }
            guard pts.count >= 3 else { continue }
            pts = Geom.oriented(pts)
            let xs = pts.map(\.x), zs = pts.map(\.y)
            rooms.append(Room(id: id, name: r["name"]?.string ?? id, points: pts, area: Geom.area(pts),
                              floor: r["floor"]?.string ?? "oak",
                              minX: xs.min()!, minZ: zs.min()!, maxX: xs.max()!, maxZ: zs.max()!))
        }
        guard !rooms.isEmpty else { throw Problem(message: "The plan has no rooms") }
        self.rooms = rooms
        let roomIds = Set(rooms.map(\.id))

        openings = (o["openings"]?.array ?? []).enumerated().compactMap { i, x in
            guard let from = x["from"]?.point, let to = x["to"]?.point else { return nil }
            return Opening(index: i, type: x["type"]?.string ?? "door", from: from, to: to,
                           sill: x["sill"]?.double ?? 0.85, head: x["head"]?.double ?? 2.1,
                           hinge: x["hinge"]?.string ?? "from", swing: x["swing"]?.string,
                           curtain: x["curtain"]?.bool ?? false)
        }

        furniture = (o["furniture"]?.array ?? []).enumerated().compactMap { i, x in
            guard let type = x["type"]?.string, let pos = x["pos"]?.point, let props = x.object else { return nil }
            return Furniture(index: i, type: type, pos: pos, rot: x["rot"]?.double ?? 0, y: x["y"]?.double, props: props)
        }

        lights = (o["lights"]?.array ?? []).compactMap { l in
            guard let id = l["id"]?.string, let room = l["room"]?.string, roomIds.contains(room),
                  let pos = l["pos"]?.point else { return nil }
            let linked = (l["link"]?["id"]?.string != nil) || (l["tuya"]?["deviceId"]?.string != nil)
            return LightConfig(id: id, name: l["name"]?.string ?? id, room: room, type: l["type"]?.string ?? "ceiling",
                               pos: pos, rot: l["rot"]?.double ?? 0, y: l["y"]?.double, length: l["length"]?.double,
                               intensity: l["intensity"]?.double,
                               capabilities: (l["capabilities"]?.array ?? []).compactMap(\.string),
                               color: l["color"]?.string, linked: linked)
        }

        acs = (o["acs"]?.array ?? []).compactMap { a in
            guard let id = a["id"]?.string, let room = a["room"]?.string, roomIds.contains(room),
                  let pos = a["pos"]?.point else { return nil }
            let unit = a["unit"]?.string == "F" ? "F" : "C"
            let (lo, hi) = unit == "F" ? (61, 86) : (16, 30)
            return ACConfig(id: id, name: a["name"]?.string ?? id, room: room, wall: a["wall"]?.string ?? "north",
                            pos: pos, y: a["y"]?.double ?? 2.2, unit: unit,
                            min: a["min"]?.int ?? lo, max: a["max"]?.int ?? hi)
        }

        scenes = (o["scenes"]?.array ?? []).compactMap { s in
            guard let id = s["id"]?.string else { return nil }
            var lights: [String: LightPatch] = [:]
            for (k, v) in s["lights"]?.object ?? [:] { lights[k] = LightPatch(json: v) }
            return SceneConfig(id: id, name: s["name"]?.string ?? id, icon: s["icon"]?.string ?? "sun",
                               lights: lights, acs: s["acs"]?.object ?? [:])
        }

        var seen = Set<String>()
        tileOrder = (o["tileOrder"]?.array ?? []).compactMap(\.string).filter { !$0.isEmpty && seen.insert($0).inserted }

        minX = rooms.map(\.minX).min()!
        minZ = rooms.map(\.minZ).min()!
        maxX = rooms.map(\.maxX).max()!
        maxZ = rooms.map(\.maxZ).max()!
    }

    init(data: Data) throws {
        guard let json = JSON.parse(data) else { throw Problem(message: "The plan isn't valid JSON") }
        try self.init(json: json)
    }

    static func bundled() -> Plan {
        let url = Bundle.main.url(forResource: "riley", withExtension: "json")!
        // The bundled plan is part of the app: it always parses.
        return try! Plan(data: try! Data(contentsOf: url))
    }

    /// What changes the 3D model (everything but the order of tiles and rooms).
    var modelKey: String {
        guard case .object(var o) = raw else { return "" }
        o["tileOrder"] = nil
        o["scenes"] = nil
        if case .array(let r)? = o["rooms"] {
            o["rooms"] = .array(r.sorted { ($0["id"]?.string ?? "") < ($1["id"]?.string ?? "") })
        }
        return String(decoding: JSON.object(o).data(), as: UTF8.self)
    }

    /// The plan to save with a new tile order and room order; every other key as it came.
    func saving(tileOrder: [String], roomOrder: [String], scenes: [JSON]? = nil) -> JSON {
        guard case .object(var o) = raw else { return raw }
        o["tileOrder"] = .array(tileOrder.map(JSON.string))
        if let scenes { o["scenes"] = .array(scenes) }
        if case .array(let list)? = o["rooms"] {
            let rank = Dictionary(uniqueKeysWithValues: roomOrder.enumerated().map { ($1, $0) })
            let sorted = list.enumerated().sorted { a, b in
                let ra = rank[a.element["id"]?.string ?? ""] ?? Int.max
                let rb = rank[b.element["id"]?.string ?? ""] ?? Int.max
                return ra != rb ? ra < rb : a.offset < b.offset
            }.map(\.element)
            o["rooms"] = .array(sorted)
        }
        return .object(o)
    }

    /// The plan's scenes as written (an ordered list).
    var scenesJSON: [JSON] { raw["scenes"]?.array ?? [] }

    /// The same plan with other scenes.
    func with(scenes: [JSON]) -> Plan {
        guard case .object(var o) = raw else { return self }
        o["scenes"] = .array(scenes)
        return (try? Plan(json: .object(o))) ?? self
    }

    /// The smallest room a point of the floor is in.
    func roomAt(_ p: P2) -> String? {
        rooms.filter { Geom.contains($0.points, p) }.min { $0.area < $1.area }?.id
    }

    var center: P2 { P2((minX + maxX) / 2, (minZ + maxZ) / 2) }
}
