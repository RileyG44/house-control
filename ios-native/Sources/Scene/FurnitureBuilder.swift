import Foundation
import RealityKit
import simd

/// Where a TV's screen is, for TvUnit: in the world, facing +z of `transform`.
struct TVScreenSpot {
    var furniture: Furniture
    var transform: simd_float4x4   // the screen's centre-bottom, world space
    var width: Float
    var height: Float
    var bounds: (min: SIMD3<Float>, max: SIMD3<Float>)   // the whole piece, world space
}

/// The procedural furniture library, ported from web/src/three/furniture.js. Every piece stands
/// on y = 0, centred on its footprint, facing +z; the plan's `rot` turns it.
@MainActor
enum FurnitureBuilder {
    static let wood = "#a98459", darkWood = "#5a4334", white = "#eceae5", black = "#1b1c21", metal = "#9a9fa8"
    static let baseY: [String: Double] = ["microwave": 0.9, "closetRod": 1.75]

    static func build(_ items: [Furniture], into b: MeshBuilder) -> [TVScreenSpot] {
        var screens: [TVScreenSpot] = []
        for item in items {
            let pos = SIMD3(Float(item.pos.x), Float(item.y ?? baseY[item.type] ?? 0), Float(item.pos.y))
            let rot = Float(item.rot * .pi / 180)
            b.group(pos, rotY: rot) {
                if let s = piece(item, b) {
                    let (fw, fd) = footprint(item)
                    let m = b.current
                    let local = Xform.make(SIMD3(0, s.y, s.z))
                    // The piece's box in the world, for the tap target and the close-up.
                    let corners = [SIMD3<Float>(-fw / 2, 0, -fd / 2), SIMD3(fw / 2, 0, -fd / 2), SIMD3(fw / 2, 0, fd / 2), SIMD3(-fw / 2, 0, fd / 2)]
                        .flatMap { [$0, $0 + SIMD3(0, s.y + s.h + 0.05, 0)] }
                        .map { m * SIMD4($0, 1) }.map { SIMD3($0.x, $0.y, $0.z) }
                    let lo = corners.reduce(SIMD3<Float>(repeating: .infinity)) { simd_min($0, $1) }
                    let hi = corners.reduce(SIMD3<Float>(repeating: -.infinity)) { simd_max($0, $1) }
                    screens.append(TVScreenSpot(furniture: item, transform: m * local, width: s.w, height: s.h, bounds: (lo, hi)))
                }
            }
        }
        return screens
    }

    static func darker(_ hex: String, _ k: Double = 0.75) -> String {
        let c = RGB(hex: hex)
        return RGB(min(1, c.r * k), min(1, c.g * k), min(1, c.b * k)).hex
    }

    static func legs(_ b: MeshBuilder, _ w: Float, _ d: Float, _ h: Float, _ m: Mat, inset: Float = 0.06, r: Float = 0.022) {
        for sx: Float in [-1, 1] { for sz: Float in [-1, 1] {
            b.cyl(r, r * 0.8, h, m, seg: 10, at: SIMD3(sx * (w / 2 - inset), 0, sz * (d / 2 - inset)))
        } }
    }

    static func doorLines(_ b: MeshBuilder, _ width: Float, _ height: Float, _ y: Float, _ z: Float, _ count: Int, _ m: Mat) {
        guard count > 1 else { return }
        for i in 1..<count { b.box(0.008, height, 0.006, m, r: 0, at: SIMD3(-width / 2 + width / Float(count) * Float(i), y, z)) }
    }

    static func seating(_ b: MeshBuilder, _ width: Float, _ depth: Float, _ color: String, _ cushions: Int) {
        let fabric = Mat.c(color, rough: 1), dark = Mat.c(darker(color, 0.82), rough: 1)
        let arm: Float = 0.2, inner = width - arm * 2
        legs(b, width, depth, 0.1, .c(black, rough: 0.5), inset: 0.08)
        b.box(width, 0.2, depth, dark, r: 0.05, at: SIMD3(0, 0.1, 0))
        b.box(inner, 0.52, 0.24, dark, r: 0.09, at: SIMD3(0, 0.3, -depth / 2 + 0.12))
        for sx: Float in [-1, 1] { b.box(arm, 0.36, depth, dark, r: 0.08, at: SIMD3(sx * (width / 2 - arm / 2), 0.3, 0)) }
        let cw = inner / Float(cushions)
        for i in 0..<cushions {
            let x = -inner / 2 + cw * (Float(i) + 0.5)
            b.box(cw - 0.02, 0.17, depth - 0.3, fabric, r: 0.06, at: SIMD3(x, 0.3, 0.1))
            b.group(SIMD3(x, 0.46, -depth / 2 + 0.3), rotX: -0.14) { b.box(cw - 0.04, 0.36, 0.16, fabric, r: 0.07) }
        }
    }

