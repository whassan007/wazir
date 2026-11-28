import Foundation

/// Loads and saves `FleetConfig` as pretty-printed JSON.
public struct ConfigStore: Sendable {
    public let url: URL

    public init(url: URL = ConfigStore.defaultURL) {
        self.url = url
    }

    public static var defaultURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Fleet", isDirectory: true).appendingPathComponent("hosts.json")
    }

    public enum LoadResult: Sendable {
        case loaded(FleetConfig)
        case seeded(FleetConfig)
    }

    /// Loads config; seeds the defaults file if none exists. Throws on malformed JSON
    /// (never silently replaces a user's file).
    public func loadOrSeed(defaults: FleetConfig = DefaultFleet.config) throws -> LoadResult {
        if FileManager.default.fileExists(atPath: url.path) {
            return .loaded(try load())
        }
        try save(defaults)
        return .seeded(defaults)
    }

    public func load() throws -> FleetConfig {
        let data = try Data(contentsOf: url)
        do {
            return try JSONDecoder().decode(FleetConfig.self, from: data)
        } catch {
            throw FleetError("Could not parse \(url.path): \(Self.describe(error))")
        }
    }

    public func save(_ config: FleetConfig) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try enc.encode(config).write(to: url, options: .atomic)
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case DecodingError.dataCorrupted(let ctx):
            return "corrupted data at \(path(ctx.codingPath)): \(ctx.debugDescription)"
        case DecodingError.keyNotFound(let key, let ctx):
            return "missing key '\(key.stringValue)' at \(path(ctx.codingPath))"
        case DecodingError.typeMismatch(_, let ctx), DecodingError.valueNotFound(_, let ctx):
            return "wrong type at \(path(ctx.codingPath)): \(ctx.debugDescription)"
        default:
            return error.localizedDescription
        }
    }

    private static func path(_ keys: [CodingKey]) -> String {
        keys.isEmpty ? "root" : keys.map { $0.intValue.map { "[\($0)]" } ?? $0.stringValue }.joined(separator: ".")
    }
}

/// Simple, equatable error carrying a user-facing message.
public struct FleetError: Error, Equatable, Sendable, LocalizedError, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
    public var description: String { message }
}
