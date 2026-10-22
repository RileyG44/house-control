import Foundation

/// The Mac hub (hub/house.py) over its local HTTP API: the same `/api/call` commands and
/// `/api/events` state the hub's own web panel uses. It is what drives WiZ, AiDot and
/// MRCOOL devices, so a native panel on the hub's Mac forwards those links here instead
/// of simulating them.
public struct LocalHubClient: Sendable {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    /// The hub on this Mac, at the port hub/house.py serves (HOUSE_HUB_PORT replaces it).
    public static var local: LocalHubClient {
        let port = ProcessInfo.processInfo.environment["HOUSE_HUB_PORT"] ?? "8766"
        return LocalHubClient(baseURL: URL(string: "http://127.0.0.1:\(port)")!)
    }

    /// The first `data:` event of an `/api/events` stream: the devices' current state,
    /// keyed by the plan's device ids, in the shape the panel's `applyRemote` takes.
    public static func firstEvent(from payload: String) -> [String: Any]? {
        for line in payload.split(separator: "\n") {
            guard line.hasPrefix("data:") else { continue }
            let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard let data = json.data(using: .utf8),
                  let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return state
        }
        return nil
    }

    /// Current device state from the hub, or nil when it is not running.
    public func state() async -> [String: Any]? {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/events"))
        request.timeoutInterval = 5
        guard let (bytes, response) = try? await session.bytes(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        do {
            for try await line in bytes.lines {
                if line.hasPrefix("data:") {
                    return Self.firstEvent(from: line)
                }
            }
        } catch {
            return nil
        }
        return nil
    }

    /// One panel command, answered the way the native shell answers: `{"ok": true}` or
    /// `{"error": …}`. A hub that is not running answers with an error, never a fake ok.
    public func command(planId: String, patch: [String: Any], state: [String: Any]) async -> [String: Any] {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/call"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 10
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["type": "command", "id": planId, "patch": patch, "state": state])
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["error": "The hub on this Mac cannot be reached"]
        }
        return result
    }

    /// Whether the panel may reach `path` on the hub through the app (`hubRequest`): only
    /// the TV's routes (hub/tv.py) and the weather at the house (hub/weather.py). The rest
    /// of the hub has its own native calls.
    public static func allows(path: String) -> Bool {
        let path = path.hasPrefix("/") ? String(path.dropFirst()) : path
        if path == "api/weather" || path == "api/spotify" { return true }
        guard path == "api/tv" || path.hasPrefix("api/tv/") || path.hasPrefix("api/tv?") else { return false }
        return !path.contains("..") && !path.contains("#") && !path.contains("\\")
    }

    /// One request to the hub on the panel's behalf, answered with the decoded JSON
    /// (a 4xx/5xx answer keeps its `{"error": …}`), or `{"error": …}` when the hub cannot
    /// be reached. `path` is relative, like "api/tv" or "api/tv/search?q=…".
    public func request(method: String, path: String, body: [String: Any]? = nil) async -> [String: Any] {
        guard Self.allows(path: path) else { return ["error": "The panel may not ask the hub for \(path)"] }
        let relative = path.hasPrefix("/") ? String(path.dropFirst()) : path
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: "\(base)/\(relative)") else {
            return ["error": "Not a hub address: \(path)"]
        }
        var request = URLRequest(url: url)
        request.httpMethod = method.uppercased() == "POST" ? "POST" : "GET"
        // An app launch waits for a sleeping TV, and the catalog search reaches JustWatch.
        request.timeoutInterval = 25
        if request.httpMethod == "POST" {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let json: [String: Any] = body.map { JSONSerialization.isValidJSONObject($0) ? $0 : [:] } ?? [:]
            request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        guard let (data, response) = try? await session.data(for: request), response is HTTPURLResponse else {
            return ["error": "The hub on this Mac cannot be reached"]
        }
        guard let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ["error": "The hub answered HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)"]
        }
        return result
    }
}
