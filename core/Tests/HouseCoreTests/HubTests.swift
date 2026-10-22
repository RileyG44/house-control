import XCTest
@testable import HouseCore

/// The Mac hub (hub/house.py, ~/.house-hub) and the native panel must show the same home:
/// the hub's plan becomes the panel's home when the native store has none of its own, and
/// WiZ/AiDot/MRCOOL links are forwarded to the hub instead of being simulated.
@MainActor
final class HubTests: XCTestCase {
    private func tempDir() -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private let hubPlan: [String: Any] = [
        "name": "Riley's Studio",
        "rooms": [["id": "studio", "name": "Studio", "rect": [0, 0, 10.8, 6.4], "floor": "walnut"]],
        "lights": [["id": "studio.edison-bulb", "name": "Edison Bulb", "room": "studio",
                    "type": "table", "pos": [9.9, 5.8],
                    "link": ["service": "wiz", "id": "d8a0113a23e6"]]],
        "acs": [],
    ]

    func testPlanStoreAdoptsHubPlanWhenNativeHasNone() throws {
        let native = tempDir(), hubDir = tempDir()
        defer { try? FileManager.default.removeItem(at: native); try? FileManager.default.removeItem(at: hubDir) }
        try PlanStore.encode(hubPlan).write(to: hubDir.appendingPathComponent("plan.json"))

        let store = PlanStore(directory: native, hubDirectory: hubDir)
        XCTAssertEqual(store.activePlan, "custom")
        XCTAssertEqual(store.bootPayload()["config"] as? [String: Any] != nil, true)
        XCTAssertEqual((store.bootPayload()["config"] as? [String: Any])?["name"] as? String, "Riley's Studio")
        XCTAssertEqual(store.customPlan()?["name"] as? String, "Riley's Studio")
    }

    func testPlanStoreKeepsExplicitDemoChoiceOverHubPlan() throws {
        let native = tempDir(), hubDir = tempDir()
        defer { try? FileManager.default.removeItem(at: native); try? FileManager.default.removeItem(at: hubDir) }
        try PlanStore.encode(hubPlan).write(to: hubDir.appendingPathComponent("plan.json"))
        try JSONSerialization.data(withJSONObject: ["plan": "home"]).write(to: native.appendingPathComponent("settings.json"))

        let store = PlanStore(directory: native, hubDirectory: hubDir)
        XCTAssertEqual(store.activePlan, "home")
        XCTAssertNil(store.bootPayload()["config"])
    }

    func testFreshPlanStoreShowsRileysStudio() {
        let native = tempDir(), hubDir = tempDir()
        defer { try? FileManager.default.removeItem(at: native); try? FileManager.default.removeItem(at: hubDir) }

        let store = PlanStore(directory: native, hubDirectory: hubDir)
        XCTAssertEqual(store.activePlan, "riley")
        XCTAssertEqual(store.bootPayload()["plan"] as? String, "riley")
        store.removeCustom()
        XCTAssertEqual(store.activePlan, "riley")
    }

    func testLocalHubParsesFirstEvent() {
        let payload = "data: {\"lights\": {\"studio.edison-bulb\": {\"on\": true}}, \"acs\": {}, \"features\": {}}\n\ndata: {\"lights\": {}}\n\n"
        let state = LocalHubClient.firstEvent(from: payload)
        XCTAssertEqual(((state?["lights"] as? [String: Any])?["studio.edison-bulb"] as? [String: Any])?["on"] as? Bool, true)
        XCTAssertNil(LocalHubClient.firstEvent(from: ": keep-alive\n\n"))
    }

    func testDeviceHubForwardsWizCommandAndStateToLocalHub() async throws {
        HubStub.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HubStub.self]
        let client = LocalHubClient(baseURL: URL(string: "http://hub.test")!,
                                    session: URLSession(configuration: config))
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let hub = DeviceHub(directory: dir, secret: { _ in MemorySecretStore() }, localHub: client)
        hub.setLinks(from: hubPlan)
        XCTAssertTrue(hub.canPoll)
        XCTAssertEqual(hub.linkedDeviceCount, 1)

