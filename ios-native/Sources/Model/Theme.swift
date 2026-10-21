import SwiftUI
import UIKit

/// Light, dark or the system's (Auto), cycled by the card's appearance button and kept on this
/// phone. The colours are the asset catalog's sets, which mirror the tokens at the top of
/// web/src/style.css (any / dark appearances).
@MainActor @Observable
final class ThemeStore {
    enum Choice: String, CaseIterable {
        case auto, light, dark
        var next: Choice { self == .auto ? .light : self == .light ? .dark : .auto }
        var name: String { self == .auto ? "Automatic" : self == .light ? "Light" : "Dark" }
        var symbol: String { self == .auto ? "circle.lefthalf.filled" : self == .light ? "sun.max" : "moon" }
    }

    var choice: Choice {
        didSet { UserDefaults.standard.set(choice.rawValue, forKey: "house.theme") }
    }

    init() {
        choice = Choice(rawValue: UserDefaults.standard.string(forKey: "house.theme") ?? "") ?? .auto
    }

    var colorScheme: ColorScheme? {
        switch choice {
        case .auto: nil
        case .light: .light
        case .dark: .dark
        }
    }

    func cycle() { choice = choice.next }
}

extension Color {
    static let stage = Color("Stage")
    static let ink = Color("Ink")
    static let muted = Color("Muted")
    static let faint = Color("Faint")
    static let fill = Color("Fill")
    static let fillHi = Color("FillHi")
    static let line = Color("Line")
    static let well = Color("Well")
    static let accentInk = Color("AccentInk")
    static let accentSoft = Color("AccentSoft")
    static let warm = Color("Warm")
    static let warmInk = Color("WarmInk")
    static let idle = Color("Idle")
    static let onBase = Color("OnBase")
    static let onSub = Color("OnSub")
    static let onBubble = Color("OnBubble")
    static let tile = Color("Tile")
    static let danger = Color("Danger")

    init(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        let v = UInt64(s, radix: 16) ?? 0
        self.init(.sRGB, red: Double((v >> 16) & 0xff) / 255, green: Double((v >> 8) & 0xff) / 255, blue: Double(v & 0xff) / 255)
    }
}

/// RGB in 0…1, for colours worked out in code (a lamp's colour, a temperature's).
struct RGB: Equatable, Sendable {
    var r: Double, g: Double, b: Double

    init(_ r: Double, _ g: Double, _ b: Double) { self.r = r; self.g = g; self.b = b }

    init(hex: String) {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        let v = UInt64(s, radix: 16) ?? 0
        self.init(Double((v >> 16) & 0xff) / 255, Double((v >> 8) & 0xff) / 255, Double(v & 0xff) / 255)
    }

    func lerp(_ o: RGB, _ t: Double) -> RGB { RGB(r + (o.r - r) * t, g + (o.g - g) * t, b + (o.b - b) * t) }
    var color: Color { Color(.sRGB, red: r, green: g, blue: b) }
    var uiColor: UIColor { UIColor(red: r, green: g, blue: b, alpha: 1) }
    var hex: String { String(format: "#%02x%02x%02x", Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded())) }

    /// A white lamp's colour for its temperature (web/src/three/lights.js `tempToColor`).
    static func kelvin(_ k: Double) -> RGB {
        let stops: [(Double, RGB)] = [(2200, RGB(hex: "#ff9438")), (3000, RGB(hex: "#ffbd7a")), (4200, RGB(hex: "#ffe2c2")), (6500, RGB(hex: "#dfe9ff"))]
        let k = min(6500, max(2200, k))
        for i in 0..<(stops.count - 1) where k <= stops[i + 1].0 {
            return stops[i].1.lerp(stops[i + 1].1, (k - stops[i].0) / (stops[i + 1].0 - stops[i].0))
        }
        return stops.last!.1
    }

    static func of(_ s: LightState) -> RGB { s.color.map(RGB.init(hex:)) ?? kelvin(s.temp) }
}

/// The colour of each AC mode (web/src/three/ac.js `MODE_COLORS`).
let modeColors: [String: String] = ["cool": "#5db2ff", "heat": "#ff8c3a", "dry": "#62e0cf", "fan": "#cfdcff", "auto": "#9bd28a"]
let modeNames: [String: String] = ["cool": "Cool", "heat": "Heat", "dry": "Dry", "fan": "Fan", "auto": "Auto"]
let modeSymbols: [String: String] = ["cool": "snowflake", "heat": "flame", "dry": "drop", "fan": "fan", "auto": "arrow.triangle.2.circlepath"]
let fanNames: [String: String] = ["auto": "Auto", "low": "Low", "medium": "Medium", "high": "High", "turbo": "Turbo"]
let swingNames: [String: String] = ["swing": "Swing", "l1": "L1", "l2": "L2", "l3": "L3", "l4": "L4", "l5": "L5", "off": "Off"]
let swingValues = ["swing", "l1", "l2", "l3", "l4", "l5", "off"]

/// The symbol for a lamp of each kind.
func lampSymbol(_ type: String, plug: Bool = false) -> String {
    if plug { return "powerplug" }
    switch type {
    case "ceiling": return "light.recessed"
    case "pendant": return "lamp.ceiling"
    case "spots": return "lightbulb"
    case "floor": return "lamp.floor"
    case "table": return "lamp.desk"
    case "strip": return "light.strip.2"
    default: return "lightbulb"
    }
}

/// The scene icons the web panel and this app share (the web draws them with lucide).
let sceneIcons = ["sun", "bright", "dim", "sofa", "film", "tv", "moon", "bed", "sparkles", "leaf",
                  "kitchen", "dining", "bath", "office", "heat", "cool", "power"]

func sceneSymbol(_ icon: String) -> String {
    switch icon {
    case "sun": return "sun.max"
    case "bright": return "sun.max.fill"
    case "dim": return "sun.min"
    case "sofa": return "sofa"
    case "film": return "film"
    case "tv": return "tv"
    case "moon": return "moon"
    case "bed": return "bed.double"
    case "sparkles": return "sparkles"
    case "leaf": return "leaf"
    case "kitchen": return "frying.pan"
    case "dining": return "fork.knife"
    case "bath": return "bathtub"
    case "office": return "desktopcomputer"
    case "heat": return "flame"
    case "cool": return "snowflake"
    case "power": return "power"
    case "door": return "door.left.hand.open"
    default: return "sparkles"
    }
}

/// Taps you can feel: a tick for each step of a slider or the pad, light / medium for a switch.
@MainActor
enum Haptics {
    private static let selection = UISelectionFeedbackGenerator()
    private static let light_ = UIImpactFeedbackGenerator(style: .light)
    private static let medium_ = UIImpactFeedbackGenerator(style: .medium)
    private static let heavy_ = UIImpactFeedbackGenerator(style: .heavy)
    private static let note = UINotificationFeedbackGenerator()

    static func tick() { selection.selectionChanged(); selection.prepare() }
    static func light() { light_.impactOccurred() }
    static func medium() { medium_.impactOccurred() }
    static func heavy() { heavy_.impactOccurred() }
    static func error() { note.notificationOccurred(.error) }
    static func success() { note.notificationOccurred(.success) }
}
