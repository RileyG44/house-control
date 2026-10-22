import CoreGraphics
import Foundation
import Metal
import RealityKit
import UIKit
import simd

/// The shape of the land around the house (web/src/three/landscape.js `at`): a yard, the lake on
/// one side with its sandy bank and the far shore's dry hills, the field on another, scrub between.
struct Terrain {
    static let water = -0.42        // the lake's level (the yard is at -0.05, the floors at 0)
    static let ground = -0.05
    static let bank = 2.4           // metres of sloping sand down to the water
    static let fieldHalf = 70.0     // the field's half width
    static let clear = 1.5          // nothing above the floor this near the walls
    static let reach = 1700.0       // the land goes out this far

    let minX: Double, minZ: Double, maxX: Double, maxZ: Double
    let cx: Double, cz: Double
    let W: SIMD2<Double>?, F: SIMD2<Double>?
    let halfW: Double, halfF: Double
    let shore: Double, fieldEdge: Double

    init(plan: Plan, site: Site) {
        minX = plan.minX; minZ = plan.minZ; maxX = plan.maxX; maxZ = plan.maxZ
        cx = (minX + maxX) / 2
        cz = (minZ + maxZ) / 2
        W = Site.vector(site.water).map { SIMD2(Double($0.x), Double($0.y)) }
        F = Site.vector(site.field).map { SIMD2(Double($0.x), Double($0.y)) }
        let (w, d) = (maxX - minX, maxZ - minZ)
        halfW = W.map { abs($0.x) * w / 2 + abs($0.y) * d / 2 } ?? 0
        halfF = F.map { abs($0.x) * w / 2 + abs($0.y) * d / 2 } ?? 0
        shore = site.shore
        fieldEdge = site.fieldEdge
    }

    /// How far (x, z) is from the house's outline (its bounding box).
    func boxDist(_ x: Double, _ z: Double) -> Double {
        let dx = max(minX - x, 0, x - maxX), dz = max(minZ - z, 0, z - maxZ)
        return (dx * dx + dz * dz).squareRoot()
    }

    /// In a side's own frame: how far beyond the house's face (t), and how far along it (s).
    func depth(_ v: SIMD2<Double>, _ h: Double, _ x: Double, _ z: Double) -> Double { (x - cx) * v.x + (z - cz) * v.y - h }
    func along(_ v: SIMD2<Double>, _ x: Double, _ z: Double) -> Double { -(x - cx) * v.y + (z - cz) * v.x }

    /// The waterline curves gently, and runs off past both sides of the house.
    func shoreAt(_ s: Double) -> Double {
        max(Self.clear + Self.bank, shore + 1.3 * sin(s * 0.075 + 0.9) + 0.6 * sin(s * 0.21 + 2.3))
    }

    /// The far shore, about 1–1.5 km out, wanders too.
    func farAt(_ s: Double) -> Double { 1050 + 260 * sin(s * 0.0021 + 1.3) + 90 * sin(s * 0.0071) }

    func bumps(_ x: Double, _ z: Double) -> Double {
        let a = sin(x * 0.31 + z * 0.17) * 0.5
        let b = sin(x * 0.11 - z * 0.27 + 1.7) * 0.35
        return a + b + sin(x * 0.53 + z * 0.61 + 4.1) * 0.15
    }

    func hills(_ s: Double) -> Double { 0.55 + 0.25 * sin(s * 0.009 + 0.4) + 0.2 * sin(s * 0.023 + 2.2) }

