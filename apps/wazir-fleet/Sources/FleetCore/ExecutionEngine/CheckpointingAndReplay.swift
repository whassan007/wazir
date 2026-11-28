import Foundation

public struct ExecutionCheckpoint: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var runID: UUID
    public var stepID: String
    public var output: String
    public var tokenCount: Int
    public var createdAt: Date

    public init(id: UUID = UUID(), runID: UUID, stepID: String, output: String, tokenCount: Int, createdAt: Date = Date()) {
        self.id = id
        self.runID = runID
        self.stepID = stepID
        self.output = output
        self.tokenCount = tokenCount
        self.createdAt = createdAt
    }
}

public actor ExecutionReplayEngine {
    private var checkpoints: [UUID: [ExecutionCheckpoint]] = [:]

    public init() {}

    public func saveCheckpoint(_ cp: ExecutionCheckpoint) {
        checkpoints[cp.runID, default: []].append(cp)
    }

    public func replay(runID: UUID) -> [ExecutionCheckpoint] {
        (checkpoints[runID] ?? []).sorted { $0.createdAt < $1.createdAt }
    }
}
