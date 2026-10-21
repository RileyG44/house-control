import SwiftUI
import UIKit
import UIKit.UIGestureRecognizerSubclass

/// A recognizer that takes the finger the moment it lands and keeps it until it lifts, so a
/// slider, the volume or the direction pad never starts a scroll or pulls the card instead.
final class ImmediatePan: UIGestureRecognizer {
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .possible { state = .began } else { state = .changed }
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) { state = .changed }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { state = .ended }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .cancelled }
    // Scrolling and the sheet's own drag wait for this one, which never fails while touched.
    override func shouldBeRequiredToFail(by other: UIGestureRecognizer) -> Bool { true }
    override func canBePrevented(by other: UIGestureRecognizer) -> Bool { false }
}

enum TouchPhase { case began, moved, ended, cancelled }

/// Reports a finger on a SwiftUI view, in that view's own coordinates.
struct TouchTracking: UIGestureRecognizerRepresentable {
    var handler: (TouchPhase, CGPoint) -> Void

    func makeUIGestureRecognizer(context: Context) -> ImmediatePan { ImmediatePan() }

    func handleUIGestureRecognizerAction(_ g: ImmediatePan, context: Context) {
        let p = context.converter.localLocation
        switch g.state {
        case .began: handler(.began, p)
        case .changed: handler(.moved, p)
        case .ended: handler(.ended, p)
        case .cancelled, .failed: handler(.cancelled, p)
        default: break
        }
    }
}

extension View {
    func onTouch(_ handler: @escaping (TouchPhase, CGPoint) -> Void) -> some View {
        gesture(TouchTracking(handler: handler))
    }
}

/// A slider on a gradient track (brightness, white temperature, an AC's set-point), with a tick
/// you can feel on every `detent` step.
struct GradientSlider: View {
    var value: Double
    var range: ClosedRange<Double>
    var step: Double = 1
    var detent: Double? = nil
    var colors: [Color]
    var height: CGFloat = 44
    var onChange: (Double) -> Void
    var onEnd: (Double) -> Void = { _ in }
    @State private var dragging: Double?
    @State private var lastNotch: Int?

    var body: some View {
        let shown = dragging ?? value
        let t = (shown - range.lowerBound) / (range.upperBound - range.lowerBound)
        GeometryReader { g in
            let w = g.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(LinearGradient(colors: colors, startPoint: .leading, endPoint: .trailing))
                Circle()
                    .fill(.white)
                    .frame(width: height - 8, height: height - 8)
                    .shadow(color: .black.opacity(0.3), radius: 4, y: 2)
                    .offset(x: 4 + CGFloat(min(1, max(0, t))) * (w - height))
                    .scaleEffect(dragging != nil ? 1.08 : 1)
            }
            .contentShape(Rectangle())
            .onTouch { phase, p in
                let raw = range.lowerBound + Double(min(1, max(0, (p.x - height / 2) / max(1, w - height)))) * (range.upperBound - range.lowerBound)
                let v = (raw / step).rounded() * step
                switch phase {
                case .began, .moved:
                    if let detent {
                        let notch = Int((v / detent).rounded(.down))
                        if lastNotch != nil, notch != lastNotch { Haptics.tick() }
                        lastNotch = notch
                    }
                    if v != dragging { dragging = v; onChange(v) }
                case .ended:
                    dragging = nil; lastNotch = nil; onEnd(v)
                case .cancelled:
                    dragging = nil; lastNotch = nil
                }
            }
        }
        .frame(height: height)
        .animation(.snappy(duration: 0.15), value: dragging != nil)
        .accessibilityElement()
        .accessibilityValue("\(Int(shown))")
        .accessibilityAdjustableAction { dir in
            let v = min(range.upperBound, max(range.lowerBound, value + (dir == .increment ? step : -step) * (detent.map { $0 / step } ?? 1)))
            onChange(v); onEnd(v)
        }
    }
}

/// A sideways slide across a tile (a lamp's brightness, an AC's set-point). The axis is decided
/// after ~8 pt: mostly up or down, it gives way so the card scrolls; mostly sideways, it takes
/// the finger (and the scroll and the card's drag wait for it). Held still, it gives way after
/// 0.3 s so a long press can lift the tile instead.
final class HorizontalSlide: UIPanGestureRecognizer {
    private var start: CGPoint = .zero
    private var timer: Timer?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        super.touchesBegan(touches, with: event)
        start = touches.first?.location(in: view) ?? .zero
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.state == .possible else { return }
                self.state = .failed
            }
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .possible, let p = touches.first?.location(in: view) {
            let dx = abs(p.x - start.x), dy = abs(p.y - start.y)
            if max(dx, dy) < 8 { return }
            if dy >= dx { state = .failed; return }
            timer?.invalidate()
        }
        super.touchesMoved(touches, with: event)
    }

    override func reset() {
        super.reset()
        timer?.invalidate()
        timer = nil
    }

    // The card's scroll view and the sheet's drag (pans in other views) wait to see which way it goes.
    override func shouldBeRequiredToFail(by other: UIGestureRecognizer) -> Bool {
        other is UIPanGestureRecognizer && other.view !== view
    }
}

struct SlideGesture: UIGestureRecognizerRepresentable {
    var onBegin: () -> Void
    var onChange: (CGFloat) -> Void      // horizontal travel since the start, in points
    var onEnd: () -> Void

    func makeUIGestureRecognizer(context: Context) -> HorizontalSlide {
        let g = HorizontalSlide()
        g.maximumNumberOfTouches = 1
        return g
    }

    func handleUIGestureRecognizerAction(_ g: HorizontalSlide, context: Context) {
        switch g.state {
        case .began: onBegin(); onChange(context.converter.localTranslation?.x ?? 0)
        case .changed: onChange(context.converter.localTranslation?.x ?? 0)
        case .ended, .cancelled, .failed: onEnd()
        default: break
        }
    }
}
