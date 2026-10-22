import Foundation
import simd

/// Run with Airflow.swift, so this checks the native renderer's actual path on macOS without
/// an iOS simulator or a device. Low vents must never animate streaks under the floor.
@main
struct AirflowChecks {
    static func main() {
        for height: Float in [0.2, 0.6, 2.15] {
            let floor: Float = 0.025 - (height - 0.17)
            for angle: Float in [12, 38, 66] {
                for step in 0...100 {
                    let p = Airflow.point(Float(step) / 100, lane: 0.8, angle: angle, time: 3, phase: 0.4, floor: floor)
                    precondition(p.x.isFinite && p.y.isFinite && p.z.isFinite)
                    precondition(height - 0.17 + p.y >= 0.0249, "Air crossed the floor")
                }
            }
        }
        let a = Airflow.point(0.2, lane: 0.8, angle: 38, time: 0, phase: 0, floor: -2)
        let b = Airflow.point(0.6, lane: 0.8, angle: 38, time: 0, phase: 0, floor: -2)
        precondition(b.z > a.z && b.y < a.y, "Air must travel out and down")
        precondition(Airflow.speed("low") < Airflow.speed("high") && Airflow.speed("high") < Airflow.speed("turbo"))
        print("Native airflow: floor clearance, travel and fan speeds passed")
    }
}
