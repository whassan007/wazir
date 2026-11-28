import Foundation

public struct TaskLease: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var idempotencyKey: String
    public var machineID: String
    public var workflowID: UUID
    public var expiresAt: Date

    public init(id: UUID = UUID(), idempotencyKey: String, machineID: String, workflowID: UUID, expiresAt: Date) {
        self.id = id
        self.idempotencyKey = idempotencyKey
        self.machineID = machineID
        self.workflowID = workflowID
        self.expiresAt = expiresAt
    }
}

/// Manages heartbeats, task leases, controlled machine draining, restart recovery,
/// and strict enforcement against unauthorized cloud fallback.
public actor ResilienceAndMigrationEngine {
    private var leases: [UUID: TaskLease] = [:]
    private var completedIdempotencyKeys: Set<String> = []

    public init() {}

    public func acquireLease(_ lease: TaskLease) throws(FleetError) {
        if completedIdempotencyKeys.contains(lease.idempotencyKey) {
            throw FleetError("Duplicate side effect prevented: idempotency key '\(lease.idempotencyKey)' already completed.")
        }
        leases[lease.id] = lease
    }

    public func completeLease(_ id: UUID) {
        if let lease = leases.removeValue(forKey: id) {
            completedIdempotencyKeys.insert(lease.idempotencyKey)
        }
    }

    /// Drains all active leases on a machine being removed from a workflow.
    public func drainMachine(_ machineID: String) -> [TaskLease] {
        let affected = leases.values.filter { $0.machineID == machineID }
        for l in affected { leases.removeValue(forKey: l.id) }
        return affected
    }

    /// Validates whether workload migration to a target provider is authorized under the active scheduling profile.
    public func authorizeMigration(toIsCloud: Bool, profile: SchedulingObjectiveProfile) throws(FleetError) {
        if toIsCloud && profile == .localExecutionOnly {
            throw FleetError("Policy violation: unauthorized cloud fallback rejected under localExecutionOnly profile.")
        }
    }
}
