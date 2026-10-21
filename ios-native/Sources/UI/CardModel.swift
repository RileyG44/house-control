import SwiftUI

/// Where the card's two detents are: rest (the card top a little under the middle of the screen,
/// where the web panel's card rests) and expanded (about an inch below the Dynamic Island).
/// The sheet asks for the heights itself, so they are kept here as plain numbers.
enum CardMetrics {
    nonisolated(unsafe) static var screenHeight: CGFloat = 932
    nonisolated(unsafe) static var safeTop: CGFloat = 59
    nonisolated(unsafe) static var safeBottom: CGFloat = 34

    /// The card's top at rest and pulled up, in screen points.
    static var restTop: CGFloat { (min(470, screenHeight * 0.52) - 34).rounded() }
    static var expandedTop: CGFloat { min(restTop, safeTop + 92) }
    /// A detent's height is the sheet's height above the bottom safe area.
    static func height(top: CGFloat) -> CGFloat { screenHeight - safeBottom - top }
}

struct RestDetent: CustomPresentationDetent {
    static func height(in context: Context) -> CGFloat? { CardMetrics.height(top: CardMetrics.restTop) }
}

struct ExpandedDetent: CustomPresentationDetent {
    static func height(in context: Context) -> CGFloat? { CardMetrics.height(top: CardMetrics.expandedTop) }
}

extension PresentationDetent {
    static let rest = PresentationDetent.custom(RestDetent.self)
    static let expanded = PresentationDetent.custom(ExpandedDetent.self)
}

enum Route: Hashable {
    case light(String)
    case ac(String)
    case tv(String)
    case settings
}

/// The card's state: which detent it is at, how far it is pulled up (`progress`, 0 at rest … 1
/// expanded, read every frame from where the sheet really is), and the page shown on it.
@MainActor @Observable
final class CardModel {
    var detent: PresentationDetent = .rest
    /// 0 at rest … 1 expanded; a little beyond either while the sheet stretches.
    var progress: CGFloat = 0
    /// Where the sheet's top is on screen just now.
    var top: CGFloat = CardMetrics.restTop
    var path: [Route] = [] {
        didSet { pathChanged(from: oldValue) }
    }
    /// Where the card was on the home page, for when a device's page closes.
    private var homeDetent: PresentationDetent = .rest
    /// Rooms being put in order (the list becomes one row per room).
    var arrangingRooms = false

    var route: Route? { path.last }
    var tvOpen: String? { if case .tv(let id)? = path.last { return id }; return nil }

    func sheetMoved(top: CGFloat) {
        self.top = top
        let rest = CardMetrics.restTop, exp = CardMetrics.expandedTop
        let p = rest > exp ? (rest - top) / (rest - exp) : 0
        let clamped = min(1.08, max(-0.1, p))
        if abs(clamped - progress) > 0.0005 { progress = clamped }
    }

    func detentChanged() {
        if path.isEmpty { homeDetent = detent }
    }

    func open(_ route: Route) {
        if path.isEmpty { homeDetent = detent }
        path = [route]
    }

    private func pathChanged(from old: [Route]) {
        guard path != old else { return }
        // The TV's remote opens pulled up; a lamp's or the AC's page at rest; home goes back to
        // where the card was.
        switch path.last {
        case .tv?: detent = .expanded
        case .light?, .ac?: detent = .rest
        case .settings?: detent = .expanded
        case nil: detent = homeDetent
        }
    }

    func toggleDetent() {
        detent = detent == .expanded ? .rest : .expanded
    }

    // MARK: - deep links and launch arguments (screenshots, Shortcuts): only what is shown

    /// housenative://open?device=tv:<id> | light:<id> | ac:<id> · housenative://card?detent=expanded
    /// · housenative://theme?choice=light · housenative://home
    func open(url: URL, store: HomeStore, theme: ThemeStore) {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let q = { (k: String) in items.first { $0.name == k }?.value }
        switch url.host() {
        case "open": if let d = q("device") { openDevice(d) }
        case "card": detent = q("detent") == "expanded" ? .expanded : .rest
        case "theme": if let c = q("choice").flatMap(ThemeStore.Choice.init(rawValue:)) { theme.choice = c }
        case "home": path = []
        default: break
        }
    }

    func applyLaunchArguments(store: HomeStore, theme: ThemeStore) {
        let d = UserDefaults.standard
        if let c = d.string(forKey: "theme").flatMap(ThemeStore.Choice.init(rawValue:)) { theme.choice = c }
        if let dev = d.string(forKey: "open") { openDevice(dev) }
        if d.string(forKey: "card") == "expanded" { detent = .expanded }
        if d.bool(forKey: "arrange") { arrangingRooms = true }
    }

    private func openDevice(_ key: String) {
        let parts = key.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return }
        switch parts[0] {
        case "tv": open(.tv(parts[1]))
        case "light": open(.light(parts[1]))
        case "ac": open(.ac(parts[1]))
        case "settings": open(.settings)
        default: break
        }
    }
}
