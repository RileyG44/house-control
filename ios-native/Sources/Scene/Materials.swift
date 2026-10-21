import CoreGraphics
import Metal
import RealityKit
import UIKit

/// RealityKit materials for the model, and the procedural floor textures (web/src/three/kit.js).
@MainActor
enum Materials {
    private static var cache: [Mat: PhysicallyBasedMaterial] = [:]
    private static var floors: [String: TextureResource] = [:]

    static func make(_ m: Mat) -> PhysicallyBasedMaterial {
        if let hit = cache[m] { return hit }
        var p = PhysicallyBasedMaterial()
        if let kind = m.floor, let tex = floorTexture(kind) {
            let sampler = MaterialParameters.Texture.Sampler({
                let d = MTLSamplerDescriptor()
                d.sAddressMode = .repeat
                d.tAddressMode = .repeat
                d.minFilter = .linear
                d.magFilter = .linear
                d.mipFilter = .linear
                d.maxAnisotropy = 8
                return d
            }())
            p.baseColor = .init(tint: .white, texture: .init(tex, sampler: sampler))
            p.roughness = .init(floatLiteral: kind == "tile" || kind == "stone" ? 0.55 : 0.75)
        } else {
            p.baseColor = .init(tint: UIColor(rgb: RGB(hex: m.color)))
            p.roughness = .init(floatLiteral: m.rough)
        }
        p.metallic = .init(floatLiteral: m.metal)
        if let e = m.emissive {
            p.emissiveColor = .init(color: UIColor(rgb: RGB(hex: e)))
            p.emissiveIntensity = m.emissiveIntensity
        }
        if m.opacity < 1 { p.blending = .transparent(opacity: .init(floatLiteral: m.opacity)) }
        if m.doubleSided { p.faceCulling = .none }
        cache[m] = p
        return p
    }

    // MARK: - floors

    private static let tileMetres: CGFloat = 2.4

    static func floorTexture(_ kind: String) -> TextureResource? {
        if let t = floors[kind] { return t }
        let image: CGImage?
        switch kind {
        case "walnut": image = planks(base: RGB(hex: "#94705a"), seed: 6 * 97 + 110)
        case "tile": image = tiles(base: RGB(hex: "#d5dade"), perSide: 4, grout: RGB(hex: "#aab0b8"), seed: 4 * 31 + 53)
        case "stone": image = tiles(base: RGB(hex: "#a2a7ae"), perSide: 3, grout: RGB(hex: "#7c828b"), seed: 3 * 31 + 50)
        default: image = planks(base: RGB(hex: "#c7a47c"), seed: 7 * 97 + 97)
        }
        guard let image, let tex = try? TextureResource(image: image, options: .init(semantic: .color, mipmapsMode: .allocateAndGenerateAll)) else { return nil }
        floors[kind] = tex
        return tex
    }

    /// Deterministic pseudo-random numbers, so a plan always looks the same (kit.js `rng`).
    struct Rng {
        var s: UInt32
        init(_ seed: Int) { s = UInt32(truncatingIfNeeded: seed) == 0 ? 1 : UInt32(truncatingIfNeeded: seed) }
        mutating func next() -> Double {
            s = s &+ 0x6d2b79f5
            var t = (s ^ (s >> 15)) &* (1 | s)
            t = (t &+ ((t ^ (t >> 7)) &* (61 | t))) ^ t
            return Double(t ^ (t >> 14)) / 4294967296
        }
    }

    private static func shade(_ c: RGB, _ amount: Double) -> UIColor {
        var h: CGFloat = 0, s: CGFloat = 0, l: CGFloat = 0, a: CGFloat = 0
        let ui = UIColor(rgb: c)
        ui.getHue(&h, saturation: &s, brightness: &l, alpha: &a)
        return UIColor(hue: h, saturation: s, brightness: min(1, max(0, l + CGFloat(amount))), alpha: 1)
    }

    private static func draw(_ size: Int, _ body: (CGContext, CGFloat) -> Void) -> CGImage? {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        body(ctx, CGFloat(size))
        return ctx.makeImage()
    }

    private static func planks(base: RGB, seed: Int) -> CGImage? {
        draw(1024) { g, s in
            var rand = Rng(seed)
            let rows = 16
            let rh = s / CGFloat(rows)
            for r in 0..<rows {
                var x = -CGFloat(rand.next()) * s * 0.5
                while x < s {
                    let len = s * CGFloat(0.35 + rand.next() * 0.35)
                    g.setFillColor(shade(base, (rand.next() - 0.5) * 0.09).cgColor)
                    g.fill(CGRect(x: x, y: CGFloat(r) * rh, width: len, height: rh))
                    g.setFillColor(UIColor(white: 0, alpha: 0.28).cgColor)
                    g.fill(CGRect(x: x, y: CGFloat(r) * rh, width: 1.5, height: rh))
                    g.setStrokeColor(UIColor(white: 0, alpha: 0.05).cgColor)
                    for _ in 0..<3 {
                        let y = CGFloat(r) * rh + CGFloat(rand.next()) * rh
                        g.move(to: CGPoint(x: x, y: y))
                        g.addLine(to: CGPoint(x: x + len, y: y + CGFloat(rand.next() - 0.5) * 3))
                        g.strokePath()
                    }
                    x += len
                }
                g.setFillColor(UIColor(white: 0, alpha: 0.3).cgColor)
                g.fill(CGRect(x: 0, y: CGFloat(r) * rh, width: s, height: 1.5))
            }
        }
    }

    private static func tiles(base: RGB, perSide: Int, grout: RGB, seed: Int) -> CGImage? {
        draw(512) { g, s in
            var rand = Rng(seed)
            let t = s / CGFloat(perSide)
            g.setFillColor(UIColor(rgb: grout).cgColor)
            g.fill(CGRect(x: 0, y: 0, width: s, height: s))
            for i in 0..<perSide {
                for j in 0..<perSide {
                    g.setFillColor(shade(base, (rand.next() - 0.5) * 0.05).cgColor)
                    g.fill(CGRect(x: CGFloat(i) * t + 2, y: CGFloat(j) * t + 2, width: t - 4, height: t - 4))
                }
            }
        }
    }
}

extension UIColor {
    convenience init(rgb: RGB, alpha: CGFloat = 1) {
        self.init(red: rgb.r, green: rgb.g, blue: rgb.b, alpha: alpha)
    }
}
