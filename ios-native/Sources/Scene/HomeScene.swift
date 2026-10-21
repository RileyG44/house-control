import CoreGraphics
import Foundation
import RealityKit
import SwiftUI
import UIKit
import simd

/// The 3D home: built once per plan from the plan (no mesh files), its lamps, AC and TV following
/// the live state every frame, and the camera rig of web/src/three/world.js (orbit, pinch, the
/// focus on a room or the AC, the close-up in front of the TV).
@MainActor
final class HomeScene {
    let root = Entity()
    let camera = PerspectiveCamera()
    private(set) var plan: Plan
    private let ibl = Entity()
    private var plinth: ModelEntity?
    private let moon = Entity()
    private(set) var lamps: [String: LampUnit] = [:]
    private(set) var acUnits: [String: ACUnit] = [:]
    private(set) var tvUnits: [TVUnit] = []
    private var darkEnv: EnvironmentResource?
    private var lightEnv: EnvironmentResource?
    var subscription: EventSubscription?

    // MARK: camera rig

    static let fov: Float = 24
    static let near: Float = 0.5
    static let tvDist: Float = 0.9
    static let tvAround: SIMD2<Float> = [1.32, 1.75]
    static let tvClear: Float = 0.36
    static let orbitAz: Float = 40
    static let elMin: Float = 26, elMax: Float = 70
    static let zoomMin: Float = 0.55, zoomMax: Float = 1.2

    struct Rig {
        var az: Float, el: Float, dist: Float, target: SIMD3<Float>, fov: Float
    }
    enum Focus: Equatable { case home, room(String), ac(String), tv(String) }

    private(set) var rig: Rig
    private(set) var goal: Rig
    var zoom: Float = 1
    private(set) var focus: Focus = .home
    /// What the goal frames (world points), for the small view over the pulled-up card.
    private(set) var corners: [SIMD3<Float>] = []
    private var tween: (from: Rig, t0: Double, dur: Double)?
    private let baseAz: Float
    private let camDir: P2

    /// The screen, and the parts of it the model keeps clear of at rest (status bar, the card).
    var size = CGSize(width: 430, height: 932)
    var topInset: CGFloat = 63
    var bottomInset: CGFloat = 500
    /// 0 … 1: how far the camera is into the TV's close-up (eased with the fly-in).
    private(set) var tvWeight: Float = 0

    /// 0 dark … 1 light, eased toward `lookGoal` over 0.3 s.
    private var look: Float = 0
    var lookGoal: Float = 0

    weak var store: HomeStore?

    init(plan: Plan, store: HomeStore, light: Bool) {
        self.plan = plan
        self.store = store
        baseAz = Float(plan.azimuth)
        let a = Double(plan.azimuth) * .pi / 180
        camDir = P2(sin(a), cos(a))
        let center = SIMD3(Float(plan.center.x), 0, Float(plan.center.y))
        rig = Rig(az: baseAz, el: Float(plan.elevation), dist: 30, target: center, fov: Self.fov)
        goal = rig
        look = light ? 1 : 0
        lookGoal = look
        build()
    }

    // MARK: - building

