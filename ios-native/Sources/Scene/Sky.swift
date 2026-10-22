import CoreGraphics
import Foundation
import RealityKit
import UIKit
import simd

/// The look the sky gives the stage at one moment (web/src/three/sky.js `goal` and `look`): the
/// sky's own colours, the fog, the ground's wetness and snow, and the light on the model.
struct SkyLook: Equatable {
    var zenith = RGB(hex: "#050916"), horizon = RGB(hex: "#121a2e"), glow = RGB(0, 0, 0)
    var sunColor = RGB(0, 0, 0)
    var moonLight = 0.0, stars = 0.0, cover = 0.35
    var cloudLit = RGB(hex: "#1b1f28"), cloudDark = RGB(hex: "#0b0d12")
    var fog = RGB(hex: "#121a2e")
    var fogStart = 120.0, fogLen = 1200.0, fogMax = 0.75
    var wet = 0.0, snowCover = 0.0, frost = 0.0
    /// The hemisphere light (the house's image-based light): sky and ground colours, strength.
    var hemiSky = RGB(hex: "#8ea6ff"), hemiGround = RGB(hex: "#0b0e17"), hemi = 0.42
    /// The sun's or the moon's light: colour, strength (the web's units), and where it comes from.
    var light = RGB(hex: "#a9c0ff"), lightI = 0.6
    var exposure = 1.0
    var dir = SIMD3<Float>(0, 1, 0)
    var day = 0.0

    /// How much fog lies over something `d` metres out from the house.
    func fogAt(_ d: Double) -> Double { fogMax * (1 - exp(-max(d - fogStart, 0) / max(fogLen, 0.1))) }

    /// A fraction `k` of the way to `g`.
    func toward(_ g: SkyLook, _ k: Double) -> SkyLook {
        var o = self
        o.zenith = zenith.lerp(g.zenith, k); o.horizon = horizon.lerp(g.horizon, k); o.glow = glow.lerp(g.glow, k)
        o.sunColor = sunColor.lerp(g.sunColor, k)
        o.moonLight += (g.moonLight - moonLight) * k; o.stars += (g.stars - stars) * k; o.cover += (g.cover - cover) * k
        o.cloudLit = cloudLit.lerp(g.cloudLit, k); o.cloudDark = cloudDark.lerp(g.cloudDark, k)
        o.fog = fog.lerp(g.fog, k)
        o.fogStart += (g.fogStart - fogStart) * k; o.fogLen += (g.fogLen - fogLen) * k; o.fogMax += (g.fogMax - fogMax) * k
        o.wet += (g.wet - wet) * k; o.snowCover += (g.snowCover - snowCover) * k; o.frost += (g.frost - frost) * k
        o.hemiSky = hemiSky.lerp(g.hemiSky, k); o.hemiGround = hemiGround.lerp(g.hemiGround, k); o.hemi += (g.hemi - hemi) * k
        o.light = light.lerp(g.light, k); o.lightI += (g.lightI - lightI) * k
        o.exposure += (g.exposure - exposure) * k
        o.day += (g.day - day) * k
        let d = dir + (g.dir - dir) * Float(k)
        o.dir = simd_length(d) > 1e-4 ? simd_normalize(d) : g.dir
        return o
    }

    /// How far apart two looks are: a real change, or only the sun creeping on.
    func gap(_ g: SkyLook) -> Double {
        var d = zenith.gap(g.zenith) + horizon.gap(g.horizon) + hemiSky.gap(g.hemiSky) + hemiGround.gap(g.hemiGround)
        d += light.gap(g.light) + cloudLit.gap(g.cloudLit) + fog.gap(g.fog) + glow.gap(g.glow)
        d += abs(hemi - g.hemi) + abs(lightI - g.lightI) / 2 + abs(cover - g.cover) + abs(stars - g.stars)
        d += abs(wet - g.wet) + abs(snowCover - g.snowCover) + abs(fogMax - g.fogMax) + abs(log(max(fogLen, 1) / max(g.fogLen, 1))) / 4
        d += Double(simd_distance(dir, g.dir))
        return d
    }
}

extension RGB {
    /// The summed difference of the channels.
    func gap(_ o: RGB) -> Double { abs(r - o.r) + abs(g - o.g) + abs(b - o.b) }
    func scaled(_ k: Double) -> RGB { RGB(r * k, g * k, b * k) }
    var clamped: RGB { RGB(min(1, max(0, r)), min(1, max(0, g)), min(1, max(0, b))) }
}

/// 0 below `a`, 1 above `b`, easing between (GLSL's smoothstep).
func smoothStep(_ a: Double, _ b: Double, _ v: Double) -> Double {
    let t = min(1, max(0, (v - a) / (b - a)))
    return t * t * (3 - 2 * t)
}

