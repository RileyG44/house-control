import Foundation
import Observation
import SwiftUI

struct LightState: Equatable, Sendable {
    var on = false
    var brightness = 0.8
    var temp = 3000.0
    var color: String?
}

struct ACState: Equatable, Sendable {
    var on = false
    var target = 74
    var mode = "cool"
    var fan = "auto"
    var swing = "swing"
    var sleep = false
    var eco = false
    var roomTemp = 72.0
}

struct ACFeatures: Equatable, Sendable {
    var modes = ["cool", "heat", "dry", "fan", "auto"]
    var fans = ["auto", "low", "medium", "high", "turbo"]
    var sleep = true
    var eco = true
    var swing = true

    init() {}
    init(json: JSON) {
        modes = (json["modes"]?.array ?? []).compactMap(\.string)
        fans = (json["fans"]?.array ?? []).compactMap(\.string)
        sleep = json["sleep"]?.bool ?? false
        eco = json["eco"]?.bool ?? false
        swing = json["swing"]?.bool ?? false
    }
}

/// A tile of the card: a lamp, an AC or a TV, by its name in `tileOrder`.
struct Tile: Identifiable, Equatable {
    enum Kind { case light, ac, tv, speaker }
    var kind: Kind
    var id: String          // "studio.door", "studio.ac", "tv:79519fff"
    var deviceID: String    // the lamp's, the AC's or the TV's own id
    var room: String
    var wide: Bool { kind != .light }
}

struct Toast: Equatable, Identifiable {
    var id = UUID()
    var text: String
    var error: Bool
}

/// Everything the screen shows: the plan, each lamp's and AC's state, the TV, and the order the
/// tiles and rooms were dragged into. Changes made here show at once and go to the hub
/// (web/src/store.js does the same): one command per device in flight, whatever changes
/// meanwhile merged into one follow-up, and a change the device refuses rolled back.
@MainActor @Observable
final class HomeStore {
    let hub: HubClient
    let tv: TVStore
    let spotify: SpotifyStore
    /// The house agent: what was asked aloud or typed, its steps and its reply (VoiceAgent.swift).
    let voice: VoiceAgent
    private(set) var plan: Plan
    /// Bumped when the model itself changes (not only the order of tiles or rooms).
    private(set) var modelRev = 0
    var lights: [String: LightState] = [:]
    var acs: [String: ACState] = [:]
    var features: [String: ACFeatures] = [:]
    var scene: String?
    private(set) var tileOrder: [String] = []
    private(set) var roomOrder: [String] = []
    var folded: Set<String> = []
    var toast: Toast?
    /// Whether the first state from the hub has come.
    private(set) var live = false
    /// The weather at the plan's site from the hub in use (or forced with `-sky`); nil: none known,
    /// and the sky shows the real day or night with a plain look.
    private(set) var weather: WeatherReading? = SkyOverride.kind.flatMap(WeatherReading.forced)

    @ObservationIgnored private var outbox: [String: Outbox] = [:]
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var saveVersion = 0
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    @ObservationIgnored private var planTask: Task<Void, Never>?
    /// Whether the plan shown came from the hub in this session (only such a plan is saved back,
    /// never the bundled one or an old copy, which would undo changes made elsewhere).
    @ObservationIgnored private var planFresh = false
    /// The scenes as edited here, until the hub has them.
    @ObservationIgnored private var localScenes: [JSON]?
    @ObservationIgnored private var weatherTask: Task<Void, Never>?
    /// Weather events heard: a read that was on its way when one came is older than it.
    @ObservationIgnored private var weatherHeard = 0

    private struct Outbox { var pending: [String: JSON]?; var before: [String: JSON] = [:] }