    private func build() {
        root.addChild(ibl)
        darkEnv = Self.environment(sky: RGB(hex: "#8ea6ff"), ground: RGB(hex: "#0b0e17"))
        lightEnv = Self.environment(sky: RGB(hex: "#fff4e6"), ground: RGB(hex: "#a89a86"))

        let b = MeshBuilder()
        HouseBuilder.build(plan, camDir: camDir, into: b)
        let screens = FurnitureBuilder.build(plan.furniture, into: b)
        for e in b.entities() {
            e.components.set(ImageBasedLightReceiverComponent(imageBasedLight: ibl))
            root.addChild(e)
        }

        // The plinth the model stands on: its colour follows the look.
        let p = MeshBuilder()
        let (minX, minZ, maxX, maxZ) = (Float(plan.minX), Float(plan.minZ), Float(plan.maxX), Float(plan.maxZ))
        p.box(maxX - minX + 0.7, 0.3, maxZ - minZ + 0.7, .c("#141927", rough: 0.9), r: 0.12, at: SIMD3((minX + maxX) / 2, -0.305, (minZ + maxZ) / 2))
        if let e = p.entity(named: "plinth") {
            e.components.set(ImageBasedLightReceiverComponent(imageBasedLight: ibl))
            root.addChild(e)
            plinth = e
        }

        let H = Float(plan.wallHeight)
        // RealityKit lights the scene with at most eight lights: the moon, then the lamps, the AC and the TV.
        var budget = 7
        for cfg in plan.lights {
            let u = LampUnit(cfg, wallHeight: H, ibl: ibl)
            u.hasLight = budget > 0
            if budget > 0 { budget -= 1 } else { stripLights(u.root) }
            lamps[cfg.id] = u
            root.addChild(u.root)
        }
        for cfg in plan.acs {
            let u = ACUnit(cfg, ibl: ibl)
            u.hasLight = budget > 0
            if budget > 0 { budget -= 1 } else { stripLights(u.root) }
            acUnits[cfg.id] = u
            root.addChild(u.root)
        }
        for s in screens {
            let u = TVUnit(s)
            u.hasLight = budget > 0
            if budget > 0 { budget -= 1 } else { stripLights(u.root) }
            tvUnits.append(u)
            root.addChild(u.root)
            root.addChild(u.hitTarget)
        }

        // Moonlight (or sun), steep and from the viewer's side so the faces we see stay readable.
        let center = SIMD3(Float(plan.center.x), 0, Float(plan.center.y))
        let span = Float(max(plan.maxX - plan.minX, plan.maxZ - plan.minZ))
        var dl = DirectionalLightComponent(color: .white, intensity: 1000)
        dl.isRealWorldProxy = false
        moon.components.set(dl)
        moon.components.set(DirectionalLightComponent.Shadow(maximumDistance: span * 3, depthBias: 1.5))
        let from = center + SIMD3(Float(camDir.x) * 3.2 + 1.5, 10, Float(camDir.y) * 3.2 - 1.5)
        moon.look(at: center, from: from, relativeTo: nil)
        root.addChild(moon)

        camera.camera.near = Self.near
        camera.camera.far = 120
        camera.camera.fieldOfViewInDegrees = Self.fov
        root.addChild(camera)

        applyLook()
        frameGoal()
        rig = goal
        placeCamera()
    }

    private func stripLights(_ e: Entity) {
        e.components.remove(PointLightComponent.self)
        e.components.remove(SpotLightComponent.self)
        for c in e.children { stripLights(c) }
    }

