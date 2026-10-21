import Foundation
import RealityKit
import simd

/// Floors, walls, windows, doors and curtains from the plan's rooms and openings, ported from
/// web/src/three/house.js. The walls on the camera's side are cut down to a curb so the rooms
/// can be seen into; interior walls stand at `interiorWallHeight`.
@MainActor
enum HouseBuilder {
    static let extT: Float = 0.2
    static let intT: Float = 0.1
    static let curb: Float = 0.14
    static let doorOpen: Float = 30 * .pi / 180

    static let wallBody = Mat.c("#e7e3db", rough: 0.95)
    static let wallCap = Mat.c("#262b3a", rough: 0.8)
    static let glass = Mat(color: "#9cc0ff", rough: 0.08, emissive: "#3d5fae", emissiveIntensity: 0.5, opacity: 0.22)
    static let frame = Mat.c("#2c3142", rough: 0.6)
    static let door = Mat.c("#d8d0c2", rough: 0.7)
    static let handle = Mat.c("#9a9fa8", rough: 0.3, metal: 0.8)
    static let rod = Mat.c("#c9ccd2", rough: 0.3, metal: 0.8)
    static let cloth = Mat(color: "#e9eef4", rough: 0.9, opacity: 0.62, doubleSided: true)

    /// `camDir`: from the home toward the camera, flat (x, z).
    static func build(_ plan: Plan, camDir: P2, into b: MeshBuilder) {
        let H = Float(plan.wallHeight)
        let Hi = min(Float(plan.interiorWallHeight), H)

        // Rooms may overlap (a bathroom drawn inside the studio): the smaller floor lies a hair higher.
        let bySize = plan.rooms.sorted { $0.area > $1.area }
        for room in plan.rooms {
            let layer = Float(bySize.firstIndex(of: room) ?? 0)
            b.group(SIMD3(0, layer * 0.003, 0)) {
                b.add(Prim.floor(room.points), Mat(color: "#ffffff", rough: 0.75, floor: room.floor))
            }
        }

        let segs = Walls.segments(rooms: plan.rooms, openings: plan.openings)
        var drawn: [Int: Float] = [:]

        func piece(_ s: WallSegment, _ a: Float, _ bb: Float, _ y0: Float, _ y1: Float, _ t: Float, _ mats: [Mat]) {
            let mid = Double((a + bb) / 2)
            let c = s.from + s.dir * mid
            b.faces(SIMD3(bb - a, y1 - y0, t), mats, at: SIMD3(Float(c.x), (y0 + y1) / 2, Float(c.y)), rotY: Float(atan2(-s.dir.y, s.dir.x)))
        }
        let wallMats = [wallBody, wallBody, wallCap, wallBody, wallBody, wallBody]

        for (i, s) in segs.enumerated() {
            let ext = s.exterior
            let t = ext ? extT : intT
            let near = ext && (s.normal.x * camDir.x + s.normal.y * camDir.y) > 0.15
            let a: Float = s.extA ? -extT / 2 : 0
            let bb: Float = Float(s.len) + (s.extB ? extT / 2 : 0)
            let type = s.opening?.type
            let height = ext ? H : Hi

            if type == "door" {
                if !near { doorLeaf(s, height: min(Float(s.opening?.head ?? 2.1), height), plan: plan, b: b) }
                continue
            }
            if near {
                piece(s, a, bb, 0, curb, t, wallMats)
                drawn[i] = curb
                continue
            }
            if type == "open" {
                if s.opening?.curtain == true { curtain(s, height: min(Float(s.opening?.head ?? 2.1), height), b: b) }
                continue
            }
            if type == "window" && ext, let o = s.opening {
                let sill = Float(o.sill), head = Float(o.head)
                piece(s, a, bb, 0, sill, t, wallMats)
                piece(s, a, bb, min(head, H), H, t, wallMats)
                piece(s, a, bb, sill, head, 0.03, [glass])
                let fw: Float = 0.05
                var bars: [(Float, Float, Float, Float)] = [(a, a + fw, sill, head), (bb - fw, bb, sill, head), (a, bb, sill, sill + fw), (a, bb, head - fw, head)]
                if bb - a > 1.2 { bars.append(((a + bb) / 2 - fw / 2, (a + bb) / 2 + fw / 2, sill, head)) }
                for (fa, fb, y0, y1) in bars { piece(s, fa, fb, y0, y1, 0.07, [frame]) }
                drawn[i] = H
                continue
            }
            if type == "window" { continue }
            piece(s, a, bb, 0, height, t, wallMats)
            drawn[i] = height
        }

        // Where walls meet at an angle, a column as thick as the thicker wall closes the joint.
        for j in Walls.joints(segs) {
            let heights = j.segs.compactMap { drawn[$0] }
            guard let top = heights.max() else { continue }
            let t = j.segs.contains { segs[$0].exterior && drawn[$0] != nil } ? extT : intT
            b.group(SIMD3(Float(j.p.x), 0, Float(j.p.y))) {
                b.add(Prim.cylinder(t / 2, t / 2, top, seg: 20, caps: false), wallBody)
                b.group(SIMD3(0, top - 0.002, 0)) { b.add(Prim.cylinder(t / 2, t / 2, 0.002, seg: 20), wallCap) }
            }
        }
    }