    static func chair(_ b: MeshBuilder, _ color: String = black) {
        let m = Mat.c(color, rough: 0.7)
        legs(b, 0.42, 0.42, 0.44, m, inset: 0.04, r: 0.015)
        b.box(0.44, 0.05, 0.44, m, r: 0.02, at: SIMD3(0, 0.42, 0))
        b.group(SIMD3(0, 0.47, -0.2), rotX: -0.1) { b.box(0.42, 0.4, 0.04, m, r: 0.02) }
    }

    /// Approximate [width, depth] of each piece (furniture.js `footprint`).
    static func footprint(_ item: Furniture) -> (Float, Float) {
        let w = item.props["width"]?.double.map(Float.init)
        switch item.type {
        case "tv": return (w ?? 1.7, 0.4)
        case "tvCabinet": return ((w ?? 0.95) + 0.02, 0.54)
        default: return (w ?? 0.6, 0.6)
        }
    }

    /// Builds one piece; returns where its TV screen is (centre-bottom y, z, size) for a TV.
    private static func piece(_ it: Furniture, _ b: MeshBuilder) -> (y: Float, z: Float, w: Float, h: Float)? {
        func n(_ k: String, _ d: Double) -> Float { Float(it.num(k, d)) }
        switch it.type {
        case "rug":
            let (sw, sd) = it.size.map { (Float($0.0), Float($0.1)) } ?? (2, 1.4)
            let color = it.str("color", "#3b4a66")
            b.box(sw, 0.016, sd, .c(color, rough: 1), r: 0.006)
            b.box(sw - 0.24, 0.018, sd - 0.24, .c(darker(color, 1.18), rough: 1), r: 0.006)
        case "sofa":
            let width = n("width", 2.2)
            seating(b, width, 0.95, it.str("color", "#8b93a7"), width > 2 ? 3 : 2)
            b.group(SIMD3(-width / 2 + 0.42, 0.46, -0.1), rotY: 0.3, rotX: -0.25, rotZ: 0.1) { b.box(0.36, 0.36, 0.12, .c("#d9b98a", rough: 1), r: 0.05) }
        case "armchair":
            seating(b, 0.92, 0.88, it.str("color", "#c28a5a"), 1)
        case "coffeeTable":
            let width = n("width", 1.1)
            b.box(width, 0.04, 0.58, .c(wood, rough: 0.6), r: 0.015, at: SIMD3(0, 0.36, 0))
            b.box(width - 0.16, 0.02, 0.44, .c(black, rough: 0.5), r: 0.008, at: SIMD3(0, 0.14, 0))
            legs(b, width, 0.58, 0.36, .c(black, rough: 0.5), inset: 0.07, r: 0.015)
            b.box(0.24, 0.035, 0.17, .c("#c9553f", rough: 0.9), r: 0.006, at: SIMD3(0.22, 0.4, 0.05))
            b.cyl(0.05, 0.04, 0.09, .c(white, rough: 0.4), at: SIMD3(-0.3, 0.4, -0.08))
        case "tv":
            let width = n("width", 1.7)
            let sw = width * 0.84, sh = sw * 0.5625
            b.box(width, 0.36, 0.4, .c(darkWood, rough: 0.6), r: 0.015, at: SIMD3(0, 0.1, 0))
            legs(b, width, 0.4, 0.1, .c(black), inset: 0.08, r: 0.015)
            doorLines(b, width, 0.3, 0.13, 0.2, 3, .c(black))
            b.box(sw + 0.03, sh + 0.03, 0.035, .c(black, rough: 0.4), r: 0.008, at: SIMD3(0, 0.72, -0.15))
            b.box(0.5, 0.07, 0.09, .c("#2a2c33", rough: 0.7), r: 0.02, at: SIMD3(0, 0.46, 0.05))
            return (0.745, -0.129 + 0.006, sw - 0.02, sh - 0.02)
        case "sideboard":
            let width = n("width", 1.6)
            legs(b, width, 0.42, 0.16, .c(black), inset: 0.07, r: 0.015)
            b.box(width, 0.6, 0.42, .c(wood, rough: 0.6), r: 0.015, at: SIMD3(0, 0.16, 0))
            doorLines(b, width, 0.54, 0.19, 0.21, 4, .c(darkWood))
            b.cyl(0.07, 0.05, 0.26, .c("#3d6b8c", rough: 0.35), at: SIMD3(-width / 2 + 0.3, 0.76, 0))
            b.box(0.3, 0.05, 0.2, .c("#d8c9a8", rough: 0.9), r: 0.006, at: SIMD3(width / 2 - 0.35, 0.76, 0))
        case "diningSet":
            let width = n("width", 1.8), chairs = Int(it.num("chairs", 6)), depth: Float = 0.95
            b.box(width, 0.05, depth, .c("#b48d63", rough: 0.55), r: 0.02, at: SIMD3(0, 0.71, 0))
            legs(b, width, depth, 0.71, .c(black, rough: 0.5), inset: 0.1, r: 0.028)
            b.cyl(0.16, 0.1, 0.07, .c(white, rough: 0.4), at: SIMD3(0, 0.76, 0))
            let perSide = Int(ceil(Double(chairs) / 2))
            for i in 0..<chairs {
                let side: Float = i < perSide ? 1 : -1
                let k = i < perSide ? i : i - perSide
                let cnt = i < perSide ? perSide : chairs - perSide
                b.group(SIMD3(-width / 2 + width / Float(cnt) * (Float(k) + 0.5), 0, side * (depth / 2 + 0.12)), rotY: side > 0 ? .pi : 0) { chair(b, "#2b2e37") }
            }
        case "island":
            let width = n("width", 2), stools = Int(it.num("stools", 3))
            b.box(width - 0.12, 0.88, 0.62, .c("#39424f", rough: 0.7), r: 0.015, at: SIMD3(0, 0, -0.04))
            b.box(width, 0.05, 0.86, .c("#e9e7e2", rough: 0.3), r: 0.015, at: SIMD3(0, 0.88, 0))
            for i in 0..<stools {
                let x = -width / 2 + width / Float(stools) * (Float(i) + 0.5)
                b.cyl(0.16, 0.16, 0.012, .c(black, rough: 0.4), at: SIMD3(x, 0, 0.62))
                b.cyl(0.015, 0.015, 0.64, .c(metal, rough: 0.3, metal: 0.8), seg: 10, at: SIMD3(x, 0, 0.62))
                b.cyl(0.17, 0.15, 0.05, .c("#c28a5a", rough: 0.9), at: SIMD3(x, 0.64, 0.62))
            }
        case "kitchen":
            let width = n("width", 3), upper = it.bool("upper", true)
            let front = Mat.c("#e4e1da", rough: 0.6), seam = Mat.c("#b9b6ae")
            let cnt = max(2, Int((width / 0.6).rounded()))
            b.box(width, 0.86, 0.6, front, r: 0.008)
            doorLines(b, width, 0.78, 0.06, 0.3, cnt, seam)
            b.box(width + 0.02, 0.04, 0.63, .c("#33363d", rough: 0.35), r: 0.008, at: SIMD3(0, 0.86, 0.005))
            b.box(0.58, 0.012, 0.5, .c("#0c0d10", rough: 0.15), r: 0, at: SIMD3(-width / 4, 0.9, 0))
            b.box(0.5, 0.012, 0.38, .c(metal, rough: 0.3, metal: 0.9), r: 0, at: SIMD3(width / 4, 0.9, 0.02))
            b.cyl(0.015, 0.015, 0.24, .c(metal, rough: 0.25, metal: 0.9), seg: 10, at: SIMD3(width / 4, 0.9, -0.22))
            if upper {
                b.box(width, 0.72, 0.35, front, r: 0.008, at: SIMD3(0, 1.48, -0.125))
                doorLines(b, width, 0.66, 1.51, 0.05, cnt, seam)
                b.box(0.7, 0.1, 0.42, .c("#2f3239", rough: 0.4, metal: 0.4), r: 0.008, at: SIMD3(-width / 4, 1.42, -0.09))
            }
        case "fridge":
            let body = Mat.c("#c5c9d0", rough: 0.35, metal: 0.5)
            b.box(0.7, 1.92, 0.68, body, r: 0.025)
            b.box(0.66, 0.008, 0.005, .c("#7c8088"), r: 0, at: SIMD3(0, 1.25, 0.34))
            b.box(0.02, 0.5, 0.03, .c("#70747c", rough: 0.3, metal: 0.7), r: 0.008, at: SIMD3(-0.26, 1.34, 0.35))
            b.box(0.02, 0.4, 0.03, .c("#70747c", rough: 0.3, metal: 0.7), r: 0.008, at: SIMD3(-0.26, 0.76, 0.35))
        case "bed":
            let width = n("width", 1.6), color = it.str("color", "#7f8fb5"), depth: Float = 2.1
            let linen = Mat.c("#f1efea", rough: 1)
            b.box(width + 0.1, 0.26, depth + 0.04, .c(darkWood, rough: 0.7), r: 0.03, at: SIMD3(0, 0.04, 0))
            b.box(width + 0.16, 1.02, 0.1, .c(darker(color, 0.6), rough: 1), r: 0.04, at: SIMD3(0, 0, -depth / 2))
            b.box(width, 0.2, depth - 0.06, linen, r: 0.07, at: SIMD3(0, 0.28, 0.02))
            b.box(width + 0.05, 0.13, depth * 0.63, .c(color, rough: 1), r: 0.06, at: SIMD3(0, 0.4, depth * 0.17))
            b.box(width + 0.06, 0.05, 0.3, .c(darker(color, 0.8), rough: 1), r: 0.02, at: SIMD3(0, 0.5, depth * 0.36))
            for sx: Float in [-1, 1] {
                b.group(SIMD3(sx * width / 4, 0.46, -depth / 2 + 0.36), rotX: -0.18) { b.box(width / 2 - 0.14, 0.13, 0.42, linen, r: 0.06) }
            }
        case "nightstand":
            b.box(0.46, 0.44, 0.4, .c(wood, rough: 0.6), r: 0.015, at: SIMD3(0, 0.06, 0))
            legs(b, 0.46, 0.4, 0.06, .c(black), inset: 0.06, r: 0.014)
            b.box(0.4, 0.006, 0.005, .c(darkWood), r: 0, at: SIMD3(0, 0.28, 0.2))
        case "dresser":
            let width = n("width", 1.3), height = n("height", 0.84)
            let body = max(0.3, height - 0.1)
            let drawers = max(3, Int((body / 0.25).rounded()))
            legs(b, width, 0.45, 0.1, .c(black), inset: 0.06, r: 0.015)
            b.box(width, body, 0.45, .c(white, rough: 0.6), r: 0.015, at: SIMD3(0, 0.1, 0))
            b.cyl(0.09, 0.07, 0.18, .c("#c9a15e", rough: 0.4), at: SIMD3(width / 2 - 0.3, height, 0))
            for i in 1..<drawers { b.box(width - 0.06, 0.006, 0.005, .c("#b9b6ae"), r: 0, at: SIMD3(0, 0.1 + body / Float(drawers) * Float(i), 0.226)) }
        case "plant":
            let height = n("height", 1.2)
            var rand = Materials.Rng(Int((height * 1000).rounded()))
            let leaves = [Mat.c("#3f7d52", rough: 0.9), .c("#4f9462", rough: 0.9), .c("#35694a", rough: 0.9)]
            b.cyl(0.17, 0.12, 0.3, .c("#d7d0c4", rough: 0.8))
            b.cyl(0.15, 0.15, 0.02, .c("#3a2c22", rough: 1), at: SIMD3(0, 0.285, 0))
            b.cyl(0.015, 0.02, height * 0.55, .c("#6b4a33", rough: 1), seg: 8, at: SIMD3(0, 0.3, 0))
            let count = Int((6 + height * 5).rounded())
            for i in 0..<count {
                let t = Float(i) / Float(count - 1)
                let y = 0.5 + t * (height - 0.62)
                let spread = 0.28 * sin(.pi * (0.25 + t * 0.7))
                let a = Float(rand.next()) * .pi * 2
                let r = 0.13 + Float(rand.next()) * 0.1
                let p = SIMD3(cos(a) * spread * Float(rand.next()), y, sin(a) * spread * Float(rand.next()))
                b.group(p, scale: SIMD3(1, 0.75 + Float(rand.next()) * 0.3, 1)) { b.add(Prim.sphere(r, wSeg: 10, hSeg: 7), leaves[i % 3]) }
            }
        case "vanity":
            let width = n("width", 1)
            b.box(width, 0.62, 0.48, .c(wood, rough: 0.6), r: 0.012, at: SIMD3(0, 0.2, 0))
            doorLines(b, width, 0.56, 0.23, 0.24, 2, .c(darkWood))
            b.box(width + 0.03, 0.04, 0.5, .c(white, rough: 0.25), r: 0.012, at: SIMD3(0, 0.82, 0))
            b.cyl(0.19, 0.15, 0.1, .c(white, rough: 0.2), at: SIMD3(0, 0.86, 0.02))
            b.cyl(0.012, 0.012, 0.2, .c(metal, rough: 0.2, metal: 0.9), seg: 10, at: SIMD3(0, 0.86, -0.18))
            b.box(width * 0.82, 0.8, 0.025, .c("#b9c7dc", rough: 0.12, metal: 0.9), r: 0.01, at: SIMD3(0, 1.08, -0.225))
        case "bathtub":
            b.box(1.7, 0.56, 0.78, .c(white, rough: 0.25), r: 0.1)
            b.box(1.5, 0.02, 0.58, Mat(color: "#9fd3ec", rough: 0.1, emissive: "#1d4f6b", emissiveIntensity: 0.25), r: 0.009, at: SIMD3(0, 0.545, 0))
            b.cyl(0.014, 0.014, 0.2, .c(metal, rough: 0.2, metal: 0.9), seg: 10, at: SIMD3(-0.74, 0.56, 0))
        case "toilet":
            let c = Mat.c(white, rough: 0.25)
            b.box(0.38, 0.78, 0.17, c, r: 0.03, at: SIMD3(0, 0, -0.24))
            b.group(SIMD3(0, 0, 0.1), scale: SIMD3(1, 1, 1.25)) { b.add(Prim.cylinder(0.19, 0.13, 0.4), c) }
            b.group(SIMD3(0, 0.4, 0.1), scale: SIMD3(1, 1, 1.25)) { b.add(Prim.cylinder(0.2, 0.2, 0.03), c) }
        case "desk":
            let width = n("width", 1.4)
            b.box(width, 0.04, 0.65, .c(wood, rough: 0.55), r: 0.012, at: SIMD3(0, 0.72, 0))
            legs(b, width, 0.65, 0.72, .c(black), inset: 0.06, r: 0.02)
            b.box(0.56, 0.34, 0.025, .c(black, rough: 0.3), r: 0.008, at: SIMD3(0, 0.86, -0.18))
            b.box(0.2, 0.1, 0.12, .c(black), r: 0.008, at: SIMD3(0, 0.76, -0.18))
            b.group(SIMD3(0, 0, 0.5), rotY: .pi) { chair(b, "#2b2e37") }
        case "wardrobe":
            let width = n("width", 1.6), height = n("height", 2.1)
            b.box(width, height, 0.6, .c(white, rough: 0.6), r: 0.015)
            doorLines(b, width, height - 0.08, 0.04, 0.3, max(2, Int((width / 0.55).rounded())), .c("#b9b6ae"))
        case "bookshelf":
            let width = n("width", 1), height = n("height", 1.8)
            var rand = Materials.Rng(Int((width * 100 + height * 7).rounded()))
            let w = Mat.c(wood, rough: 0.6)
            b.box(width, height, 0.04, w, r: 0, at: SIMD3(0, 0, -0.14))
            for sx: Float in [-1, 1] { b.box(0.03, height, 0.32, w, r: 0, at: SIMD3(sx * (width / 2 - 0.015), 0, 0)) }
            let shelves = Int((height / 0.38).rounded())
            let colors = ["#c9553f", "#3d6b8c", "#d8c9a8", "#4f9462", "#8b93a7", "#d9b98a"]
            for i in 0...shelves {
                let y = (height - 0.03) * (Float(i) / Float(shelves))
                b.box(width, 0.03, 0.32, w, r: 0, at: SIMD3(0, y, 0))
                if i == shelves { break }
                var x = -width / 2 + 0.06
                while x < width / 2 - 0.12 {
                    let bw = 0.03 + Float(rand.next()) * 0.04
                    let bh = 0.2 + Float(rand.next()) * 0.1
                    b.box(bw, bh, 0.2, .c(colors[Int(rand.next() * Double(colors.count))], rough: 0.9), r: 0, at: SIMD3(x + bw / 2, y + 0.03, 0))
                    x += bw + 0.004
                    if rand.next() < 0.12 { x += 0.12 }
                }
            }
        case "counter":
            let width = n("width", 1.2), depth = n("depth", 0.62), sink = it.str("sink", "none"), sinkAt = n("sinkAt", 0), top = it.str("top", "#cfcbc3")
            let front = Mat.c(white, rough: 0.6), seam = Mat.c("#b9b6ae")
            let doors = max(1, Int((width / 0.5).rounded()))
            let face = depth / 2 - 0.02
            b.box(width - 0.04, 0.1, depth - 0.1, .c("#2a2c33", rough: 0.9), r: 0, at: SIMD3(0, 0, -0.05))
            b.box(width, 0.76, depth - 0.04, front, r: 0.008, at: SIMD3(0, 0.1, -0.02))
            doorLines(b, width, 0.56, 0.12, face + 0.003, doors, seam)
            b.box(width - 0.03, 0.006, 0.005, seam, r: 0, at: SIMD3(0, 0.69, face + 0.003))
            b.box(width + 0.01, 0.04, depth, .c(top, rough: 0.4), r: 0.008, at: SIMD3(0, 0.86, 0))
            if sink == "single" || sink == "double" {
                let double = sink == "double"
                let sw = min(double ? 0.8 : 0.5, width - 0.1)
                let x = min(max(sinkAt, -(width - sw) / 2), (width - sw) / 2)
                let steel = Mat.c(metal, rough: 0.3, metal: 0.9), basin = Mat.c("#6f747c", rough: 0.35, metal: 0.7)
                b.box(sw, 0.006, 0.44, steel, r: 0, at: SIMD3(x, 0.9, 0.02))
                let bw = double ? (sw - 0.07) / 2 : sw - 0.06
                for bx in double ? [x - (bw + 0.02) / 2, x + (bw + 0.02) / 2] : [x] { b.box(bw, 0.006, 0.36, basin, r: 0.004, at: SIMD3(bx, 0.903, 0.03)) }
                b.cyl(0.015, 0.015, 0.26, steel, seg: 10, at: SIMD3(x, 0.9, -0.2))
                b.group(SIMD3(x, 1.15, -0.13), rotX: .pi / 2) { b.add(Prim.cylinder(0.012, 0.012, 0.16, seg: 10), steel) }
            }
        case "stove":
            let width = n("width", 0.76), d: Float = 0.66
            let w = Mat.c("#f1efe9", rough: 0.45), dark = Mat.c(black, rough: 0.45)
            b.box(width, 0.9, d, w, r: 0.012)
            b.box(width - 0.02, 0.006, d - 0.12, .c("#e2dfd8", rough: 0.5), r: 0, at: SIMD3(0, 0.9, 0.04))
            b.box(width, 0.2, 0.07, w, r: 0.012, at: SIMD3(0, 0.9, -d / 2 + 0.035))
            b.box(width - 0.2, 0.26, 0.008, .c("#14161b", rough: 0.15), r: 0.006, at: SIMD3(0, 0.3, d / 2))
            b.box(width - 0.06, 0.006, 0.005, .c("#b9b6ae"), r: 0, at: SIMD3(0, 0.12, d / 2 + 0.001))
            b.box(width - 0.06, 0.006, 0.005, .c("#b9b6ae"), r: 0, at: SIMD3(0, 0.7, d / 2 + 0.001))
            b.box(width - 0.16, 0.022, 0.03, .c(metal, rough: 0.3, metal: 0.8), r: 0.008, at: SIMD3(0, 0.64, d / 2 + 0.03))
            let bx = min(0.17, width / 4.4)
            for (x, z, r) in [(-bx, Float(-0.12), Float(0.1)), (bx, -0.12, 0.08), (-bx, 0.14, 0.08), (bx, 0.14, 0.1)] {
                b.cyl(r + 0.02, r + 0.02, 0.006, .c("#9da1a8", rough: 0.4, metal: 0.6), seg: 24, at: SIMD3(x, 0.903, z))
                for k: Float in [1, 0.62, 0.3] {
                    b.group(SIMD3(x, 0.915, z), rotX: -.pi / 2) { b.add(Prim.torus(r * k, 0.008, radial: 6, tubular: 28), dark) }
                }
            }
            for i in 0..<4 {
                b.group(SIMD3(-width / 2 + 0.12 + (width - 0.24) / 3 * Float(i), 1.0, -d / 2 + 0.07), rotX: .pi / 2) { b.add(Prim.cylinder(0.022, 0.022, 0.03, seg: 14), dark) }
            }
        case "microwave":
            let blk = Mat.c("#18191d", rough: 0.4)
            legs(b, 0.48, 0.36, 0.012, blk, inset: 0.05, r: 0.012)
            b.box(0.5, 0.29, 0.38, blk, r: 0.012, at: SIMD3(0, 0.012, 0))
            b.box(0.32, 0.2, 0.006, Mat(color: "#2c3340", rough: 0.1, emissive: "#0e1626", emissiveIntensity: 0.4), r: 0.004, at: SIMD3(-0.07, 0.07, 0.19))
            b.box(0.09, 0.22, 0.006, .c("#2a2d34", rough: 0.5), r: 0.004, at: SIMD3(0.18, 0.05, 0.19))
            b.box(0.06, 0.025, 0.004, Mat(color: "#5fd3a3", emissive: "#3fbf8a", emissiveIntensity: 0.8), r: 0, at: SIMD3(0.18, 0.225, 0.194))
            b.box(0.012, 0.18, 0.02, .c(metal, rough: 0.3, metal: 0.8), r: 0.004, at: SIMD3(0.105, 0.07, 0.2))
        case "tvCabinet":
            let width = n("width", 0.95), d: Float = 0.52
            let w = Mat.c("#7a5236", rough: 0.65), seam = Mat.c("#3d2a1d")
            let sw = max(0.4, it.props["tv"]?.double.map(Float.init) ?? width - 0.05), sh = sw * 0.5625
            b.box(width, 0.76, d, w, r: 0.012)
            b.box(0.006, 0.66, 0.005, seam, r: 0, at: SIMD3(0, 0.06, d / 2 + 0.001))
            b.box(width + 0.02, 0.035, d + 0.02, .c("#2b2d31", rough: 0.25), r: 0.008, at: SIMD3(0, 0.76, 0))
            b.box(0.05, 0.05, 0.012, .c("#c9a15e", rough: 0.4, metal: 0.5), r: 0.005, at: SIMD3(width / 4 - 0.18, 0.45, d / 2 + 0.006))
            b.box(0.24, 0.015, 0.16, .c(black, rough: 0.4), r: 0.005, at: SIMD3(0, 0.795, -0.06))
            b.box(0.05, 0.1, 0.03, .c(black, rough: 0.4), r: 0.005, at: SIMD3(0, 0.81, -0.08))
            b.box(sw + 0.02, sh + 0.02, 0.04, .c(black, rough: 0.4), r: 0.008, at: SIMD3(0, 0.88, -0.08))
            for i in 1..<3 { b.box(width / 2 - 0.04, 0.006, 0.005, seam, r: 0, at: SIMD3(-width / 4, 0.06 + 0.66 / 3 * Float(i), d / 2 + 0.001)) }
            return (0.89, -0.055 + 0.006, sw - 0.02, sh - 0.02)
        case "beanBag":
            let (w, d) = it.size.map { (Float($0.0), Float($0.1)) } ?? (1.5, 0.9)
            let h = min(0.62, 0.3 + min(w, d) * 0.22)
            var g = Prim.sphere(1, wSeg: 40, hSeg: 24)
            var rand = Materials.Rng(Int((w * 100 + d * 37).rounded()))
            let bumps = (0..<5).map { _ in (Float(rand.next()) * .pi * 2, 0.04 + Float(rand.next()) * 0.05) }
            g.positions = g.positions.map { p in
                let a = atan2(p.z, p.x)
                let spread = 1 + 0.12 * pow(1 - (p.y + 1) / 2, 2) + bumps.reduce(0) { $0 + $1.1 * pow(cos(a - $1.0), 8) }
                let ny = p.y < 0 ? p.y * 0.25 : p.y * (1 - 0.45 * exp(-((p.x * p.x + p.z * p.z) / 0.25)))
                return SIMD3(p.x * spread * w / 2.24, (ny + 0.25) / 1.25 * h, p.z * spread * d / 2.24)
            }
            Prim.smoothNormals(&g)
            b.add(g, .c(it.str("color", "#d79aa6"), rough: 1))
        case "waterHeater":
            let r = n("diameter", 0.55) / 2, height = n("height", 1.5)
            let w = Mat.c("#f0eee8", rough: 0.4), copper = Mat.c("#b87346", rough: 0.35, metal: 0.7)
            b.cyl(r, r, height - 0.06, w, seg: 32)
            b.group(SIMD3(0, height - 0.06, 0), scale: SIMD3(1, 0.18, 1)) { b.add(Prim.sphere(r, wSeg: 28, hSeg: 10, thetaLength: .pi / 2), w) }
            b.cyl(r + 0.004, r + 0.004, 0.05, .c("#c9c6bf", rough: 0.5), seg: 32)
            b.box(0.12, 0.12, 0.07, .c("#3a3d45", rough: 0.5), r: 0.01, at: SIMD3(0, 0.3, r + 0.01))
            b.cyl(0.035, 0.035, 0.32, .c("#7f848c", rough: 0.4, metal: 0.6), seg: 12, at: SIMD3(0, height - 0.02, 0))
            for x in [-r * 0.5, r * 0.5] { b.cyl(0.016, 0.016, 0.45, copper, seg: 10, at: SIMD3(x, height - 0.04, -r * 0.3)) }
        case "chair":
            let w = Mat.c(wood, rough: 0.6), seat = Mat.c(it.str("color", "#2b2e37"), rough: 0.8)
            legs(b, 0.42, 0.42, 0.45, w, inset: 0.03, r: 0.017)
            b.box(0.44, 0.04, 0.44, w, r: 0.012, at: SIMD3(0, 0.43, 0))
            b.box(0.4, 0.04, 0.4, seat, r: 0.015, at: SIMD3(0, 0.47, 0.01))
            b.box(0.4, 0.2, 0.025, seat, r: 0.012, at: SIMD3(0, 0.68, -0.2))
            for sx: Float in [-1, 1] { b.box(0.035, 0.5, 0.035, w, r: 0.008, at: SIMD3(sx * 0.19, 0.45, -0.2)) }
        case "closetRod":
            let width = n("width", 1.5), clothes = it.bool("clothes", true)
            let steel = Mat.c("#c9ccd2", rough: 0.3, metal: 0.8)
            b.group(SIMD3(-width / 2, 0, 0), rotZ: -.pi / 2) { b.add(Prim.cylinder(0.014, 0.014, width, seg: 12), steel) }
            for sx: Float in [-1, 1] { b.box(0.03, 0.08, 0.06, .c(white, rough: 0.6), r: 0.005, at: SIMD3(sx * (width / 2 - 0.015), -0.05, 0)) }
            var rand = Materials.Rng(Int((width * 1000).rounded()))
            let colors = ["#3d4f6b", "#c9553f", "#e9e6df", "#4f7a5c", "#1f2229", "#8b93a7", "#b8a07a", "#6a4a5e"]
            let count = max(3, Int(floor(width / (clothes ? 0.075 : 0.18))))
            for i in 0..<count {
                let x = -width / 2 + 0.08 + (width - 0.16) / Float(max(1, count - 1)) * Float(i) + Float(rand.next() - 0.5) * 0.02
                b.box(0.004, 0.06, 0.004, steel, r: 0, at: SIMD3(x, -0.04, 0))
                b.box(0.006, 0.012, 0.4, steel, r: 0, at: SIMD3(x, -0.1, 0))
                if !clothes { continue }
                let len = 0.55 + Float(rand.next()) * 0.35
                let depth = 0.42 + Float(rand.next()) * 0.06
                let color = colors[Int(rand.next() * Double(colors.count))]
                b.group(SIMD3(x, -0.1 - len, 0), rotY: Float(rand.next() - 0.5) * 0.25) { b.box(0.035, len, depth, .c(color, rough: 1), r: 0.015) }
            }
        case "storageBins":
            let width = n("width", 0.6), color = it.str("color", "#c8372d"), d: Float = 0.42
            let body = Mat.c(color, rough: 0.55), blk = Mat.c("#1e1f23", rough: 0.6)
            let cnt = max(1, min(6, Int(it.num("stack", 2).rounded())))
            for i in 0..<cnt {
                let y = Float(i) * 0.31
                b.box(width - 0.03, 0.25, d - 0.03, body, r: 0.02, at: SIMD3(0, y, 0))
                b.box(width, 0.05, d, blk, r: 0.015, at: SIMD3(0, y + 0.25, 0))
                b.box(width * 0.4, 0.025, 0.04, blk, r: 0.008, at: SIMD3(0, y + 0.18, d / 2 - 0.01))
                for sx: Float in [-1, 1] { for sz: Float in [-1, 1] {
                    b.box(0.05, 0.25, 0.05, blk, r: 0.01, at: SIMD3(sx * (width / 2 - 0.035), y, sz * (d / 2 - 0.035)))
                } }
            }
        case "shower":
            let (w, d) = it.size.map { (Float($0.0), Float($0.1)) } ?? (0.9, 0.9)
            b.box(w, 0.05, d, .c(white, rough: 0.3), r: 0.012)
            b.box(w - 0.1, 0.01, d - 0.1, .c("#dfe6ec", rough: 0.2), r: 0.02, at: SIMD3(0, 0.046, 0))
            b.cyl(0.045, 0.045, 0.008, .c(metal, rough: 0.3, metal: 0.8), seg: 20, at: SIMD3(0, 0.05, 0))
        default:
            break
        }
        return nil
    }
}
