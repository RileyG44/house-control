import Foundation
import RealityKit
import SwiftUI
import UIKit
import simd

/// Names that a tap in the model resolves to: "pick:light:<id>", "pick:ac:<id>", "pick:tv:<id>".
enum Pick: Equatable {
    case light(String), ac(String), tv(String)

    init?(name: String) {
        let parts = name.split(separator: ":", maxSplits: 2).map(String.init)
        guard parts.count == 3, parts[0] == "pick" else { return nil }
        switch parts[1] {
        case "light": self = .light(parts[2])
        case "ac": self = .ac(parts[2])
        case "tv": self = .tv(parts[2])
        default: return nil
        }
    }
}

@MainActor
func hitEntity(_ name: String, size: SIMD3<Float>, at p: SIMD3<Float>) -> Entity {
    let e = Entity()
    e.name = name
    e.position = p
    e.components.set(CollisionComponent(shapes: [.generateBox(size: size)]))
    e.components.set(InputTargetComponent())
    return e
}

/// Eases `value` toward `goal` (1 - e^(-dt·rate) of the way each frame).
@inline(__always) func ease(_ value: inout Float, _ goal: Float, _ dt: Float, _ rate: Float) {
    value += (goal - value) * (1 - exp(-dt * rate))
}

// MARK: - lamps

/// A lamp: a small fixture, its glowing part, and the light it throws (web/src/three/lights.js).
@MainActor
final class LampUnit {
    let cfg: LightConfig
    let root = Entity()
    private let model = Entity()
    private var glow: ModelEntity?
    private let lightEntity = Entity()
    private let spot: Bool
    private let maxLumens: Float
    private let pivotY: Float
    var hasLight = true

    private(set) var level: Float = 0
    private var goal: Float = 0
    private var color = RGB(hex: "#ffbd7a")
    private var goalColor = RGB(hex: "#ffbd7a")
    private var pulse: Float = 0
    private var written: (Float, RGB, Float)?