    private static func along(_ s: WallSegment, _ p: P2) -> Double {
        (p.x - s.from.x) * s.dir.x + (p.y - s.from.y) * s.dir.y
    }

    /// A door leaf on its hinge, standing open toward the room it opens into.
    private static func doorLeaf(_ s: WallSegment, height: Float, plan: Plan, b: MeshBuilder) {
        guard let o = s.opening else { return }
        let side = Walls.doorSide(s, rooms: plan.rooms)
        let hingeAtTo = o.hinge == "to" ? along(s, o.to) > s.len / 2 : along(s, o.from) > s.len / 2
        let hinge = hingeAtTo ? s.to : s.from
        let closed = hingeAtTo ? -s.dir : s.dir
        let n = s.normal * side
        let k = Double(doorOpen)
        let d = P2(closed.x * cos(k) + n.x * sin(k), closed.y * cos(k) + n.y * sin(k))
        let w = Float(s.len) - 0.03
        b.group(SIMD3(Float(hinge.x + n.x * 0.02), 0, Float(hinge.y + n.y * 0.02)), rotY: Float(atan2(-d.y, d.x))) {
            b.box(w, height - 0.02, 0.04, door, r: 0.01, at: SIMD3(w / 2, 0.01, 0))
            if height > 0.9 {
                for z: Float in [-0.035, 0.035] { b.cyl(0.022, 0.022, 0.02, handle, seg: 12, at: SIMD3(w - 0.08, 0.95, z)) }
            }
        }
    }

    /// A shower or closet curtain: a rod across the opening, the cloth gathered at its `from` end.
    private static func curtain(_ s: WallSegment, height: Float, b: MeshBuilder) {
        guard let o = s.opening else { return }
        let rodY = height - 0.06
        let rotY = Float(atan2(-s.dir.y, s.dir.x))
        let len = Float(s.len)
        let mid = s.from + s.dir * Double(len / 2)
        b.faces(SIMD3(len - 0.04, 0.024, 0.024), [rod], at: SIMD3(Float(mid.x), rodY, Float(mid.y)), rotY: rotY)
        let atFrom = along(s, o.from) < s.len / 2
        let span = min(0.45, len * 0.35)
        let folds = 7
        for i in 0..<folds {
            let t = span / Float(folds) * (Float(i) + 0.5)
            let pos = atFrom ? 0.04 + t : len - 0.04 - t
            let off: Float = (i % 2 == 1 ? 1 : -1) * 0.025
            let p = s.from + s.dir * Double(pos) + s.normal * Double(off)
            b.faces(SIMD3(span / Float(folds) * 1.25, rodY - 0.12, 0.012), [cloth],
                    at: SIMD3(Float(p.x), 0.1 + (rodY - 0.12) / 2, Float(p.y)), rotY: rotY + (i % 2 == 1 ? 0.5 : -0.5))
        }
    }
}
