import Foundation
import RealityKit
import simd
import UIKit

/// A material by value, so geometry that shares one can be merged into one mesh
/// (web/src/three/kit.js `mat`).
struct Mat: Hashable, Sendable {
    var color: String
    var rough: Float = 0.85
    var metal: Float = 0
    var emissive: String? = nil
    var emissiveIntensity: Float = 1
    var opacity: Float = 1
    var doubleSided = false
    var floor: String? = nil      // a procedural floor texture (oak, walnut, tile, stone)

    static func c(_ color: String, rough: Float = 0.85, metal: Float = 0) -> Mat { Mat(color: color, rough: rough, metal: metal) }
}

/// Triangles for one material, in world space.
struct MeshBatch {
    var positions: [SIMD3<Float>] = []
    var normals: [SIMD3<Float>] = []
    var uvs: [SIMD2<Float>] = []
    var indices: [UInt32] = []

    var isEmpty: Bool { indices.isEmpty }

    mutating func add(positions p: [SIMD3<Float>], normals n: [SIMD3<Float>], uvs t: [SIMD2<Float>]?, indices idx: [UInt32], transform m: simd_float4x4) {
        let base = UInt32(positions.count)
        let nm = simd_transpose(simd_inverse(simd_float3x3(columns: (SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z),
                                                                      SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
                                                                      SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z)))))
        positions.reserveCapacity(positions.count + p.count)
        for v in p {
            let w = m * SIMD4(v, 1)
            positions.append(SIMD3(w.x, w.y, w.z))
        }
        for v in n { normals.append(simd_normalize(nm * v)) }
        if let t { uvs += t } else { uvs += Array(repeating: .zero, count: p.count) }
        // A mirroring transform (negative scale) would turn the faces inside out.
        let flip = simd_determinant(m) < 0
        var i = 0
        while i + 2 < idx.count {
            if flip { indices += [base + idx[i], base + idx[i + 2], base + idx[i + 1]] }
            else { indices += [base + idx[i], base + idx[i + 1], base + idx[i + 2]] }
            i += 3
        }
    }

    @MainActor func resource() throws -> MeshResource {
        var d = MeshDescriptor(name: "batch")
        d.positions = MeshBuffers.Positions(positions)
        d.normals = MeshBuffers.Normals(normals)
        d.textureCoordinates = MeshBuffers.TextureCoordinates(uvs)
        d.primitives = .triangles(indices)
        return try MeshResource.generate(from: [d])
    }
}

/// Raw geometry of a primitive, around its own origin.
struct Geo {
    var positions: [SIMD3<Float>] = []
    var normals: [SIMD3<Float>] = []
    var uvs: [SIMD2<Float>] = []
    var indices: [UInt32] = []

    mutating func quad(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32) { indices += [a, b, c, a, c, d] }
}

/// Builds the static model: primitives placed through a stack of transforms, merged by material.
@MainActor
final class MeshBuilder {
    private(set) var batches: [Mat: MeshBatch] = [:]
    private var stack: [simd_float4x4] = [matrix_identity_float4x4]

    var current: simd_float4x4 { stack.last! }

    /// Draws `body` moved to `pos`, turned `rotY` radians about the vertical (then `rotX`, `rotZ`), scaled.
    func group(_ pos: SIMD3<Float> = .zero, rotY: Float = 0, rotX: Float = 0, rotZ: Float = 0, scale: SIMD3<Float> = .one, _ body: () -> Void) {
        stack.append(current * Xform.make(pos, rotY: rotY, rotX: rotX, rotZ: rotZ, scale: scale))
        body()
        stack.removeLast()
    }

    func add(_ g: Geo, _ mat: Mat) {
        batches[mat, default: MeshBatch()].add(positions: g.positions, normals: g.normals, uvs: g.uvs.isEmpty ? nil : g.uvs, indices: g.indices, transform: current)
    }

    // MARK: primitives, standing on y = 0 like web/src/three/kit.js

    func box(_ w: Float, _ h: Float, _ d: Float, _ mat: Mat, r: Float = 0.02, at p: SIMD3<Float> = .zero) {
        group(p) { add(Prim.box(w, h, d, r: r), mat) }
    }