    init(_ cfg: LightConfig, wallHeight H: Float, ibl: Entity) {
        self.cfg = cfg
        root.position = SIMD3(Float(cfg.pos.x), 0, Float(cfg.pos.y))
        root.orientation = simd_quatf(angle: Float(cfg.rot * .pi / 180), axis: [0, 1, 0])
        let dark = Mat.c("#23262e")
        let darkMetal = Mat.c("#23262e", rough: 0.4, metal: 0.5)
        let parts = MeshBuilder(), glows = MeshBuilder()
        let glowMat = Mat.c("#8d8f96", rough: 0.6)
        var lightY: Float = 1
        var hit = SIMD4<Float>(0.5, 0.5, 0.5, 1)
        var spot = false
        var intensity: Float = 1
        let y0 = cfg.y.map(Float.init)
        switch cfg.type {
        case "ceiling":
            let y = y0 ?? H - 0.14
            parts.cyl(0.012, 0.012, H - y - 0.05, dark, seg: 8, at: SIMD3(0, y + 0.05, 0))
            glows.cyl(0.27, 0.27, 0.055, glowMat, seg: 40, at: SIMD3(0, y, 0))
            lightY = y - 0.02; spot = true; intensity = Float(cfg.intensity ?? 20); hit = SIMD4(0.75, 0.5, 0.75, y)
        case "pendant":
            let y = y0 ?? 1.8
            parts.cyl(0.006, 0.006, H - y - 0.15, dark, seg: 6, at: SIMD3(0, y + 0.15, 0))
            parts.cyl(0.04, 0.05, 0.05, darkMetal, seg: 16, at: SIMD3(0, y + 0.14, 0))
            glows.group(SIMD3(0, y, 0)) { glows.add(Prim.sphere(0.17), glowMat) }
            lightY = y - 0.05; spot = true; intensity = Float(cfg.intensity ?? 9); hit = SIMD4(0.6, 0.7, 0.6, y)
        case "spots":
            let y = y0 ?? H - 0.16
            parts.box(0.95, 0.03, 0.05, .c("#23262e", rough: 0.5), r: 0.01, at: SIMD3(0, y + 0.05, 0))
            for x: Float in [-0.32, 0, 0.32] { glows.cyl(0.055, 0.045, 0.1, glowMat, seg: 20, at: SIMD3(x, y - 0.06, 0)) }
            lightY = y - 0.08; spot = true; intensity = Float(cfg.intensity ?? 20); hit = SIMD4(1.1, 0.45, 0.5, y)
        case "floor":
            parts.cyl(0.15, 0.16, 0.025, darkMetal)
            parts.cyl(0.011, 0.011, 1.3, darkMetal, seg: 8, at: SIMD3(0, 0.02, 0))
            glows.cyl(0.14, 0.19, 0.3, glowMat, seg: 32, at: SIMD3(0, 1.28, 0))
            lightY = 1.46; intensity = Float(cfg.intensity ?? 3.4); hit = SIMD4(0.6, 1.7, 0.6, 0.85)
        case "table":
            let y = y0 ?? 0.5
            parts.cyl(0.065, 0.075, 0.02, darkMetal, at: SIMD3(0, y, 0))
            parts.cyl(0.01, 0.01, 0.18, darkMetal, seg: 8, at: SIMD3(0, y + 0.02, 0))
            glows.cyl(0.085, 0.125, 0.17, glowMat, seg: 28, at: SIMD3(0, y + 0.18, 0))
            lightY = y + 0.3; intensity = Float(cfg.intensity ?? 1.5); hit = SIMD4(0.5, 0.6, 0.5, y + 0.2)
        default: // strip
            let y = y0 ?? 1
            let len = Float(cfg.length ?? 1)
            glows.box(len, 0.022, 0.022, glowMat, r: 0.008, at: SIMD3(0, y - 0.011, 0))
            lightY = y; intensity = Float(cfg.intensity ?? 1.6); hit = SIMD4(len + 0.2, 0.4, 0.4, y)
            lightEntity.position.z = 0.05
        }
        self.spot = spot
        // three.js candela → RealityKit lumens, by eye: a little brighter than 4π so lamps read.
        maxLumens = intensity * (spot ? 2000 : 9000)
        pivotY = hit.w

        model.position.y = pivotY
        root.addChild(model)
        for e in parts.entities() {
            e.position.y -= pivotY
            e.components.set(ImageBasedLightReceiverComponent(imageBasedLight: ibl))
            model.addChild(e)
        }
        if let g = glows.entity(named: "glow") {
            g.position.y -= pivotY
            g.components.set(ImageBasedLightReceiverComponent(imageBasedLight: ibl))
            model.addChild(g)
            glow = g
        }
        lightEntity.position.y = lightY
        if spot {
            lightEntity.orientation = simd_quatf(angle: -.pi / 2, axis: [1, 0, 0])
            var c = SpotLightComponent(color: .white, intensity: 0, innerAngleInDegrees: 50, outerAngleInDegrees: 110, attenuationRadius: 7)
            c.attenuationFalloffExponent = 2
            lightEntity.components.set(c)
        } else {
            var c = PointLightComponent(color: .white, intensity: 0, attenuationRadius: cfg.type == "strip" ? 3.2 : 5)
            c.attenuationFalloffExponent = 2
            lightEntity.components.set(c)
        }
        root.addChild(lightEntity)
        root.addChild(hitEntity("pick:light:\(cfg.id)", size: SIMD3(hit.x, hit.y, hit.z), at: SIMD3(0, hit.w, 0)))
        write()
    }

    func apply(_ s: LightState, instant: Bool = false) {
        goal = s.on ? (cfg.dimmable ? Float(s.brightness) : 1) : 0
        goalColor = RGB.of(s)
        if instant { level = goal; color = goalColor }
        else if level < 0.01 { color = goalColor }
    }

    func bump() { pulse = 1 }

    /// Returns whether anything moved.
    func update(_ dt: Float) -> Bool {
        let dl = goal - level
        let dc = abs(color.r - goalColor.r) + abs(color.g - goalColor.g) + abs(color.b - goalColor.b)
        guard abs(dl) > 0.002 || dc > 0.004 || pulse > 0.004 else {
            if level != goal || pulse != 0 || color != goalColor { level = goal; pulse = 0; color = goalColor; write(); return true }
            return false
        }
        ease(&level, goal, dt, goal > level ? 7 : 5)
        pulse *= exp(-dt * 7)
        color = color.lerp(goalColor, Double(1 - exp(-dt * 6)))
        write()
        return true
    }

