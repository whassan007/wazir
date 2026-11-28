import Foundation

public enum ExtensionPermission: String, Codable, Sendable, CaseIterable, Hashable {
    case registerOntology
    case registerPolicy
    case registerEvaluator
    case registerWorkflow
    case registerCommand
    case registerDashboard
    case externalDataConnector
}

public struct FleetExtensionManifest: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var version: String
    public var coreVersionConstraint: String
    public var permissions: Set<ExtensionPermission>

    public init(id: String, name: String, version: String, coreVersionConstraint: String = ">=1.0.0",
                permissions: Set<ExtensionPermission>) {
        self.id = id
        self.name = name
        self.version = version
        self.coreVersionConstraint = coreVersionConstraint
        self.permissions = permissions
    }
}

public protocol FleetExtensionPlugin: Sendable {
    var manifest: FleetExtensionManifest { get }
    func registerWorkflows() -> [WorkflowSpecification]
    func registerRubrics() -> [EvaluationRubric]
    func registerCustomCommands() -> [String]
}

public final class ExtensionManager: @unchecked Sendable {
    private var plugins: [String: any FleetExtensionPlugin] = [:]
    private var enabledIDs: Set<String> = []
    private let lock = NSLock()

    public init() {}

    public func load(_ plugin: any FleetExtensionPlugin) throws(FleetError) {
        let id = plugin.manifest.id
        guard !id.isEmpty else { throw FleetError("Extension id cannot be empty") }
        lock.withLock {
            plugins[id] = plugin
            enabledIDs.insert(id)
        }
    }

    public func setEnabled(_ enabled: Bool, for id: String) {
        lock.withLock {
            if enabled && plugins[id] != nil { enabledIDs.insert(id) }
            else { enabledIDs.remove(id) }
        }
    }

    public func unload(_ id: String) {
        lock.withLock {
            plugins.removeValue(forKey: id)
            enabledIDs.remove(id)
        }
    }

    public func activePlugins() -> [any FleetExtensionPlugin] {
        lock.withLock { enabledIDs.compactMap { plugins[$0] } }
    }

    public func allManifests() -> [(manifest: FleetExtensionManifest, enabled: Bool)] {
        lock.withLock {
            plugins.values.sorted { $0.manifest.id < $1.manifest.id }
                .map { ($0.manifest, enabledIDs.contains($0.manifest.id)) }
        }
    }
}
