import Foundation
import Network
import Observation

/// Talks to the House Control hub (hub/house.py): the plan, device commands, the TV and the
/// server-sent events that carry every device's state. There are two hubs that keep the same plan:
/// the home server (dell-server) and a backup (Riley's MacBook). The home server's addresses (the
/// house Wi-Fi and Tailscale) are asked at once; only when neither answers within ~3 s are the
/// backup's. While on the backup the home server is asked again every 30 s, and taken back as soon
/// as it answers. The hub needs no sign-in: requests carry no Origin header, which its same-origin
/// check allows.
@MainActor @Observable
final class HubClient {
    enum Link: Equatable {
        case connecting
        case connected(URL)
        case offline(String)
    }

    static let defaultAddresses = ["http://192.168.0.127:8766", "https://dell-server.tail946e94.ts.net"]
    static let defaultBackupAddresses = ["http://192.168.0.188:8766", "https://rileys-macbook-air.tail946e94.ts.net:8451"]
    static let defaultBackupName = "Mac"
    /// How long the home server has before the backup is asked, and how often it is asked again.
    static let primaryWait: Double = 3
    static let primaryRetry: Double = 30

    private(set) var link: Link = .connecting
    /// Whether the hub in use is the backup.
    private(set) var onBackup = false
    /// The home server's addresses, asked first.
    private(set) var addresses: [String]
    /// The backup hub's addresses, and what it is called ("Backup hub · Mac").
    private(set) var backupAddresses: [String]
    private(set) var backupName: String

    /// Where the hub in use is, as the card and Settings say it.
    var which: String { onBackup ? "Backup hub · \(backupName)" : "Home server" }
    /// This app, as the hub's reload events name the screen that saved a plan.
    let clientID = "ios-native-" + UUID().uuidString.prefix(8).lowercased()

    /// Device state (`lights` / `acs` / `features`), the TV, and "the plan changed".
    @ObservationIgnored var onDevices: ((JSON) -> Void)?
    @ObservationIgnored var onTV: ((JSON) -> Void)?
    @ObservationIgnored var onPlanChanged: (() -> Void)?
    /// A fresh connection: the plan should be read again.
    @ObservationIgnored var onConnected: ((URL) -> Void)?

    @ObservationIgnored private var base: URL?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var active = false
    @ObservationIgnored private let monitor = NWPathMonitor()
    @ObservationIgnored private var lastPath: String?

