import Foundation

/// Plane geometry of the floor plan, ported from web/src/geom.js and the wall builder of
/// web/src/three/house.js. Points are [x, z] in metres seen from above: x east, z south.
typealias P2 = SIMD2<Double>

enum Geom {
    static let tol = 1e-3

    static func signed(_ pts: [P2]) -> Double {
        var s = 0.0
        for i in pts.indices {
            let a = pts[i], b = pts[(i + 1) % pts.count]
            s += a.x * b.y - b.x * a.y
        }
        return s
    }

    static func area(_ pts: [P2]) -> Double { abs(signed(pts)) / 2 }

    /// The corners turning the same way as a rect's, so an edge's room is always on its right.
    static func oriented(_ pts: [P2]) -> [P2] { signed(pts) < 0 ? pts.reversed() : pts }

    static func segDist(_ p: P2, _ a: P2, _ b: P2) -> Double {
        let d = b - a
        let len = d.x * d.x + d.y * d.y
        let t = len > 0 ? max(0, min(1, ((p.x - a.x) * d.x + (p.y - a.y) * d.y) / len)) : 0
        let q = a + d * t
        return hypot(p.x - q.x, p.y - q.y)
    }

    static func edgeDist(_ pts: [P2], _ p: P2) -> Double {
        var best = Double.infinity
        for i in pts.indices { best = min(best, segDist(p, pts[i], pts[(i + 1) % pts.count])) }
        return best
    }

    /// Strictly inside (even-odd rule).
    static func inPolygon(_ pts: [P2], _ p: P2) -> Bool {
        var inside = false
        var j = pts.count - 1
        for i in pts.indices {
            let a = pts[i], b = pts[j]
            if (a.y > p.y) != (b.y > p.y), p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x { inside.toggle() }
            j = i
        }
        return inside
    }

    static func contains(_ pts: [P2], _ p: P2, pad: Double = tol) -> Bool {
        inPolygon(pts, p) || edgeDist(pts, p) <= pad
    }

    struct Line { var dir: P2; var n: P2; var c: Double }

    static func lineOf(_ a: P2, _ b: P2) -> Line {
        var u = b - a
        let len = max(1e-12, hypot(u.x, u.y))
        u /= len
        if u.x < -1e-9 || (abs(u.x) <= 1e-9 && u.y < 0) { u = -u }
        let n = P2(-u.y, u.x)
        return Line(dir: u, n: n, c: n.x * a.x + n.y * a.y)
    }

    static func lineDist(_ l: Line, _ p: P2) -> Double { abs(l.n.x * p.x + l.n.y * p.y - l.c) }
    static func along(_ l: Line, _ p: P2) -> Double { l.dir.x * p.x + l.dir.y * p.y }
    static func pointAt(_ l: Line, _ t: Double) -> P2 { P2(l.dir.x * t + l.n.x * l.c, l.dir.y * t + l.n.y * l.c) }

    /// Ear-clipping triangulation of a simple polygon; returns index triples.
    static func triangulate(_ pts: [P2]) -> [Int] {
        var idx = Array(pts.indices)
        if signed(pts) < 0 { idx.reverse() }
        var out: [Int] = []
        var guardCount = 0
        while idx.count > 3, guardCount < 10_000 {
            guardCount += 1
            var clipped = false
            for i in idx.indices {
                let ia = idx[(i + idx.count - 1) % idx.count], ib = idx[i], ic = idx[(i + 1) % idx.count]
                let a = pts[ia], b = pts[ib], c = pts[ic]
                let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
                if cross <= 1e-12 { continue }
                var empty = true
                for j in idx where j != ia && j != ib && j != ic {
                    if pointInTriangle(pts[j], a, b, c) { empty = false; break }
                }
                if !empty { continue }
                out += [ia, ib, ic]
                idx.remove(at: i)
                clipped = true
                break
            }
            if !clipped { break }
        }
        if idx.count == 3 { out += idx }
        return out
    }

