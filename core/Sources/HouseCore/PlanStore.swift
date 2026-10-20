import Foundation
import CryptoKit

/// Persists which floor plan is active and the user's own plan file.
/// Everything lives in ~/Library/Application Support/HouseControl (or HOUSE_DATA_DIR).
public final class PlanStore {
    /// Riley's Studio (the default home) and the two demos.
    public static let bundled = ["riley", "home", "studio"]
    /// The bundled plan a fresh install shows.
    public static let defaultPlan = "riley"

    public let directory: URL
    public var customPlanURL: URL { directory.appendingPathComponent("plan.json") }
    private var settingsURL: URL { directory.appendingPathComponent("settings.json") }
    /// The Mac hub's own plan (hub/house.py reads ~/.house-hub), when this store adopted it.
    private let hubPlanURL: URL?

    /// "riley" for Riley's Studio, "home" / "studio" for the bundled demos, or "custom" for plan.json.
    public private(set) var activePlan = PlanStore.defaultPlan

    /// `hubDirectory` is the Mac hub's folder (~/.house-hub by default on the machine that
    /// runs it). When the native store has no plan and no plan was ever chosen here, the
    /// hub's plan becomes this store's home, so the menu bar panel and the hub's web panel
    /// show the same house. A plan chosen or saved here always wins over the hub's.
    public init(directory: URL? = nil, hubDirectory: URL? = nil) {
        // HOUSE_DATA_DIR points the app at another folder: a throw-away one for testing or
        // screenshots leaves the real plan and the Smart Life session alone.
        var adoptedHub = false
        if let directory {
            self.directory = directory
            adoptedHub = hubDirectory != nil
        } else if let custom = ProcessInfo.processInfo.environment["HOUSE_DATA_DIR"], !custom.isEmpty {
            self.directory = URL(fileURLWithPath: (custom as NSString).expandingTildeInPath, isDirectory: true)
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            self.directory = base.appendingPathComponent("HouseControl", isDirectory: true)
            adoptedHub = true
        }
        if let hubDirectory {
            hubPlanURL = hubDirectory.appendingPathComponent("plan.json")
        } else if adoptedHub {
            let env = ProcessInfo.processInfo.environment["HOUSE_HUB_DIR"]
            let base = env.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath, isDirectory: true) }
                ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".house-hub", isDirectory: true)
            hubPlanURL = base.appendingPathComponent("plan.json")
        } else {
            hubPlanURL = nil
        }
        try? FileManager.default.createDirectory(at: self.directory, withIntermediateDirectories: true)
        var chosePlan = false
        if let data = try? Data(contentsOf: settingsURL),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let plan = json["plan"] as? String {
            activePlan = plan
            chosePlan = true
        }
        if !chosePlan, !FileManager.default.fileExists(atPath: customPlanURL.path), hubPlan() != nil {
            activePlan = "custom"
        }
        if activePlan == "custom", customPlan() == nil { activePlan = Self.defaultPlan }
    }

    /// The file the active custom plan is read from: this store's own, or the hub's when adopted.
    public var effectiveCustomPlanURL: URL {
        if FileManager.default.fileExists(atPath: customPlanURL.path) { return customPlanURL }
        return hubPlanURL ?? customPlanURL
    }

    /// The hub's own plan file, when this store adopted the hub's home.
    public func hubPlan() -> [String: Any]? {
        guard let hubPlanURL, let data = try? Data(contentsOf: hubPlanURL) else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    public func customPlan() -> [String: Any]? {
        if let data = try? Data(contentsOf: customPlanURL),
           let plan = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return plan
        }
        return hubPlan()
    }

    public var hasCustomPlan: Bool { customPlan() != nil }

    /// The name the user gave their home, for menus.
    public var customPlanName: String? { customPlan()?["name"] as? String }

    /// Fingerprint of the user's plan as stored; two devices holding the same revision
    /// have nothing to exchange.
    public var customPlanRevision: String? {
        if let data = try? Data(contentsOf: customPlanURL) { return Self.revision(of: data) }
        guard let hubPlanURL, let data = try? Data(contentsOf: hubPlanURL) else { return nil }
        return Self.revision(of: data)
    }

    public static func revision(of data: Data) -> String {
        SHA256.hash(data: data).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    public func select(_ plan: String) {
        guard Self.bundled.contains(plan) || (plan == "custom" && customPlan() != nil) else { return }
        activePlan = plan
        let data = try? JSONSerialization.data(withJSONObject: ["plan": plan])
        try? data?.write(to: settingsURL, options: .atomic)
    }

    /// Stores `plan` as the user's plan and makes it active.
    public func saveCustom(_ plan: [String: Any]) throws {
        try saveCustom(data: Self.encode(plan))
    }

    /// Stores an already serialised plan byte for byte, so its revision matches the sender's.
    public func saveCustom(data: Data, select: Bool = true) throws {
        try data.write(to: customPlanURL, options: .atomic)
        if select { self.select("custom") }
    }

    public static func encode(_ plan: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: plan, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    }

    /// Checks that `data` is a floor plan at all before it replaces the user's one.
    public static func validate(_ data: Data) throws -> [String: Any] {
        guard let plan = try JSONSerialization.jsonObject(with: data) as? [String: Any], plan["rooms"] is [Any] else {
            throw NSError(domain: "HouseControl", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "This file is not a House Control floor plan (no \"rooms\" list)."])
        }
        return plan
    }

    public func importPlan(from url: URL) throws {
        try saveCustom(Self.validate(try Data(contentsOf: url)))
    }

    /// Forgets the user's plan and falls back to the default home.
    public func removeCustom() {
        try? FileManager.default.removeItem(at: customPlanURL)
        if activePlan == "custom" { select(Self.defaultPlan) }
    }

    /// The plan the UI should render: the custom JSON inline, or the name of a bundled demo.
    public func bootPayload() -> [String: Any] {
        var boot: [String: Any] = ["plan": activePlan, "hasCustomPlan": hasCustomPlan]
        if activePlan == "custom", let plan = customPlan() { boot["config"] = plan }
        return boot
    }
}