    /// The height of the land at (x, z), and how much of it is field, sand and scrub.
    func at(_ x: Double, _ z: Double) -> (h: Double, field: Double, sand: Double, scrub: Double) {
        let d = boxDist(x, z)
        let rough = smoothStep(Self.clear + 0.5, 12, d) * 0.22 + smoothStep(40, 160, d) * 1.4
        var h = Self.ground + bumps(x, z) * rough
        var field = 0.0, sand = 0.0
        var scrub = smoothStep(9, 22, d)
        if let F {
            let t = depth(F, halfF, x, z)
            let s = abs(along(F, x, z))
            // A flat field from `fieldEdge` on, as wide as a farm, out to the horizon.
            let inField = smoothStep(fieldEdge - 0.2, fieldEdge + 0.2, t) * (1 - smoothStep(Self.fieldHalf - 4, Self.fieldHalf + 4, s))
            let flat = smoothStep(fieldEdge - 4, fieldEdge, t) * (1 - smoothStep(Self.fieldHalf, Self.fieldHalf + 12, s))
            h += (Self.ground - h) * flat
            field = inField
            scrub *= 1 - smoothStep(fieldEdge - 6, fieldEdge, t) * (1 - smoothStep(Self.fieldHalf - 4, Self.fieldHalf + 10, s))
        }
        if let W {
            let t = depth(W, halfW, x, z)
            let s = along(W, x, z)
            let line = shoreAt(s)
            // The yard runs down to the lake as a lawn; then sand and water.
            scrub *= 1 - smoothStep(line - 12, line - 4, t) * (1 - smoothStep(40, 70, abs(s)))
            let k = smoothStep(line - Self.bank, line, t)
            h += (Self.water - 0.14 - h) * k
            if t > line { h = Self.water - 0.14 - min(1.6, (t - line) * 0.12) }
            sand = smoothStep(line - Self.bank - 0.5, line - Self.bank + 0.3, t)
            field *= 1 - smoothStep(line - Self.bank - 2, line - Self.bank, t)
            // The far shore rises into low, dry hills.
            let far = farAt(s)
            if t > far - 40 {
                let rise = smoothStep(far - 40, far + 220, t)
                let lift = 8 + 46 * hills(s) * smoothStep(far, far + 500, t) + 6 * bumps(x * 0.05, z * 0.05)
                h = max(h, Self.water - 1.5 + rise * lift)
                sand *= 1 - smoothStep(far + 20, far + 80, t)
                scrub = max(scrub, smoothStep(far, far + 60, t))
            }
        }
        return (h, field, sand, min(1, scrub))
    }
}

/// The land around the house (docs/landscape-weather.md), ported from web/src/three/landscape.js:
/// a yard of grass, the lake with its bank and the far shore's hills, the farm field with its rows
/// running away from the house, dry scrub with sagebrush, a few rocks and a lone tree or two. Low
/// poly like the model. Nothing rises above the floor within 1.5 m of the walls, nothing stands
/// between the camera and the house, and nothing is picked by a tap (no collision shapes).
///
/// Lit by the sky (Sky.swift): every part is cut into rings by distance from the house so the fog
/// can lie thicker further out (each ring's colour gives way to the fog's), and the ground turns
/// wet, frosted or white with the weather.
@MainActor
final class Landscape {
    enum Zone: Int, CaseIterable { case grass, scrub, sand, field, water, plant, rock, trunk, crown }

    /// The rings, by metres from the house: the fog's colour comes in ring by ring.
    static let rings: [Double] = [0, 4, 7, 10, 13, 16, 20, 24, 29, 34, 40, 48, 58, 70, 85, 100, 125, 150, 190, 240, 320, 400, 550, 700, 950, 1200, 1e9]

    /// The crop through the year (by month, 0 = January): crop, furrow.
    static let fieldColors: [(String, String)] = [
        ("#7d6650", "#5e4a39"), ("#7d6650", "#5e4a39"), ("#7d6650", "#5e4a39"), ("#7f9a4c", "#6a5440"),
        ("#5f8a3a", "#4a6c2e"), ("#5b8636", "#47692b"), ("#628a38", "#4d6d2c"), ("#c9a54a", "#a8873a"),
        ("#c4a04c", "#9e8038"), ("#b59a6a", "#6f5638"), ("#ad946a", "#6a5338"), ("#7d6650", "#5e4a39"),
    ]
    /// The yard's grass: green while it is watered, olive in the autumn, dull in the winter.
    static let grassColors: [String] = [
        "#8a8a62", "#8a8a62", "#86895d", "#6f9447", "#64904a", "#5f8c46",
        "#628b45", "#6d8c46", "#7d9150", "#8b9659", "#8e9260", "#8a8a62",
    ]