    func cyl(_ rTop: Float, _ rBottom: Float, _ h: Float, _ mat: Mat, seg: Int = 28, at p: SIMD3<Float> = .zero) {
        group(p) { add(Prim.cylinder(rTop, rBottom, h, seg: seg), mat) }
    }

    /// A box whose six faces (+x, -x, +y, -y, +z, -z) can have their own materials, centred on `p`.
    func faces(_ size: SIMD3<Float>, _ mats: [Mat], at p: SIMD3<Float>, rotY: Float) {
        group(p, rotY: rotY) {
            for (i, g) in Prim.boxFaces(size).enumerated() { add(g, mats[min(i, mats.count - 1)]) }
        }
    }

    func entities() -> [ModelEntity] {
        var out: [ModelEntity] = []
        for (mat, batch) in batches where !batch.isEmpty {
            guard let mesh = try? batch.resource() else { continue }
            let e = ModelEntity(mesh: mesh, materials: [Materials.make(mat)])
            e.name = "static"
            out.append(e)
        }
        return out
    }

    /// One entity for everything drawn so far (a part whose material changes while running).
    func entity(named name: String) -> ModelEntity? {
        let all = batches.filter { !$0.value.isEmpty }
        guard let first = all.first, let mesh = try? first.value.resource() else { return nil }
        let e = ModelEntity(mesh: mesh, materials: [Materials.make(first.key)])
        e.name = name
        return e
    }
}

enum Xform {
    static func make(_ pos: SIMD3<Float>, rotY: Float = 0, rotX: Float = 0, rotZ: Float = 0, scale: SIMD3<Float> = .one) -> simd_float4x4 {
        var q = simd_quatf(angle: rotY, axis: [0, 1, 0])
        if rotX != 0 { q = q * simd_quatf(angle: rotX, axis: [1, 0, 0]) }
        if rotZ != 0 { q = q * simd_quatf(angle: rotZ, axis: [0, 0, 1]) }
        var m = simd_float4x4(q)
        m.columns.0 *= scale.x
        m.columns.1 *= scale.y
        m.columns.2 *= scale.z
        m.columns.3 = SIMD4(pos, 1)
        return m
    }
}

/// Primitive geometry, counter-clockwise seen from outside.
enum Prim {
    /// A box from y = 0 to h, centred on x/z, its edges rounded by `r` (a plain box when tiny).
    static func box(_ w: Float, _ h: Float, _ d: Float, r rIn: Float = 0.02) -> Geo {
        let r = max(0, min(rIn, min(w, h, d) / 2 - 0.001))
        if r <= 0.003 {
            var g = Geo()
            for f in boxFaces(SIMD3(w, h, d)) {
                let base = UInt32(g.positions.count)
                g.positions += f.positions.map { $0 + SIMD3(0, h / 2, 0) }
                g.normals += f.normals
                g.uvs += f.uvs
                g.indices += f.indices.map { $0 + base }
            }
            return g
        }
        // Each face is a grid; every grid point is pulled onto the rounded surface.
        let half = SIMD3(w / 2, h / 2, d / 2)
        let seg = 3
        func samples(_ hlf: Float) -> [Float] {
            var s: [Float] = []
            for i in 0...seg { s.append(-(hlf - r) - r * cos(Float.pi / 2 * Float(i) / Float(seg))) }
            for i in 0...seg { s.append((hlf - r) + r * sin(Float.pi / 2 * Float(i) / Float(seg))) }
            return s
        }
        let sx = samples(half.x), sy = samples(half.y), sz = samples(half.z)
        var g = Geo()
        // (fixed axis, sign, u axis, v axis) with u × v pointing outward.
        let faces: [(Int, Float, Int, Int)] = [(0, 1, 1, 2), (0, -1, 2, 1), (1, 1, 2, 0), (1, -1, 0, 2), (2, 1, 0, 1), (2, -1, 1, 0)]
        let axisSamples = [sx, sy, sz]
        for (axis, sign, ua, va) in faces {
            let us = axisSamples[ua], vs = axisSamples[va]
            let base = UInt32(g.positions.count)
            for v in vs {
                for u in us {
                    var p = SIMD3<Float>(repeating: 0)
                    p[axis] = sign * half[axis]
                    p[ua] = u
                    p[va] = v
                    let inner = simd_clamp(p, -(half - r), half - r)
                    var n = p - inner
                    let len = simd_length(n)
                    n = len > 1e-6 ? n / len : { var z = SIMD3<Float>(repeating: 0); z[axis] = sign; return z }()
                    let pos = inner + n * r
                    g.positions.append(pos + SIMD3(0, h / 2, 0))
                    g.normals.append(n)
                    g.uvs.append(SIMD2((u + half[ua]) / (2 * half[ua]), (v + half[va]) / (2 * half[va])))
                }
            }
            let nu = UInt32(us.count), nv = UInt32(vs.count)
            for j in 0..<(nv - 1) {
                for i in 0..<(nu - 1) {
                    let a = base + j * nu + i, b = a + 1, c = a + nu + 1, dd = a + nu
                    g.quad(a, b, c, dd)
                }
            }
        }
        return g
    }