    /// A sky-over-ground environment for the image-based light (the web's hemisphere light).
    static func environment(sky: RGB, ground: RGB) -> EnvironmentResource? {
        let w = 128, h = 64
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let colors = [UIColor(rgb: sky).cgColor, UIColor(rgb: sky.lerp(ground, 0.5)).cgColor, UIColor(rgb: ground).cgColor] as CFArray
        guard let g = CGGradient(colorsSpace: cs, colors: colors, locations: [0, 0.5, 1]) else { return nil }
        ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: h), end: CGPoint(x: 0, y: 0), options: [])
        guard let img = ctx.makeImage() else { return nil }
        return try? EnvironmentResource(equirectangular: img)
    }

    // MARK: - light and dark

    private func applyLook() {
        let t = look * look * (3 - 2 * look)
        if let darkEnv, let lightEnv {
            ibl.components.set(ImageBasedLightComponent(source: .blend(darkEnv, lightEnv, t), intensityExponent: -0.35 + 1.35 * t))
        }
        if var dl = moon.components[DirectionalLightComponent.self] {
            dl.color = UIColor(rgb: RGB(hex: "#a9c0ff").lerp(RGB(hex: "#fff0dc"), Double(t)))
            dl.intensity = 700 + (4200 - 700) * t
            moon.components.set(dl)
        }
        if let plinth {
            var m = PhysicallyBasedMaterial()
            m.baseColor = .init(tint: UIColor(rgb: RGB(hex: "#141927").lerp(RGB(hex: "#d9d0c4"), Double(t))))
            m.roughness = 0.9
            plinth.model?.materials = [m]
        }
    }

    // MARK: - camera

    private func basis(_ az: Float, _ el: Float) -> (fwd: SIMD3<Float>, right: SIMD3<Float>, up: SIMD3<Float>) {
        let a = az * .pi / 180, e = el * .pi / 180
        let fwd = SIMD3(-sin(a) * cos(e), -sin(e), -cos(a) * cos(e))
        let right = SIMD3(cos(a), 0, -sin(a))
        return (fwd, right, simd_cross(right, fwd))
    }

    private var aspect: Float { Float(size.width / max(1, size.height)) }
    private var usable: Float { Float(max(0.3, (size.height - topInset - bottomInset) / size.height)) }

    /// Smallest distance at which `box` fits the usable part of the screen.
    private func fitDistance(_ lo: SIMD3<Float>, _ hi: SIMD3<Float>, _ az: Float, _ el: Float, fill: Float) -> (Float, SIMD3<Float>) {
        let (fwd, right, up) = basis(az, el)
        let c = (lo + hi) / 2
        let tanV = tan(goal.fov * .pi / 360) * fill * usable
        let tanH = tan(goal.fov * .pi / 360) * aspect * fill
        var dist: Float = 0
        for i in 0..<8 {
            let p = SIMD3(i & 1 != 0 ? hi.x : lo.x, i & 2 != 0 ? hi.y : lo.y, i & 4 != 0 ? hi.z : lo.z)
            let v = p - c
            let depth = simd_dot(v, fwd)
            dist = max(dist, abs(simd_dot(v, right)) / tanH - depth, abs(simd_dot(v, up)) / tanV - depth)
        }
        return (dist, c)
    }

    private func box(_ lo: SIMD3<Float>, _ hi: SIMD3<Float>) -> [SIMD3<Float>] {
        (0..<8).map { i in SIMD3(i & 1 != 0 ? hi.x : lo.x, i & 2 != 0 ? hi.y : lo.y, i & 4 != 0 ? hi.z : lo.z) }
    }

    func frameGoal() {
        goal.fov = Self.fov
        let H = Float(plan.wallHeight)
        var lo: SIMD3<Float>, hi: SIMD3<Float>
        var fill: Float = 0.96
        switch focus {
        case .tv(let id):
            if let u = tvUnits.first(where: { $0.id == id }) { closeUp(u); return }
            lo = SIMD3(Float(plan.minX), 0, Float(plan.minZ)); hi = SIMD3(Float(plan.maxX), H * 0.8, Float(plan.maxZ))
        case .room(let id):
            if let r = plan.rooms.first(where: { $0.id == id }) {
                lo = SIMD3(Float(r.minX), 0, Float(r.minZ)); hi = SIMD3(Float(r.maxX), H * 0.75, Float(r.maxZ)); fill = 0.84
            } else {
                lo = SIMD3(Float(plan.minX), 0, Float(plan.minZ)); hi = SIMD3(Float(plan.maxX), H * 0.8, Float(plan.maxZ))
            }
        case .ac(let id):
            if let u = acUnits[id] {
                let p = u.root.position
                let out = u.root.orientation.act([0, 0, 1])
                let c = SIMD3(p.x + out.x * 1.3, 1.25, p.z + out.z * 1.3)
                lo = c - SIMD3(1.8, 1.3, 1.8); hi = c + SIMD3(1.8, 1.3, 1.8); fill = 0.92
            } else {
                lo = SIMD3(Float(plan.minX), 0, Float(plan.minZ)); hi = SIMD3(Float(plan.maxX), H * 0.8, Float(plan.maxZ))
            }
        case .home:
            lo = SIMD3(Float(plan.minX), 0, Float(plan.minZ)); hi = SIMD3(Float(plan.maxX), H * 0.8, Float(plan.maxZ))
        }
        let (d, c) = fitDistance(lo, hi, goal.az, goal.el, fill: fill)
        goal.dist = d * zoom
        goal.target = c
        corners = box(lo, hi)
    }

    /// Standing in front of the TV, eyes level with the middle of its screen, looking straight at it.
    private func closeUp(_ u: TVUnit) {
        let (c, n, w, h) = u.face()
        let az = atan2(n.x, n.z) * 180 / .pi
        goal.az = az + ((rig.az - az) / 360).rounded() * 360
        goal.el = 0
        goal.dist = Self.tvDist
        goal.target = c
        let H = Float(size.height), W = Float(size.width)
        let usableH = max(40, H - Float(topInset + bottomInset))
        let bw = w * Self.tvAround.x, bh = h * Self.tvAround.y
        var t = max(tan(10 * Float.pi / 180), max(bw * H / (2 * Self.tvDist * W), bh * H / (2 * Self.tvDist * usableH)))
        // A short view (the strip over the pulled-up remote) steps back rather than going wide-angle.
        let widest = tan(32 * Float.pi / 180)
        if t > widest { goal.dist = Self.tvDist * t / widest; t = widest }
        goal.fov = 2 * atan(t) * 180 / .pi
        let side = SIMD3(n.z, 0, -n.x)
        corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)].map { (sx: Float, sy: Float) in c + side * (sx * bw / 2) + SIMD3(0, sy * bh / 2, 0) }
    }

    var closeUpOn: Bool { if case .tv(let id) = focus { return tvUnits.contains { $0.id == id } }; return false }

    /// Whether the goal is the TV's close-up (the TV may be linked only after the focus was set).
    private var framedClose = false

    func setFocus(_ next: Focus) {
        guard next != focus else { return }
        let wasClose = framedClose
        focus = next
        zoom = 1
        if case .ac(let id) = next, let u = acUnits[id] {
            goal.az = baseAz + (["north": -14, "west": 14][u.cfg.wall] ?? 0)
            goal.el = 30
        } else if !closeUpOn {
            goal.az = baseAz
            goal.el = Float(plan.elevation)
        }
        frameGoal()
        framedClose = closeUpOn
        if wasClose != closeUpOn { tween = (rig, CACurrentMediaTime(), 0.7) }
    }

    func orbit(byX dx: Float, y dy: Float, from start: (az: Float, el: Float)) {
        guard !closeUpOn else { return }
        goal.az = min(baseAz + Self.orbitAz, max(baseAz - Self.orbitAz, start.az - dx * 0.35))
        goal.el = min(Self.elMax, max(Self.elMin, start.el + dy * 0.3))
        frameGoal()
    }

    func pinch(_ z: Float) {
        guard !closeUpOn else { return }
        zoom = min(Self.zoomMax, max(Self.zoomMin, z))
        frameGoal()
    }

    /// Whatever stands between the camera and the TV's cabinet is cut away by the near plane.
    private func placeCamera() {
        let (fwd, _, up) = basis(rig.az, rig.el)
        // The model sits in the middle of the part of the screen the card leaves (the web shifts the
        // projection; here the camera looks a little lower instead).
        let (aim, pos) = eyeAndAim(rig, up: up, fwd: fwd, tv: tvWeight)
        camera.look(at: aim, from: pos, relativeTo: nil)
        camera.camera.near = Self.near + max(0, rig.dist - Self.tvClear - Self.near) * tvWeight
        camera.camera.fieldOfViewInDegrees = rig.fov
    }

    /// Where the camera looks and stands. The model is lowered into the part of the screen the card
    /// leaves: for the home by tilting the camera a little, in front of the TV by moving the camera
    /// down instead (a lens shift), so the camera stays level and the screen is seen face on.
    private func eyeAndAim(_ r: Rig, up: SIMD3<Float>, fwd: SIMD3<Float>, tv: Float) -> (aim: SIMD3<Float>, eye: SIMD3<Float>) {
        let dyPx = Float((topInset - bottomInset) / 2)
        let shift = dyPx / Float(size.height / 2) * tan(r.fov * .pi / 360) * r.dist
        let level = SIMD3<Float>(0, shift * tv, 0)
        return (r.target + up * shift * (1 - tv) + level, r.target - fwd * r.dist + level)
    }

    private func updateRig(_ dt: Float) -> Bool {
        if let tw = tween {
            let p = Float(min(1, max(0, (CACurrentMediaTime() - tw.t0) / tw.dur)))
            let e = p < 0.5 ? 4 * p * p * p : 1 - pow(-2 * p + 2, 3) / 2
            rig.az = tw.from.az + (goal.az - tw.from.az) * e
            rig.el = tw.from.el + (goal.el - tw.from.el) * e
            rig.dist = exp(log(tw.from.dist) + (log(goal.dist) - log(tw.from.dist)) * e)
            rig.fov = tw.from.fov + (goal.fov - tw.from.fov) * e
            rig.target = tw.from.target + (goal.target - tw.from.target) * e
            tvWeight = closeUpOn ? max(tvWeight, e) : min(tvWeight, 1 - e)
            if p >= 1 {
                tween = nil
                tvWeight = closeUpOn ? 1 : 0
                if !closeUpOn {
                    let turns = ((rig.az - baseAz) / 360).rounded() * 360
                    rig.az -= turns; goal.az -= turns
                }
            }
            placeCamera()
            return true
        }
        let k = 1 - exp(-dt * 5.5)
        let delta = abs(goal.az - rig.az) + abs(goal.el - rig.el) + abs(goal.dist - rig.dist) * 2 + simd_distance(goal.target, rig.target) * 4 + abs(goal.fov - rig.fov)
        guard delta > 0.002 else { return false }
        rig.az += (goal.az - rig.az) * k
        rig.el += (goal.el - rig.el) * k
        rig.dist += (goal.dist - rig.dist) * k
        rig.fov += (goal.fov - rig.fov) * k
        rig.target += (goal.target - rig.target) * k
        placeCamera()
        return true
    }

    func resize(_ s: CGSize, top: CGFloat, bottom: CGFloat) {
        guard s != size || top != topInset || bottom != bottomInset else { return }
        size = s
        topInset = top
        bottomInset = bottom
        frameGoal()
        placeCamera()
    }

    // MARK: - the small view over the pulled-up card

    /// Where the goal's frame lies on screen at rest (seen from where the camera is heading).
    func restRect() -> CGRect? {
        guard !corners.isEmpty else { return nil }
        let (fwd, right, up) = basis(goal.az, goal.el)
        let (aim, eye) = eyeAndAim(goal, up: up, fwd: fwd, tv: closeUpOn ? 1 : 0)
        let f = simd_normalize(aim - eye)
        let r = simd_normalize(simd_cross(f, [0, 1, 0]))
        let u = simd_cross(r, f)
        _ = right
        let tanV = tan(goal.fov * .pi / 360), tanH = tanV * aspect
        var x0 = CGFloat.infinity, y0 = CGFloat.infinity, x1 = -CGFloat.infinity, y1 = -CGFloat.infinity
        for p in corners {
            let v = p - eye
            let z = simd_dot(v, f)
            guard z > 0.01 else { continue }
            let nx = simd_dot(v, r) / (z * tanH), ny = simd_dot(v, u) / (z * tanV)
            let sx = CGFloat((nx * 0.5 + 0.5)) * size.width, sy = CGFloat((-ny * 0.5 + 0.5)) * size.height
            x0 = min(x0, sx); x1 = max(x1, sx); y0 = min(y0, sy); y1 = max(y1, sy)
        }
        guard x1 > x0, y1 > y0 else { return nil }
        return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }

    /// How close the camera is to the TV, 0 … 1.
    var tvness: CGFloat { CGFloat(tvWeight) }

    // MARK: - every frame

    #if DEBUG
    private var frameTimes: [Float] = []
    private var frameLog: [String] = []
    /// Debug builds note the frame rate every 2 s in Documents/frames.txt (read it with
    /// `xcrun devicectl device copy from … --domain-type appDataContainer`).
    private func noteFrame(_ dt: Float) {
        frameTimes.append(dt)
        guard frameTimes.reduce(0, +) >= 2 else { return }
        let avg = frameTimes.reduce(0, +) / Float(frameTimes.count)
        let worst = frameTimes.max() ?? 0
        frameLog.append(String(format: "%@ fps %.1f worst %.1f ms frames %d", ISO8601DateFormatter().string(from: Date()), 1 / avg, worst * 1000, frameTimes.count))
        frameTimes.removeAll()
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appending(path: "frames.txt")
        try? frameLog.suffix(200).joined(separator: "\n").write(to: url, atomically: true, encoding: .utf8)
    }
    #endif

    func update(dt: Float) {
        #if DEBUG
        noteFrame(dt)
        #endif
        guard let store else { return }
        if look != lookGoal {
            let step = dt / 0.3
            look = lookGoal > look ? min(lookGoal, look + step) : max(lookGoal, look - step)
            applyLook()
        }
        // In front of the TV the framing follows the card every frame (no easing lag).
        if closeUpOn, tween == nil, case .tv(let id) = focus, let u = tvUnits.first(where: { $0.id == id }) {
            closeUp(u)
            rig = goal
            placeCamera()
        } else {
            _ = updateRig(dt)
        }
        for (id, u) in lamps {
            if let s = store.lights[id] { u.apply(s) }
            _ = u.update(dt)
        }
        for (id, u) in acUnits {
            if let s = store.acs[id] { u.apply(s) }
            _ = u.update(dt)
        }
        let tvState = store.tv.state
        let links = tvLinks(plan.furniture, tvState)
        for u in tvUnits {
            let id = links.first { $0.furniture.index == u.spot.furniture.index }?.id
            u.link(id)
            u.apply(id.flatMap { i in tvState.devices.first { $0.id == i } })
            _ = u.update(dt)
        }
        // The TV turned up (or went) while its page was open: fly in (or out) now.
        if closeUpOn != framedClose {
            framedClose = closeUpOn
            frameGoal()
            tween = (rig, CACurrentMediaTime(), 0.7)
        }
    }

    /// Starts the lamps from what they show now, without fading in.
    func syncInstantly() {
        guard let store else { return }
        for (id, u) in lamps { if let s = store.lights[id] { u.apply(s, instant: true); _ = u.update(0) } }
        for (id, u) in acUnits { if let s = store.acs[id] { u.apply(s, instant: true) } }
    }
}