    private func write() {
        let out = pow(level, 1.5)
        if hasLight {
            if spot, var c = lightEntity.components[SpotLightComponent.self] {
                c.intensity = maxLumens * out
                c.color = UIColor(rgb: color)
                lightEntity.components.set(c)
            } else if var c = lightEntity.components[PointLightComponent.self] {
                c.intensity = maxLumens * out
                c.color = UIColor(rgb: color)
                lightEntity.components.set(c)
            }
        }
        let e: Float = level > 0.001 ? 0.8 + 1.7 * pow(level, 0.7) : 0
        if let glow, written == nil || written!.0 != level || written!.1 != color {
            var m = PhysicallyBasedMaterial()
            let base = RGB(hex: "#8d8f96").lerp(color, Double(min(1, level * 2)))
            m.baseColor = .init(tint: UIColor(rgb: base))
            m.roughness = 0.6
            m.emissiveColor = .init(color: UIColor(rgb: level > 0.001 ? color : RGB(0, 0, 0)))
            m.emissiveIntensity = e * 1.6
            glow.model?.materials = [m]
        }
        written = (level, color, pulse)
        let s = 1 + sin(pulse * .pi) * 0.22
        model.scale = SIMD3(repeating: s)
    }
}

// MARK: - the air conditioner

/// A wall-mounted AC: its LED, its flap and a soft wash of the mode's colour when it runs
/// (web/src/three/ac.js; the moving streaks of air are left out).
@MainActor
final class ACUnit {
    let cfg: ACConfig
    let root = Entity()
    private let flapPivot = Entity()
    private var led: ModelEntity?
    private var air: ModelEntity?
    private let wash = Entity()
    private var power: Float = 0
    private var goal: Float = 0
    private var color = RGB(hex: "#5db2ff")
    private var goalColor = RGB(hex: "#5db2ff")
    private var swing = "swing"
    private var angle: Float = 38
    private var clock: Float = 0
    var hasLight = true

    static let wallRot: [String: Float] = ["north": 0, "south": .pi, "west": .pi / 2, "east": -.pi / 2]
    static let swingAngle: [String: Float] = ["l1": 12, "l2": 24, "l3": 38, "l4": 52, "l5": 66, "off": 38]

    init(_ cfg: ACConfig, ibl: Entity) {
        self.cfg = cfg
        root.position = SIMD3(Float(cfg.pos.x), Float(cfg.y), Float(cfg.pos.y))
        root.orientation = simd_quatf(angle: Self.wallRot[cfg.wall] ?? 0, axis: [0, 1, 0])
        let body = Entity()
        body.position.z = 0.205
        let b = MeshBuilder()
        b.box(0.94, 0.29, 0.21, .c("#f3f4f6", rough: 0.35), r: 0.05, at: SIMD3(0, -0.145, 0))
        b.box(0.82, 0.03, 0.09, .c("#17191d", rough: 0.6), r: 0.006, at: SIMD3(0, -0.16, 0.055))
        b.box(0.9, 0.004, 0.006, .c("#c9ccd2"), r: 0, at: SIMD3(0, 0.02, 0.105))
        for e in b.entities() { e.components.set(ImageBasedLightReceiverComponent(imageBasedLight: ibl)); body.addChild(e) }
        let l = MeshBuilder()
        l.box(0.085, 0.022, 0.006, .c("#30343c", rough: 0.4), r: 0.003, at: SIMD3(0.34, -0.06, 0.105))
        if let e = l.entity(named: "led") { body.addChild(e); led = e }
        let f = MeshBuilder()
        f.box(0.8, 0.012, 0.075, .c("#e3e5e9", rough: 0.35), r: 0.004, at: SIMD3(0, -0.006, 0.0375))
        flapPivot.position = SIMD3(0, -0.145, 0.03)
        for e in f.entities() { e.components.set(ImageBasedLightReceiverComponent(imageBasedLight: ibl)); flapPivot.addChild(e) }
        body.addChild(flapPivot)
        // The air: a faint fan of the mode's colour spreading down from the flap.
        var g = Geo()
        let reach: Float = 1.6
        g.positions = [SIMD3(-0.4, 0, 0), SIMD3(0.4, 0, 0), SIMD3(1.0, -reach * 0.55, reach * 0.85), SIMD3(-1.0, -reach * 0.55, reach * 0.85)]
        g.normals = Array(repeating: SIMD3(0, 1, 0), count: 4)
        g.uvs = [[0, 0], [1, 0], [1, 1], [0, 1]]
        g.indices = [0, 1, 2, 0, 2, 3]
        var batch = MeshBatch()
        batch.add(positions: g.positions, normals: g.normals, uvs: g.uvs, indices: g.indices, transform: matrix_identity_float4x4)
        if let mesh = try? batch.resource() {
            let e = ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: .clear)])
            e.position = SIMD3(0, -0.17, 0.15)
            e.isEnabled = false
            body.addChild(e)
            air = e
        }
        root.addChild(body)
        wash.position = SIMD3(0, -0.5, 0.75)
        var c = PointLightComponent(color: .white, intensity: 0, attenuationRadius: 3.4)
        c.attenuationFalloffExponent = 2
        wash.components.set(c)
        root.addChild(wash)
        root.addChild(hitEntity("pick:ac:\(cfg.id)", size: SIMD3(1.2, 0.6, 0.6), at: SIMD3(0, -0.15, 0.25)))
    }

    func apply(_ s: ACState, instant: Bool = false) {
        goal = s.on ? 1 : 0
        goalColor = RGB(hex: modeColors[s.mode] ?? "#5db2ff")
        swing = s.swing
        if instant { power = goal; color = goalColor }
    }

    func update(_ dt: Float) -> Bool {
        ease(&power, goal, dt, 3.5)
        if abs(goal - power) < 0.002 { power = goal }
        color = color.lerp(goalColor, Double(1 - exp(-dt * 5)))
        clock += dt
        let target = swing == "swing" ? 38 + sin(clock * 0.9) * 26 : (Self.swingAngle[swing] ?? 38)
        ease(&angle, target, dt, 4)
        flapPivot.orientation = simd_quatf(angle: (angle * 0.9 + 10) * .pi / 180 * power, axis: [1, 0, 0])
        if let led {
            var m = PhysicallyBasedMaterial()
            m.baseColor = .init(tint: UIColor(rgb: RGB(hex: "#30343c")))
            m.emissiveColor = .init(color: UIColor(rgb: color))
            m.emissiveIntensity = power * 3
            led.model?.materials = [m]
        }
        if let air {
            air.isEnabled = power > 0.01
            if power > 0.01 {
                var m = UnlitMaterial(color: UIColor(rgb: color))
                m.blending = .transparent(opacity: .init(floatLiteral: (0.1 + 0.05 * sin(clock * 2.2)) * power))
                m.faceCulling = .none
                air.model?.materials = [m]
            }
        }
        if hasLight, var c = wash.components[PointLightComponent.self] {
            c.color = UIColor(rgb: color)
            c.intensity = power * 1.4 * 420
            wash.components.set(c)
        }
        return power > 0.004 || goal != power
    }
}

