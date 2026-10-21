import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// The remote's swipe pad (web/src/tv/remote.js `createPad`): swipe to move, a step per stretch
/// of travel like a touchpad (a fast flick goes a step or two further); tap to select. A ring
/// spreads from a tap; each step glows toward the edge it moves to, and a faint light follows the
/// finger. A keyboard-like tick with each. Held still past half a second, it sends nothing.
/// A UIKit view, so its touches never start a scroll or pull the card.
struct SwipePad: UIViewRepresentable {
    var enabled: Bool
    var onKey: (String) -> Void

    func makeUIView(context: Context) -> PadView {
        let v = PadView()
        v.onKey = onKey
        return v
    }

    func updateUIView(_ v: PadView, context: Context) {
        v.onKey = onKey
        v.alpha = enabled ? 1 : 0.55
    }

    final class PadView: UIView {
        var onKey: ((String) -> Void)?

        static let tapSlop: CGFloat = 10
        static let pressTime: TimeInterval = 0.5
        static let swipe: CGFloat = 24
        static let step: CGFloat = 44
        static let maxSteps = 8
        static let flick: CGFloat = 1200      // pt/s at release
        nonisolated(unsafe) static var used = false

        private let haptic = UISelectionFeedbackGenerator()
        private let hint = UILabel()
        private let fingerLight = CAGradientLayer()
        private var edges: [String: CAGradientLayer] = [:]
        private var g: Gesture?

        private struct Gesture {
            var start: CGPoint
            var t0: TimeInterval
            var anchor: CGPoint
            var steps = 0
            var swiping = false
            var moved: CGFloat = 0
            var trail: [(TimeInterval, CGPoint)]
        }

        override init(frame: CGRect) {
            super.init(frame: frame)
            layer.cornerRadius = 28
            layer.cornerCurve = .continuous
            clipsToBounds = true
            isMultipleTouchEnabled = false
            accessibilityLabel = "Touch pad"
            accessibilityHint = "Swipe to move, double-tap to select"
            isAccessibilityElement = true
            accessibilityTraits = .allowsDirectInteraction

            hint.text = "Swipe to move · Tap to select"
            hint.font = .systemFont(ofSize: 13, weight: .medium)
            hint.textAlignment = .center
            hint.alpha = Self.used ? 0 : 1
            addSubview(hint)

            fingerLight.type = .radial
            fingerLight.startPoint = CGPoint(x: 0.5, y: 0.5)
            fingerLight.endPoint = CGPoint(x: 1, y: 1)
            fingerLight.bounds = CGRect(x: 0, y: 0, width: 150, height: 150)
            fingerLight.opacity = 0
            layer.addSublayer(fingerLight)

            for d in ["up", "down", "left", "right"] {
                let e = CAGradientLayer()
                e.opacity = 0
                layer.addSublayer(e)
                edges[d] = e
            }
            let rec = PadRecognizer(target: self, action: #selector(handle(_:)))
            addGestureRecognizer(rec)
            updateColors()
            registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _: UITraitCollection) in self.updateColors() }
        }

        required init?(coder: NSCoder) { fatalError() }


        private var halo: UIColor {
            let accent = UIColor(named: "AccentColor") ?? .systemBlue
            return traitCollection.userInterfaceStyle == .dark ? accent.blend(.white, 0.45) : accent.blend(.white, 0.15)
        }

        private func updateColors() {
            let dark = traitCollection.userInterfaceStyle == .dark
            backgroundColor = dark ? UIColor(white: 1, alpha: 0.06) : UIColor(red: 27 / 255, green: 32 / 255, blue: 48 / 255, alpha: 0.05)
            layer.borderWidth = 1
            layer.borderColor = (dark ? UIColor(white: 1, alpha: 0.09) : UIColor(red: 27 / 255, green: 32 / 255, blue: 48 / 255, alpha: 0.1)).cgColor
            hint.textColor = dark ? UIColor(white: 1, alpha: 0.38) : UIColor(red: 27 / 255, green: 32 / 255, blue: 48 / 255, alpha: 0.42)
            fingerLight.colors = [halo.withAlphaComponent(0.28).cgColor, halo.withAlphaComponent(0).cgColor]
            for (d, e) in edges {
                e.colors = [halo.withAlphaComponent(0.55).cgColor, halo.withAlphaComponent(0).cgColor]
                switch d {
                case "up": e.startPoint = CGPoint(x: 0.5, y: 0); e.endPoint = CGPoint(x: 0.5, y: 1)
                case "down": e.startPoint = CGPoint(x: 0.5, y: 1); e.endPoint = CGPoint(x: 0.5, y: 0)
                case "left": e.startPoint = CGPoint(x: 0, y: 0.5); e.endPoint = CGPoint(x: 1, y: 0.5)
                default: e.startPoint = CGPoint(x: 1, y: 0.5); e.endPoint = CGPoint(x: 0, y: 0.5)
                }
            }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            hint.frame = bounds.insetBy(dx: 12, dy: 0)
            let w = bounds.width, h = bounds.height, band: CGFloat = 56
            edges["up"]?.frame = CGRect(x: 0, y: 0, width: w, height: band)
            edges["down"]?.frame = CGRect(x: 0, y: h - band, width: w, height: band)
            edges["left"]?.frame = CGRect(x: 0, y: 0, width: band, height: h)
            edges["right"]?.frame = CGRect(x: w - band, y: 0, width: band, height: h)
        }

