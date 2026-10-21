import Foundation
import Observation

/// The TV's state for the whole app, from the hub (`GET /api/tv`, then `{"tv": …}` events), and
/// what is asked of it (`POST /api/tv/{id}`). A change asked for shows at once (the app being
/// opened, the volume) and stands until the TV reports it or a few seconds pass, like
/// web/src/tv/client.js.
///
/// **The direct route** (docs/tv-launcher.md, phase 3). When the hub drives the TV through its
/// launcher, the TV says where that is (`direct`). While its remote page is open, and this phone
/// has paired with the launcher, the launcher is asked straight over the house Wi-Fi (600 ms to
/// answer, again whenever the network changes). While it answers, the keys, the pad, play and
/// pause, seeking, the volume and typing go to it, and the TV's state comes from its long poll,
/// mapped the way the hub maps it (`LauncherState`), so the page looks the same either way.
/// What only the hub can do stays with the hub: opening apps and titles (it checks the links),
/// search, the keys only tv-remote has, a volume level when the launcher's is fixed, and waking
/// a TV the launcher didn't wake. The first time the launcher fails (no answer, or a 401), the
/// hub takes over at once and the command goes there; a 401 also forgets the token. A toggle
/// (play/pause, mute, power) that timed out isn't sent again: the TV may already have done it.
@MainActor @Observable
final class TVStore {
    private let hub: HubClient
    /// The TV as the hub last reported it.
    private(set) var real = TVState()
    private(set) var ready = false
    /// Device id -> what was asked for and not yet reported.
    private var held: [String: Held] = [:]
    @ObservationIgnored private var queues: [String: Queue] = [:]
    @ObservationIgnored var onError: ((String) -> Void)?

    /// The launcher that answers on this Wi-Fi, while it does.
    private(set) var direct: DirectLink?
    /// The TV whose launcher answers here but hasn't been paired with this phone: the remote
    /// page offers to pair.
    private(set) var pairable: String?
    /// This phone's launcher tokens, by `TVDirect.accounts.first` (read from the Keychain once).
    private var tokens: [String: String] = [:]
    @ObservationIgnored private var looked: Set<String> = []
    /// The TV whose remote page is open (the only time the launcher is followed).
    @ObservationIgnored private var remoteOpen: String?
    /// The probe, then the long poll, of the launcher.
    @ObservationIgnored private var link: Task<Void, Never>?
    /// The launcher last tried, so the hub's every event doesn't try it again.
    @ObservationIgnored private var probed: String?

    /// How long the launcher has to answer before the hub is used.
    static let probeTimeout: Double = 0.6
    /// How long a woken TV has to say it is on before the hub is asked to wake it too.
    static let wakeWait: Double = 6

    struct DirectLink {
        var id: String
        var client: LauncherClient
        /// The TV from the launcher's state, before the hub's view is laid over it (`merged`).
        var device: TVDevice
        /// The Chromecast's volume is fixed (HDMI-CEC sends every change to the TV): no level here.
        var volumeFixed: Bool
    }

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

    /// The panel's remote keys as the launcher's commands (hub/tv.py `LAUNCHER_KEYS`). The ones
    /// missing here go to the hub.
    static let launcherKeys: [String: JSON] = {
        var out: [String: JSON] = [:]
        for k in ["up", "down", "left", "right", "ok", "back", "home"] {
            out[k] = .object(["type": .string("key"), "key": .string(k)])
        }
        let media = { (action: String, ms: Double?) -> JSON in
            var o: [String: JSON] = ["type": .string("media"), "action": .string(action)]
            if let ms { o["ms"] = .number(ms) }
            return .object(o)
        }
        out["playpause"] = media("toggle", nil)
        out["play"] = media("play", nil)
        out["pause"] = media("pause", nil)
        out["rewind"] = media("seekBy", -10_000)
        out["forward"] = media("seekBy", 10_000)
        out["volup"] = .object(["type": .string("volume"), "delta": .number(1)])
        out["voldown"] = .object(["type": .string("volume"), "delta": .number(-1)])
        for k in ["mute", "power", "wake", "sleep"] { out[k] = .object(["type": .string(k)]) }
        return out
    }()