/// The real sky over the house (docs/landscape-weather.md, web/src/three/sky.js): the sun and
/// the moon where they really are, the weather the hub reads, and the stage's light that follows
/// them. Only for a plan with a `site`. The camera looks down on the model, so the sky itself is
/// rarely in view: it shows in the light, in the lake (lit by an image of the sky, clouds and
/// stars included), in the falling rain or snow, and in a dome with drifting clouds behind it all.
@MainActor
final class Sky {
    static let domeRadius: Float = 2200
    static let sunEvery: Double = 30          // seconds between sun and moon positions
    static let ease: Double = 1.6             // how fast the look follows a change (1/s)
    static let refreshEvery: Double = 180     // the sky's images are made again at most this often as the sun moves
    static let minSun = 20.0, minMoon = 30.0  // the light never comes in lower (the rooms stay readable)
    static let volume: Float = 32             // metres across the box rain and snow fall in
    static let volumeHeight: Float = 15
    static let puffCount = 36
    /// How much each kind darkens the day, beyond its clouds.
    static let gloom: [String: Double] = ["storm": 0.8, "rain": 0.34, "drizzle": 0.24, "snow": 0.16, "fog": 0.26, "overcast": 0.12]

    private enum Pal {
        static let dayZenith = RGB(hex: "#3b74c9"), dayHorizon = RGB(hex: "#b9d3ec")
        static let greyZenith = RGB(hex: "#8c96a1"), greyHorizon = RGB(hex: "#b7bec5")
        static let stormZenith = RGB(hex: "#3c434c"), stormHorizon = RGB(hex: "#646c74")
        static let nightZenith = RGB(hex: "#050916"), nightHorizon = RGB(hex: "#121a2e")
        static let nightGreyZenith = RGB(hex: "#0b0d12"), nightGreyHorizon = RGB(hex: "#1c1d22")
        static let twZenith = RGB(hex: "#2c3d76"), twHorizon = RGB(hex: "#e8995e"), twGlow = RGB(hex: "#ff8c3a")
        static let fogDay = RGB(hex: "#c3c8cc"), fogNight = RGB(hex: "#22252b")
        static let cloudDay = RGB(hex: "#f4f6f8"), cloudGrey = RGB(hex: "#9aa3ac"), cloudNight = RGB(hex: "#1b1f28"), cloudDusk = RGB(hex: "#e7a37c")
        // The stage: today's dark look by night, its light look by a clear day.
        static let hemiNight = RGB(hex: "#8ea6ff"), hemiDay = RGB(hex: "#fff4e6"), hemiGrey = RGB(hex: "#e4e9ee"), hemiDusk = RGB(hex: "#ffc196")
        static let icy = RGB(hex: "#9fb3c8")
        static let groundNight = RGB(hex: "#0b0e17"), groundDay = RGB(hex: "#8f9172"), groundSnow = RGB(hex: "#dfe4ea")
        static let moonLight = RGB(hex: "#a9c0ff"), sunNoon = RGB(hex: "#fff0dc"), sunLow = RGB(hex: "#ffa45e")
        static let rain = RGB(hex: "#c9d4e4")
    }

    /// What falls: rain (or drizzle) or snow, how much and how fast.
    struct Precip: Equatable {
        var snow: Bool
        var count: Double          // particles in the air at once, over the whole volume
        var speed: Float           // m/s
        var size: Float            // m
        var drift: SIMD2<Float>    // m/s sideways, with the wind
        var stretch: Float
        var color: RGB
    }

    let root = Entity()
    let site: Site
    /// The lake's image-based light: the sky itself, so the water mirrors it.
    let waterIBL = Entity()
    private let center: SIMD3<Float>
    private let bounds: (lo: SIMD2<Float>, hi: SIMD2<Float>)
    private let nightDir: SIMD3<Float>
    private let reduceMotion: Bool

    private(set) var look = SkyLook()
    private var goal = SkyLook()
    /// Reduced motion: no drifting, no flashes, rain and snow standing still.
    var still: Bool { reduceMotion }
    private(set) var reading: WeatherReading?
    private(set) var sunDir = SIMD3<Float>(0, -1, 0)
    private(set) var moonDir = SIMD3<Float>(0, -1, 0)
    private var moonLit = 0.0
    private var sinceSun = 0.0
    /// Where the wind blows towards (x, z), and its speed in m/s.
    private(set) var wind = SIMD3<Float>(0, 0, 0)
    /// Seconds of drift so far (still with reduced motion).
    private(set) var clock: Double = 0

    // Lightning: a flash every 6–20 s in a storm, two quick pulses.
    private(set) var flash: Float = 0
    private var flashT: Double = -1
    private var nextFlash: Double = 5
    private var storm = false

    // The images of the sky, made again on a change of weather or every few minutes: the
    // house's light and the lake's, each blended from the last image to the new one.
    private var houseEnv: (from: EnvironmentResource?, to: EnvironmentResource?) = (nil, nil)
    private var waterEnv: (from: EnvironmentResource?, to: EnvironmentResource?) = (nil, nil)
    private var envT: Double = 1
    private var envLook = SkyLook()
    private var envAge: Double = 0
    private var cloudShift = SIMD2<Float>(0, 0)
    private var lightDirty = true
    private var litDir = SIMD3<Float>(0, 0, 0)