        // MARK: - the finger

        @objc private func handle(_ r: PadRecognizer) {
            let p = r.location(in: self)
            let now = CACurrentMediaTime()
            switch r.state {
            case .began:
                g = Gesture(start: p, t0: now, anchor: p, trail: [(now, p)])
                haptic.prepare()
                CATransaction.begin(); CATransaction.setDisableActions(true)
                fingerLight.position = p
                CATransaction.commit()
                fingerLight.opacity = 0.0
            case .changed:
                guard var gs = g else { return }
                gs.trail.append((now, p))
                while gs.trail.count > 2, now - gs.trail[0].0 > 0.08 { gs.trail.removeFirst() }
                gs.moved = max(gs.moved, hypot(p.x - gs.start.x, p.y - gs.start.y))
                CATransaction.begin(); CATransaction.setDisableActions(true)
                fingerLight.position = p
                fingerLight.opacity = gs.swiping ? 1 : 0
                CATransaction.commit()
                if !gs.swiping {
                    if gs.moved >= Self.swipe {
                        // A swipe from here on: its first step goes the way it went the most.
                        gs.swiping = true
                        firstUse()
                        let dx = p.x - gs.start.x, dy = p.y - gs.start.y
                        step(&gs, abs(dx) > abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"), at: p)
                        gs.anchor = p
                    }
                } else {
                    // On from there, like a touchpad: a step for every 44 pt along the way it goes.
                    let ax = p.x - gs.anchor.x, ay = p.y - gs.anchor.y
                    if abs(ax) >= Self.step, abs(ax) >= abs(ay) {
                        gs.anchor.x += ax > 0 ? Self.step : -Self.step
                        gs.anchor.y = p.y
                        step(&gs, ax > 0 ? "right" : "left", at: p)
                    } else if abs(ay) >= Self.step {
                        gs.anchor.y += ay > 0 ? Self.step : -Self.step
                        gs.anchor.x = p.x
                        step(&gs, ay > 0 ? "down" : "up", at: p)
                    }
                }
                g = gs
            case .ended:
                guard let gs = g else { return }
                g = nil
                fadeFinger()
                let held = now - gs.t0
                let (t0, p0) = gs.trail[0]
                let dt = max(0.001, now - t0)
                let vx = (p.x - p0.x) / dt, vy = (p.y - p0.y) / dt
                let v = max(abs(vx), abs(vy))
                let dir = abs(vx) > abs(vy) ? (vx > 0 ? "right" : "left") : (vy > 0 ? "down" : "up")
                if !gs.swiping {
                    if gs.moved < Self.tapSlop, held <= Self.pressTime {
                        firstUse()
                        send("ok")
                        ring(at: gs.start)
                    } else if gs.moved >= Self.tapSlop, v > Self.flick * 0.5 {
                        // Too short for a swipe but quick: a flick, one step.
                        firstUse()
                        var copy = gs
                        step(&copy, dir, at: p)
                    }
                    return
                }
                // A fast flick at the end goes a step or two further, the way it was going.
                if v > Self.flick {
                    let extra = min(Self.maxSteps - gs.steps, v > Self.flick * 2 ? 2 : 1)
                    for i in 0..<max(0, extra) {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.07 * Double(i + 1)) { [weak self] in
                            self?.send(dir)
                            self?.stepHalo(dir, at: p)
                        }
                    }
                }
            default:
                g = nil
                fadeFinger()
            }
        }

        private func step(_ gs: inout Gesture, _ dir: String, at p: CGPoint) {
            guard gs.steps < Self.maxSteps else { return }
            gs.steps += 1
            send(dir)
            stepHalo(dir, at: p)
        }

        private func send(_ key: String) {
            haptic.selectionChanged()
            onKey?(key)
        }

        private func firstUse() {
            guard !Self.used else { return }
            Self.used = true
            UIView.animate(withDuration: 0.4) { self.hint.alpha = 0 }
        }

        private func fadeFinger() {
            let a = CABasicAnimation(keyPath: "opacity")
            a.fromValue = fingerLight.presentation()?.opacity ?? fingerLight.opacity
            a.toValue = 0
            a.duration = 0.25
            fingerLight.opacity = 0
            fingerLight.add(a, forKey: "fade")
        }

        // MARK: - halos

        private var reduced: Bool { UIAccessibility.isReduceMotionEnabled }