    init(hub: HubClient) { self.hub = hub }

    /// The TV as last reported: the hub's, with the launcher's view of its own TV on top while
    /// the direct route is up.
    private var reported: TVState {
        guard let link = direct else { return real }
        var s = real
        let d = merged(link, real.devices.first { $0.id == link.id })
        if let i = s.devices.firstIndex(where: { $0.id == link.id }) { s.devices[i] = d } else { s.devices.append(d) }
        s.available = true
        s.error = ""
        return s
    }

    /// What to show: the TV's report with what was just asked for on top.
    var state: TVState {
        var s = reported
        let now = Date()
        s.devices = s.devices.map { d in
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
        loadTokens()
        settle()
        // The hub just said where the launcher is (or it moved): look for it.
        if let id = remoteOpen, direct == nil, link == nil, let target = launcher(of: id), probe(target) != probed {
            connectDirect()
        }
    }

    /// Each asked-for field stands until the TV reports that value.
    private func settle() {
        let now = Date()
        let s = reported
        for (id, h) in held {
            guard h.until > now, let d = s.devices.first(where: { $0.id == id }) else { held[id] = nil; continue }
            var h = h
            if h.on == d.on { h.on = nil }
            if let app = h.app, app?.id == d.app?.id { h.app = nil }
            if h.volume == d.volume { h.volume = nil }
            if h.muted == d.muted { h.muted = nil }
            held[id] = h.isEmpty ? nil : h
        }
    }

    func refresh() {
        // The hub (or the app) is back: the launcher is looked for again with the next state.
        if remoteOpen != nil, direct == nil { probed = nil }
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

    /// Asks the TV for something (see hub/tv.py): through the launcher while the direct route
    /// is up and it can, else through the hub. Sent one after another per TV; a held key that
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
            switch await self.sendDirect(id, body) {
            case .done: return true
            case .unanswered:
                // The TV may have toggled already: sending it again through the hub could undo it.
                await MainActor.run { self.held[id] = nil }
                return false
            case .notSent: break
            }
            do {
                _ = try await hub.post("api/tv/\(Self.path(id))", .object(body))
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

    private static func path(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
    }

    // MARK: - the direct route

    /// Which way the TV `id` is driven now, as the remote page's menu says it.
    func isDirect(_ id: String) -> Bool { direct?.id == id }

    /// Whether this phone has paired with the launcher of the TV `id`.
    func isPaired(_ id: String) -> Bool { launcher(of: id).flatMap { tokens[account($0)] } != nil }

    /// Where the hub says the TV's launcher is.
    func launcher(of id: String) -> TVDirect? { real.devices.first { $0.id == id }?.direct }

    private func account(_ t: TVDirect) -> String { t.accounts.first ?? t.url.absoluteString }
    private func probe(_ t: TVDirect) -> String { t.url.absoluteString + "#" + (t.id ?? "") }

    /// The remote page of the TV `id` opened: its launcher is looked for.
    func remoteOpened(_ id: String) {
        remoteOpen = id
        probed = nil
        connectDirect()
    }

    /// The remote page closed: the launcher is let go, and the hub is the way again.
    func remoteClosed(_ id: String) {
        guard remoteOpen == id else { return }
        remoteOpen = nil
        pairable = nil
        dropDirect()
    }

    /// The phone moved to another network (or off one): the launcher is looked for again.
    func networkChanged() {
        guard remoteOpen != nil else { return }
        probed = nil
        connectDirect()
    }

    private func loadTokens() {
        for d in real.devices {
            guard let t = d.direct else { continue }
            let key = account(t)
            guard !looked.contains(key) else { continue }
            looked.insert(key)
            if let token = LauncherTokens.token(t.accounts) { tokens[key] = token }
        }
    }

    private func dropDirect() {
        link?.cancel()
        link = nil
        if direct != nil {
            direct = nil
            settle()
        }
    }

    /// Asks the launcher of the open remote's TV whether it answers here: with a token, its
    /// state (then follows it); without one, who it is (then the page offers to pair).
    private func connectDirect() {
        dropDirect()
        guard let id = remoteOpen, let target = launcher(of: id) else { return }
        probed = probe(target)
        if let token = tokens[account(target)] {
            let client = LauncherClient(base: target.url, token: token)
            link = Task { [weak self] in await self?.follow(id, client) }
        } else {
            link = Task { [weak self] in
                let answers = (try? await LauncherClient.hello(target.url, timeout: Self.probeTimeout)) != nil
                guard !Task.isCancelled, let self else { return }
                self.pairable = answers ? id : nil
                self.link = nil
            }
        }
    }

    /// The launcher's state, at once and then by long poll, until it fails (the hub takes over)
    /// or the page closes.
    private func follow(_ id: String, _ client: LauncherClient) async {
        var since: Int?
        while !Task.isCancelled {
            do {
                let st = try await client.state(since: since, timeout: since == nil ? Self.probeTimeout : LauncherClient.longPoll + 10)
                guard !Task.isCancelled else { return }
                guard let rev = st["rev"]?.int else { throw LauncherClient.Failure.unreachable }
                since = rev
                adopt(st, id: id, client: client)
            } catch {
                guard !Task.isCancelled, !(error is CancellationError) else { return }
                fallBack(client, unpaired: (error as? LauncherClient.Failure) == .unpaired)
                dropDirect()   // this follow is the current one: not cancelled
                return
            }
        }
    }

    private func adopt(_ st: JSON, id: String, client: LauncherClient) {
        let name = real.devices.first { $0.id == id }?.name
        guard let d = LauncherState.device(st, id: id, name: name, at: Date().timeIntervalSince1970, picture: client.picture) else { return }
        direct = DirectLink(id: id, client: client, device: d, volumeFixed: st["tv"]?["volumeFixed"]?.bool ?? false)
        pairable = nil
        ready = true
        settle()
    }

    /// The launcher at `client` failed: the hub is the way from now on (until the page opens
    /// again or the network changes). A 401 means its token is no good: it is forgotten, and
    /// the page offers to pair again.
    private func fallBack(_ client: LauncherClient, unpaired: Bool) {
        if unpaired, let id = remoteOpen, let t = launcher(of: id), tokens[account(t)] == client.token {
            LauncherTokens.forget(t.accounts)
            tokens[account(t)] = nil
            pairable = id
        }
        if direct?.client == client { dropDirect() }
    }

    /// The launcher's TV with what only the hub knows laid over it, as hub/tv.py does: the
    /// hub's name and `direct`, tv-remote's volume while the Chromecast's is fixed, the picture
    /// the hub found for the same title, and what Cast says plays when the launcher sees no
    /// media session.
    private func merged(_ link: DirectLink, _ seen: TVDevice?) -> TVDevice {
        var d = link.device
        guard let seen else { return d }
        d.name = seen.name
        d.direct = seen.direct
        if link.volumeFixed, seen.volume != nil {
            d.volume = seen.volume
            d.volumeMax = seen.volumeMax
            d.muted = seen.muted
        }
        if var np = d.nowPlaying {
            if np.artwork == nil, let theirs = seen.nowPlaying, theirs.title == np.title {
                np.artwork = theirs.artwork
                d.nowPlaying = np
            }
        } else if d.on, let theirs = seen.nowPlaying, seen.app?.id == d.app?.id {
            d.nowPlaying = theirs
        }
        return d
    }

    /// Sends `body` to the launcher when the direct route is up and it can do it. True when the
    /// TV did it; false sends it to the hub: the route is down, the hub does this one, the
    /// launcher said no (the hub has tv-remote to step in, and the words for a no), or it
    /// failed (then the hub is the way from now on).
    private enum Direct { case done, notSent, unanswered }

    /// Actions that flip the TV's state: one that may have reached it isn't sent again.
    static let toggles: Set<String> = ["playpause", "mute", "power"]

    /// Through the launcher: `done`, `notSent` (the hub should do it), or `unanswered` when a
    /// toggle timed out and may have happened; that one isn't sent to the hub as well.
    private func sendDirect(_ id: String, _ body: [String: JSON]) async -> Direct {
        guard let link = direct, link.id == id, let cmd = command(body, link) else { return .notSent }
        do {
            guard try await link.client.cmd(cmd) else { return .notSent }
            if body["action"]?.string == "wake" { checkAwake(id) }
            return .done
        } catch {
            if error is CancellationError { return .notSent }
            fallBack(link.client, unpaired: (error as? LauncherClient.Failure) == .unpaired)
            if (error as? LauncherClient.Failure) == .timedOut, Self.toggles.contains(body["action"]?.string ?? "") {
                return .unanswered
            }
            return .notSent
        }
    }

    /// `body` as the launcher's command, or nil when the hub does it.
    private func command(_ body: [String: JSON], _ link: DirectLink) -> JSON? {
        let action = body["action"]?.string ?? ""
        // "play" with an app is a search result to play: the hub checks its link.
        if let c = Self.launcherKeys[action], body["app"] == nil { return c }
        switch action {
        case "volume":
            // A fixed volume has no level to set here: tv-remote sets it, through the hub.
            guard !link.volumeFixed, let level = body["level"]?.int, level >= 0, level <= (link.device.volumeMax ?? 100) else { return nil }
            return .object(["type": .string("volume"), "level": .number(Double(level))])
        case "seek":
            // Only what the launcher's own media session plays; Cast's goes through the hub.
            guard let np = link.device.nowPlaying, np.seekable, let duration = np.duration,
                  let p = body["position"]?.double, p.isFinite else { return nil }
            let target = min(max(0, p), max(0, duration - 1))
            return .object(["type": .string("seek"), "positionMs": .number((target * 1000).rounded())])
        case "text":
            guard let text = body["text"]?.string, !text.trimmingCharacters(in: .whitespaces).isEmpty, text.count <= 200 else { return nil }
            return .object(["type": .string("text"), "text": .string(text)])
        default:
            return nil
        }
    }

    /// A launcher may say it woke the TV and still not reach it (HDMI-CEC, a Chromecast half
    /// asleep): if the TV doesn't say it is on within a few seconds, the hub wakes it too
    /// (through tv-remote).
    private func checkAwake(_ id: String) {
        Task { [hub] in
            try? await Task.sleep(for: .seconds(Self.wakeWait))
            guard self.reported.devices.first(where: { $0.id == id })?.on != true else { return }
            _ = try? await hub.post("api/tv/\(Self.path(id))", .object(["action": .string("wake")]))
        }
    }

    // MARK: - pairing

    enum Pairing: Equatable {
        case paired
        case wrongCode
        case failed(String)
    }

    /// Asks the TV to show a 4-digit code. Nil when it does, else what to tell the person.
    func startPairing(_ id: String) async -> String? {
        guard let target = launcher(of: id) else { return "The hub doesn’t say where the TV’s launcher is." }
        do {
            return try await LauncherClient.startPairing(target.url)
                ? nil : "The TV can’t show a code: its remote input is off. Set it up again from the Mac."
        } catch {
            return "The TV doesn’t answer on this Wi-Fi. Pair it at home."
        }
    }

    /// Trades the code on the TV for the launcher's token, keeps it in the Keychain, and takes
    /// the direct route.
    func finishPairing(_ id: String, code: String) async -> Pairing {
        guard let target = launcher(of: id) else { return .failed("The hub doesn’t say where the TV’s launcher is.") }
        do {
            guard let token = try await LauncherClient.finishPairing(target.url, code: code) else { return .wrongCode }
            LauncherTokens.save(token, accounts: target.accounts)
            tokens[account(target)] = token
            pairable = nil
            if remoteOpen == id { connectDirect() }
            return .paired
        } catch {
            return .failed("The TV stopped answering.")
        }
    }

    /// Hides the code on the TV.
    func cancelPairing(_ id: String) {
        guard let target = launcher(of: id) else { return }
        Task { await LauncherClient.cancelPairing(target.url) }
    }

    /// Forgets this phone's token for the TV's launcher: the hub is the way again.
    func forgetPairing(_ id: String) {
        guard let target = launcher(of: id) else { return }
        LauncherTokens.forget(target.accounts)
        tokens[account(target)] = nil
        if remoteOpen == id { connectDirect() } else { dropDirect() }
    }
}