    init(hub: HubClient) {
        self.hub = hub
        self.tv = TVStore(hub: hub)
        self.spotify = SpotifyStore(hub: hub)
        self.voice = VoiceAgent(hub: hub)
        let cached = (try? Data(contentsOf: Self.cacheURL)).flatMap { try? Plan(data: $0) }
        plan = cached ?? Plan.bundled()
        adoptPlan(plan, first: true)
        hub.onDevices = { [weak self] in self?.applyRemote($0) }
        hub.onTV = { [weak self] in self?.tv.take($0) }
        hub.onPathChanged = { [weak self] in self?.tv.networkChanged() }
        hub.onPlanChanged = { [weak self] in self?.refreshPlan() }
        hub.onWeather = { [weak self] in self?.takeWeather($0) }
        hub.onAgent = { [weak self] in self?.voice.take($0) }
        hub.onConnected = { [weak self] _ in
            self?.refreshPlan()
            self?.tv.refresh()
            self?.refreshWeather()
        }
        tv.onError = { [weak self] in self?.show($0, error: true) }
        // Read again every 10 minutes, whatever events come (an event may have been missed).
        weatherTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(600))
                self?.refreshWeather()
            }
        }
    }

    private static var cacheURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appending(path: "hub-plan.json")
    }

    // MARK: - the plan

    func refreshPlan() {
        planTask?.cancel()
        planTask = Task {
            guard let next = try? await hub.plan(), !Task.isCancelled else { return }
            try? next.raw.data().write(to: Self.cacheURL)
            planFresh = true
            adoptPlan(next, first: false)
        }
    }

    private func adoptPlan(_ incoming: Plan, first: Bool) {
        // Scenes edited here and not yet saved stay as edited.
        let next = localScenes.map { incoming.with(scenes: $0) } ?? incoming
        let rebuild = first || next.modelKey != plan.modelKey
        plan = next
        if rebuild { modelRev += 1 }
        for l in next.lights where lights[l.id] == nil {
            lights[l.id] = LightState(on: false, brightness: 0.8, temp: 3000, color: l.color)
        }
        for a in next.acs where acs[a.id] == nil {
            acs[a.id] = ACState(target: a.unit == "F" ? 74 : 24, roomTemp: a.unit == "F" ? 72 : 22)
        }
        // A save of ours still on its way keeps the order shown here.
        if saveTask == nil {
            tileOrder = next.tileOrder
            roomOrder = next.rooms.map(\.id)
        }
        folded = Set(UserDefaults.standard.stringArray(forKey: "house.folded:\(next.name)") ?? [])
    }

    // MARK: - the weather

    /// Asks the hub in use for the weather at the plan's site (not when it is forced, nor for a plan
    /// without a site). No answer: the last reading stays.
    func refreshWeather() {
        guard !SkyOverride.active, plan.site != nil else { return }
        let mark = weatherHeard
        Task {
            do {
                let reading = try await hub.weather()
                guard mark == weatherHeard, reading != weather else { return }
                weather = reading
            } catch {
                // The hub can't be asked just now: the last reading stays.
            }
        }
    }

    private func takeWeather(_ json: JSON) {
        weatherHeard += 1
        guard !SkyOverride.active else { return }
        let reading = WeatherReading(json: json)
        if reading != weather { weather = reading }
    }

    var orderedRooms: [Room] {
        let rank = Dictionary(uniqueKeysWithValues: roomOrder.enumerated().map { ($1, $0) })
        return plan.rooms.enumerated().sorted { a, b in
            (rank[a.element.id] ?? 10_000 + a.offset) < (rank[b.element.id] ?? 10_000 + b.offset)
        }.map(\.element)
    }

    func lightConfig(_ id: String) -> LightConfig? { plan.lights.first { $0.id == id } }
    func acConfig(_ id: String) -> ACConfig? { plan.acs.first { $0.id == id } }
    func roomName(_ id: String) -> String { plan.rooms.first { $0.id == id }?.name ?? id }

    // MARK: - tiles

    /// The TVs the plan's TV pieces show, each with the room it stands in.
    var tvTiles: [Tile] {
        var out: [Tile] = []
        for link in tvLinks(plan.furniture, tv.state) {
            guard let id = link.id, !out.contains(where: { $0.deviceID == id }) else { continue }
            out.append(Tile(kind: .tv, id: "tv:\(id)", deviceID: id, room: plan.roomAt(link.furniture.pos) ?? plan.rooms[0].id))
        }
        return out
    }

    /// A room's tiles: first those in `tileOrder`, as they were dragged; then the others as the
    /// plan has them (its ACs, its TV, then its lamps).
    func tiles(in room: String) -> [Tile] {
        let acs = plan.acs.filter { $0.room == room }.map { Tile(kind: .ac, id: $0.id, deviceID: $0.id, room: room) }
        let tvs = tvTiles.filter { $0.room == room }
        let lamps = plan.lights.filter { $0.room == room }.map { Tile(kind: .light, id: $0.id, deviceID: $0.id, room: room) }
        let speakers = plan.furniture.filter { $0.type == "speaker" && plan.roomAt($0.pos) == room }
            .map { Tile(kind: .speaker, id: "speaker:\($0.device ?? "spotify")", deviceID: $0.device ?? "spotify", room: room) }
        let uniqueSpeakers = speakers.reduce(into: [Tile]()) { out, tile in if !out.contains(where: { $0.id == tile.id }) { out.append(tile) } }
        let plain = acs + tvs + uniqueSpeakers + lamps
        let rank = Dictionary(tileOrder.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        return plain.enumerated().sorted { a, b in
            let ra = rank[a.element.id] ?? Int.max, rb = rank[b.element.id] ?? Int.max
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map(\.element)
    }

    /// One room's tiles were dragged into `keys`. A tile that isn't shown just now (a TV that is
    /// away) keeps its place after the tile it followed (web/src/ui/panel.js `reordered`).
    func reorderTiles(_ keys: [String]) {
        let moved = Set(keys)
        var i = 0
        var next = orderedRooms.flatMap { tiles(in: $0.id).map(\.id) }.map { k -> String in
            guard moved.contains(k) else { return k }
            defer { i += 1 }
            return keys[i]
        }
        for (at, k) in tileOrder.enumerated() where !next.contains(k) {
            if let before = tileOrder[..<at].reversed().first(where: { next.contains($0) }), let j = next.firstIndex(of: before) {
                next.insert(k, at: j + 1)
            } else {
                next.insert(k, at: 0)
            }
        }
        guard next != tileOrder else { return }
        tileOrder = next
        saveSoon()
    }

    func reorderRooms(_ ids: [String]) {
        guard ids != roomOrder else { return }
        roomOrder = ids
        saveSoon()
    }

    func toggleFold(_ room: String) {
        if folded.contains(room) { folded.remove(room) } else { folded.insert(room) }
        UserDefaults.standard.set(Array(folded), forKey: "house.folded:\(plan.name)")
    }

    /// Saves the plan with the new order 0.7 s after the last move (savePlan, like the web panel).
    private func saveSoon() {
        saveVersion += 1
        let version = saveVersion
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            if !planFresh {
                guard let next = try? await hub.plan() else {
                    guard version == saveVersion else { return }
                    show("The change wasn’t saved: the hub can’t be reached", error: true)
                    saveTask = nil
                    return
                }
                guard !Task.isCancelled, version == saveVersion else { return }
                planFresh = true
                adoptPlan(next, first: false)   // keeps the order shown here (a save is under way)
            }
            let config = plan.saving(tileOrder: tileOrder, roomOrder: roomOrder, scenes: localScenes)
            do {
                _ = try await hub.post("api/call", .object(["type": .string("savePlan"), "config": config, "client": .string(hub.clientID)]))
                guard !Task.isCancelled, version == saveVersion else { return }
                if let saved = try? Plan(json: config) { plan = saved }
                localScenes = nil
            } catch {
                guard !Task.isCancelled, version == saveVersion else { return }
                show("The change wasn’t saved: \(error.localizedDescription)", error: true)
                Haptics.error()
            }
            if version == saveVersion { saveTask = nil }
        }
    }

    // MARK: - state from the hub

    func applyRemote(_ msg: JSON) {
        live = true
        for (id, patch) in msg["lights"]?.object ?? [:] { writeLight(id, LightPatch(json: patch), remote: true) }
        for (id, patch) in msg["acs"]?.object ?? [:] { writeAC(id, patch.object ?? [:], remote: true) }
        for (id, f) in msg["features"]?.object ?? [:] where acs[id] != nil { features[id] = ACFeatures(json: f) }
    }

    func acFeatures(_ id: String) -> ACFeatures { features[id] ?? ACFeatures() }

    // MARK: - lamps

    private func lightJSON(_ s: LightState) -> [String: JSON] {
        ["on": .bool(s.on), "brightness": .number(s.brightness), "temp": .number(s.temp), "color": s.color.map(JSON.string) ?? .null]
    }

    @discardableResult
    private func writeLight(_ id: String, _ patch: LightPatch, remote: Bool) -> Bool {
        guard var cur = lights[id], let cfg = lightConfig(id) else { return false }
        let before = cur
        if let on = patch.on { cur.on = on }
        if let b = patch.brightness, cfg.dimmable || remote { cur.brightness = min(1, max(0.05, b)) }
        if let t = patch.temp, cfg.hasTemp || remote { cur.temp = min(6500, max(2200, t)); cur.color = nil }
        if let c = patch.color, cfg.hasColor || c == nil || remote { cur.color = c }
        guard cur != before else { return false }
        lights[id] = cur
        if !remote {
            let a = lightJSON(before), b = lightJSON(cur)
            let diff = b.filter { a[$0.key] != $0.value }
            dispatch(kind: "light", id: id, diff: diff, before: a.filter { diff[$0.key] != nil })
        }
        return true
    }

    func setLight(_ id: String, _ patch: LightPatch) {
        if writeLight(id, patch, remote: false) { scene = nil }
    }

    func toggleLight(_ id: String) {
        guard let s = lights[id] else { return }
        setLight(id, LightPatch(on: !s.on))
    }

    func setAllLights(_ on: Bool) {
        for l in plan.lights { writeLight(l.id, LightPatch(on: on), remote: false) }
        scene = nil
    }

    var lightsOn: Int { plan.lights.filter { lights[$0.id]?.on == true }.count }
    var anyOn: Bool { lightsOn > 0 || acs.values.contains { $0.on } }

    func toggleEverything() {
        if anyOn {
            setAllLights(false)
            for a in plan.acs { setAC(a.id, ["on": .bool(false)]) }
        } else {
            setAllLights(true)
        }
    }

    func applyScene(_ id: String) {
        guard let s = plan.scenes.first(where: { $0.id == id }) else { return }
        for l in plan.lights {
            var patch = (s.lights[l.id] ?? LightPatch()).merged(over: s.lights["*"] ?? LightPatch())
            // A scene that sets a white temperature is not overridden by a stale colour.
            if patch.color == nil, patch.temp != nil { patch.color = .some(nil) }
            writeLight(l.id, patch, remote: false)
        }
        for a in plan.acs {
            var patch = s.acs["*"]?.object ?? [:]
            for (k, v) in s.acs[a.id]?.object ?? [:] { patch[k] = v }
            if !patch.isEmpty { writeAC(a.id, patch, remote: false) }
        }
        for (deviceID, action) in s.tvs {
            guard let app = action["app"]?.string, !app.isEmpty else { continue }
            Task { await tv.act(deviceID, ["action": .string("open"), "app": .string(app), "name": action["name"] ?? .string(app)]) }
        }
        // The speaker by its id, or by its name if Spotify has given it a new one (the hub looks).
        if let music = s.spotify, let uri = music["uri"]?.string {
            var fields: [String: JSON] = ["uri": .string(uri)]
            if let device = music["device"]?.string, !device.isEmpty { fields["device"] = .string(device) }
            if let name = music["deviceName"]?.string, !name.isEmpty { fields["deviceName"] = .string(name) }
            spotify.perform("play", fields: fields)
        }
        scene = id
    }

    // MARK: - scenes of your own

    /// What every lamp (and, if asked, the AC) is doing now, as a scene's `lights` / `acs`
    /// (the shape web/src/store.js `applyScene` reads: one entry per lamp, no "*").
    func captureLights() -> JSON {
        var out: [String: JSON] = [:]
        for l in plan.lights {
            guard let s = lights[l.id] else { continue }
            guard s.on else { out[l.id] = .object(["on": .bool(false)]); continue }
            var e: [String: JSON] = ["on": .bool(true)]
            if l.dimmable { e["brightness"] = .number((s.brightness * 100).rounded() / 100) }
            if let c = s.color, l.hasColor { e["color"] = .string(c) }
            else if l.hasTemp { e["temp"] = .number(s.temp.rounded()) }
            out[l.id] = .object(e)
        }
        return .object(out)
    }

    func captureACs() -> JSON {
        var out: [String: JSON] = [:]
        for a in plan.acs {
            guard let s = acs[a.id] else { continue }
            out[a.id] = .object(["on": .bool(s.on), "mode": .string(s.mode), "target": .number(Double(s.target)), "fan": .string(s.fan)])
        }
        return .object(out)
    }

    /// Saves a new scene (`id` nil) or changes one; `capture`: take what the lamps (and the AC,
    /// with `includeAC`) do now, otherwise keep what the scene already sets.
    @discardableResult
    func saveScene(id: String?, name: String, icon: String, capture: Bool, includeAC: Bool, tvs: [String: JSON] = [:], spotify music: JSON? = nil) -> String {
        var list = plan.scenesJSON
        let index = id.flatMap { i in list.firstIndex { $0["id"]?.string == i } }
        var entry: [String: JSON] = index.flatMap { list[$0].object } ?? [:]
        let sceneID = id ?? Self.newSceneID(name)
        entry["id"] = .string(sceneID)
        entry["name"] = .string(name.isEmpty ? "Scene" : name)
        entry["icon"] = .string(icon)
        entry["tvs"] = tvs.isEmpty ? nil : .object(tvs)
        entry["spotify"] = music
        if capture || index == nil {
            entry["lights"] = captureLights()
            entry["acs"] = includeAC && !plan.acs.isEmpty ? captureACs() : nil
        } else if !includeAC {
            entry["acs"] = nil
        } else if entry["acs"] == nil, !plan.acs.isEmpty {
            entry["acs"] = captureACs()
        }
        if let index { list[index] = .object(entry) } else { list.append(.object(entry)) }
        setScenes(list)
        if index == nil { scene = sceneID }
        return sceneID
    }

    func deleteScene(_ id: String) {
        setScenes(plan.scenesJSON.filter { $0["id"]?.string != id })
        if scene == id { scene = nil }
    }

    func reorderScenes(_ ids: [String]) {
        let entries = plan.scenesJSON
        let byID = Dictionary(entries.compactMap { entry in entry["id"]?.string.map { ($0, entry) } }, uniquingKeysWith: { first, _ in first })
        guard Set(ids) == Set(byID.keys), ids.count == byID.count else { return }
        setScenes(ids.compactMap { byID[$0] })
    }

    private func setScenes(_ list: [JSON]) {
        localScenes = list
        plan = plan.with(scenes: list)
        saveSoon()
    }

    static func newSceneID(_ name: String) -> String {
        let slug = name.lowercased().map { $0.isLetter || $0.isNumber ? $0 : "-" }
            .reduce(into: "") { s, c in if !(c == "-" && s.last == "-") { s.append(c) } }
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        let hex = String(format: "%04x", Int.random(in: 0..<65536))
        return "custom-\(slug.isEmpty ? "scene" : String(slug.prefix(24)))-\(hex)"
    }

    // MARK: - air conditioners

    private func acJSON(_ s: ACState) -> [String: JSON] {
        ["on": .bool(s.on), "target": .number(Double(s.target)), "mode": .string(s.mode), "fan": .string(s.fan),
         "swing": .string(s.swing), "sleep": .bool(s.sleep), "eco": .bool(s.eco), "roomTemp": .number(s.roomTemp)]
    }

    @discardableResult
    private func writeAC(_ id: String, _ patch: [String: JSON], remote: Bool) -> Bool {
        guard var cur = acs[id], let cfg = acConfig(id) else { return false }
        let before = cur
        if let v = patch["on"]?.bool { cur.on = v }
        if let v = patch["target"]?.double { cur.target = min(cfg.max, max(cfg.min, Int(v.rounded()))) }
        if let v = patch["mode"]?.string { cur.mode = v }
        if let v = patch["fan"]?.string { cur.fan = v }
        if let v = patch["swing"]?.string { cur.swing = v }
        if let v = patch["sleep"]?.bool { cur.sleep = v }
        if let v = patch["eco"]?.bool { cur.eco = v }
        if let v = patch["roomTemp"]?.double { cur.roomTemp = v }
        guard cur != before else { return false }
        acs[id] = cur
        if !remote {
            let a = acJSON(before), b = acJSON(cur)
            var diff = b.filter { a[$0.key] != $0.value }
            diff["roomTemp"] = nil
            if !diff.isEmpty { dispatch(kind: "ac", id: id, diff: diff, before: a.filter { diff[$0.key] != nil }) }
        }
        return true
    }

    func setAC(_ id: String, _ patch: [String: JSON]) { writeAC(id, patch, remote: false) }

    // MARK: - sending

    private func dispatch(kind: String, id: String, diff: [String: JSON], before: [String: JSON]) {
        guard !diff.isEmpty else { return }
        if var slot = outbox[id] {
            slot.pending = (slot.pending ?? [:]).merging(diff) { _, new in new }
            slot.before = before.merging(slot.before) { _, old in old } // the oldest value is the one to go back to
            outbox[id] = slot
            return
        }
        outbox[id] = Outbox()
        Task { await run(kind: kind, id: id, patch: diff, before: before) }
    }

    private func run(kind: String, id: String, patch: [String: JSON], before: [String: JSON]) async {
        let started = ContinuousClock.now
        let state: [String: JSON] = kind == "light" ? lightJSON(lights[id] ?? LightState()) : acJSON(acs[id] ?? ACState())
        let body: JSON = .object(["type": .string("command"), "kind": .string(kind), "id": .string(id),
                                  "patch": .object(patch), "state": .object(state)])
        do {
            let answer = try await hub.post("api/call", body)
            _ = answer
        } catch {
            rollback(kind: kind, id: id, patch: patch, before: before, message: error.localizedDescription)
        }
        // Lamps take a new value every ~120 ms while a slider moves; ACs (infrared, the cloud) less often.
        let gap: Duration = kind == "light" ? .milliseconds(120) : .milliseconds(900)
        let wait = gap - (ContinuousClock.now - started)
        if wait > .zero { try? await Task.sleep(for: wait) }
        guard let slot = outbox[id], let next = slot.pending else { outbox[id] = nil; return }
        outbox[id] = Outbox()
        await run(kind: kind, id: id, patch: next, before: slot.before)
    }

    private func rollback(kind: String, id: String, patch: [String: JSON], before: [String: JSON], message: String) {
        if kind == "light", var cur = lights[id] {
            var j = lightJSON(cur)
            for (k, v) in patch where j[k] == v && outbox[id]?.pending?[k] == nil { j[k] = before[k] }
            cur.on = j["on"]?.bool ?? cur.on
            cur.brightness = j["brightness"]?.double ?? cur.brightness
            cur.temp = j["temp"]?.double ?? cur.temp
            cur.color = j["color"]?.string
            lights[id] = cur
        } else if kind == "ac", let cur = acs[id] {
            var j = acJSON(cur)
            for (k, v) in patch where j[k] == v && outbox[id]?.pending?[k] == nil { j[k] = before[k] }
            writeAC(id, j, remote: true)
        }
        let name = kind == "light" ? lightConfig(id)?.name : acConfig(id)?.name
        show("\(name ?? "The device"): \(message)", error: true)
        Haptics.error()
    }

    // MARK: - toasts

    func show(_ text: String, error: Bool = false) {
        withAnimation(.snappy) { toast = Toast(text: text, error: error) }
        toastTask?.cancel()
        toastTask = Task {
            try? await Task.sleep(for: .seconds(3.2))
            guard !Task.isCancelled else { return }
            withAnimation(.smooth) { toast = nil }
        }
    }
}