    private static func pointInTriangle(_ p: P2, _ a: P2, _ b: P2, _ c: P2) -> Bool {
        func s(_ p1: P2, _ p2: P2, _ p3: P2) -> Double { (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y) }
        let d1 = s(p, a, b), d2 = s(p, b, c), d3 = s(p, c, a)
        let neg = d1 < 0 || d2 < 0 || d3 < 0
        let pos = d1 > 0 || d2 > 0 || d3 > 0
        return !(neg && pos)
    }
}

/// One stretch of wall between two rooms (interior) or a room and the outside (exterior).
struct WallSegment {
    var from: P2
    var to: P2
    var dir: P2
    var normal: P2        // outward
    var len: Double
    var exterior: Bool
    var opening: Opening?
    var freeA = false, freeB = false
    var extA = false, extB = false
    var jointA = false, jointB = false
    fileprivate var lineIndex = 0
    fileprivate var ta = 0.0, tb = 0.0
    fileprivate var inside = 1
    fileprivate var out = 1
}

enum Walls {
    private struct LineGroup {
        var line: Geom.Line
        var edges: [(a: Double, b: Double, inside: Int)] = []
        var openings: [(o: Opening, a: Double, b: Double)] = []
    }

    /// Splits every room edge into wall segments (see wallSegments in web/src/three/house.js).
    static func segments(rooms: [Room], openings: [Opening]) -> [WallSegment] {
        let polys = rooms.map { Geom.oriented($0.points) }
        var lines: [LineGroup] = []
        func lineFor(_ a: P2, _ b: P2) -> Int {
            if let i = lines.firstIndex(where: { Geom.lineDist($0.line, a) < Geom.tol && Geom.lineDist($0.line, b) < Geom.tol }) { return i }
            lines.append(LineGroup(line: Geom.lineOf(a, b)))
            return lines.count - 1
        }
        for pts in polys {
            for i in pts.indices {
                let a = pts[i], b = pts[(i + 1) % pts.count]
                let li = lineFor(a, b)
                let ta = Geom.along(lines[li].line, a), tb = Geom.along(lines[li].line, b)
                lines[li].edges.append((min(ta, tb), max(ta, tb), ta < tb ? 1 : -1))
            }
        }
        for o in openings {
            var best: (Int, Double)?
            for (i, l) in lines.enumerated() {
                let d = max(Geom.lineDist(l.line, o.from), Geom.lineDist(l.line, o.to))
                if d <= 0.01, best == nil || d < best!.1 { best = (i, d) }
            }
            guard let (li, _) = best else { continue }
            let p0 = Geom.along(lines[li].line, o.from), p1 = Geom.along(lines[li].line, o.to)
            if abs(p0 - p1) < 0.01 { continue }
            lines[li].openings.append((o, min(p0, p1), max(p0, p1)))
        }

        var segments: [WallSegment] = []
        for (li, l) in lines.enumerated() {
            var keys = Set<Int>()
            for e in l.edges { keys.insert(Int((e.a * 1000).rounded())); keys.insert(Int((e.b * 1000).rounded())) }
            for o in l.openings { keys.insert(Int((o.a * 1000).rounded())); keys.insert(Int((o.b * 1000).rounded())) }
            let pts = keys.sorted().map { Double($0) / 1000 }
            var run: [WallSegment] = []
            if pts.count < 2 { continue }
            for i in 0..<(pts.count - 1) {
                let mid = (pts[i] + pts[i + 1]) / 2
                let covering = l.edges.filter { $0.a < mid && mid < $0.b }
                guard let first = covering.first else { continue }
                let m = Geom.pointAt(l.line, mid)
                func side(_ d: Double) -> Bool { polys.contains { Geom.inPolygon($0, P2(m.x + l.line.n.x * d, m.y + l.line.n.y * d)) } }
                let plus = side(0.05), minus = side(-0.05)
                let opening = l.openings.first { $0.a < mid && mid < $0.b }
                var seg = WallSegment(from: .zero, to: .zero, dir: l.line.dir, normal: .zero, len: 0,
                                      exterior: !(plus && minus), opening: opening?.o)
                seg.lineIndex = li
                seg.ta = pts[i]; seg.tb = pts[i + 1]
                seg.inside = first.inside
                seg.out = plus && !minus ? -1 : (minus && !plus ? 1 : -first.inside)
                if var prev = run.last, abs(prev.tb - seg.ta) < 1e-4, prev.exterior == seg.exterior, prev.inside == seg.inside,
                   prev.out == seg.out, prev.opening == seg.opening {
                    prev.tb = seg.tb
                    run[run.count - 1] = prev
                } else {
                    run.append(seg)
                }
            }
            for i in run.indices {
                run[i].freeA = !(i > 0 && abs(run[i - 1].tb - run[i].ta) < 1e-4)
                run[i].freeB = !(i + 1 < run.count && abs(run[i + 1].ta - run[i].tb) < 1e-4)
            }
            segments += run
        }
        func tidy(_ p: P2) -> P2 { P2((p.x * 1e6).rounded() / 1e6, (p.y * 1e6).rounded() / 1e6) }
        for i in segments.indices {
            let l = lines[segments[i].lineIndex].line
            segments[i].from = tidy(Geom.pointAt(l, segments[i].ta))
            segments[i].to = tidy(Geom.pointAt(l, segments[i].tb))
            segments[i].normal = l.n * Double(segments[i].out)
            segments[i].len = segments[i].tb - segments[i].ta
        }
        let snapshot = segments
        for i in segments.indices {
            for end in 0..<2 {
                let free = end == 0 ? segments[i].freeA : segments[i].freeB
                guard free else { continue }
                let p = end == 0 ? segments[i].from : segments[i].to
                let others = snapshot.enumerated().filter { $0.element.lineIndex != segments[i].lineIndex && Geom.segDist(p, $0.element.from, $0.element.to) < Geom.tol }.map(\.element)
                let d = segments[i].dir
                let square = others.contains { abs($0.dir.x * d.x + $0.dir.y * d.y) < 1e-3 }
                let joint = others.contains { abs($0.dir.x * d.x + $0.dir.y * d.y) >= 1e-3 }
                if end == 0 { segments[i].extA = square || others.isEmpty; segments[i].jointA = joint }
                else { segments[i].extB = square || others.isEmpty; segments[i].jointB = joint }
            }
        }
        return segments
    }

