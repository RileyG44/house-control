import Foundation
import Security

/// The TV's own launcher ("Living Room", tv-launcher/ in the repo), as the remote page talks to
/// it straight over the house Wi-Fi: no hub in between, so a key press is one hop. The hub says
/// where it is (`direct` on the TV, hub/tv.py); this phone pairs with it on its own and keeps
/// the token in the Keychain (`LauncherTokens`).
///
///   GET  /api/state?since=rev     the whole state; waits (up to 25 s) until it changes after `rev`
///   POST /api/cmd                 {"type": key|media|seek|volume|mute|text|wake|sleep|…} -> {"ok"}
///   GET  /art/now, /banner/{pkg}  what is playing, an app's banner
///   POST /pair/start, /pair/finish {code}, /pair/cancel   a 4-digit code on the TV, traded for the token
///
/// Every /api call carries the token as X-LR-Key; without the right one the answer is 401.
struct LauncherClient: Sendable, Equatable {
    enum Failure: Error, Equatable {
        /// No connection (refused, no route), or an answer that isn't the launcher's.
        case unreachable
        /// The request went out but no answer came in time: the TV may have done it anyway.
        case timedOut
        /// The launcher answered, but doesn't take this token (it was paired again, or reset).
        case unpaired
    }

    /// How long the launcher holds a long poll before it answers anyway.
    static let longPoll: Double = 25

    let base: URL
    let token: String

    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = LauncherClient.longPoll + 10
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()

    // MARK: - state and commands

    /// The launcher's /api/state. With `since`, it waits until something changed after that rev
    /// (or the long poll runs out); without it, it answers at once, which is how the page finds
    /// out whether the TV answers on this network at all.
    func state(since: Int?, timeout: Double) async throws -> JSON {
        var c = URLComponents(url: base.appending(path: "api/state"), resolvingAgainstBaseURL: false)
        if let since { c?.queryItems = [URLQueryItem(name: "since", value: String(since))] }
        guard let url = c?.url else { throw Failure.unreachable }
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        req.setValue(token, forHTTPHeaderField: "X-LR-Key")
        let (data, status) = try await Self.fetch(req)
        if status == 401 { throw Failure.unpaired }
        guard status == 200, let json = JSON.parse(data), json["tv"]?.object != nil else { throw Failure.unreachable }
        return json
    }

    /// One command. True when the TV did it, false when it couldn't (nothing playing, no text
    /// field, a fixed volume); a launcher that doesn't answer throws.
    func cmd(_ body: JSON, timeout: Double = 3.5) async throws -> Bool {
        var req = URLRequest(url: base.appending(path: "api/cmd"))
        req.httpMethod = "POST"
        req.timeoutInterval = timeout
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(token, forHTTPHeaderField: "X-LR-Key")
        req.httpBody = body.data()
        let (data, status) = try await Self.fetch(req)
        if status == 401 { throw Failure.unpaired }
        guard status == 200, let json = JSON.parse(data) else { throw Failure.unreachable }
        return json["ok"]?.bool == true
    }

    /// One of the launcher's pictures (`art/now?v=…`, `banner/{pkg}`, as its state names them),
    /// with the token as `?k=`, for AsyncImage.
    func picture(_ path: String) -> URL? {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        guard var c = URLComponents(string: base.absoluteString + "/" + trimmed) else { return nil }
        c.queryItems = (c.queryItems ?? []) + [URLQueryItem(name: "k", value: token)]
        return c.url
    }

    // MARK: - pairing (no token yet)

    /// Who the TV at `base` is ({"name", "id", "paired"}); a quick look that it answers here.
    static func hello(_ base: URL, timeout: Double) async throws -> JSON {
        var req = URLRequest(url: base.appending(path: "pair/hello"))
        req.timeoutInterval = timeout
        let (data, status) = try await fetch(req)
        guard status == 200, let json = JSON.parse(data), json["id"] != nil else { throw Failure.unreachable }
        return json
    }

    /// Asks the TV to show a 4-digit code. False when it can't draw one (its remote input
    /// service is off).
    static func startPairing(_ base: URL) async throws -> Bool {
        let (data, status) = try await fetch(post(base, "pair/start", nil))
        guard status == 200 else { throw Failure.unreachable }
        return JSON.parse(data)?["ok"]?.bool == true
    }

    /// The token for the code on the TV, or nil when that isn't it (five wrong tries and the TV
    /// takes its code away).
    static func finishPairing(_ base: URL, code: String) async throws -> String? {
        let (data, status) = try await fetch(post(base, "pair/finish", .object(["code": .string(code)])))
        if status == 403 { return nil }
        guard status == 200, let token = JSON.parse(data)?["token"]?.string, !token.isEmpty else { throw Failure.unreachable }
        return token
    }

    /// Hides the code on the TV.
    static func cancelPairing(_ base: URL) async {
        _ = try? await fetch(post(base, "pair/cancel", nil))
    }

    private static func post(_ base: URL, _ path: String, _ body: JSON?) -> URLRequest {
        var req = URLRequest(url: base.appending(path: path))
        req.httpMethod = "POST"
        req.timeoutInterval = 5
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = (body ?? .object([:])).data()
        return req
    }

    /// The answer's body and HTTP status. No answer in time is `timedOut`; anything else that
    /// isn't an answer (refused, no route) is `unreachable`; a cancelled task stays a cancellation.
    private static func fetch(_ req: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, resp) = try await session.data(for: req)
            return (data, (resp as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            if (error as? URLError)?.code == .timedOut { throw Failure.timedOut }
            throw Failure.unreachable
        }
    }
}

/// This phone's token for each TV's launcher, in the Keychain (a generic password per TV, under
/// the launcher's own id, or its address when the hub doesn't know the id). It stays on this
/// device and out of backups.
enum LauncherTokens {
    private static let service = "dev.riley.HouseControl.tv-launcher"

    /// The token saved under the first of `accounts` that has one. One found under a later
    /// account (the address, before the hub knew the id) is moved to the first.
    static func token(_ accounts: [String]) -> String? {
        for (i, account) in accounts.enumerated() {
            guard let token = read(account) else { continue }
            if i > 0, let first = accounts.first {
                save(token, accounts: [first])
                delete(account)
            }
            return token
        }
        return nil
    }

    /// Saves `token` under the first of `accounts`.
    static func save(_ token: String, accounts: [String]) {
        guard let account = accounts.first else { return }
        let data = Data(token.utf8)
        let status = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(account)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(add as CFDictionary, nil)
        }
    }

    /// Forgets the token under every one of `accounts`.
    static func forget(_ accounts: [String]) {
        for account in accounts { delete(account) }
    }

    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private static func read(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func delete(_ account: String) {
        SecItemDelete(query(account) as CFDictionary)
    }
}
