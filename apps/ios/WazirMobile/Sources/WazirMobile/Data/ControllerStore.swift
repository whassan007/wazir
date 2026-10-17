import Foundation
import Combine

struct ControllerCachedState {
    var dashboard: DashboardSnapshot?
    var tasks: [MobileTaskSummary] = []
    var approvals: [MobileApprovalRecord] = []
    var models: [ModelCatalogItem] = []
    var modelInstances: [ModelInstanceItem] = []
    var runtimes: [RuntimeItem] = []
    var agents: [AgentDescriptorItem] = []
    var computers: [ComputerTelemetryItem] = []
    var resources: ResourceBudgetSnapshot?
    var autonomy: MobileAutonomyState = MobileAutonomyState()
    var schedules: [MobileScheduleItem] = []
    var pushRegistrations: [PushRelayRegistration] = []
    var recentPushWakeups: [PushWakeupEvent] = []
    var lastSequence: Int64 = 0
    var syncedAtMs: Int64?
}

/// A JSON-file-backed cache of paired controllers and their last-known state, mirroring
/// the role of Android's Room `WazirCacheDao` (controller list, a per-controller snapshot
/// for offline display, and a bounded per-task detail cache) without pulling in
/// CoreData/SwiftData for what is, at this scale, a handful of small JSON blobs.
/// Device credentials (bearer tokens) are never stored here — those live only in
/// `CredentialVault` (Keychain).
@MainActor
final class ControllerStore: ObservableObject {
    @Published private(set) var controllers: [ControllerProfile] = []

    private let fileManager = FileManager.default
    private let baseDir: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let maxCachedTaskDetails = 50

    init() {
        let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        baseDir = support.appendingPathComponent("WazirMobile", isDirectory: true)
        try? fileManager.createDirectory(at: baseDir, withIntermediateDirectories: true)
        controllers = Self.loadControllers(from: baseDir, decoder: decoder)
    }

    private static func loadControllers(from baseDir: URL, decoder: JSONDecoder) -> [ControllerProfile] {
        let url = baseDir.appendingPathComponent("controllers.json")
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? decoder.decode([ControllerProfile].self, from: data)) ?? []
    }

    private func persistControllers() {
        let url = baseDir.appendingPathComponent("controllers.json")
        guard let data = try? encoder.encode(controllers) else { return }
        try? data.write(to: url, options: .atomic)
    }

    func upsertController(_ profile: ControllerProfile) {
        if let idx = controllers.firstIndex(where: { $0.id == profile.id }) {
            controllers[idx] = profile
        } else {
            controllers.append(profile)
        }
        persistControllers()
    }

    func removeController(_ controllerId: String) {
        controllers.removeAll { $0.id == controllerId }
        persistControllers()
        try? fileManager.removeItem(at: snapshotURL(controllerId))
        for url in taskDetailURLs(controllerId) {
            try? fileManager.removeItem(at: url)
        }
    }

    // MARK: - Snapshot cache

    private func snapshotURL(_ controllerId: String) -> URL {
        baseDir.appendingPathComponent("snapshot-\(controllerId).json")
    }

    func loadCachedState(_ controllerId: String) -> ControllerCachedState {
        guard let data = try? Data(contentsOf: snapshotURL(controllerId)),
              let persisted = try? decoder.decode(PersistedSnapshot.self, from: data) else {
            return ControllerCachedState()
        }
        return ControllerCachedState(
            dashboard: persisted.dashboard,
            tasks: persisted.tasks,
            approvals: persisted.approvals,
            models: persisted.models,
            modelInstances: persisted.modelInstances,
            runtimes: persisted.runtimes,
            agents: persisted.agents,
            computers: persisted.computers,
            resources: persisted.resources,
            autonomy: persisted.autonomy ?? MobileAutonomyState(),
            schedules: persisted.schedules ?? [],
            pushRegistrations: persisted.pushRegistrations ?? [],
            recentPushWakeups: persisted.recentPushWakeups ?? [],
            lastSequence: persisted.lastSequence,
            syncedAtMs: persisted.syncedAtMs
        )
    }

    func saveSnapshot(_ controllerId: String, state: ControllerCachedState) {
        let persisted = PersistedSnapshot(
            dashboard: state.dashboard, tasks: state.tasks, approvals: state.approvals,
            models: state.models, modelInstances: state.modelInstances, runtimes: state.runtimes,
            agents: state.agents, computers: state.computers, resources: state.resources,
            autonomy: state.autonomy, schedules: state.schedules,
            pushRegistrations: state.pushRegistrations, recentPushWakeups: state.recentPushWakeups,
            lastSequence: state.lastSequence, syncedAtMs: state.syncedAtMs
        )
        guard let data = try? encoder.encode(persisted) else { return }
        try? data.write(to: snapshotURL(controllerId), options: .atomic)
    }

    // MARK: - Task detail cache

    private func taskDetailURL(_ controllerId: String, _ taskId: String) -> URL {
        let safeTaskId = taskId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? taskId
        return baseDir.appendingPathComponent("task-\(controllerId)-\(safeTaskId).json")
    }

    private func taskDetailURLs(_ controllerId: String) -> [URL] {
        (try? fileManager.contentsOfDirectory(at: baseDir, includingPropertiesForKeys: [.contentModificationDateKey]))?
            .filter { $0.lastPathComponent.hasPrefix("task-\(controllerId)-") } ?? []
    }

    func getTaskDetail(_ controllerId: String, _ taskId: String) -> MobileTaskDetail? {
        guard let data = try? Data(contentsOf: taskDetailURL(controllerId, taskId)) else { return nil }
        return try? decoder.decode(MobileTaskDetail.self, from: data)
    }

    func saveTaskDetail(_ controllerId: String, _ taskId: String, detail: MobileTaskDetail) {
        guard let data = try? encoder.encode(detail) else { return }
        try? data.write(to: taskDetailURL(controllerId, taskId), options: .atomic)
        pruneTaskDetails(controllerId)
    }

    private func pruneTaskDetails(_ controllerId: String) {
        let urls = taskDetailURLs(controllerId)
        guard urls.count > maxCachedTaskDetails else { return }
        let sorted = urls.sorted { lhs, rhs in
            let l = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            let r = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            return l > r
        }
        for stale in sorted.dropFirst(maxCachedTaskDetails) {
            try? fileManager.removeItem(at: stale)
        }
    }
}

private struct PersistedSnapshot: Codable {
    var dashboard: DashboardSnapshot?
    var tasks: [MobileTaskSummary]
    var approvals: [MobileApprovalRecord]
    var models: [ModelCatalogItem]
    var modelInstances: [ModelInstanceItem]
    var runtimes: [RuntimeItem]
    var agents: [AgentDescriptorItem]
    var computers: [ComputerTelemetryItem]
    var resources: ResourceBudgetSnapshot?
    var autonomy: MobileAutonomyState?
    var schedules: [MobileScheduleItem]?
    var pushRegistrations: [PushRelayRegistration]?
    var recentPushWakeups: [PushWakeupEvent]?
    var lastSequence: Int64
    var syncedAtMs: Int64?
}