    /// Corners where walls meet at an angle other than 90°, with the indices of the segments there.
    static func joints(_ segs: [WallSegment]) -> [(p: P2, segs: [Int])] {
        var joints: [(p: P2, segs: [Int])] = []
        for (i, s) in segs.enumerated() {
            for (flag, p) in [(s.jointA, s.from), (s.jointB, s.to)] where flag {
                if let j = joints.firstIndex(where: { hypot($0.p.x - p.x, $0.p.y - p.y) < Geom.tol }) {
                    joints[j].segs.append(i)
                } else {
                    joints.append((p, [i]))
                }
            }
        }
        for j in joints.indices {
            for (i, s) in segs.enumerated() where !joints[j].segs.contains(i) && Geom.segDist(joints[j].p, s.from, s.to) < Geom.tol {
                joints[j].segs.append(i)
            }
        }
        return joints
    }

    /// Which side of a door's wall its leaf opens to: +1 along the normal, -1 against.
    static func doorSide(_ s: WallSegment, rooms: [Room]) -> Double {
        let mid = (s.from + s.to) / 2
        func roomOn(_ sign: Double) -> Room? {
            let p = mid + s.normal * (sign * 0.15)
            return rooms.filter { Geom.inPolygon($0.points, p) }.min { $0.area < $1.area }
        }
        let sides: [(sign: Double, room: Room?)] = [(1, roomOn(1)), (-1, roomOn(-1))]
        if s.opening?.swing == "out" { return sides.first { $0.room == nil }?.sign ?? 1 }
        if let swing = s.opening?.swing, let named = sides.first(where: { $0.room?.id == swing }) { return named.sign }
        let withRoom = sides.filter { $0.room != nil }.sorted { $0.room!.area < $1.room!.area }
        return withRoom.first?.sign ?? -1
    }
}