        let sent = expectation(description: "forwarded")
        hub.command(["id": "studio.edison-bulb", "kind": "light",
                     "patch": ["on": false], "state": ["on": false]]) { reply in
            XCTAssertEqual(reply["ok"] as? Bool, true)
            sent.fulfill()
        }
        await fulfillment(of: [sent], timeout: 2)
        XCTAssertEqual(HubStub.lastPath, "/api/call")
        XCTAssertEqual(HubStub.lastBody?["id"] as? String, "studio.edison-bulb")
        XCTAssertEqual((HubStub.lastBody?["patch"] as? [String: Any])?["on"] as? Bool, false)

        let update = await hub.poll()
        XCTAssertEqual((update?["lights"] as? [String: [String: Any]])?["studio.edison-bulb"]?["on"] as? Bool, true)
    }

    func testLocalHubRequestReachesOnlyTheTV() async {
        XCTAssertTrue(LocalHubClient.allows(path: "api/tv"))
        XCTAssertTrue(LocalHubClient.allows(path: "api/tv/79519fff"))
        XCTAssertTrue(LocalHubClient.allows(path: "api/tv/search?q=the%20bear"))
        XCTAssertTrue(LocalHubClient.allows(path: "api/weather"))
        XCTAssertTrue(LocalHubClient.allows(path: "api/spotify"))
        XCTAssertFalse(LocalHubClient.allows(path: "api/spotify/../call"))
        XCTAssertFalse(LocalHubClient.allows(path: "api/spotify?local=1"))
        XCTAssertFalse(LocalHubClient.allows(path: "api/weather/../call"))
        XCTAssertFalse(LocalHubClient.allows(path: "api/call"))
        XCTAssertFalse(LocalHubClient.allows(path: "api/tvx"))
        XCTAssertFalse(LocalHubClient.allows(path: "api/tv/../call"))

        HubStub.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HubStub.self]
        let client = LocalHubClient(baseURL: URL(string: "http://hub.test")!, session: URLSession(configuration: config))
        let state = await client.request(method: "GET", path: "api/tv")
        XCTAssertEqual(state["available"] as? Bool, true)
        XCTAssertEqual(HubStub.lastPath, "/api/tv")
        let sent = await client.request(method: "POST", path: "api/tv/79519fff", body: ["action": "up"])
        XCTAssertEqual(sent["ok"] as? Bool, true)
        XCTAssertEqual(HubStub.lastPath, "/api/tv/79519fff")
        XCTAssertEqual(HubStub.lastBody?["action"] as? String, "up")
        let refused = await client.request(method: "POST", path: "api/call", body: ["type": "command"])
        XCTAssertNotNil(refused["error"])
        XCTAssertEqual(HubStub.lastPath, "/api/tv/79519fff") // never sent
    }
}

/// Serves the hub's endpoints from memory: POST /api/call, GET /api/events (SSE) and the TV's /api/tv.
private final class HubStub: URLProtocol {
    static var lastPath: String?
    static var lastBody: [String: Any]?

    static func reset() { lastPath = nil; lastBody = nil }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "hub.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastPath = request.url?.path
        if request.url?.path == "/api/tv" {
            respond(Data("{\"available\": true, \"error\": \"\", \"devices\": []}".utf8))
        } else if request.url?.path == "/api/call" || request.url?.path.hasPrefix("/api/tv/") == true {
            var data = request.httpBody ?? Data()
            if data.isEmpty, let stream = request.httpBodyStream {
                stream.open()
                var chunk = [UInt8](repeating: 0, count: 4096)
                let count = stream.read(&chunk, maxLength: chunk.count)
                if count > 0 { data = Data(chunk.prefix(count)) }
                stream.close()
            }
            Self.lastBody = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            respond(Data("{\"ok\": true}".utf8))
        } else {
            respond(Data("data: {\"lights\": {\"studio.edison-bulb\": {\"on\": true, \"brightness\": 1.0}}, \"acs\": {}, \"features\": {}}\n\n".utf8))
        }
    }

    private func respond(_ data: Data) {
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
