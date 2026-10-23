import CoreGraphics

/// The renderer always spans the screen. Only its height changes with the controls card,
/// so the camera can fit the house while the sky and landscape still reach both edges.
struct StageFraming: Equatable {
    static let tuck: CGFloat = 46

    let viewport: CGSize
    let topInset: CGFloat
    let bottomInset: CGFloat
    let progress: CGFloat

    init(size: CGSize, safeTop: CGFloat, restTop: CGFloat, expandedTop: CGFloat, progress: CGFloat) {
        let p = min(1, max(0, progress))
        self.progress = p
        viewport = CGSize(width: size.width,
                          height: (size.height + (expandedTop + 10 + Self.tuck - size.height) * p).rounded())
        topInset = safeTop + 4
        let restBottom = size.height - restTop + 10
        bottomInset = restBottom + (16 + Self.tuck - restBottom) * p
    }

    /// The renderer runs under the sheet; fade that overlap without narrowing the scene.
    var fadeStart: CGFloat { max(0, 1 - Self.tuck * 1.6 / max(1, viewport.height)) }
}