    private let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 12
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    private let streamSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 60   // the hub sends a keep-alive every 20 s
        c.timeoutIntervalForResource = 60 * 60 * 24
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    init() {
        let defaults = UserDefaults.standard
        if let saved = defaults.stringArray(forKey: "hub.primary") {
            addresses = saved
        } else {
            // Before there was a backup, one list held the hub's addresses: what was written there
            // stays the home server's, except an address of the backup hub (the hub once ran on it).
            let backupHosts = Set(Self.defaultBackupAddresses.compactMap { URL(string: $0)?.host() })
            let old = (defaults.stringArray(forKey: "hub.addresses") ?? [])
                .filter { !backupHosts.contains(URL(string: $0.trimmingCharacters(in: .whitespaces))?.host() ?? "") }
            let primary = old.isEmpty ? Self.defaultAddresses : old
            addresses = primary
            defaults.set(primary, forKey: "hub.primary")
            defaults.removeObject(forKey: "hub.addresses")
        }
        backupAddresses = defaults.stringArray(forKey: "hub.backup") ?? Self.defaultBackupAddresses
        backupName = defaults.string(forKey: "hub.backupName") ?? Self.defaultBackupName
        monitor.pathUpdateHandler = { [weak self] path in
            let key = "\(path.status)-\(path.availableInterfaces.map(\.name).joined(separator: ","))"
            Task { @MainActor in self?.pathChanged(key) }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    var baseURL: URL? { base }

    /// New addresses from Settings (empty fields left out), then a fresh look for the hub.
    func setAddresses(primary: [String], backup: [String], backupName name: String) {
        let clean = { (list: [String]) in list.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
        addresses = clean(primary)
        backupAddresses = clean(backup)
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        backupName = trimmed.isEmpty ? Self.defaultBackupName : trimmed
        let defaults = UserDefaults.standard
        defaults.set(addresses, forKey: "hub.primary")
        defaults.set(backupAddresses, forKey: "hub.backup")
        defaults.set(backupName, forKey: "hub.backupName")
        reconnect()
    }

    private func pathChanged(_ key: String) {
        defer { lastPath = key }
        guard lastPath != nil, lastPath != key, active else { return }
        reconnect()
    }

    // MARK: - lifecycle

    /// The app came to the front: find the hub and keep its events coming.
    func resume() {
        active = true
        reconnect()
    }

    /// The app went to the background: let the stream go.
    func suspend() {
        active = false
        streamTask?.cancel()
        streamTask = nil
    }

    func reconnect() {
        guard active else { return }
        streamTask?.cancel()
        streamTask = Task { [weak self] in await self?.run() }
    }

    private func run() async {
        var delay: Double = 1
        while !Task.isCancelled {
            if base == nil || link != .connected(base!) { link = .connecting }
            if let (url, backup) = await find() {
                base = url
                onBackup = backup
                link = .connected(url)
                UserDefaults.standard.set(url.absoluteString, forKey: "hub.last")
                onConnected?(url)
                delay = 1
                if backup {
                    // The home server is back: connect to it now (its events, its plan).
                    if await streamWatchingPrimary(from: url) { continue }
                } else {
                    await stream(from: url)
                }
                if Task.isCancelled { return }
            } else {
                link = .offline(backupAddresses.isEmpty ? "The hub can’t be reached" : "Neither hub can be reached")
            }
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 5)
        }
    }

    /// The home server if one of its addresses answers within ~3 s, else the backup hub.
    private func find() async -> (URL, Bool)? {
        if let url = await pick(addresses, within: Self.primaryWait) { return (url, false) }
        if Task.isCancelled { return nil }
        if let url = await pick(backupAddresses, within: 5) { return (url, true) }
        return nil
    }

    /// Every address is asked for `GET /api/plan` at once; the first that answers wins. The Wi-Fi
    /// address gets a short head start (it is the faster one when it works). None that answers
    /// within `seconds` (5 s for the backup, which a first Tailscale connection can need): nil.
    private func pick(_ addresses: [String], within seconds: Double) async -> URL? {
        let list = addresses.compactMap { URL(string: $0.trimmingCharacters(in: .whitespaces)) }
        guard !list.isEmpty else { return nil }
        let session = self.session
        let deadline = URL(string: "about:deadline")!
        return await withTaskGroup(of: URL?.self) { group in
            group.addTask {
                try? await Task.sleep(for: .seconds(seconds + 0.3))
                return deadline
            }
            for (i, url) in list.enumerated() {
                group.addTask {
                    if i > 0 { try? await Task.sleep(for: .milliseconds(300 * i)) }
                    var req = URLRequest(url: url.appending(path: "api/plan"))
                    req.timeoutInterval = seconds
                    guard let (_, resp) = try? await session.data(for: req),
                          (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
                    return url
                }
            }
            var left = list.count
            for await found in group {
                if let found {
                    group.cancelAll()
                    return found == deadline ? nil : found
                }
                left -= 1
                if left == 0 { break }
            }
            group.cancelAll()
            return nil
        }
    }

    /// Reads the backup hub's events while asking the home server every 30 s. True: the home
    /// server answered (the stream is let go); false: the backup's stream dropped.
    private func streamWatchingPrimary(from url: URL) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask { await self.stream(from: url); return false }
            group.addTask {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(Self.primaryRetry))
                    if Task.isCancelled { return false }
                    if await self.primaryAnswers() { return true }
                }
                return false
            }
            let back = await group.next() ?? false
            group.cancelAll()
            return back
        }
    }

    private func primaryAnswers() async -> Bool {
        await pick(addresses, within: Self.primaryWait) != nil
    }

    /// Reads `/api/events` until it drops. Each message is one `data:` line of JSON.
    private func stream(from url: URL) async {
        var req = URLRequest(url: url.appending(path: "api/events"))
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        do {
            let (bytes, resp) = try await streamSession.bytes(for: req)
            guard (resp as? HTTPURLResponse)?.statusCode == 200 else { return }
            for try await line in bytes.lines {
                guard line.hasPrefix("data:") else { continue }
                let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                guard let msg = JSON.parse(Data(payload.utf8)) else { continue }
                if msg["reload"]?.bool == true {
                    if msg["by"]?.string != clientID { onPlanChanged?() }
                } else if let tv = msg["tv"] {
                    onTV?(tv)
                } else {
                    onDevices?(msg)
                }
            }
        } catch {
            // Dropped (sleep, Wi-Fi change, hub restart): run() tries again.
        }
    }

    // MARK: - requests

    struct HubError: Error, LocalizedError {
        var message: String
        var errorDescription: String? { message }
    }

    private func url(_ path: String) throws -> URL {
        guard let base else { throw HubError(message: "The hub can’t be reached") }
        return URL(string: path, relativeTo: base)!.absoluteURL
    }

    /// `checkError`: an answer with a non-empty `error` throws it (the TV's state carries one as data).
    func get(_ path: String, checkError: Bool = true) async throws -> JSON {
        let (data, _) = try await send(URLRequest(url: try url(path)))
        guard let json = JSON.parse(data) else { throw HubError(message: "The hub answered something unreadable") }
        if checkError, let e = json["error"]?.string, !e.isEmpty { throw HubError(message: e) }
        return json
    }

    func post(_ path: String, _ body: JSON) async throws -> JSON {
        var req = URLRequest(url: try url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body.data()
        let (data, _) = try await send(req)
        guard let json = JSON.parse(data) else { throw HubError(message: "The hub answered something unreadable") }
        if let e = json["error"]?.string, !e.isEmpty { throw HubError(message: e) }
        return json
    }

    private func send(_ req: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: req)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            if (error as? URLError)?.code != .cancelled { reconnect() }
            throw HubError(message: "The hub can’t be reached")
        }
    }

    func plan() async throws -> Plan {
        let (data, resp) = try await send(URLRequest(url: try url("api/plan")))
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw HubError(message: "The hub has no plan") }
        return try Plan(data: data)
    }
}