// MARK: - the TV

/// A TV in the model, showing what the real one shows: dark when it is off or out of reach; lit
/// with the app's logo on its brand colour when it is on, with a faint spill of that colour on
/// the room. A new picture cross-fades over the old one (web/src/three/tv.js).
@MainActor
final class TVUnit {
    let spot: TVScreenSpot
    let root = Entity()
    private let screen: ModelEntity
    private let leaving: ModelEntity
    private let spill = Entity()
    private let hit: Entity
    private(set) var id: String?
    private var level: Float = 0
    private var goal: Float = 0
    private var shown: String?
    private var fade: Float = 1
    private var color = RGB(0, 0, 0)
    private var goalColor = RGB(0, 0, 0)
    private var texture: TextureResource?
    private var oldTexture: TextureResource?
    var hasLight = true

    static let glowLevel: Float = 1

    init(_ spot: TVScreenSpot) {
        self.spot = spot
        root.transform = Transform(matrix: spot.transform)
        let mesh = MeshResource.generatePlane(width: spot.width, height: spot.height)
        screen = ModelEntity(mesh: mesh, materials: [Self.material(nil, 0)])
        screen.position = SIMD3(0, spot.height / 2, 0)
        root.addChild(screen)
        leaving = ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: .black)])
        leaving.position = SIMD3(0, spot.height / 2, 0.0008)
        leaving.isEnabled = false
        root.addChild(leaving)
        spill.position = SIMD3(0, spot.height * 0.5, 0.45)
        var c = PointLightComponent(color: .white, intensity: 0, attenuationRadius: 2.6)
        c.attenuationFalloffExponent = 2
        spill.components.set(c)
        root.addChild(spill)
        let lo = spot.bounds.min, hi = spot.bounds.max
        hit = hitEntity("pick:tv:", size: hi - lo + 0.04, at: (lo + hi) / 2)
    }

    /// The tap target lives in world space (the piece's box), not under the screen.
    var hitTarget: Entity { hit }

    /// Off: a glossy black panel. On: the picture, lit from within (unlit, so it reads true at any angle).
    static func material(_ tex: TextureResource?, _ lit: Float) -> any RealityKit.Material {
        if let tex, lit > 0.002 {
            var m = UnlitMaterial(applyPostProcessToneMap: false)
            m.color = .init(tint: UIColor(white: CGFloat(min(1, lit)), alpha: 1), texture: .init(tex))
            return m
        }
        var m = PhysicallyBasedMaterial()
        m.baseColor = .init(tint: UIColor(rgb: RGB(hex: "#030406")))
        m.roughness = 0.22
        m.metallic = 0.2
        return m
    }

    func link(_ id: String?) {
        guard self.id != id else { return }
        self.id = id
        hit.name = "pick:tv:\(id ?? "")"
        hit.components[InputTargetComponent.self]?.isEnabled = id != nil
    }

    func apply(_ d: TVDevice?, instant: Bool = false) {
        let on = id != nil && d?.online == true && d?.on == true
        goal = on ? 1 : 0
        if on {
            let info = TVCatalog.info(for: d?.app)
            let key = "\(info.id):\(info.name)"
            if key != shown {
                let old = texture
                shown = key
                texture = TVPicture.texture(info)
                if level > 0.05, let old {
                    oldTexture = old
                    fade = 0
                    var m = UnlitMaterial(applyPostProcessToneMap: false)
                    m.color = .init(tint: .white, texture: .init(old))
                    leaving.model?.materials = [m]
                    leaving.isEnabled = true
                    leaving.components.set(OpacityComponent(opacity: 1))
                }
                writeScreen()
            }
            goalColor = RGB(hex: info.glow)
        }
        if instant { level = goal; color = goalColor; fade = 1; leaving.isEnabled = false; writeScreen() }
    }

    private func writeScreen() {
        screen.model?.materials = [Self.material(texture, level * Self.glowLevel)]
    }

    func update(_ dt: Float) -> Bool {
        let before = level
        ease(&level, goal, dt, goal > level ? 9 : 12)
        if abs(goal - level) < 0.003 { level = goal }
        color = color.lerp(goalColor, Double(1 - exp(-dt * 8)))
        var fading = false
        if leaving.isEnabled {
            fade = min(1, fade + dt / 0.3)
            leaving.components.set(OpacityComponent(opacity: 1 - fade))
            if fade >= 1 { leaving.isEnabled = false; oldTexture = nil }
            fading = true
        }
        if level != before { writeScreen() }
        if hasLight, var c = spill.components[PointLightComponent.self] {
            c.color = UIColor(rgb: color)
            c.intensity = level * 0.55 * 420
            spill.components.set(c)
        }
        return fading || level != before
    }

    /// The screen's middle, the way it faces (flat), and its size, in the world.
    func face() -> (center: SIMD3<Float>, normal: SIMD3<Float>, w: Float, h: Float) {
        let m = spot.transform
        let c = m * SIMD4(0, spot.height / 2 + 0.01, 0, 1)
        var n = SIMD3(m.columns.2.x, 0, m.columns.2.z)
        n = simd_length(n) > 1e-5 ? simd_normalize(n) : SIMD3(0, 0, 1)
        return (SIMD3(c.x, c.y, c.z), n, spot.width, spot.height)
    }
}

/// The TV's picture for an app: its brand background with its logo, 1024 × 576.
@MainActor
enum TVPicture {
    private static var cache: [String: TextureResource] = [:]

    static func texture(_ app: TVAppInfo) -> TextureResource? {
        if let t = cache[app.id + app.name] { return t }
        let view = Canvas { ctx, size in
            LogoPainter.paint(app, in: &ctx, rect: CGRect(origin: .zero, size: size), markSize: size.height * 0.78)
        }
        .frame(width: 1024, height: 576)
        let r = ImageRenderer(content: view)
        r.scale = 1
        // Into plain 8-bit sRGB: the renderer may hand back a wide-gamut, deep image.
        guard let rendered = r.cgImage,
              let ctx = CGContext(data: nil, width: 1024, height: 576, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.draw(rendered, in: CGRect(x: 0, y: 0, width: 1024, height: 576))
        guard let cg = ctx.makeImage(), let tex = try? TextureResource(image: cg, options: .init(semantic: .color)) else { return nil }
        cache[app.id + app.name] = tex
        return tex
    }
}
