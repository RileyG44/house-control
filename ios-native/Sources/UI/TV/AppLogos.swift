import SwiftUI

/// The TV's apps and their logos, drawn here in the brands' colours (no image files), ported from
/// web/src/tv/apps.js: each logo is a few shapes on a 100 × 100 square. The same drawing fills
/// the launcher's tiles and, rendered to an image, the TV screen in the 3D model.
struct TVAppInfo: Identifiable, Equatable, Sendable {
    enum Shape: Equatable, Sendable {
        case path(String, String)                                  // d, fill
        case stroke(String, String, Double, CGLineCap)             // d, colour, width, cap
        case circle(Double, Double, Double, String)                // cx, cy, r, fill
        case text(String, Double, Double, Double, String, Font.Weight, serif: Bool, italic: Bool, spacing: Double)
    }
    var id: String
    var name: String
    var package: String?
    var bg: [String]                 // one colour, or a diagonal gradient's two
    var glow: String
    var mark: [Shape]
}

enum TVCatalog {
    typealias S = TVAppInfo.Shape

    static func text(_ s: String, _ x: Double, _ y: Double, _ size: Double, _ fill: String, _ weight: Font.Weight = .bold,
                     serif: Bool = false, italic: Bool = false, spacing: Double = 0) -> S {
        .text(s, x, y, size, fill, weight, serif: serif, italic: italic, spacing: spacing)
    }

    static let apps: [TVAppInfo] = [
        TVAppInfo(id: "youtube", name: "YouTube", package: "com.google.android.youtube.tv", bg: ["#0f0f0f"], glow: "#ff0033", mark: [
            .path("M22 34 C22 28 26 25 32 24.6 C40 24 60 24 68 24.6 C74 25 78 28 78 34 L78 66 C78 72 74 75 68 75.4 C60 76 40 76 32 75.4 C26 75 22 72 22 66 Z", "#ff0033"),
            .path("M43 38 L62 50 L43 62 Z", "#ffffff"),
        ]),
        TVAppInfo(id: "netflix", name: "Netflix", package: "com.netflix.ninja", bg: ["#000000"], glow: "#e50914", mark: [
            .path("M33 16 H45 V84 Q39 84.5 33 86 Z", "#b1060f"),
            .path("M55 16 H67 V86 Q61 84.5 55 84 Z", "#b1060f"),
            .path("M33 16 H45 L67 86 Q61 84.5 55 84 Z", "#e50914"),
        ]),
        TVAppInfo(id: "hulu", name: "Hulu", package: "com.hulu.livingroomplus", bg: ["#040405"], glow: "#1ce783", mark: [
            .stroke("M19 35 V64 M19 52 C19 43.5 31 43.5 31 52 V64", "#1ce783", 6.5, .butt),
            .stroke("M37 45 V56 C37 64.5 49 64.5 49 56 V45 M49 54 V64", "#1ce783", 6.5, .butt),
            .stroke("M56 35 V64", "#1ce783", 6.5, .butt),
            .stroke("M63 45 V56 C63 64.5 75 64.5 75 56 V45 M75 54 V64", "#1ce783", 6.5, .butt),
        ]),
        TVAppInfo(id: "prime", name: "Prime Video", package: "com.amazon.amazonvideo.livingroom", bg: ["#1a98ff", "#0a6ed1"], glow: "#1a98ff", mark: [
            text("prime", 50, 45, 25, "#ffffff", .heavy, spacing: -0.5),
            text("video", 50, 61, 15, "#ffffff", .semibold, spacing: 0.5),
            .stroke("M29 67 Q50 76 69 67.5", "#ffffff", 2.8, .round),
            .path("M65 64 L73.5 65.5 L69.5 72.5 Z", "#ffffff"),
        ]),
        TVAppInfo(id: "disney", name: "Disney+", package: "com.disney.disneyplus", bg: ["#0e1a4f", "#0a2a8f"], glow: "#2f6bff", mark: [
            .stroke("M14 58 C26 30 70 26 88 46", "#9ec5ff", 2.4, .round),
            text("Disney", 42, 63, 23, "#ffffff", .bold, serif: true, italic: true, spacing: -0.5),
            .stroke("M81 51 V67 M73 59 H89", "#ffffff", 3.4, .butt),
        ]),
        TVAppInfo(id: "max", name: "Max", package: "com.wbd.stream", bg: ["#002be7", "#0018a8"], glow: "#2a4dff", mark: [
            text("max", 50, 61, 34, "#ffffff", .black, spacing: -1.5),
        ]),
        TVAppInfo(id: "peacock", name: "Peacock", package: "com.peacocktv.peacockandroid", bg: ["#000000"], glow: "#6e55dc", mark:
            [text("peacock", 44, 57, 16, "#ffffff", .heavy, spacing: -0.6)]
            + ["#fccc12", "#f37c20", "#ef1541", "#6e55dc", "#069de0", "#05ac3f"].enumerated().map { i, c in S.circle(84, 37 + Double(i) * 4.8, 1.9, c) }),
        TVAppInfo(id: "paramount", name: "Paramount+", package: "com.cbs.ott", bg: ["#0064ff", "#0040c8"], glow: "#2f7bff", mark:
            [S.path("M24 72 L42 46 L49 54 L55 47 L76 72 Z", "#ffffff")]
            + (0..<11).map { i in
                let a = Double.pi * (1.08 + (Double(i) / 10) * 0.84)
                return S.circle(50 + cos(a) * 32, 60 + sin(a) * 32, 2, "#ffffff")
            }
            + [S.stroke("M74 30 V40 M69 35 H79", "#ffffff", 2.4, .butt)]),
        TVAppInfo(id: "appletv", name: "Apple TV", package: "com.apple.atve.androidtv.appletv", bg: ["#000000"], glow: "#9aa4b5", mark: [
            .path("M32.5 40.5 C29 40.5 25 43.4 25 49.8 C25 57.6 30 66 33.6 66 C35.4 66 36.6 64.8 38.6 64.8 C40.6 64.8 41.6 66 43.6 66 C46.6 66 49.4 61 50.4 57.8 C47.4 56.4 45.8 53.8 45.8 50.8 C45.8 48 47.2 45.8 49.2 44.4 C47.6 42 45 40.6 42.4 40.6 C40 40.6 38.6 41.8 37.4 41.8 C36 41.8 34.6 40.5 32.5 40.5 Z", "#ffffff"),
            .path("M37.6 39.4 C37.4 36.2 39.6 33.4 42.8 33 C43 36.2 40.6 39 37.6 39.4 Z", "#ffffff"),
            text("tv", 64, 64, 27, "#ffffff", .semibold, spacing: -0.5),
        ]),
        TVAppInfo(id: "tubi", name: "Tubi", package: "com.tubitv", bg: ["#7408ff", "#4a00b0"], glow: "#7408ff", mark: [
            text("tubi", 50, 61, 33, "#ffff13", .black, spacing: -1),
        ]),
        TVAppInfo(id: "pluto", name: "Pluto TV", package: "tv.pluto.android", bg: ["#000000"], glow: "#fff200", mark: [
            text("pluto", 40, 59, 21, "#ffffff", .heavy, spacing: -0.8),
            .circle(79, 52, 9.5, "#fff200"),
            text("tv", 79, 56, 10.5, "#000000", .black, spacing: -0.3),
        ]),
        TVAppInfo(id: "plex", name: "Plex", package: "com.plexapp.android", bg: ["#1f2326"], glow: "#e5a00d", mark: [
            .path("M37 24 H54 L72 50 L54 76 H37 L55 50 Z", "#e5a00d"),
        ]),
        TVAppInfo(id: "crunchyroll", name: "Crunchyroll", package: "com.crunchyroll.crunchyroid", bg: ["#ff7a2e", "#f2600c"], glow: "#f47521", mark: [
            .circle(48, 52, 25, "#ffffff"),
            .circle(55, 46, 16.5, "#f47521"),
            .circle(60, 42, 6.5, "#ffffff"),
        ]),
    ]

