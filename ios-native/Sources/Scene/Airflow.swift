import Foundation
import simd

/// The same curved, spreading path as the desktop renderer. Coordinates are relative to the
/// vent: low units skim along the floor instead of sending their air through it.
enum Airflow {
    static func point(_ t: Float, lane: Float, angle: Float, time: Float, phase: Float, floor: Float) -> SIMD3<Float> {
        let radians = angle * .pi / 180
        let distance = 2.5 * t
        let y = -sin(radians) * distance - 0.35 * t * t
        let under = max(0, floor - y)
        let sway = sin(time * 1.6 + phase + t * 5) * 0.035 * t
        return SIMD3(lane * (0.36 + 0.5 * t + under * 0.5) + sway,
                     y + under, cos(radians) * distance + under * 0.6)
    }

    static func speed(_ fan: String) -> Float {
        ["auto": 0.24, "low": 0.16, "medium": 0.24, "high": 0.34, "turbo": 0.45][fan] ?? 0.24
    }
}
