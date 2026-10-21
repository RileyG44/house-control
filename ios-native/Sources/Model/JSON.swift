import Foundation

/// A parsed JSON value that is Sendable, so plans and hub messages can cross actors. The hub's
/// shapes are loose (numbers as ints or floats, optional keys, explicit nulls), so the app reads
/// them through this rather than strict Codable types.
enum JSON: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    init(any value: Any?) {
        switch value {
        case nil, is NSNull: self = .null
        case let n as NSNumber:
            // JSONSerialization hands booleans over as NSNumber too.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { self = .bool(n.boolValue) } else { self = .number(n.doubleValue) }
        case let s as String: self = .string(s)
        case let a as [Any]: self = .array(a.map { JSON(any: $0) })
        case let d as [String: Any]: self = .object(d.mapValues { JSON(any: $0) })
        default: self = .null
        }
    }

    static func parse(_ data: Data) -> JSON? {
        guard let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return nil }
        return JSON(any: any)
    }

    /// Back to Foundation objects, for JSONSerialization.
    var any: Any {
        switch self {
        case .null: return NSNull()
        case .bool(let b): return b
        case .number(let n):
            if n.rounded() == n, abs(n) < 1e15 { return Int(n) }
            return n
        case .string(let s): return s
        case .array(let a): return a.map(\.any)
        case .object(let o): return o.mapValues(\.any)
        }
    }

    func data() -> Data {
        (try? JSONSerialization.data(withJSONObject: any, options: [.fragmentsAllowed, .sortedKeys])) ?? Data("null".utf8)
    }

    subscript(key: String) -> JSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var double: Double? { if case .number(let n) = self { return n }; return nil }
    var int: Int? { double.map { Int($0.rounded()) } }
    var string: String? { if case .string(let s) = self { return s }; return nil }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
    var object: [String: JSON]? { if case .object(let o) = self { return o }; return nil }
    var isNull: Bool { if case .null = self { return true }; return false }

    /// [x, z] pairs.
    var point: SIMD2<Double>? {
        guard let a = array, a.count == 2, let x = a[0].double, let z = a[1].double else { return nil }
        return SIMD2(x, z)
    }
}
