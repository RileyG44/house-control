import Foundation
import simd

/// Where the sun and the moon are, seen from the house: pure functions of a time and a place, so
/// day and night are right with no network at all (web/src/sky/sun.js). The sun is NOAA's solar
/// position (well under a degree); the moon a short series (a degree or so) and its phase. Angles
/// in and out are degrees; a bearing is the compass direction, 0 north, 90 east.
enum SunMoon {
    struct Place: Sendable, Equatable {
        var altitude: Double
        var bearing: Double
    }

    struct Moon: Sendable, Equatable {
        var altitude: Double
        var bearing: Double
        /// The fraction of its face in sunlight, 0 … 1.
        var lit: Double
        /// 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter.
        var phase: Double
    }

    private static let rad = Double.pi / 180
    private static let deg = 180 / Double.pi
    private static let j2000 = 2451545.0

    private static func julian(_ date: Date) -> Double { date.timeIntervalSince1970 / 86400 + 2440587.5 }
    private static func wrap(_ d: Double) -> Double { (d.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) }

    /// The sun's altitude and bearing at `date` from `lat`, `lon`.
    static func sun(at date: Date, lat: Double, lon: Double) -> Place {
        let jc = (julian(date) - j2000) / 36525
        let L = wrap(280.46646 + jc * (36000.76983 + jc * 0.0003032))          // mean longitude
        let M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc)                // mean anomaly
        let e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc)           // orbit eccentricity
        let c1: Double = sin(M * rad) * (1.914602 - jc * (0.004817 + 0.000014 * jc))
        let c2: Double = sin(2 * M * rad) * (0.019993 - 0.000101 * jc)
        let C: Double = c1 + c2 + sin(3 * M * rad) * 0.000289
        let omega = 125.04 - 1934.136 * jc
        let lambda = L + C - 0.00569 - 0.00478 * sin(omega * rad)              // apparent longitude
        let arcsec: Double = 21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))
        let eps0: Double = 23 + (26 + arcsec / 60) / 60
        let eps = eps0 + 0.00256 * cos(omega * rad)                            // obliquity
        let decl = asin(sin(eps * rad) * sin(lambda * rad))
        // The equation of time, in minutes: how far the sun runs ahead of the clock.
        let y: Double = pow(tan(eps / 2 * rad), 2)
        let q1: Double = y * sin(2 * L * rad) - 2 * e * sin(M * rad)
        let q2: Double = 4 * e * y * sin(M * rad) * cos(2 * L * rad)
        let q3: Double = 0.5 * y * y * sin(4 * L * rad) + 1.25 * e * e * sin(2 * M * rad)
        let eqTime: Double = 4 * deg * (q1 + q2 - q3)
        let secondsOfDay = date.timeIntervalSince1970 - (date.timeIntervalSince1970 / 86400).rounded(.down) * 86400
        let minutes = secondsOfDay / 60
        let solar = ((minutes + eqTime + 4 * lon).truncatingRemainder(dividingBy: 1440) + 1440).truncatingRemainder(dividingBy: 1440)
        let hourAngle = solar / 4 < 0 ? solar / 4 + 180 : solar / 4 - 180
        return horizon(lat, decl, hourAngle * rad)
    }

    /// Altitude and bearing of something at declination `decl` and hour angle `H` (radians).
    private static func horizon(_ lat: Double, _ decl: Double, _ H: Double) -> Place {
        let phi = lat * rad
        let alt = asin(sin(phi) * sin(decl) + cos(phi) * cos(decl) * cos(H))
        // Measured from south, turning west; +180 makes it a compass bearing.
        let az = atan2(sin(H), cos(H) * sin(phi) - tan(decl) * cos(phi))
        return Place(altitude: alt * deg + refraction(alt * deg), bearing: wrap(az * deg + 180))
    }

    /// The air lifts what is near the horizon by about half a degree.
    private static func refraction(_ alt: Double) -> Double {
        if alt < -2 { return 0 }
        return 1.02 / tan((alt + 10.3 / (alt + 5.11)) * rad) / 60
    }

    /// The moon's right ascension, declination (radians) and distance (km) `d` days after J2000.
    private static func moonCoords(_ d: Double) -> (ra: Double, dec: Double, dist: Double) {
        let L = (218.316 + 13.176396 * d) * rad   // ecliptic longitude
        let M = (134.963 + 13.064993 * d) * rad   // mean anomaly
        let F = (93.272 + 13.229350 * d) * rad    // mean distance from the node
        let l = L + 6.289 * rad * sin(M)
        let b = 5.128 * rad * sin(F)
        let e = 23.4397 * rad
        let ra: Double = atan2(sin(l) * cos(e) - tan(b) * sin(e), cos(l))
        let dec: Double = asin(sin(b) * cos(e) + cos(b) * sin(e) * sin(l))
        return (ra, dec, 385001 - 20905 * cos(M))
    }

    private static func sunCoords(_ d: Double) -> (ra: Double, dec: Double) {
        let M = (357.5291 + 0.98560028 * d) * rad
        let C: Double = (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M)) * rad
        let L: Double = M + C + 102.9372 * rad + Double.pi
        let e = 23.4397 * rad
        return (atan2(sin(L) * cos(e), cos(L)), asin(sin(e) * sin(L)))
    }

    /// The moon's altitude, bearing, lit fraction and phase at `date` from `lat`, `lon`.
    static func moon(at date: Date, lat: Double, lon: Double) -> Moon {
        let d = julian(date) - j2000
        let m = moonCoords(d)
        let sidereal = (280.16 + 360.9856235 * d) * rad + lon * rad
        let pos = horizon(lat, m.dec, sidereal - m.ra)
        let s = sunCoords(d)
        let sunKm = 149598000.0
        let phi = acos(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra))
        let inc = atan2(sunKm * sin(phi), m.dist - sunKm * cos(phi))
        let ay: Double = cos(s.dec) * sin(s.ra - m.ra)
        let ax: Double = sin(s.dec) * cos(m.dec) - cos(s.dec) * sin(m.dec) * cos(s.ra - m.ra)
        let angle = atan2(ay, ax)
        let side: Double = angle < 0 ? -1 : 1
        return Moon(altitude: pos.altitude, bearing: pos.bearing, lit: (1 + cos(inc)) / 2,
                    phase: 0.5 + 0.5 * inc * side / Double.pi)
    }

    /// A direction in the sky as a unit vector in the plan's frame (x right, y up, z towards the
    /// plan's bottom): the plan's -z points at compass bearing `planUp`, so bearing b lies at -z
    /// turned clockwise (seen from above, as the plan is drawn) by b - planUp.
    static func planDirection(bearing: Double, altitude: Double, planUp: Double) -> SIMD3<Float> {
        let turn = (bearing - planUp) * rad
        let alt = altitude * rad
        return SIMD3(Float(cos(alt) * sin(turn)), Float(sin(alt)), Float(-cos(alt) * cos(turn)))
    }

    /// 0 at night (sun below -6°), 1 by day (above +6°), easing through twilight.
    static func daylight(_ altitude: Double) -> Double {
        let t = min(1, max(0, (altitude + 6) / 12))
        return t * t * (3 - 2 * t)
    }
}
