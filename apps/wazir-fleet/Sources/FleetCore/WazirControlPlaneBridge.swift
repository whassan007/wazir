import Foundation

/// Canonical bridge between Wazir Fleet (SwiftUI / FleetCore) and Wazir's
/// authoritative TypeScript/Node.js control plane (`~/.wazir` state directory
/// and `/api/v1/fleet/*` / `/api/v1/studio/*` endpoints).
public struct WazirControlPlaneBridge: Sendable {
    public let wazirHomeURL: URL
    public let controllerURL: URL

    public init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) {
        if let customHome = environment["WAZIR_HOME"], !customHome.isEmpty {
            self.wazirHomeURL = URL(fileURLWithPath: customHome, isDirectory: true)
        } else {
            self.wazirHomeURL = fileManager.homeDirectoryForCurrentUser.appendingPathComponent(".wazir", isDirectory: true)
        }

        let rawUrl = environment["WAZIR_CONTROLLER_URL"]
            ?? environment["WAZIR_API_URL"]
            ?? "http://127.0.0.1:4800"
        self.controllerURL = URL(string: rawUrl) ?? URL(string: "http://127.0.0.1:4800")!
    }

    public var sharedFleetStateURL: URL {
        wazirHomeURL.appendingPathComponent("fleet-state.json")
    }

    public var sharedHostsConfigURL: URL {
        wazirHomeURL.appendingPathComponent("hosts.json")
    }

    public struct SharedFleetSnapshot: Codable, Sendable, Equatable {
        public var schemaVersion: Int
        public var updatedAt: String
        public var source: String
        public var hosts: [SharedHostRecord]

        public init(
            schemaVersion: Int = 1,
            updatedAt: String = ISO8601DateFormatter().string(from: Date()),
            source: String = "wazir-fleet-swiftui",
            hosts: [SharedHostRecord]
        ) {
            self.schemaVersion = schemaVersion
            self.updatedAt = updatedAt
            self.source = source
            self.hosts = hosts
        }
    }

    public struct SharedHostRecord: Codable, Sendable, Equatable {
        public var id: String
        public var name: String
        public var online: Bool
        public var address: String?
        public var latencyMS: Double?
        public var loadedModels: [String]
        public var installedModels: [String]

        public init(
            id: String,
            name: String,
            online: Bool,
            address: String? = nil,
            latencyMS: Double? = nil,
            loadedModels: [String] = [],
            installedModels: [String] = []
        ) {
            self.id = id
            self.name = name
            self.online = online
            self.address = address
            self.latencyMS = latencyMS
            self.loadedModels = loadedModels
            self.installedModels = installedModels
        }
    }

    public func exportSnapshot(from config: FleetConfig, state: FleetState) throws {
        try FileManager.default.createDirectory(at: wazirHomeURL, withIntermediateDirectories: true)
        let records: [SharedHostRecord] = config.hosts.map { host in
            let hs = state.hosts[host.id]
            let online: Bool
            let address: String?
            let latencyMS: Double?
            if case .online(let ms, let addr)? = hs?.reachability {
                online = true
                address = addr
                latencyMS = ms
            } else {
                online = false
                address = nil
                latencyMS = nil
            }
            let models = hs?.runtimes.values.flatMap(\.models) ?? []
            let loaded = models.filter(\.isLoaded).map(\.name)
            let installed = models.map(\.name)
            return SharedHostRecord(
                id: host.id,
                name: host.name,
                online: online,
                address: address,
                latencyMS: latencyMS,
                loadedModels: loaded,
                installedModels: installed
            )
        }
        let snapshot = SharedFleetSnapshot(hosts: records)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(snapshot)
        try data.write(to: sharedFleetStateURL, options: .atomic)
    }

    public func readSnapshot() throws -> SharedFleetSnapshot? {
        guard FileManager.default.fileExists(atPath: sharedFleetStateURL.path) else {
            return nil
        }
        let data = try Data(contentsOf: sharedFleetStateURL)
        return try JSONDecoder().decode(SharedFleetSnapshot.self, from: data)
    }
}