    private var dome: ModelEntity?
    private var puffs: [(entity: Entity, top: ModelEntity, base: ModelEntity, pos: SIMD3<Float>)] = []
    private var puffLook = SkyLook()
    private var precip: Precip?
    private var emitters: [Entity] = []
    private var stillFor: Double = 0

    init(plan: Plan, site: Site, camDir: P2) {
        self.site = site
        center = SIMD3(Float(plan.center.x), 0, Float(plan.center.y))
        bounds = (SIMD2(Float(plan.minX), Float(plan.minZ)), SIMD2(Float(plan.maxX), Float(plan.maxZ)))
        // Today's night light: steep, from the viewer's side (HomeScene's moon).
        nightDir = simd_normalize(SIMD3(Float(camDir.x) * 3.2 + 1.5, 10, Float(camDir.y) * 3.2 - 1.5))
        reduceMotion = UIAccessibility.isReduceMotionEnabled
        root.name = "sky"
        root.addChild(waterIBL)
        buildDome()
        buildPuffs()
    }

    // MARK: - the weather and the sun

    /// A new reading from the hub (nil: none, the plain look).
    func take(_ next: WeatherReading?) {
        guard next != reading else { return }
        reading = next
        place()
    }

    /// Jumps to the look for now (the first frame).
    func settle() {
        place()
        look = goal
        envT = 1
        houseEnv = (nil, nil)
        waterEnv = (nil, nil)
        refreshImages()
        colourPuffs()
    }

    var now: Date { SkyOverride.now(lon: site.lon, sunrise: reading?.sunrise) }