    /// The six faces of a plain box centred on the origin, in three.js order (+x, -x, +y, -y, +z, -z).
    static func boxFaces(_ s: SIMD3<Float>) -> [Geo] {
        let h = s / 2
        let specs: [(SIMD3<Float>, SIMD3<Float>, SIMD3<Float>)] = [
            ([1, 0, 0], [0, 0, -1], [0, 1, 0]), ([-1, 0, 0], [0, 0, 1], [0, 1, 0]),
            ([0, 1, 0], [1, 0, 0], [0, 0, -1]), ([0, -1, 0], [1, 0, 0], [0, 0, 1]),
            ([0, 0, 1], [1, 0, 0], [0, 1, 0]), ([0, 0, -1], [-1, 0, 0], [0, 1, 0]),
        ]
        return specs.map { n, u, v in
            let c = n * h
            let uh = u * h, vh = v * h
            var g = Geo()
            g.positions = [c - uh - vh, c + uh - vh, c + uh + vh, c - uh + vh]
            g.normals = Array(repeating: n, count: 4)
            g.uvs = [[0, 0], [1, 0], [1, 1], [0, 1]]
            g.indices = [0, 1, 2, 0, 2, 3]
            return g
        }
    }

    /// A (possibly tapered) cylinder from y = 0 to h, with caps.
    static func cylinder(_ rTop: Float, _ rBottom: Float, _ h: Float, seg: Int = 28, caps: Bool = true) -> Geo {
        var g = Geo()
        let slope = (rBottom - rTop) / max(h, 1e-5)
        for i in 0...seg {
            let a = Float(i) / Float(seg) * 2 * .pi
            let (c, s) = (cos(a), sin(a))
            let n = simd_normalize(SIMD3(s, slope, c))
            g.positions += [SIMD3(rBottom * s, 0, rBottom * c), SIMD3(rTop * s, h, rTop * c)]
            g.normals += [n, n]
            g.uvs += [SIMD2(Float(i) / Float(seg), 0), SIMD2(Float(i) / Float(seg), 1)]
        }
        for i in 0..<seg {
            let a = UInt32(i * 2)
            g.indices += [a, a + 2, a + 3, a, a + 3, a + 1]
        }
        guard caps else { return g }
        for (y, r, up) in [(h, rTop, true), (Float(0), rBottom, false)] where r > 0 {
            let center = UInt32(g.positions.count)
            let n = SIMD3<Float>(0, up ? 1 : -1, 0)
            g.positions.append(SIMD3(0, y, 0)); g.normals.append(n); g.uvs.append([0.5, 0.5])
            for i in 0...seg {
                let a = Float(i) / Float(seg) * 2 * .pi
                g.positions.append(SIMD3(r * sin(a), y, r * cos(a)))
                g.normals.append(n)
                g.uvs.append(SIMD2(0.5 + 0.5 * sin(a), 0.5 + 0.5 * cos(a)))
            }
            for i in 0..<UInt32(seg) {
                if up { g.indices += [center, center + 1 + i, center + 2 + i] }
                else { g.indices += [center, center + 2 + i, center + 1 + i] }
            }
        }
        return g
    }

