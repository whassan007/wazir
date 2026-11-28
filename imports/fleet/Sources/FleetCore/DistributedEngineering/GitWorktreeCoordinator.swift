import Foundation

public struct FileOwnershipLease: Codable, Sendable, Equatable {
    public var filePath: String
    public var ownerAgentID: String
    public var worktreePath: String
    public var acquiredAt: Date

    public init(filePath: String, ownerAgentID: String, worktreePath: String, acquiredAt: Date = Date()) {
        self.filePath = filePath
        self.ownerAgentID = ownerAgentID
        self.worktreePath = worktreePath
        self.acquiredAt = acquiredAt
    }
}

/// Manages exclusive file ownership leases, human modification protection,
/// and isolated git worktrees for distributed software engineering.
public actor GitWorktreeCoordinator {
    private var leases: [String: FileOwnershipLease] = [:]
    private var protectedHumanFiles: Set<String> = []

    public init() {}

    public func protectHumanModifications(_ paths: [String]) {
        for p in paths { protectedHumanFiles.insert(p) }
    }

    public func claimOwnership(files: [String], agentID: String, worktreePath: String) throws(FleetError) {
        for f in files {
            if protectedHumanFiles.contains(f) {
                throw FleetError("File '\(f)' has protected human modifications; agent '\(agentID)' cannot claim write ownership.")
            }
            if let existing = leases[f], existing.ownerAgentID != agentID {
                throw FleetError("Conflict: '\(f)' is already owned by agent '\(existing.ownerAgentID)' in worktree '\(existing.worktreePath)'.")
            }
        }
        for f in files {
            leases[f] = FileOwnershipLease(filePath: f, ownerAgentID: agentID, worktreePath: worktreePath)
        }
    }

    public func releaseOwnership(agentID: String) {
        leases = leases.filter { $0.value.ownerAgentID != agentID }
    }

    public func activeLeases() -> [FileOwnershipLease] {
        leases.values.sorted { $0.filePath < $1.filePath }
    }
}
