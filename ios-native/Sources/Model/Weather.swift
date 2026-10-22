import Foundation

/// The weather at the house, as the hub reads it from Open-Meteo (hub/weather.py `normalise`,
/// `GET /api/weather` and the `weather` event): what the sky over the model shows.
struct WeatherReading: Sendable, Equatable {
    static let kinds = ["clear", "partly", "overcast", "fog", "drizzle", "rain", "snow", "storm"]

    var kind: String
    var code: Int
    var cloud: Double          // %
    var precip: Double         // mm/h
    var snow: Double           // cm/h
    var wind: Double           // km/h
    var windDir: Double        // degrees, where it blows from
    var visibility: Double     // m
    var snowDepth: Double      // m
    var sunrise: String?       // ISO with the house's UTC offset
    var stale: Bool

    init(kind: String, code: Int, cloud: Double, precip: Double = 0, snow: Double = 0, wind: Double = 9,
         windDir: Double = 225, visibility: Double = 24000, snowDepth: Double = 0, sunrise: String? = nil, stale: Bool = false) {
        self.kind = kind; self.code = code; self.cloud = cloud; self.precip = precip; self.snow = snow
        self.wind = wind; self.windDir = windDir; self.visibility = visibility; self.snowDepth = snowDepth
        self.sunrise = sunrise; self.stale = stale
    }

    /// A reading from the hub; nil for `{"kind": null}` (none yet) or anything unreadable.
    init?(json: JSON) {
        guard let kind = json["kind"]?.string, Self.kinds.contains(kind) else { return nil }
        self.init(kind: kind, code: json["code"]?.int ?? 2, cloud: json["cloud"]?.double ?? 35,
                  precip: json["precip"]?.double ?? 0, snow: json["snow"]?.double ?? 0,
                  wind: json["wind"]?.double ?? 0, windDir: json["windDir"]?.double ?? 225,
                  visibility: json["visibility"]?.double ?? 24000, snowDepth: json["snowDepth"]?.double ?? 0,
                  sunrise: json["sunrise"]?.string, stale: json["stale"]?.bool ?? false)
    }

    /// When nothing is known (no hub, no reading yet): a plain, partly cloudy day or night.
    static let plain = WeatherReading(kind: "partly", code: 2, cloud: 35)

    /// What a forced kind looks like, as a reading from the hub would say it (web/src/sky/weather.js).
    static func forced(_ kind: String) -> WeatherReading? {
        switch kind {
        case "clear": return WeatherReading(kind: kind, code: 0, cloud: 4, wind: 8)
        case "partly": return WeatherReading(kind: kind, code: 2, cloud: 45, wind: 14)
        case "overcast": return WeatherReading(kind: kind, code: 3, cloud: 100, wind: 16)
        case "fog": return WeatherReading(kind: kind, code: 45, cloud: 100, wind: 3, visibility: 140)
        case "drizzle": return WeatherReading(kind: kind, code: 53, cloud: 96, precip: 0.4, wind: 10, visibility: 9000)
        case "rain": return WeatherReading(kind: kind, code: 63, cloud: 100, precip: 4, wind: 24, visibility: 6000)
        case "snow": return WeatherReading(kind: kind, code: 73, cloud: 100, snow: 1.2, wind: 12, visibility: 2500, snowDepth: 0.08)
        case "storm": return WeatherReading(kind: kind, code: 95, cloud: 100, precip: 9, wind: 38, visibility: 5000)
        default: return nil
        }
    }
}

/// `-sky <kind> -skytime <HH:MM> [-skydate YYYY-MM-DD]` launch arguments force a look and a local
/// time at the house and skip the hub (for testing and screenshots; no UI), like the web's
/// `?sky=&skytime=`.
enum SkyOverride {
    static let kind: String? = UserDefaults.standard.string(forKey: "sky").flatMap { WeatherReading.kinds.contains($0) ? $0 : nil }
    static let time: [Int]? = numbers(UserDefaults.standard.string(forKey: "skytime"), ":", count: 2)
    static let date: [Int]? = numbers(UserDefaults.standard.string(forKey: "skydate"), "-", count: 3)

    /// Whether the look or the time is forced (the hub is then not asked for the weather).
    static var active: Bool { kind != nil || time != nil || date != nil }

    private static func numbers(_ s: String?, _ sep: Character, count: Int) -> [Int]? {
        guard let s else { return nil }
        let parts = s.split(separator: sep).compactMap { Int($0) }
        return parts.count == count ? parts : nil
    }

    /// Now, or the forced time: `skytime` is a local time at the house, whose UTC offset is taken
    /// from the reading's sunrise when there is one, else this phone's own when it is near the
    /// house's longitude, else the longitude's (15° an hour).
    static func now(lon: Double, sunrise: String?) -> Date {
        let real = Date()
        guard time != nil || date != nil else { return real }
        let offset = utcOffset(lon: lon, sunrise: sunrise, at: real)   // seconds east of UTC
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(secondsFromGMT: 0) ?? .current
        let local = utc.dateComponents([.year, .month, .day, .hour, .minute], from: real.addingTimeInterval(Double(offset)))
        var c = DateComponents()
        c.year = date?[0] ?? local.year
        c.month = date?[1] ?? local.month
        c.day = date?[2] ?? local.day
        c.hour = time?[0] ?? local.hour
        c.minute = time?[1] ?? local.minute
        guard let at = utc.date(from: c) else { return real }
        return at.addingTimeInterval(-Double(offset))
    }

    /// The house's offset from UTC in seconds.
    static func utcOffset(lon: Double, sunrise: String?, at: Date) -> Int {
        if let s = sunrise, s.count >= 6 {
            let tail = Array(s.suffix(6))
            if tail[3] == ":", tail[0] == "+" || tail[0] == "-",
               let h = Int(String(tail[1...2])), let m = Int(String(tail[4...5])) {
                return (tail[0] == "-" ? -1 : 1) * (h * 3600 + m * 60)
            }
        }
        let mine = TimeZone.current.secondsFromGMT(for: at)
        return abs(Double(mine) / 60 - lon * 4) <= 100 ? mine : Int((lon / 15).rounded()) * 3600
    }
}

extension HubClient {
    /// The hub's last reading of the weather at the plan's site: nil when it has none
    /// (`{"kind": null}`); throws when the hub can't be asked (the last reading then stays).
    func weather() async throws -> WeatherReading? {
        let json = try await get("api/weather", checkError: false)
        return WeatherReading(json: json)
    }
}