    static let home = TVAppInfo(id: "home", name: "Google TV", bg: ["#1b2232", "#0d1220"], glow: "#7aa2ff", mark: [
        .stroke("M29 33 H71", "#4285f4", 6, .round),
        .stroke("M71 33 Q77 33 77 39 V57 Q77 63 71 63", "#ea4335", 6, .round),
        .stroke("M71 63 H29", "#fbbc04", 6, .round),
        .stroke("M29 63 Q23 63 23 57 V39 Q23 33 29 33", "#34a853", 6, .round),
        .stroke("M42 72 H58", "#9aa3b8", 4, .round),
    ])
    static let ambient = TVAppInfo(id: "ambient", name: "Ambient", bg: ["#3a2d6b", "#173a5e"], glow: "#7f73d9", mark: [
        .circle(62, 42, 13, "#ffd6aa"),
        .path("M10 74 C28 60 40 66 52 62 C66 57 76 50 92 56 V92 H10 Z", "#14183a"),
    ])
    static let settings = TVAppInfo(id: "settings", name: "Settings", bg: ["#2b3140", "#1b1f29"], glow: "#9aa4b5", mark:
        (0..<8).map { i in
            let a = Double(i) / 8 * Double.pi * 2
            return S.stroke("M\(50 + cos(a) * 15) \(50 + sin(a) * 15) L\(50 + cos(a) * 23) \(50 + sin(a) * 23)", "#dfe6f2", 8, .butt)
        } + [S.circle(50, 50, 17, "#dfe6f2"), S.circle(50, 50, 7.5, "#262b38")])
    static let other = TVAppInfo(id: "other", name: "App", bg: ["#2b3140", "#151923"], glow: "#9aa4b5", mark: [
        .path("M42 36 L64 50 L42 64 Z", "#dfe6f2"),
    ])

    private static let byID: [String: TVAppInfo] = Dictionary(uniqueKeysWithValues: (apps + [home, ambient, settings]).map { ($0.id, $0) })

