import SwiftUI
import UIKit

/// Reports where the sheet it sits in really is, every frame: while a finger drags it and while
/// the system's spring carries it to a detent (read from the presentation layer, which is where
/// an animation shows it). The 3D model is moved with this value, so both move together.
struct SheetProbe: UIViewRepresentable {
    var onMove: (CGFloat) -> Void

    func makeUIView(context: Context) -> ProbeView {
        let v = ProbeView()
        v.onMove = onMove
        v.isUserInteractionEnabled = false
        return v
    }

    func updateUIView(_ view: ProbeView, context: Context) { view.onMove = onMove }

    final class ProbeView: UIView {
        var onMove: ((CGFloat) -> Void)?
        private var link: CADisplayLink?
        private var last: CGFloat = .nan
        private var still = 0

        override func didMoveToWindow() {
            super.didMoveToWindow()
            link?.invalidate()
            link = nil
            guard window != nil else { return }
            let l = CADisplayLink(target: self, selector: #selector(step))
            l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            l.add(to: .main, forMode: .common)
            link = l
        }

        @objc private func step() {
            guard let window else { return }
            // The presentation layers' tree is where the sheet is on screen this frame.
            let mine = layer.presentation() ?? layer
            let root = window.layer.presentation() ?? window.layer
            let y = mine.convert(CGPoint.zero, to: root).y
            if abs(y - last) > 0.01 || last.isNaN {
                last = y
                onMove?(y)
                if still >= 20 { link?.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120) }
                still = 0
            } else {
                still += 1
                // At rest it only has to notice the next move: no need to keep the screen at 120 Hz.
                if still == 20 { link?.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30) }
            }
        }
    }
}
