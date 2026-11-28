import Foundation

public enum ExecutionTopology: Codable, Sendable, Equatable {
    case sequential
    case fanOutFanIn
    case dag
    case hierarchicalTeam
    case plannerExecutorReviewer
    case evaluatorOptimizer
    case competingCandidates(count: Int)
    case independentPeerReview
    case conditionalBranching
    case adaptiveRouting
    case multiStageSynthesis
    case recursiveDecomposition(maxDepth: Int)
    case dependencyAwareParallel(maxConcurrency: Int)

    public var displayName: String {
        switch self {
        case .sequential: "Sequential"
        case .fanOutFanIn: "Fan-Out / Fan-In"
        case .dag: "DAG"
        case .hierarchicalTeam: "Hierarchical Team"
        case .plannerExecutorReviewer: "Planner → Executor → Reviewer"
        case .evaluatorOptimizer: "Evaluator / Optimizer"
        case .competingCandidates(let n): "Competing Candidates (\(n))"
        case .independentPeerReview: "Independent Peer Review"
        case .conditionalBranching: "Conditional Branching"
        case .adaptiveRouting: "Adaptive Routing"
        case .multiStageSynthesis: "Multi-Stage Synthesis"
        case .recursiveDecomposition(let d): "Recursive Decomposition (depth \(d))"
        case .dependencyAwareParallel(let c): "Dependency-Aware Parallel (max \(c))"
        }
    }
}

public struct DecisionRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var timestamp: Date
    public var kind: String
    public var rationale: String
    public var selectedOption: String
    public var alternatives: [String]

    public init(id: UUID = UUID(), timestamp: Date = Date(), kind: String, rationale: String,
                selectedOption: String, alternatives: [String] = []) {
        self.id = id
        self.timestamp = timestamp
        self.kind = kind
        self.rationale = rationale
        self.selectedOption = selectedOption
        self.alternatives = alternatives
    }
}

public actor MetaOrchestrator {
    private var journal: [DecisionRecord] = []

    public init() {}

    public func recordDecision(_ record: DecisionRecord) {
        journal.append(record)
    }

    public func decisionJournal() -> [DecisionRecord] {
        journal
    }

    /// Validates task decomposition against the original user objective before allocating compute.
    public func validateDecomposition(objective: String, subtasks: [AgentPrompts.Subtask]) -> (valid: Bool, reason: String) {
        guard !objective.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return (false, "Objective cannot be empty")
        }
        guard !subtasks.isEmpty else {
            return (false, "Decomposition produced zero subtasks")
        }
        return (true, "Validated \(subtasks.count) subtasks against objective")
    }
}
