import CoreGraphics

/// The renderer always spans the screen. Only its height changes with the controls card,
/// so the camera can fit the house while the sky and landscape still reach both edges.
struct StageFraming: Equatable {
    static let tuck: CGFloat = 46
    private static let expandedInset = 16 + tuck
    private static let fadeLength = tuck * 1.6

    let viewport: CGSize
    let topInset: CGFloat
    let bottomInset: CGFloat
    let progress: CGFloat

    init(size: CGSize, safeTop: CGFloat, restTop: CGFloat, expandedTop: CGFloat, progress: CGFloat) {
        // Follow the sheet's upward stretch too, so it cannot cover the house's base.
        let p = min(1.08, max(0, progress))
        self.progress = p
        viewport = CGSize(width: size.width,
                          height: (size.height + (expandedTop + 10 + Self.tuck - size.height) * p).rounded())
        topInset = safeTop + 4
        let restBottom = size.height - restTop + 10
        bottomInset = restBottom + (Self.expandedInset - restBottom) * p
    }

    /// The renderer runs under the sheet; fade that overlap without narrowing the scene.
    var fadeStart: CGFloat {
        // A stretch reduces the overlap below the sheet. Keep the same short band of the
        // visible house in the fade rather than fading most of the remaining model.
        let length = min(Self.fadeLength, max(0, bottomInset + Self.fadeLength - Self.expandedInset))
        return max(0, 1 - length / max(1, viewport.height))
    }
}
