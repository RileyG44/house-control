import CoreGraphics
import Foundation

/// Compile with the renderer's StageFraming.swift. The expanded house must keep a full-width
/// viewport, and the camera's usable area must stay above the sheet throughout a drag.
@main
struct StageFramingChecks {
    static func main() {
        for (width, height, safeTop): (CGFloat, CGFloat, CGFloat) in [
            (375, 812, 44), (390, 844, 47), (393, 852, 59), (430, 932, 59), (440, 956, 62)
        ] {
            let size = CGSize(width: width, height: height)
            let rest = (min(470, height * 0.52) - 34).rounded()
            let expanded = min(rest, safeTop + 92)
            var lastHeight = height
            for step in -10...110 {
                let progress = CGFloat(step) / 100
                let f = StageFraming(size: size, safeTop: safeTop, restTop: rest,
                                     expandedTop: expanded, progress: progress)
                let sheetTop = rest + (expanded - rest) * f.progress
                let usableBottom = f.viewport.height - f.bottomInset
                precondition(f.viewport.width == width, "The landscape must reach both screen edges")
                precondition(f.viewport.height <= lastHeight, "Pulling up must shorten the viewport continuously")
                precondition(usableBottom - f.topInset >= 70, "The model needs usable space under the status bar")
                precondition(sheetTop - usableBottom >= 5.5 && sheetTop - usableBottom <= 10.5,
                             "The camera must frame the house above the moving sheet")
                precondition((0...1).contains(f.fadeStart), "The overlap fade must stay inside the viewport")
                if progress <= 0 { precondition(f.viewport == size, "Rest framing must stay full screen") }
                if progress >= 1 {
                    precondition(f.viewport.height > sheetTop + 50, "The scene must continue under the sheet")
                }
                lastHeight = f.viewport.height
            }
        }
        print("Native stage framing: full width, sheet clearance, drag continuity and overlap passed")
    }
}
