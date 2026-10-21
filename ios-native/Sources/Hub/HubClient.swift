import Foundation
import Network
import Observation

/// Talks to the House Control hub on dell-server (hub/house.py): the plan, device commands, the TV
/// and the server-sent events that carry every device's state. Two addresses are tried in turn
/// (the Dell on the house Wi-Fi, then over Tailscale); the first that answers is remembered.
/// The hub needs no sign-in: requests carry no Origin header, which its same-origin check allows.
@MainActor @Observable
final class HubClient {
    enum Link: Equatable {
        case connecting
        case connected(URL)
        case offline(String)
    }

    static let defaultAddresses = ["http://192.168.0.127:8766", "https://dell-server.tail946e94.ts.net"]

    private(set) var link: Link = .connecting
    var addresses: [String] {
        didSet { UserDefaults.standard.set(addresses, forKey: "hub.addresses"); reconnect() }
    }
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
        addresses = UserDefaults.standard.stringArray(forKey: "hub.addresses") ?? Self.defaultAddresses
        monitor.pathUpdateHandler = { [weak self] path in
            let key = "\(path.status)-\(path.availableInterfaces.map(\.name).joined(separator: ","))"
            Task { @MainActor in self?.pathChanged(key) }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    var baseURL: URL? { base }

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
            if let url = await pick() {
                base = url
                link = .connected(url)
                UserDefaults.standard.set(url.absoluteString, forKey: "hub.last")
                onConnected?(url)
                delay = 1
                await stream(from: url)
                if Task.isCancelled { return }
            } else {
                link = .offline("The hub can’t be reached")
            }
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 5)
        }
    }

    /// Every address is asked for `GET /api/plan` at once; the first that answers wins. The Wi-Fi
    /// address gets a short head start (it is the faster one when it works), and each has up to
    /// 5 s, which a first Tailscale connection can need.
    private func pick() async -> URL? {
        let list = addresses.compactMap { URL(string: $0.trimmingCharacters(in: .whitespaces)) }
        guard !list.isEmpty else { return nil }
        let session = self.session
        return await withTaskGroup(of: URL?.self) { group in
            for (i, url) in list.enumerated() {
                group.addTask {
                    if i > 0 { try? await Task.sleep(for: .milliseconds(400 * i)) }
                    var req = URLRequest(url: url.appending(path: "api/plan"))
                    req.timeoutInterval = 5
                    guard let (_, resp) = try? await session.data(for: req),
                          (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
                    return url
                }
            }
            for await found in group where found != nil {
                group.cancelAll()
                return found
            }
            return nil
        }
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