    /// A UV sphere (or part of one: `thetaLength` < π leaves the bottom open).
    static func sphere(_ r: Float, wSeg: Int = 32, hSeg: Int = 20, thetaLength: Float = .pi) -> Geo {
        var g = Geo()
        for j in 0...hSeg {
            let t = Float(j) / Float(hSeg) * thetaLength
            for i in 0...wSeg {
                let p = Float(i) / Float(wSeg) * 2 * .pi
                let n = SIMD3(-cos(p) * sin(t), cos(t), sin(p) * sin(t))
                g.positions.append(n * r)
                g.normals.append(n)
                g.uvs.append(SIMD2(Float(i) / Float(wSeg), 1 - Float(j) / Float(hSeg)))
            }
        }
        let row = UInt32(wSeg + 1)
        for j in 0..<UInt32(hSeg) {
            for i in 0..<UInt32(wSeg) {
                let a = j * row + i, b = a + row
                g.indices += [a, b, a + 1, a + 1, b, b + 1]
            }
        }
        return g
    }

    /// A ring lying in the x/y plane (turn it to lie flat).
    static func torus(_ radius: Float, _ tube: Float, radial: Int = 6, tubular: Int = 28) -> Geo {
        var g = Geo()
        for j in 0...radial {
            for i in 0...tubular {
                let u = Float(i) / Float(tubular) * 2 * .pi
                let v = Float(j) / Float(radial) * 2 * .pi
                let center = SIMD3(radius * cos(u), radius * sin(u), 0)
                let p = SIMD3((radius + tube * cos(v)) * cos(u), (radius + tube * cos(v)) * sin(u), tube * sin(v))
                g.positions.append(p)
                g.normals.append(simd_normalize(p - center))
                g.uvs.append(SIMD2(Float(i) / Float(tubular), Float(j) / Float(radial)))
            }
        }
        let row = UInt32(tubular + 1)
        for j in 1...UInt32(radial) {
            for i in 1...UInt32(tubular) {
                let a = row * j + i - 1, b = row * (j - 1) + i - 1, c = row * (j - 1) + i, d = row * j + i
                g.indices += [a, b, d, b, c, d]
            }
        }
        return g
    }

    /// A flat polygon on y = 0 facing up, its UVs in world metres / `tile`.
    static func floor(_ pts: [P2], tile: Float = 2.4) -> Geo {
        var g = Geo()
        for p in pts {
            g.positions.append(SIMD3(Float(p.x), 0, Float(p.y)))
            g.normals.append([0, 1, 0])
            g.uvs.append(SIMD2(Float(p.x) / tile, Float(p.y) / tile))
        }
        // Seen from above (+y), x east and z south turn the other way round to a rect's corners.
        let tri = Geom.triangulate(pts)
        var i = 0
        while i + 2 < tri.count {
            let a = pts[tri[i]], b = pts[tri[i + 1]], c = pts[tri[i + 2]]
            let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
            // Counter-clockwise seen from +y means clockwise in x/z (z points toward the viewer's bottom).
            if cross < 0 { g.indices += [UInt32(tri[i]), UInt32(tri[i + 1]), UInt32(tri[i + 2])] }
            else { g.indices += [UInt32(tri[i]), UInt32(tri[i + 2]), UInt32(tri[i + 1])] }
            i += 3
        }
        return g
    }

    /// Normals from the faces (for deformed shapes).
    static func smoothNormals(_ g: inout Geo) {
        var acc = Array(repeating: SIMD3<Float>(repeating: 0), count: g.positions.count)
        var i = 0
        while i + 2 < g.indices.count {
            let a = Int(g.indices[i]), b = Int(g.indices[i + 1]), c = Int(g.indices[i + 2])
            let n = simd_cross(g.positions[b] - g.positions[a], g.positions[c] - g.positions[a])
            acc[a] += n; acc[b] += n; acc[c] += n
            i += 3
        }
        g.normals = acc.map { simd_length($0) > 1e-9 ? simd_normalize($0) : [0, 1, 0] }
    }
}