        /// A tap: a soft ring spreads from the finger and fades, over a brief glow under it.
        private func ring(at p: CGPoint) {
            glow(at: p, strength: 0.9)
            guard !reduced else { return }
            let r = CAShapeLayer()
            let size: CGFloat = 92
            r.path = UIBezierPath(ovalIn: CGRect(x: -size / 2, y: -size / 2, width: size, height: size)).cgPath
            r.fillColor = UIColor.clear.cgColor
            r.strokeColor = halo.withAlphaComponent(0.9).cgColor
            r.lineWidth = 2
            r.position = p
            layer.addSublayer(r)
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.25
            scale.toValue = 1.7
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.85
            fade.toValue = 0
            let group = CAAnimationGroup()
            group.animations = [scale, fade]
            group.duration = 0.38
            group.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.3, 1)
            r.opacity = 0
            CATransaction.begin()
            CATransaction.setCompletionBlock { r.removeFromSuperlayer() }
            r.add(group, forKey: "ring")
            CATransaction.commit()
        }

        private func glow(at p: CGPoint, strength: Float) {
            let gl = CAGradientLayer()
            gl.type = .radial
            gl.startPoint = CGPoint(x: 0.5, y: 0.5)
            gl.endPoint = CGPoint(x: 1, y: 1)
            gl.colors = [halo.withAlphaComponent(0.45).cgColor, halo.withAlphaComponent(0).cgColor]
            gl.bounds = CGRect(x: 0, y: 0, width: 130, height: 130)
            gl.position = p
            gl.opacity = 0
            layer.insertSublayer(gl, at: 0)
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = strength
            fade.toValue = 0
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.7
            scale.toValue = 1.15
            let group = CAAnimationGroup()
            group.animations = [fade, scale]
            group.duration = 0.42
            CATransaction.begin()
            CATransaction.setCompletionBlock { gl.removeFromSuperlayer() }
            gl.add(group, forKey: "glow")
            CATransaction.commit()
        }

        /// A step: a soft light travels from the finger toward the edge it moves to, which brightens.
        private func stepHalo(_ dir: String, at p: CGPoint) {
            if let e = edges[dir] {
                let k = CAKeyframeAnimation(keyPath: "opacity")
                k.values = [0, 1, 0]
                k.keyTimes = [0, 0.25, 1]
                k.duration = 0.46
                e.add(k, forKey: "flash")
            }
            guard !reduced else { return }
            let d: CGPoint = ["up": CGPoint(x: 0, y: -1), "down": CGPoint(x: 0, y: 1), "left": CGPoint(x: -1, y: 0)][dir] ?? CGPoint(x: 1, y: 0)
            let reach = min(d.x != 0 ? bounds.width : bounds.height, 160) * 0.42
            let b = CAGradientLayer()
            b.type = .radial
            b.startPoint = CGPoint(x: 0.5, y: 0.5)
            b.endPoint = CGPoint(x: 1, y: 1)
            b.colors = [halo.withAlphaComponent(0.6).cgColor, halo.withAlphaComponent(0).cgColor]
            b.bounds = CGRect(x: 0, y: 0, width: 90, height: 90)
            b.position = p
            b.opacity = 0
            layer.addSublayer(b)
            let move = CABasicAnimation(keyPath: "position")
            move.fromValue = NSValue(cgPoint: p)
            move.toValue = NSValue(cgPoint: CGPoint(x: p.x + d.x * reach, y: p.y + d.y * reach))
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0.9
            fade.toValue = 0
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.6
            scale.toValue = 1.05
            let group = CAAnimationGroup()
            group.animations = [move, fade, scale]
            group.duration = 0.42
            group.timingFunction = CAMediaTimingFunction(controlPoints: 0.25, 0.8, 0.35, 1)
            CATransaction.begin()
            CATransaction.setCompletionBlock { b.removeFromSuperlayer() }
            b.add(group, forKey: "step")
            CATransaction.commit()
        }

        // VoiceOver: double-tap selects; the rotor's adjustable action moves.
        override func accessibilityActivate() -> Bool { send("ok"); return true }
        override func accessibilityIncrement() { send("up") }
        override func accessibilityDecrement() { send("down") }
    }

    /// Takes the finger at once and holds it until it lifts, so nothing else (the card's drag,
    /// a scroll) starts from inside the pad.
    final class PadRecognizer: UIGestureRecognizer {
        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
            if state == .possible { state = .began }
        }
        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) { state = .changed }
        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { state = .ended }
        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .cancelled }
        override func shouldBeRequiredToFail(by other: UIGestureRecognizer) -> Bool { true }
        override func canBePrevented(by other: UIGestureRecognizer) -> Bool { false }
    }
}

extension UIColor {
    func blend(_ other: UIColor, _ t: CGFloat) -> UIColor {
        var r1: CGFloat = 0, g1: CGFloat = 0, b1: CGFloat = 0, a1: CGFloat = 0
        var r2: CGFloat = 0, g2: CGFloat = 0, b2: CGFloat = 0, a2: CGFloat = 0
        getRed(&r1, green: &g1, blue: &b1, alpha: &a1)
        other.getRed(&r2, green: &g2, blue: &b2, alpha: &a2)
        return UIColor(red: r1 + (r2 - r1) * t, green: g1 + (g2 - g1) * t, blue: b1 + (b2 - b1) * t, alpha: a1 + (a2 - a1) * t)
    }
}
