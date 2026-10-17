import Foundation

/// The mobile controller API (apps/api/src/mobile.ts) serializes with
/// `encodeDefaults = true, explicitNulls = false` and every DTO field has a
/// Kotlin default, so real responses are frequently sparse (`{}` decodes fine
/// server-round-trip). Swift's synthesized `Decodable` has no concept of a
/// default for a missing key, so every DTO below writes its own `init(from:)`
/// through these helpers instead of relying on synthesis.
extension KeyedDecodingContainer {
    func decode<T: Decodable>(_ type: T.Type, forKey key: Key, default value: T) throws -> T {
        try decodeIfPresent(type, forKey: key) ?? value
    }
}
