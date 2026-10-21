import SwiftUI

/// The remote's direction pad, like a Chromecast remote's: one big glass disc with four arrow
/// zones at its rim and a round OK in the middle. A press in a rim quarter is that direction
/// (picked by its angle from the centre; a ring between OK and the rim does nothing); held, it
/// repeats after 300 ms every 120 ms. A tick with each press and repeat, a firmer tap for OK.
/// No swiping. Its touches never start the card's drag or a scroll (`onTouch`).
struct DPad: View {
    var enabled: Bool
    var onKey: (String) -> Void
    var size: CGFloat = 260
    @State private var pressed: String?
    @State private var repeater: Task<Void, Never>?
    @Environment(\.colorScheme) private var scheme

    private let okFraction: CGFloat = 0.4
    private let directions: [(key: String, symbol: String, angle: Angle)] = [
        ("up", "chevron.up", .degrees(-90)), ("right", "chevron.right", .degrees(0)),
        ("down", "chevron.down", .degrees(90)), ("left", "chevron.left", .degrees(180)),
    ]

    var body: some View {
        let r = size / 2
        let okR = r * okFraction
        ZStack {
            Circle()
                .fill(.clear)
                .glassEffect(.regular, in: .circle)
            // The pressed quarter lights up.
            ForEach(directions, id: \.key) { d in
                Quarter(angle: d.angle, inner: (okR + 6) / r)
                    .fill(RadialGradient(colors: [Color.accentColor.opacity(0.0), Color.accentColor.opacity(scheme == .dark ? 0.38 : 0.26)],
                                         center: .center, startRadius: okR, endRadius: r))
                    .opacity(pressed == d.key ? 1 : 0)
                Image(systemName: d.symbol)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(pressed == d.key ? Color.accentColor : Color.ink.opacity(0.75))
                    .offset(x: cos(d.angle.radians) * (r - 30), y: sin(d.angle.radians) * (r - 30))
            }
            Circle()
                .fill(pressed == "ok" ? Color.accentColor.opacity(0.85) : Color.fillHi)
                .overlay(Circle().strokeBorder(Color.line))
                .frame(width: okR * 2, height: okR * 2)
                .overlay(Text("OK").font(.system(size: 19, weight: .bold, design: .rounded))
                    .foregroundStyle(pressed == "ok" ? Color.white : Color.ink))
                .scaleEffect(pressed == "ok" ? 0.96 : 1)
        }
        .frame(width: size, height: size)
        .contentShape(Circle())
        .animation(.easeOut(duration: 0.12), value: pressed)
        .onTouch { phase, p in
            guard enabled else { return }
            switch phase {
            case .began:
                guard let key = zone(p, r: r, okR: okR) else { return }
                press(key)
            case .moved:
                break   // no swiping: the press stays what it was
            case .ended, .cancelled:
                release()
            }
        }
        .opacity(enabled ? 1 : 0.55)
        .onDisappear(perform: release)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Direction pad")
        .accessibilityHint("Swipe up or down to move, double-tap for OK")
        .accessibilityAction { onKey("ok") }
        .accessibilityAdjustableAction { dir in onKey(dir == .increment ? "up" : "down") }
        .accessibilityAction(named: "Left") { onKey("left") }
        .accessibilityAction(named: "Right") { onKey("right") }
    }

    /// Which key a point is: OK in the middle, a direction at the rim by its angle, nothing between.
    private func zone(_ p: CGPoint, r: CGFloat, okR: CGFloat) -> String? {
        let dx = p.x - r, dy = p.y - r
        let d = hypot(dx, dy)
        if d <= okR { return "ok" }
        if d < okR + 6 || d > r + 4 { return nil }
        let a = atan2(dy, dx) * 180 / .pi       // 0 right, 90 down
        if a >= -45 && a < 45 { return "right" }
        if a >= 45 && a < 135 { return "down" }
        if a >= -135 && a < -45 { return "up" }
        return "left"
    }

    private func press(_ key: String) {
        pressed = key
        fire(key)
        repeater?.cancel()
        guard key != "ok" else { return }
        repeater = Task {
            try? await Task.sleep(for: .milliseconds(300))
            while !Task.isCancelled {
                fire(key)
                try? await Task.sleep(for: .milliseconds(120))
            }
        }
    }

    private func fire(_ key: String) {
        if key == "ok" { Haptics.medium() } else { Haptics.tick() }
        onKey(key)
    }

    private func release() {
        repeater?.cancel()
        repeater = nil
        pressed = nil
    }
}

/// A quarter of a ring, centred on `angle`, from `inner` (a fraction of the radius) to the rim.
struct Quarter: Shape {
    var angle: Angle
    var inner: CGFloat

    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2
        var p = Path()
        p.addArc(center: c, radius: r, startAngle: angle - .degrees(45), endAngle: angle + .degrees(45), clockwise: false)
        p.addArc(center: c, radius: r * inner, startAngle: angle + .degrees(45), endAngle: angle - .degrees(45), clockwise: true)
        p.closeSubpath()
        return p
    }
}