    private struct Key: Hashable { var zone: Zone; var ring: Int }
    private struct Part { var entity: ModelEntity; var zone: Zone; var mid: Double }

    let root = Entity()
    private let terrain: Terrain
    private var parts: [Part] = []
    private var colors: [Zone: RGB] = [:]
    private var furrow = 0.75
    private var fieldTexture: TextureResource?
    private var rippleTexture: TextureResource?
    private var waterParts: [(entity: ModelEntity, material: PhysicallyBasedMaterial)] = []
    private var ripple = SIMD2<Float>(0, 0)
    private var sinceRipple = 0.0

    init(plan: Plan, site: Site, camDir: P2, month: Int, ibl: Entity, waterIBL: Entity) {
        terrain = Terrain(plan: plan, site: site)
        root.name = "landscape"
        season(month)
        var batches: [Key: MeshBatch] = [:]
        buildGround(into: &batches)
        buildLake(into: &batches)
        buildPlants(site: site, camDir: camDir, into: &batches)
        fieldTexture = Self.rowsTexture(furrow: furrow)
        rippleTexture = Self.rippleTexture()
        for (key, batch) in batches where !batch.isEmpty {
            let mesh: MeshResource?
            if key.zone == .water { mesh = try? Self.flatResource(batch) } else { mesh = try? batch.resource() }
            guard let mesh else { continue }
            let e = ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: .gray)])
            e.name = "landscape"
            e.components.set(ImageBasedLightReceiverComponent(imageBasedLight: key.zone == .water ? waterIBL : ibl))
            root.addChild(e)
            let lo = Self.rings[key.ring], hi = Self.rings[min(key.ring + 1, Self.rings.count - 1)]
            parts.append(Part(entity: e, zone: key.zone, mid: hi > 1e8 ? 1500 : (lo + hi) / 2))
        }
    }

    /// The grass and the field for the month at the house (1 … 12).
    private func season(_ month: Int) {
        let m = min(11, max(0, month - 1))
        let crop = RGB(hex: Self.fieldColors[m].0), dark = RGB(hex: Self.fieldColors[m].1)
        colors[.grass] = RGB(hex: Self.grassColors[m])
        colors[.field] = crop
        colors[.scrub] = RGB(hex: "#a39a75").lerp(RGB(hex: "#878f72"), 0.4)
        colors[.sand] = RGB(hex: "#cdb88f")
        colors[.water] = RGB(hex: "#7f9cb0")
        colors[.plant] = RGB(hex: "#7f8b66")
        colors[.rock] = RGB(hex: "#8e8a82")
        colors[.trunk] = RGB(hex: "#5c4a3a")
        colors[.crown] = RGB(hex: "#7d8a63")
        let luma = { (c: RGB) in 0.3 * c.r + 0.59 * c.g + 0.11 * c.b }
        furrow = min(0.95, max(0.5, luma(dark) / max(0.01, luma(crop))))
    }

    private static func ring(_ d: Double) -> Int {
        var i = 0
        while i + 1 < rings.count - 1, d >= rings[i + 1] { i += 1 }
        return i
    }

    /// One triangle, flat shaded, turned to face up (or out); `uv` gives each corner's texture place.
    private static func triangle(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ c: SIMD3<Float>, uv: (SIMD3<Float>) -> SIMD2<Float>, into batch: inout MeshBatch) {
        var n = simd_cross(b - a, c - a)
        let len = simd_length(n)
        guard len > 1e-9 else { return }
        n /= len
        let up = n.y >= 0
        let pts = up ? [a, b, c] : [a, c, b]
        if !up { n = -n }
        batch.add(positions: pts, normals: [n, n, n], uvs: pts.map(uv), indices: [0, 1, 2], transform: matrix_identity_float4x4)
    }

    // MARK: - the ground: rings around the house, fine near it, coarse far out

    private func buildGround(into batches: inout [Key: MeshBatch]) {
        let t = terrain
        var radii: [Double] = [0]
        var r = 0.75
        while r <= 45 { radii.append(r); r += 0.75 }
        r = 45 * 1.1
        while r < Terrain.reach { radii.append(r); r *= 1.1 }
        radii.append(Terrain.reach)
        let seg = 160
        struct V { var p: SIMD3<Float>; var field: Double; var sand: Double; var scrub: Double }
        var grid: [[V]] = []
        for rr in radii {
            var row: [V] = []
            for j in 0..<seg {
                let a = Double(j) / Double(seg) * 2 * .pi
                let x = t.cx + cos(a) * rr, z = t.cz + sin(a) * rr
                let s = t.at(x, z)
                row.append(V(p: SIMD3(Float(x), Float(s.h), Float(z)), field: s.field, sand: s.sand, scrub: s.scrub))
            }
            grid.append(row)
        }
        // The field's rows run away from the house: a texture of stripes across them.
        let origin = SIMD2(Float(t.cx), Float(t.cz))
        let fdir = t.F.map { SIMD2(Float($0.x), Float($0.y)) } ?? SIMD2<Float>(0, 1)
        let across = SIMD2(-fdir.y, fdir.x)
        let fieldUV = { (p: SIMD3<Float>) -> SIMD2<Float> in
            let q = SIMD2(p.x, p.z) - origin
            return SIMD2(simd_dot(q, across) / 0.9, simd_dot(q, fdir) / 12)
        }
        let plainUV = { (p: SIMD3<Float>) -> SIMD2<Float> in SIMD2(p.x / 4, p.z / 4) }
        for i in 0..<(radii.count - 1) {
            for j in 0..<seg {
                let a = grid[i][j], b = grid[i][(j + 1) % seg], c = grid[i + 1][j], d = grid[i + 1][(j + 1) % seg]
                for tri in [[a, b, c], [b, d, c]] {
                    let field = (tri[0].field + tri[1].field + tri[2].field) / 3
                    let sand = (tri[0].sand + tri[1].sand + tri[2].sand) / 3
                    let scrub = (tri[0].scrub + tri[1].scrub + tri[2].scrub) / 3
                    let zone: Zone = field > 0.5 ? .field : sand > 0.5 ? .sand : scrub > 0.5 ? .scrub : .grass
                    let m = (tri[0].p + tri[1].p + tri[2].p) / 3
                    // Under the lake there is nothing to see.
                    if Double(m.y) < Terrain.water - 0.6 && t.boxDist(Double(m.x), Double(m.z)) < 900 { continue }
                    let key = Key(zone: zone, ring: Self.ring(t.boxDist(Double(m.x), Double(m.z))))
                    Self.triangle(tri[0].p, tri[1].p, tri[2].p, uv: zone == .field ? fieldUV : plainUV, into: &batches[key, default: MeshBatch()])
                }
            }
        }
    }

    // MARK: - the lake

    /// A flat grid in the lake's own frame, from under the bank out to the horizon.
    private func buildLake(into batches: inout [Key: MeshBatch]) {
        let t = terrain
        guard let W = t.W else { return }
        var ss: [Double] = []
        var s = -Terrain.reach
        while s < -60 { ss.append(s); s *= 0.8 }
        s = -60
        while s <= 60 { ss.append(s); s += 3 }
        s = 60 / 0.8
        while s < Terrain.reach { ss.append(s); s /= 0.8 }
        ss.append(Terrain.reach)
        var ts: [Double] = [-4, -1, 2, 5, 9]
        var d = 13.0
        while d < Terrain.reach { ts.append(d); d *= 1.3 }
        ts.append(Terrain.reach)
        let y = Float(Terrain.water)
        func point(_ s: Double, _ tt: Double) -> SIMD3<Float> {
            let line = t.shoreAt(s) - Terrain.bank * 0.32 + tt   // where the bank meets the water
            return SIMD3(Float(t.cx + W.x * (t.halfW + line) - W.y * s), y, Float(t.cz + W.y * (t.halfW + line) + W.x * s))
        }
        let uv = { (p: SIMD3<Float>) -> SIMD2<Float> in SIMD2(p.x / 6, p.z / 6) }
        for i in 0..<(ts.count - 1) {
            for j in 0..<(ss.count - 1) {
                let a = point(ss[j], ts[i]), b = point(ss[j + 1], ts[i]), c = point(ss[j], ts[i + 1]), dd = point(ss[j + 1], ts[i + 1])
                let m = (a + b + c + dd) / 4
                let key = Key(zone: .water, ring: Self.ring(t.boxDist(Double(m.x), Double(m.z))))
                Self.triangle(a, b, c, uv: uv, into: &batches[key, default: MeshBatch()])
                Self.triangle(b, dd, c, uv: uv, into: &batches[key, default: MeshBatch()])
            }
        }
    }

    /// The lake's mesh, with tangents for its ripples (a normal map): it is flat, so they are the same everywhere.
    private static func flatResource(_ batch: MeshBatch) throws -> MeshResource {
        var d = MeshDescriptor(name: "lake")
        d.positions = MeshBuffers.Positions(batch.positions)
        d.normals = MeshBuffers.Normals(batch.normals)
        d.tangents = MeshBuffers.Tangents(Array(repeating: SIMD3<Float>(1, 0, 0), count: batch.positions.count))
        d.textureCoordinates = MeshBuffers.TextureCoordinates(batch.uvs)
        d.primitives = .triangles(batch.indices)
        return try MeshResource.generate(from: [d])
    }

    // MARK: - sagebrush, rocks and a lone tree or two

    private func buildPlants(site: Site, camDir: P2, into batches: inout [Key: MeshBatch]) {
        let t = terrain
        var rand = Materials.Rng(Int((site.lat * 1000 + site.lon * 7) * 13))
        let camSide = { (x: Double, z: Double) in (x - t.cx) * camDir.x + (z - t.cz) * camDir.y }
        func spot(_ x: Double, _ z: Double, near: Double) -> (h: Double, field: Double, sand: Double, scrub: Double)? {
            let d = t.boxDist(x, z)
            guard d >= near else { return nil }
            // Nothing between the camera and the house, however it orbits.
            if camSide(x, z) > 0 && d < 14 { return nil }
            let p = t.at(x, z)
            if p.field > 0.05 || p.h < Terrain.ground - 0.2 { return nil }
            return p
        }
        let ball = Prim.sphere(1, wSeg: 6, hSeg: 4)
        func put(_ g: Geo, _ zone: Zone, _ m: simd_float4x4) {
            let at = SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
            let key = Key(zone: zone, ring: Self.ring(t.boxDist(Double(at.x), Double(at.z))))
            batches[key, default: MeshBatch()].add(positions: g.positions, normals: g.normals, uvs: nil, indices: g.indices, transform: m)
        }
        // Sagebrush: clumps of two or three small round bushes, thicker in the scrub.
        var bushes = 0
        var tries = 0
        while tries < 3000 && bushes < 140 {
            tries += 1
            let a = rand.next() * 2 * .pi
            let r = 6 + pow(rand.next(), 0.7) * 70
            let (x, z) = (t.cx + cos(a) * r, t.cz + sin(a) * r)
            guard let p = spot(x, z, near: 5), rand.next() <= 0.15 + p.scrub else { continue }
            let size = 0.28 + rand.next() * 0.24
            let count = 2 + Int(rand.next() * 2)
            for _ in 0..<count where bushes < 140 {
                let bx = x + (rand.next() - 0.5) * size * 2.2, bz = z + (rand.next() - 0.5) * size * 2.2
                let sz = Float(size * (0.7 + rand.next() * 0.5))
                put(ball, .plant, Xform.make(SIMD3(Float(bx), Float(p.h) + sz * 0.45, Float(bz)), rotY: Float(rand.next() * 6.28), scale: SIMD3(sz * 1.15, sz * 0.8, sz)))
                bushes += 1
            }
        }
        // Rocks along the bank.
        if let W = t.W {
            let stone = Prim.sphere(1, wSeg: 5, hSeg: 3)
            var rocks = 0
            tries = 0
            while tries < 400 && rocks < 22 {
                tries += 1
                let s = (rand.next() - 0.5) * 90
                let tt = t.shoreAt(s) - Terrain.bank * (0.2 + rand.next() * 0.75)
                let x = t.cx + W.x * (t.halfW + tt) - W.y * s
                let z = t.cz + W.y * (t.halfW + tt) + W.x * s
                let d = t.boxDist(x, z)
                if d < 3 || (camSide(x, z) > 0 && d < 14) { continue }
                let size = Float(0.12 + rand.next() * 0.32)
                put(stone, .rock, Xform.make(SIMD3(Float(x), Float(t.at(x, z).h) + size * 0.2, Float(z)),
                                             rotY: Float(rand.next() * 3), rotX: Float(rand.next() * 0.6),
                                             scale: SIMD3(size * 1.3, size * 0.7, size)))
                rocks += 1
            }
        }
        // A lone tree or two (Russian olive, as along the lake), well away and never camera-side.
        let away = simd_normalize(SIMD2(-camDir.x, -camDir.y))
        let trunk = Prim.cylinder(0.12, 0.2, 2.4, seg: 6)
        let crown = Prim.sphere(1, wSeg: 7, hSeg: 5)
        for (turn, dist, size) in [(0.75, 17.0, Float(1)), (-1.05, 30.0, Float(0.85))] {
            let dir = SIMD2(away.x * cos(turn) - away.y * sin(turn), away.x * sin(turn) + away.y * cos(turn))
            var r = dist
            while r < dist + 40 {
                defer { r += 3 }
                let (x, z) = (t.cx + dir.x * r, t.cz + dir.y * r)
                guard let p = spot(x, z, near: 11), p.h >= Terrain.ground - 0.1 else { continue }
                let base = SIMD3(Float(x), Float(p.h), Float(z))
                put(trunk, .trunk, Xform.make(base, scale: SIMD3(repeating: size)))
                put(crown, .crown, Xform.make(base + SIMD3<Float>(0, 3.3 * size, 0), scale: SIMD3<Float>(2.4, 1.7, 2.1) * size))
                put(crown, .crown, Xform.make(base + SIMD3<Float>(1.1, 2.7, 0.6) * size, scale: SIMD3(repeating: 1.4 * size)))
                break
            }
        }
    }

    // MARK: - the weather on the land

    /// Colours every part for the sky's look: the season's colours, washed out on grey days,
    /// darker and glossier in the rain, white under snow, frosted by rime fog, and giving way
    /// to the fog further out (the fog's colour shines from the surface, so it is the same
    /// whatever the light).
    func apply(_ look: SkyLook) {
        waterParts = []
        let snowWhite = RGB(hex: "#eef2f6")
        let frostWhite = RGB(hex: "#dfe6ea")
        let deep = look.horizon.scaled(0.45).lerp(RGB(hex: "#1d4a66"), 0.4).lerp(RGB(hex: "#7f9cb0"), 0.35)
        for part in parts {
            var c = part.zone == .water ? deep : colors[part.zone] ?? RGB(0.5, 0.5, 0.5)
            let f = look.fogAt(part.mid)
            var m = PhysicallyBasedMaterial()
            var rough: Float = 0.95
            switch part.zone {
            case .water:
                rough = 0.12
            case .grass, .scrub, .sand, .field:
                let luma = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b
                c = c.lerp(RGB(luma, luma, luma), 0.3 * look.cover)
                c = c.scaled(1 - 0.3 * look.wet * (part.zone == .sand ? 0.6 : 1))
                c = c.lerp(frostWhite, 0.6 * look.frost)
                c = c.lerp(snowWhite, look.snowCover)
                rough = Float(0.95 - 0.5 * look.wet * (part.zone == .field ? 0.6 : 1))
            case .plant, .rock, .crown:
                c = c.lerp(snowWhite, 0.6 * look.snowCover).lerp(frostWhite, 0.4 * look.frost)
            case .trunk:
                break
            }
            let base = UIColor(rgb: c.scaled(1 - f).clamped)
            if part.zone == .field, let tex = fieldTexture {
                m.baseColor = .init(tint: base, texture: .init(tex, sampler: Self.repeating))
            } else {
                m.baseColor = .init(tint: base)
            }
            m.roughness = .init(floatLiteral: rough)
            if part.zone == .water {
                // The lake mirrors the sky (its own image-based light) and ripples in the wind.
                m.metallic = .init(floatLiteral: Float(0.4 * (1 - f)))
                if let tex = rippleTexture, part.mid < 160 {
                    m.normal = .init(texture: .init(tex, sampler: Self.repeating))
                }
            }
            if f > 0.002 {
                m.emissiveColor = .init(color: UIColor(rgb: look.fog.clamped))
                m.emissiveIntensity = Float(f)
            }
            part.entity.model?.materials = [m]
            if part.zone == .water, part.mid < 160 { waterParts.append((part.entity, m)) }
        }
        applyRipple()
    }

    /// The ripples drift downwind, bigger and quicker in a stronger wind (`wind`: towards x, z, and m/s).
    func update(dt: Double, wind: SIMD3<Float>, still: Bool) {
        guard !still, !waterParts.isEmpty else { return }
        ripple -= SIMD2(wind.x, wind.y) * (0.25 + wind.z * 0.1) * Float(dt) / 6
        sinceRipple += dt
        guard sinceRipple >= 1.0 / 15 else { return }
        sinceRipple = 0
        applyRipple()
    }

    private func applyRipple() {
        for (e, base) in waterParts {
            var m = base
            m.textureCoordinateTransform = .init(offset: ripple, scale: SIMD2(repeating: 1), rotation: 0)
            e.model?.materials = [m]
        }
    }

    // MARK: - textures

    private static let repeating: MaterialParameters.Texture.Sampler = {
        let d = MTLSamplerDescriptor()
        d.sAddressMode = .repeat
        d.tAddressMode = .repeat
        d.minFilter = .linear
        d.magFilter = .linear
        d.mipFilter = .linear
        d.maxAnisotropy = 8
        return MaterialParameters.Texture.Sampler(d)
    }()

    /// Crop rows: white with darker furrows (the tint gives the season's colour), one row across.
    private static func rowsTexture(furrow: Double) -> TextureResource? {
        let w = 64, h = 4
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        for x in 0..<w {
            let k = 0.5 + 0.5 * cos(Double(x) / Double(w) * 2 * .pi)
            let v = 1 - (1 - furrow) * smoothStep(0.5, 0.95, k)
            ctx.setFillColor(UIColor(white: CGFloat(v), alpha: 1).cgColor)
            ctx.fill(CGRect(x: x, y: 0, width: 1, height: h))
        }
        guard let img = ctx.makeImage() else { return nil }
        return try? TextureResource(image: img, options: .init(semantic: .color, mipmapsMode: .allocateAndGenerateAll))
    }

    /// Small ripples as a tiling normal map: a few waves whose sum repeats across the tile.
    private static func rippleTexture() -> TextureResource? {
        let n = 128
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue), let data = ctx.data else { return nil }
        let row = ctx.bytesPerRow
        let px = data.bindMemory(to: UInt8.self, capacity: row * n)
        // Waves with whole numbers of crests across the tile, so it repeats without a seam.
        let waves: [(Double, Double, Double, Double)] = [(1, 2, 0.0, 1), (3, -1, 1.7, 0.6), (-2, 5, 4.1, 0.35), (6, 3, 2.3, 0.22), (-7, -4, 5.2, 0.15)]
        for y in 0..<n {
            for x in 0..<n {
                let u = Double(x) / Double(n) * 2 * .pi, v = Double(y) / Double(n) * 2 * .pi
                var dx = 0.0, dy = 0.0
                for (kx, ky, phase, amp) in waves {
                    let c = cos(kx * u + ky * v + phase) * amp
                    dx += c * kx
                    dy += c * ky
                }
                let nrm = simd_normalize(SIMD3(-dx * 0.05, -dy * 0.05, 1))
                let i = y * row + x * 4
                px[i] = UInt8(max(0, min(255, (nrm.x * 0.5 + 0.5) * 255)))
                px[i + 1] = UInt8(max(0, min(255, (nrm.y * 0.5 + 0.5) * 255)))
                px[i + 2] = UInt8(max(0, min(255, (nrm.z * 0.5 + 0.5) * 255)))
                px[i + 3] = 255
            }
        }
        guard let img = ctx.makeImage() else { return nil }
        return try? TextureResource(image: img, options: .init(semantic: .normal, mipmapsMode: .allocateAndGenerateAll))
    }

    // MARK: - the slab the house stands on

    /// A thin foundation slab (5 cm) under each room, a little wider than its walls, in place of
    /// the plinth.
    static func slab(_ plan: Plan, into b: MeshBuilder) {
        let mat = Mat.c("#a8a49c", rough: 0.9)
        let top: Float = -0.004, bottom: Float = -0.05
        for room in plan.rooms {
            let pts = grow(room.points, by: Double(HouseBuilder.extT / 2 + 0.02))
            b.group(SIMD3(0, top, 0)) { b.add(Prim.floor(pts), mat) }
            var g = Geo()
            for i in pts.indices {
                let p = pts[i], q = pts[(i + 1) % pts.count]
                let a = SIMD3(Float(p.x), bottom, Float(p.y)), c = SIMD3(Float(q.x), bottom, Float(q.y))
                let out = simd_normalize(SIMD3(Float(q.y - p.y), 0, Float(p.x - q.x)))
                let base = UInt32(g.positions.count)
                g.positions += [a, c, c + SIMD3(0, top - bottom, 0), a + SIMD3(0, top - bottom, 0)]
                g.normals += [out, out, out, out]
                g.uvs += [[0, 0], [1, 0], [1, 1], [0, 1]]
                // Counter-clockwise seen from outside.
                let n = simd_cross(c - a, SIMD3<Float>(0, 1, 0))
                if simd_dot(n, out) > 0 { g.quad(base, base + 1, base + 2, base + 3) } else { g.quad(base, base + 3, base + 2, base + 1) }
            }
            b.add(g, mat)
        }
    }

    /// A polygon (counter-clockwise in Geom's sense) pushed out by `d`, its corners mitred.
    static func grow(_ pts: [P2], by d: Double) -> [P2] {
        let n = pts.count
        guard n >= 3 else { return pts }
        func normal(_ a: P2, _ b: P2) -> P2 {
            let v = b - a
            let len = max(1e-9, (v.x * v.x + v.y * v.y).squareRoot())
            return P2(v.y / len, -v.x / len)
        }
        return pts.indices.map { i in
            let prev = pts[(i + n - 1) % n], p = pts[i], next = pts[(i + 1) % n]
            let n1 = normal(prev, p), n2 = normal(p, next)
            var m = n1 + n2
            let len = (m.x * m.x + m.y * m.y).squareRoot()
            m = len > 1e-9 ? m / len : n1
            let k = min(3, 1 / max(0.2, m.x * n1.x + m.y * n1.y))
            return p + m * (d * k)
        }
    }
}