    /// The catalogue entry for an app as the TV reports it; an unknown app gets a plain glyph.
    static func info(for app: TVApp?) -> TVAppInfo {
        guard let app else { return home }
        if let known = byID[app.id] { return known }
        var o = other
        o.name = app.name
        return o
    }

    static func info(id: String) -> TVAppInfo? { byID[id] }
}

/// The logo on its own background, filling a square.
struct AppLogo: View {
    let app: TVAppInfo
    var size: CGFloat
    var monochrome = false

    var body: some View {
        Canvas { ctx, sz in
            LogoPainter.paint(app, in: &ctx, rect: CGRect(origin: .zero, size: sz), markSize: min(sz.width, sz.height) * (monochrome ? 0.82 : 1), monochrome: monochrome)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

enum LogoPainter {
    /// Fills `rect` with the app's background and draws its mark, the 100-unit square scaled to
    /// `markSize` and centred.
    static func paint(_ app: TVAppInfo, in ctx: inout GraphicsContext, rect: CGRect, markSize: CGFloat, monochrome: Bool = false) {
        func ink(_ color: String) -> Color {
            guard monochrome else { return Color(hex: color) }
            return Color(hex: (app.id == "youtube" && color == "#ffffff") || color == "#000000" ? "#f8f8f5" : "#252624")
        }
        let bg: GraphicsContext.Shading = monochrome ? .color(Color(hex: "#f8f8f5")) : app.bg.count > 1
            ? .linearGradient(Gradient(colors: app.bg.map { Color(hex: $0) }), startPoint: rect.origin, endPoint: CGPoint(x: rect.maxX, y: rect.maxY))
            : .color(Color(hex: app.bg[0]))
        ctx.fill(Path(rect), with: bg)
        var c = ctx
        c.translateBy(x: rect.midX - markSize / 2, y: rect.midY - markSize / 2)
        c.scaleBy(x: markSize / 100, y: markSize / 100)
        for shape in app.mark {
            switch shape {
            case .path(let d, let fill):
                c.fill(SVGPath.parse(d), with: .color(ink(fill)))
            case .stroke(let d, let color, let width, let cap):
                c.stroke(SVGPath.parse(d), with: .color(ink(color)), style: StrokeStyle(lineWidth: width, lineCap: cap, lineJoin: .round))
            case .circle(let cx, let cy, let r, let fill):
                c.fill(Path(ellipseIn: CGRect(x: cx - r, y: cy - r, width: r * 2, height: r * 2)), with: .color(ink(fill)))
            case .text(let s, let x, let y, let size, let fill, let weight, let serif, let italic, let spacing):
                var font = Font.system(size: size, weight: weight, design: serif ? .serif : .default)
                if italic { font = font.italic() }
                let resolved = c.resolve(Text(s).font(font).tracking(spacing).foregroundColor(ink(fill)))
                let m = resolved.measure(in: CGSize(width: 400, height: 200))
                let baseline = resolved.firstBaseline(in: m)
                c.draw(resolved, in: CGRect(x: x - m.width / 2, y: y - baseline, width: m.width, height: m.height))
            }
        }
    }
}

/// Just enough SVG path syntax for the logos: absolute M L H V C Q Z.
enum SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var tokens: [String] = []
        var cur = ""
        for ch in d {
            if ch.isLetter {
                if !cur.isEmpty { tokens.append(cur); cur = "" }
                tokens.append(String(ch))
            } else if ch == " " || ch == "," {
                if !cur.isEmpty { tokens.append(cur); cur = "" }
            } else if ch == "-" && !cur.isEmpty && cur.last != "e" {
                tokens.append(cur); cur = "-"
            } else {
                cur.append(ch)
            }
        }
        if !cur.isEmpty { tokens.append(cur) }
        var i = 0
        var cmd = "M"
        var p = CGPoint.zero
        func num() -> CGFloat { defer { i += 1 }; return i < tokens.count ? CGFloat(Double(tokens[i]) ?? 0) : 0 }
        while i < tokens.count {
            if tokens[i].first!.isLetter { cmd = tokens[i]; i += 1; if cmd == "Z" { path.closeSubpath(); continue } }
            switch cmd {
            case "M": p = CGPoint(x: num(), y: num()); path.move(to: p); cmd = "L"
            case "L": p = CGPoint(x: num(), y: num()); path.addLine(to: p)
            case "H": p.x = num(); path.addLine(to: p)
            case "V": p.y = num(); path.addLine(to: p)
            case "C":
                let c1 = CGPoint(x: num(), y: num()), c2 = CGPoint(x: num(), y: num())
                p = CGPoint(x: num(), y: num())
                path.addCurve(to: p, control1: c1, control2: c2)
            case "Q":
                let c1 = CGPoint(x: num(), y: num())
                p = CGPoint(x: num(), y: num())
                path.addQuadCurve(to: p, control: c1)
            default: i += 1
            }
        }
        return path
    }
}
