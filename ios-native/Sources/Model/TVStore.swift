import Foundation
import Observation

/// The TV's state for the whole app, from the hub (`GET /api/tv`, then `{"tv": …}` events), and
/// what is asked of it (`POST /api/tv/{id}`). A change asked for shows at once (the app being
/// opened, the volume) and stands until the TV reports it or a few seconds pass, like
/// web/src/tv/client.js.
@MainActor @Observable
final class TVStore {
    private let hub: HubClient
    private(set) var real = TVState()
    private(set) var ready = false
    /// Device id -> what was asked for and not yet reported.
    private var held: [String: Held] = [:]
    @ObservationIgnored private var queues: [String: Queue] = [:]
    @ObservationIgnored var onError: ((String) -> Void)?

    private struct Held {
        var on: Bool?
        var app: TVApp??
        var volume: Int?
        var muted: Bool?
        var until: Date
        var isEmpty: Bool { on == nil && app == nil && volume == nil && muted == nil }
    }

    private struct Queue { var tail: Task<Bool, Never>?; var keys = 0 }

    static let keys: Set<String> = ["up", "down", "left", "right", "ok", "back", "home", "menu", "playpause", "rewind", "forward", "volup", "voldown"]

    init(hub: HubClient) { self.hub = hub }

    /// What to show: the TV's report with what was just asked for on top.
    var state: TVState {
        var s = real
        let now = Date()
        s.devices = real.devices.map { d in
            guard let h = held[d.id], h.until > now else { return d }
            var d = d
            if let on = h.on { d.on = on }
            if let app = h.app { d.app = app }
            if let v = h.volume { d.volume = v }
            if let m = h.muted { d.muted = m }
            return d
        }
        return s
    }

    func device(_ id: String) -> TVDevice? { state.devices.first { $0.id == id } }

    func take(_ json: JSON) {
        real = TVState(json: json)
        ready = true
        // Each asked-for field stands until the TV reports that value.
        let now = Date()
        for (id, h) in held {
            guard h.until > now, let d = real.devices.first(where: { $0.id == id }) else { held[id] = nil; continue }
            var h = h
            if h.on == d.on { h.on = nil }
            if let app = h.app, app?.id == d.app?.id { h.app = nil }
            if h.volume == d.volume { h.volume = nil }
            if h.muted == d.muted { h.muted = nil }
            held[id] = h.isEmpty ? nil : h
        }
    }

    func refresh() {
        Task {
            if let s = try? await hub.get("api/tv", checkError: false) { take(s) }
        }
    }

    private func expect(_ d: TVDevice, _ body: [String: JSON]) -> Held? {
        let until = Date().addingTimeInterval(5)
        switch body["action"]?.string {
        case "wake": return Held(on: true, until: until)
        case "sleep": return Held(on: false, app: .some(nil), until: until)
        case "open", "play":
            guard body["app"] != nil else { return nil }
            let id = body["app"]?.string ?? ""
            return Held(on: true, app: .some(TVApp(id: id, name: body["name"]?.string ?? id)), until: until)
        case "volume": return Held(volume: body["level"]?.int, muted: false, until: until)
        case "volup", "voldown":
            guard let v = d.volume else { return nil }
            let next = max(0, min(d.volumeMax ?? 100, v + (body["action"]?.string == "volup" ? 1 : -1)))
            return Held(volume: next, muted: false, until: until)
        case "mute": return Held(muted: !d.muted, until: until)
        default: return nil
        }
    }

    /// Asks the TV for something (see hub/tv.py). Sent one after another per TV; a held key that
    /// gets ahead of the TV drops presses instead of piling them up. True when the TV did it.
    @discardableResult
    func act(_ id: String, _ body: [String: JSON]) async -> Bool {
        var q = queues[id] ?? Queue()
        let action = body["action"]?.string ?? ""
        let isKey = Self.keys.contains(action)
        if isKey, q.keys >= 3 { return false }
        if let d = device(id), let patch = expect(d, body) {
            var h = held[id] ?? Held(until: patch.until)
            if let v = patch.on { h.on = v }
            if let v = patch.app { h.app = v }
            if let v = patch.volume { h.volume = v }
            if let v = patch.muted { h.muted = v }
            h.until = patch.until
            held[id] = h
        }
        if isKey { q.keys += 1 }
        let previous = q.tail
        let task = Task<Bool, Never> { [hub] in
            _ = await previous?.value
            do {
                _ = try await hub.post("api/tv/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)", .object(body))
                return true
            } catch {
                await MainActor.run {
                    self.held[id] = nil
                    self.onError?(error.localizedDescription)
                }
                return false
            }
        }
        q.tail = task
        queues[id] = q
        let ok = await task.value
        if isKey { queues[id]?.keys -= 1 }
        return ok
    }

    func act(_ id: String, action: String) {
        Task { await act(id, ["action": .string(action)]) }
    }

    func search(_ q: String) async throws -> [SearchResult] {
        let query = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+=?"))) ?? q
        let json = try await hub.get("api/tv/search?q=\(query)")
        return (json["results"]?.array ?? []).compactMap(SearchResult.init(json:))
    }
}