    /// The month at the house (1 … 12), for the field and the grass.
    var month: Int {
        let at = now
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: SkyOverride.utcOffset(lon: site.lon, sunrise: reading?.sunrise, at: at)) ?? .current
        return utc.component(.month, from: at)
    }

    private func place() {
        let at = now
        let s = SunMoon.sun(at: at, lat: site.lat, lon: site.lon)
        let m = SunMoon.moon(at: at, lat: site.lat, lon: site.lon)
        sunDir = SunMoon.planDirection(bearing: s.bearing, altitude: s.altitude, planUp: site.planUp)
        moonDir = SunMoon.planDirection(bearing: m.bearing, altitude: m.altitude, planUp: site.planUp)
        moonLit = m.lit
        aim(sunAlt: s.altitude, moonAlt: m.altitude)
    }

    /// Where every part of the look should be for the sun, the moon and the weather now.
    private func aim(sunAlt: Double, moonAlt: Double) {
        let r = reading ?? .plain
        let kind = r.kind
        let cover = min(1, max(0, r.cloud / 100))
        let grey = pow(cover, 1.4)
        let gloom = (Self.gloom[kind] ?? 0) * (0.5 + cover * 0.5)
        let day = SunMoon.daylight(sunAlt)
        // Twilight: a warm band towards the sun just before it rises and after it sets.
        let twA = (sunAlt + 1) / 6
        let tw = exp(-twA * twA) * (1 - cover * 0.75)
        let moonUp = smoothStep(-2, 8, moonAlt)
        var g = SkyLook()

        let dayZ = Pal.dayZenith.lerp(Pal.greyZenith, grey).lerp(Pal.stormZenith, min(1, gloom * 1.2))
        let dayH = Pal.dayHorizon.lerp(Pal.greyHorizon, grey).lerp(Pal.stormHorizon, min(1, gloom * 1.2))
        // A bright moon lifts the night sky a little.
        let nz = Pal.nightZenith.lerp(Pal.nightGreyZenith, cover).scaled(1 + 0.5 * moonUp * moonLit * (1 - cover))
        let nh = Pal.nightHorizon.lerp(Pal.nightGreyHorizon, cover)
        g.zenith = nz.lerp(dayZ, day).lerp(Pal.twZenith, tw * 0.45)
        g.horizon = nh.lerp(dayH, day).lerp(Pal.twHorizon, tw * 0.7)
        g.glow = Pal.twGlow.scaled(tw * 0.55)
        g.sunColor = Pal.sunLow.lerp(Pal.sunNoon, smoothStep(0, 25, sunAlt)).scaled(smoothStep(-1, 2, sunAlt) * (1 - grey * 0.97))
        g.moonLight = moonUp * (0.35 + moonLit * 0.65) * (1 - cover * 0.95)
        g.stars = (1 - day) * pow(1 - cover, 2) * (1 - 0.6 * moonUp * moonLit)
        g.cover = cover
        g.cloudLit = Pal.cloudNight.lerp(Pal.cloudDay, day).lerp(Pal.cloudDusk, tw * 0.6).lerp(Pal.cloudGrey, gloom)
        g.cloudDark = g.cloudLit.lerp(Pal.stormZenith, 0.45 + gloom * 0.4).scaled(0.35 + day * 0.65)
        // Freezing drizzle and rain: a cold blue-grey cast.
        let icy = [56, 57, 66, 67].contains(r.code) ? 0.35 : 0

        // Haze: far hills fade softly; fog swallows the field and the lake within 60–150 m.
        let rainy = ["rain", "storm", "snow", "drizzle"].contains(kind)
        if kind == "fog" {
            let vis = min(1000, max(60, r.visibility))
            g.fogStart = 0; g.fogLen = min(30, max(8, vis / 10)); g.fogMax = 1
            g.fog = Pal.fogNight.lerp(Pal.fogDay, day)
        } else {
            let vis = min(24000, max(1000, r.visibility))
            g.fogStart = rainy ? 25 : 120; g.fogLen = rainy ? 260 : vis / 20; g.fogMax = rainy ? 0.85 : 0.75
            g.fog = g.horizon
        }

        // The ground: wet in the rain, white under snow, frosted by rime fog.
        let wetness: [String: Double] = ["rain": 1, "storm": 1, "drizzle": 0.55]
        g.wet = wetness[kind] ?? 0
        g.snowCover = max(smoothStep(0.01, 0.05, r.snowDepth), kind == "snow" ? 0.35 : 0)
        g.frost = r.code == 48 ? 1 : 0

        // The stage: night is today's dark look (lamps glowing), a clear noon its light look.
        let sunVis = (1 - 0.82 * pow(cover, 1.6)) * (1 - gloom)
        g.hemiSky = Pal.hemiNight.lerp(Pal.hemiDay.lerp(g.horizon, 0.25), day)
            .lerp(Pal.hemiGrey, day * grey * 0.6).lerp(Pal.hemiDusk, tw * 0.5).lerp(Pal.icy, icy)
        g.horizon = g.horizon.lerp(Pal.icy, icy * 0.5)
        g.zenith = g.zenith.lerp(Pal.icy, icy * 0.3)
        g.hemiGround = Pal.groundNight.lerp(g.snowCover > 0.5 ? Pal.groundSnow : Pal.groundDay, day)
        g.hemi = (0.42 + (1.55 - 0.42) * day) * (1 + 0.12 * cover * day) * (1 - 0.6 * gloom)
        let moonI = 0.6 * (0.7 + 0.3 * moonUp * moonLit)
        let sunI = 2.1 * sunVis * smoothStep(-3, 7, sunAlt)
        g.lightI = moonI + (sunI - moonI) * day
        g.light = Pal.moonLight.lerp(Pal.sunLow.lerp(Pal.sunNoon, smoothStep(2, 22, sunAlt)), day)
        g.exposure = (1.05 + (1.0 - 1.05) * day) * (1 - 0.18 * gloom)
        g.day = day

        // The light comes from the sun by day and the moon by night, never too low to read the
        // rooms by; with no moon up, from where the stage's night light always came.
        let sunL = Self.lift(sunDir, Self.minSun)
        let moonL = moonAlt > 2 ? Self.lift(moonDir, Self.minMoon) : nightDir
        let nightL = moonL + (nightDir - moonL) * Float(1 - moonUp)
        let d = nightL + (sunL - nightL) * Float(smoothStep(0.25, 0.75, day))
        g.dir = simd_length(d) > 1e-4 ? simd_normalize(d) : nightDir
        goal = g

        // What falls, and how much of it.
        let speed = Float(min(60, r.wind) / 3.6)   // m/s
        let towards = SunMoon.planDirection(bearing: r.windDir + 180, altitude: 0, planUp: site.planUp)
        wind = SIMD3(towards.x, towards.z, speed)
        let flat = SIMD2(towards.x, towards.z)
        storm = kind == "storm"
        // Rain and snow catch the light of the sky around them (in steps: a new colour starts them again).
        let lit = ((0.25 + min(1, g.hemi / 1.5) * 0.75) * 8).rounded() / 8
        var next: Precip?
        if kind == "snow" {
            let grains = r.code == 77
            let count = grains ? 700 : min(3000, max(1200, (r.snow > 0 ? r.snow : 0.5) * 2600))
            next = Precip(snow: true, count: count, speed: grains ? 1.6 : 1.1, size: grains ? 0.035 : 0.07,
                          drift: flat * min(speed, 9) * 0.55, stretch: 0, color: RGB(1, 1, 1).scaled(min(1, 0.35 + lit * 0.75)))
        } else if rainy {
            let drizzle = kind == "drizzle"
            let rate = max(r.precip, drizzle ? 0.2 : 1)
            let count = min(3200, drizzle ? 2400 : 900 + rate * 400 + (storm ? 1200 : 0))
            next = Precip(snow: false, count: count, speed: drizzle ? 4 : storm ? 12 : 9.5, size: drizzle ? 0.008 : 0.012,
                          drift: flat * min(speed, 15) * 0.6, stretch: drizzle ? 2 : 6, color: Pal.rain.scaled(lit))
        }
        if next != precip {
            precip = next
            buildPrecip()
        }
    }

    /// `dir` with its altitude raised to at least `min` degrees, its bearing kept.
    private static func lift(_ dir: SIMD3<Float>, _ minAlt: Double) -> SIMD3<Float> {
        let alt = asin(Double(min(1, max(-1, dir.y))))
        let want = max(alt, minAlt * .pi / 180)
        let flat = max(1e-4, (Double(dir.x * dir.x + dir.z * dir.z)).squareRoot())
        return SIMD3(Float(Double(dir.x) / flat * cos(want)), Float(sin(want)), Float(Double(dir.z) / flat * cos(want)))
    }

    // MARK: - every frame

    /// Moves the sky on by `dt`: the sun now and then, the look towards its goal, the clouds and
    /// the lightning. True when the stage's light has changed (HomeScene.applyLook then runs).
    func update(dt: Double) -> Bool {
        sinceSun += dt
        envAge += dt
        if sinceSun >= Self.sunEvery {
            sinceSun = 0
            place()
        }
        var changed = false
        let gap = look.gap(goal)
        if gap > 0.002 {
            look = look.toward(goal, 1 - exp(-dt * Self.ease))
            changed = true
        } else if look != goal {
            look = goal
            changed = true
        }
        // A change of weather (or the sun on the move for a few minutes): new images of the sky.
        let drift = envLook.gap(goal)
        if drift > 0.12 || (drift > 0.01 && envAge >= Self.refreshEvery) { refreshImages() }
        if envT < 1 {
            envT = min(1, envT + (1 - envT) * (1 - exp(-dt * Self.ease)) + dt * 0.01)
            if envT > 0.998 { envT = 1 }
            lightDirty = true
            changed = true
        }
        if !reduceMotion {
            clock += dt
            let w = SIMD2(wind.x, wind.y) * max(1, wind.z)
            cloudShift += w * Float(dt) * 0.004
            movePuffs(dt)
        }
        if stepStorm(dt) { changed = true }
        holdStill(dt)
        if changed { lightDirty = true }
        if puffLook.gap(look) > 0.05 { colourPuffs() }
        return changed
    }

    /// Lights the stage from the sky: the house's image-based light (the hemisphere's colours),
    /// the lake's (the sky itself), and the sun's or the moon's light from where it really is.
    func light(ibl: Entity, sun: Entity) {
        guard lightDirty else { return }
        lightDirty = false
        let f = Double(flash)
        let hemiT = min(1.2, max(-0.5, (look.hemi - 0.42) / (1.55 - 0.42)))
        let houseExp = Float(-0.35 + 1.35 * hemiT + log2(max(0.3, look.exposure)) + f * 1.2)
        if let a = houseEnv.from ?? houseEnv.to, let b = houseEnv.to {
            ibl.components.set(ImageBasedLightComponent(source: .blend(a, b, Float(envT)), intensityExponent: houseExp))
        }
        if let a = waterEnv.from ?? waterEnv.to, let b = waterEnv.to {
            waterIBL.components.set(ImageBasedLightComponent(source: .blend(a, b, Float(envT)), intensityExponent: Float(0.15 + f * 2)))
        }
        if var dl = sun.components[DirectionalLightComponent.self] {
            // The web's light strength in this scene's units: the moon's 0.6 is the dark look's
            // 700, a clear noon's 2.1 the light look's 4200.
            let x = look.lightI
            let lux = x <= 0.6 ? x / 0.6 * 700 : 700 + (x - 0.6) / 1.5 * 3500
            dl.color = UIColor(rgb: look.light.lerp(RGB(hex: "#e6ecff"), min(1, f)).clamped)
            dl.intensity = Float(max(60, lux) + f * 6000)
            sun.components.set(dl)
        }
        if simd_distance(litDir, look.dir) > 0.008 {
            litDir = look.dir
            sun.look(at: center, from: center + look.dir * 28, relativeTo: nil)
        }
    }

    // Lightning: a flash every 6–20 s, two quick pulses (none with reduced motion).
    private func stepStorm(_ dt: Double) -> Bool {
        guard storm, !reduceMotion else {
            if flash != 0 { flash = 0; flashT = -1; return true }
            return false
        }
        nextFlash -= dt
        if nextFlash <= 0, flashT < 0 { flashT = 0; nextFlash = 6 + Double.random(in: 0...14) }
        guard flashT >= 0 else { return false }
        flashT += dt
        let second = flashT > 0.16 ? 0.7 * exp(-(flashT - 0.16) / 0.12) : 0
        flash = Float(exp(-flashT / 0.07) + second)
        if flashT > 0.9 { flash = 0; flashT = -1 }
        return true
    }

    // MARK: - the images of the sky

    private func refreshImages() {
        envAge = 0
        // Mid-way through a blend, the light as it is now is where the next one starts.
        let start = envT >= 1 ? houseEnv.to : HomeScene.environment(sky: look.hemiSky, ground: look.hemiGround)
        let waterStart = envT >= 1 ? waterEnv.to : Self.skyImage(look, sun: sunDir, moon: moonDir, clouds: true, shift: cloudShift, width: 256, height: 128).flatMap { try? EnvironmentResource(equirectangular: $0) }
        houseEnv = (start, HomeScene.environment(sky: goal.hemiSky, ground: goal.hemiGround))
        let water = Self.skyImage(goal, sun: sunDir, moon: moonDir, clouds: true, shift: cloudShift, width: 256, height: 128)
        waterEnv = (waterStart, water.flatMap { try? EnvironmentResource(equirectangular: $0) })
        envT = houseEnv.from == nil ? 1 : 0
        envLook = goal
        lightDirty = true
        // The dome shows the new sky at once (it is far, and mostly out of view).
        if let dome, let img = Self.skyImage(goal, sun: sunDir, moon: moonDir, clouds: false, shift: .zero, width: 512, height: 256),
           let tex = try? TextureResource(image: img, options: .init(semantic: .color, mipmapsMode: .allocateAndGenerateAll)) {
            var m = UnlitMaterial()
            m.color = .init(tint: .white, texture: .init(tex))
            dome.model?.materials = [m]
        }
    }

    /// Where a direction falls in an image of the whole sky (x across, 0 … 1, as the dome's
    /// texture wraps round; y up, 0 at the nadir, 1 at the zenith).
    private static func spot(_ d: SIMD3<Float>) -> (u: Double, v: Double) {
        let phi = atan2(Double(d.z), Double(-d.x))
        var u = phi / (2 * .pi)
        if u < 0 { u += 1 }
        let alt = asin(Double(min(1, max(-1, d.y))))
        return (u, 0.5 + alt / .pi)
    }

    /// The whole sky as an equirectangular image: the gradient, the twilight glow, the sun, the
    /// moon, the stars and (for the lake's light) the clouds. Below the horizon it mirrors.
    static func skyImage(_ l: SkyLook, sun: SIMD3<Float>, moon: SIMD3<Float>, clouds: Bool, shift: SIMD2<Float>,
                         width w: Int, height h: Int) -> CGImage? {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let W = CGFloat(w), H = CGFloat(h)
        // The gradient: the zenith at the top, the horizon across the middle, mirrored below.
        let mid = l.zenith.lerp(l.horizon, 0.6)
        let colors = [l.zenith, mid, l.horizon, mid, l.zenith].map { UIColor(rgb: $0.clamped).cgColor } as CFArray
        if let g = CGGradient(colorsSpace: cs, colors: colors, locations: [0, 0.3, 0.5, 0.7, 1]) {
            ctx.drawLinearGradient(g, start: CGPoint(x: 0, y: H), end: CGPoint(x: 0, y: 0), options: [])
        }
        ctx.setBlendMode(.plusLighter)
        // The glow towards the sun at sunrise and sunset, wide along the horizon.
        let s = spot(sun)
        if l.glow.r + l.glow.g + l.glow.b > 0.02 {
            let glow = [UIColor(rgb: l.glow.clamped).cgColor, UIColor(rgb: l.glow.clamped, alpha: 0).cgColor] as CFArray
            if let g = CGGradient(colorsSpace: cs, colors: glow, locations: [0, 1]) {
                for k in [-1.0, 0, 1] {
                    ctx.saveGState()
                    ctx.translateBy(x: CGFloat(s.u + k) * W, y: H / 2)
                    ctx.scaleBy(x: 2.4, y: 1)
                    ctx.drawRadialGradient(g, startCenter: .zero, startRadius: 0, endCenter: .zero, endRadius: H * 0.22, options: [])
                    ctx.restoreGState()
                }
            }
        }
        // Stars, fewer near a bright moon (and none under cloud).
        if l.stars > 0.02 {
            var rand = Materials.Rng(4711)
            for _ in 0..<(w * h / 90) {
                let x = CGFloat(rand.next()) * W
                let y = H * CGFloat(0.53 + rand.next() * 0.47)
                let a = l.stars * (0.25 + 0.75 * rand.next() * rand.next())
                ctx.setFillColor(UIColor(white: 1, alpha: CGFloat(min(1, a))).cgColor)
                ctx.fill(CGRect(x: x, y: y, width: 1, height: 1))
            }
        }
        // The moon and the sun, when they are up.
        let m = spot(moon)
        if l.moonLight > 0.02, m.v > 0.49 {
            let r = max(1.5, H * 0.012)
            ctx.setFillColor(UIColor(rgb: RGB(0.85, 0.88, 0.95).scaled(min(1, l.moonLight + 0.2)), alpha: 1).cgColor)
            ctx.fillEllipse(in: CGRect(x: CGFloat(m.u) * W - r, y: CGFloat(m.v) * H - r, width: r * 2, height: r * 2))
        }
        if l.sunColor.r + l.sunColor.g + l.sunColor.b > 0.05, s.v > 0.48 {
            let r = max(2, H * 0.016)
            ctx.setFillColor(UIColor(rgb: l.sunColor.clamped, alpha: 0.35).cgColor)
            ctx.fillEllipse(in: CGRect(x: CGFloat(s.u) * W - r * 3, y: CGFloat(s.v) * H - r * 3, width: r * 6, height: r * 6))
            ctx.setFillColor(UIColor(rgb: l.sunColor.clamped, alpha: 1).cgColor)
            ctx.fillEllipse(in: CGRect(x: CGFloat(s.u) * W - r, y: CGFloat(s.v) * H - r, width: r * 2, height: r * 2))
        }
        ctx.setBlendMode(.normal)
        // Clouds: soft heaps whose number follows the cover, drifting with the wind between images.
        if clouds, l.cover > 0.02 {
            var rand = Materials.Rng(1907)
            let count = Int(l.cover * 90)
            let dx = Double(shift.x)
            for _ in 0..<count {
                let u = (rand.next() + dx).truncatingRemainder(dividingBy: 1)
                let alt = pow(rand.next(), 1.8) * 0.55 + 0.02      // most near the horizon
                let x = CGFloat(u < 0 ? u + 1 : u) * W
                let y = H * CGFloat(0.5 + alt / 2)
                let cw = W * CGFloat(0.03 + rand.next() * 0.06) * CGFloat(1 + l.cover)
                let ch = cw * CGFloat(0.22 + alt * 0.5)
                for k in [-1.0, 0, 1] {
                    let ox = CGFloat(k) * W
                    ctx.setFillColor(UIColor(rgb: l.cloudDark.clamped, alpha: 0.55).cgColor)
                    ctx.fillEllipse(in: CGRect(x: x + ox - cw / 2, y: y - ch * 0.55, width: cw, height: ch * 0.7))
                    ctx.setFillColor(UIColor(rgb: l.cloudLit.clamped, alpha: 0.6).cgColor)
                    ctx.fillEllipse(in: CGRect(x: x + ox - cw * 0.4, y: y - ch * 0.3, width: cw * 0.8, height: ch))
                    ctx.fillEllipse(in: CGRect(x: x + ox - cw * 0.1, y: y - ch * 0.1, width: cw * 0.55, height: ch * 0.85))
                }
            }
            // Overcast: one grey lid over everything.
            if l.cover > 0.75 {
                ctx.setFillColor(UIColor(rgb: l.cloudLit.lerp(l.cloudDark, 0.5).clamped, alpha: CGFloat((l.cover - 0.75) * 3)).cgColor)
                ctx.fill(CGRect(x: 0, y: H * 0.5, width: W, height: H * 0.5))
            }
        }
        return ctx.makeImage()
    }

    // MARK: - the dome and the clouds

    /// A large sphere seen from inside, unlit, behind everything (inside the camera's far plane).
    private func buildDome() {
        var g = Prim.sphere(Self.domeRadius, wSeg: 48, hSeg: 24)
        // Seen from inside: every triangle turned the other way round.
        var i = 0
        while i + 2 < g.indices.count {
            g.indices.swapAt(i + 1, i + 2)
            i += 3
        }
        var batch = MeshBatch()
        batch.add(positions: g.positions, normals: g.normals.map { -$0 }, uvs: g.uvs, indices: g.indices, transform: matrix_identity_float4x4)
        guard let mesh = try? batch.resource() else { return }
        let e = ModelEntity(mesh: mesh, materials: [UnlitMaterial(color: UIColor(rgb: look.horizon))])
        e.name = "sky-dome"
        e.position = center
        root.addChild(e)
        dome = e
    }

    /// Low-poly heaps of cloud, high over the land, drifting with the wind.
    private func buildPuffs() {
        func mesh(_ parts: [(SIMD3<Float>, SIMD3<Float>)]) -> MeshResource? {
            var batch = MeshBatch()
            let s = Prim.sphere(1, wSeg: 9, hSeg: 6)
            for (p, k) in parts {
                batch.add(positions: s.positions, normals: s.normals, uvs: s.uvs, indices: s.indices, transform: Xform.make(p, scale: k))
            }
            return try? batch.resource()
        }
        guard let top = mesh([([0, 0.35, 0], [1, 0.55, 0.8]), ([0.75, 0.2, 0.15], [0.7, 0.45, 0.6]), ([-0.7, 0.18, -0.1], [0.65, 0.42, 0.55])]),
              let base = mesh([([0, 0, 0], [1.45, 0.3, 0.95])]) else { return }
        var rand = Materials.Rng(Int((site.lat * 1000 + site.lon * 7) * 13))
        for _ in 0..<Self.puffCount {
            let a = Float(rand.next()) * 2 * .pi
            let r = 250 + Float(rand.next()) * 1650
            let size = 70 + Float(rand.next()) * 110
            let e = Entity()
            e.name = "cloud"
            let t = ModelEntity(mesh: top, materials: [UnlitMaterial(color: .white)])
            let b = ModelEntity(mesh: base, materials: [UnlitMaterial(color: .gray)])
            e.addChild(b)
            e.addChild(t)
            e.scale = SIMD3(repeating: size)
            e.orientation = simd_quatf(angle: Float(rand.next()) * 6.28, axis: [0, 1, 0])
            let pos = center + SIMD3(cos(a) * r, 300 + Float(rand.next()) * 160, sin(a) * r)
            e.position = pos
            e.isEnabled = false
            root.addChild(e)
            puffs.append((e, t, b, pos))
        }
    }

    private func colourPuffs() {
        puffLook = look
        let shown = look.fogMax >= 1 ? 0 : Int((look.cover * Double(Self.puffCount)).rounded())
        for (i, p) in puffs.enumerated() {
            p.entity.isEnabled = i < shown
            p.top.model?.materials = [UnlitMaterial(color: UIColor(rgb: look.cloudLit.clamped))]
            p.base.model?.materials = [UnlitMaterial(color: UIColor(rgb: look.cloudDark.clamped))]
        }
    }

    private func movePuffs(_ dt: Double) {
        let flat = SIMD2(wind.x, wind.y)
        guard simd_length(flat) > 0.01 else { return }
        let step = flat * max(1, wind.z) * 8 * Float(dt)
        let reach: Float = 1900
        for i in puffs.indices where puffs[i].entity.isEnabled {
            var p = puffs[i].pos
            p.x += step.x
            p.z += step.y
            // Gone past the far side, downwind: back in on the upwind side.
            let off = SIMD2(p.x - center.x, p.z - center.z)
            if simd_dot(off, flat) > reach { p.x -= flat.x * reach * 2; p.z -= flat.y * reach * 2 }
            puffs[i].pos = p
            puffs[i].entity.position = p
        }
    }

    // MARK: - rain and snow

    /// Particles falling in four boxes round the house (none over the roof), from 15 m up.
    private func buildPrecip() {
        for e in emitters { e.removeFromParent() }
        emitters = []
        stillFor = 0
        guard let p = precip else { return }
        let half = Self.volume / 2
        let lo = bounds.lo - 0.4, hi = bounds.hi + 0.4
        let c = SIMD2(center.x, center.z)
        let x0 = min(lo.x, c.x - half), x1 = max(hi.x, c.x + half)
        let z0 = min(lo.y, c.y - half), z1 = max(hi.y, c.y + half)
        let boxes: [(SIMD2<Float>, SIMD2<Float>)] = [
            (SIMD2(x0, z0), SIMD2(x1, lo.y)), (SIMD2(x0, hi.y), SIMD2(x1, z1)),
            (SIMD2(x0, lo.y), SIMD2(lo.x, hi.y)), (SIMD2(hi.x, lo.y), SIMD2(x1, hi.y)),
        ]
        let total = boxes.reduce(Float(0)) { $0 + max(0, $1.1.x - $1.0.x) * max(0, $1.1.y - $1.0.y) }
        let life = Double(Self.volumeHeight / p.speed)
        let velocity = SIMD3(p.drift.x, -p.speed, p.drift.y)
        for (a, b) in boxes {
            let size = b - a
            guard size.x > 0.1, size.y > 0.1 else { continue }
            var pe = ParticleEmitterComponent()
            pe.emitterShape = .box
            pe.birthLocation = .volume
            pe.emitterShapeSize = SIMD3(size.x, 0.2, size.y)
            pe.birthDirection = .constant
            pe.emissionDirection = simd_normalize(velocity)
            pe.speed = simd_length(velocity)
            pe.speedVariation = p.speed * 0.1
            pe.mainEmitter.birthRate = Float(p.count * Double(size.x * size.y / total) / life)
            pe.mainEmitter.lifeSpan = life
            pe.mainEmitter.size = p.size
            pe.mainEmitter.sizeVariation = p.size * 0.3
            pe.mainEmitter.color = .constant(.single(UIColor(rgb: p.color.clamped, alpha: p.snow ? 0.95 : 0.55)))
            pe.mainEmitter.acceleration = .zero
            pe.mainEmitter.dampingFactor = 0
            pe.mainEmitter.spreadingAngle = 0
            pe.mainEmitter.stretchFactor = p.stretch
            pe.mainEmitter.billboardMode = p.snow ? .billboard : .billboardYAligned
            pe.mainEmitter.blendMode = .alpha
            pe.mainEmitter.isLightingEnabled = false
            if p.snow {
                // Flakes flutter as they fall.
                pe.mainEmitter.noiseStrength = 0.25
                pe.mainEmitter.noiseScale = 1
                pe.mainEmitter.noiseAnimationSpeed = 0.3
            }
            let e = Entity()
            e.name = "precip"
            e.position = SIMD3((a.x + b.x) / 2, Self.volumeHeight, (a.y + b.y) / 2)
            e.components.set(pe)
            root.addChild(e)
            emitters.append(e)
        }
    }

    /// With reduced motion the rain or snow stands still once it has filled the air.
    private func holdStill(_ dt: Double) {
        guard reduceMotion, !emitters.isEmpty, stillFor >= 0 else { return }
        stillFor += dt
        guard stillFor > Double(Self.volumeHeight / max(0.5, precip?.speed ?? 1)) else { return }
        stillFor = -1
        for e in emitters {
            guard var pe = e.components[ParticleEmitterComponent.self] else { continue }
            pe.simulationState = .pause
            e.components.set(pe)
        }
    }
}
