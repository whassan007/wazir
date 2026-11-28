import Foundation

// MARK: - Section 3: Role Execution Contracts & Objective Classification

public enum OrchestrationRole: String, Codable, Sendable, CaseIterable, Hashable {
    case planner
    case executor
    case reviewer
    case critic
    case synthesizer
    case evaluator
    case recoverySupervisor
    case orchestrator

    public var requiredOutputDescription: String {
        switch self {
        case .planner: "Validated executable task graph"
        case .executor: "Task artifacts and execution evidence"
        case .reviewer: "Independent findings"
        case .critic: "Quality and correctness assessment"
        case .synthesizer: "Consolidated results with provenance"
        case .evaluator: "Acceptance criteria results"
        case .recoverySupervisor: "Validated recovery actions"
        case .orchestrator: "Authoritative workflow state"
        }
    }
}

public enum ObjectiveCategory: String, Codable, Sendable, CaseIterable, Hashable {
    case plan
    case research
    case recommendation
    case repositoryImplementation
}

public enum ObjectiveIntentClassifier {
    public static func classify(_ objective: String) -> ObjectiveCategory {
        let lower = objective.lowercased()
        let implSignals = [
            "implement", "build", "fix", "refactor", "create file", "edit ", "write code",
            "add test", "commit", "migrate", "deploy", "patch", "repair", "update sources"
        ]
        if implSignals.contains(where: lower.contains) {
            return .repositoryImplementation
        }
        if lower.contains("recommend") || lower.contains("suggest") || lower.contains("should we") {
            return .recommendation
        }
        if lower.contains("research") || lower.contains("analyze") || lower.contains("investigate") || lower.contains("compare") {
            return .research
        }
        return .plan
    }
}

public struct SanitizedModelOutput: Sendable, Equatable {
    public var cleanedText: String
    public var containedUntrustedCompletionMarker: Bool
    public var lacksImplementationEvidence: Bool

    public init(cleanedText: String, containedUntrustedCompletionMarker: Bool, lacksImplementationEvidence: Bool) {
        self.cleanedText = cleanedText
        self.containedUntrustedCompletionMarker = containedUntrustedCompletionMarker
        self.lacksImplementationEvidence = lacksImplementationEvidence
    }
}

public enum UntrustedOutputSanitizer {
    private static let markers = ["<!-- GOAL_COMPLETE -->", "GOAL_COMPLETE", "<!-- GOAL_CANCELLED -->"]

    public static func sanitize(
        _ raw: String,
        role: OrchestrationRole,
        objectiveCategory: ObjectiveCategory,
        verifiedArtifacts: [String],
        commitSHAs: [String]
    ) -> SanitizedModelOutput {
        var cleaned = raw
        var foundMarker = false
        for m in markers where cleaned.contains(m) {
            foundMarker = true
            cleaned = cleaned.replacingOccurrences(of: m, with: "")
        }
        cleaned = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)

        let lacksEvidence = (role == .executor && objectiveCategory == .repositoryImplementation)
            && verifiedArtifacts.isEmpty && commitSHAs.isEmpty
        return SanitizedModelOutput(
            cleanedText: cleaned,
            containedUntrustedCompletionMarker: foundMarker,
            lacksImplementationEvidence: lacksEvidence
        )
    }
}

// MARK: - Section 4 & 14: Authoritative Task & Workflow States

public enum DurableTaskState: String, Codable, Sendable, CaseIterable, Hashable {
    case created = "CREATED"
    case ready = "READY"
    case queued = "QUEUED"
    case running = "RUNNING"
    case outputReceived = "OUTPUT_RECEIVED"
    case validating = "VALIDATING"
    case verified = "VERIFIED"
    case failed = "FAILED"
    case diagnosing = "DIAGNOSING"
    case recovering = "RECOVERING"
    case replanning = "REPLANNING"
    case reassigning = "REASSIGNING"
    case waitingForDependency = "WAITING_FOR_DEPENDENCY"
    case waitingForCapacity = "WAITING_FOR_CAPACITY"
    case waitingForApproval = "WAITING_FOR_APPROVAL"
    case blocked = "BLOCKED"
    case cancelled = "CANCELLED"
    case superseded = "SUPERSEDED"
    case exhausted = "EXHAUSTED"

    public var isTerminal: Bool {
        switch self {
        case .verified, .blocked, .cancelled, .superseded, .exhausted: true
        default: false
        }
    }

    public var isActive: Bool {
        switch self {
        case .running, .outputReceived, .validating, .diagnosing, .recovering, .replanning, .reassigning: true
        default: false
        }
    }
}

public enum DurableWorkflowState: String, Codable, Sendable, CaseIterable, Hashable {
    case planning = "PLANNING"
    case executing = "EXECUTING"
    case recovering = "RECOVERING"
    case degraded = "DEGRADED"
    case verifying = "VERIFYING"
    case completed = "COMPLETED"
    case partiallyCompleted = "PARTIALLY_COMPLETED"
    case blocked = "BLOCKED"
    case failed = "FAILED"
    case paused = "PAUSED"
    case cancelled = "CANCELLED"
}

public enum TaskDependencyKind: Codable, Sendable, Equatable, Hashable {
    case required
    case optional
    case alternative(groupID: String)
    case conditional(condition: String)

    public var isBlocking: Bool {
        switch self {
        case .required: true
        case .optional, .alternative, .conditional: false
        }
    }
}

public struct TaskAttemptRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var attemptNumber: Int
    public var hostID: String
    public var model: String
    public var providerID: String
    public var adapterID: String
    public var startedAt: Date
    public var finishedAt: Date?
    public var succeeded: Bool
    public var failureCode: String?
    public var failureMessage: String?
    public var interventionApplied: String?
    public var tokensUsed: Int
    public var costUSD: Double

    public init(
        id: UUID = UUID(),
        attemptNumber: Int,
        hostID: String,
        model: String,
        providerID: String,
        adapterID: String,
        startedAt: Date = Date(),
        finishedAt: Date? = nil,
        succeeded: Bool = false,
        failureCode: String? = nil,
        failureMessage: String? = nil,
        interventionApplied: String? = nil,
        tokensUsed: Int = 0,
        costUSD: Double = 0
    ) {
        self.id = id
        self.attemptNumber = attemptNumber
        self.hostID = hostID
        self.model = model
        self.providerID = providerID
        self.adapterID = adapterID
        self.startedAt = startedAt
        self.finishedAt = finishedAt
        self.succeeded = succeeded
        self.failureCode = failureCode
        self.failureMessage = failureMessage
        self.interventionApplied = interventionApplied
        self.tokensUsed = tokensUsed
        self.costUSD = costUSD
    }
}

public struct DurableTaskRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var parentTaskID: String?
    public var revision: Int
    public var decompositionDepth: Int
    public var canonicalFingerprint: String
    public var role: OrchestrationRole
    public var title: String
    public var objective: String
    public var inputArtifacts: [String]
    public var expectedOutputArtifacts: [String]
    public var acceptanceCriteria: [String]
    public var dependencies: [String]
    public var dependencyKind: TaskDependencyKind
    public var toolRequirements: [String]
    public var fileOwnership: [String]
    public var contextBudgetTokens: Int
    public var estimatedMemoryMB: Int
    public var verificationStrategy: String
    public var state: DurableTaskState
    public var skipOrBlockReason: String?
    public var dependencyReferences: [String]
    public var assignedHostID: String?
    public var assignedModel: String?
    public var assignedProvider: String?
    public var fencingToken: UInt64
    public var attemptHistory: [TaskAttemptRecord]
    public var outputText: String?
    public var verifiedArtifacts: [String]
    public var commitSHAs: [String]
    public var worktreePath: String?
    public var updatedAt: Date

    public init(
        id: String,
        parentTaskID: String? = nil,
        revision: Int = 1,
        decompositionDepth: Int = 0,
        canonicalFingerprint: String? = nil,
        role: OrchestrationRole = .executor,
        title: String,
        objective: String,
        inputArtifacts: [String] = [],
        expectedOutputArtifacts: [String] = [],
        acceptanceCriteria: [String] = [],
        dependencies: [String] = [],
        dependencyKind: TaskDependencyKind = .required,
        toolRequirements: [String] = [],
        fileOwnership: [String] = [],
        contextBudgetTokens: Int = 4096,
        estimatedMemoryMB: Int = 4096,
        verificationStrategy: String = "deterministic_validation",
        state: DurableTaskState = .created,
        skipOrBlockReason: String? = nil,
        dependencyReferences: [String] = [],
        assignedHostID: String? = nil,
        assignedModel: String? = nil,
        assignedProvider: String? = nil,
        fencingToken: UInt64 = 0,
        attemptHistory: [TaskAttemptRecord] = [],
        outputText: String? = nil,
        verifiedArtifacts: [String] = [],
        commitSHAs: [String] = [],
        worktreePath: String? = nil,
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.parentTaskID = parentTaskID
        self.revision = revision
        self.decompositionDepth = decompositionDepth
        self.canonicalFingerprint = canonicalFingerprint ?? AgentPrompts.canonicalFingerprint(for: .init(title: title, task: objective))
        self.role = role
        self.title = title
        self.objective = objective
        self.inputArtifacts = inputArtifacts
        self.expectedOutputArtifacts = expectedOutputArtifacts
        self.acceptanceCriteria = acceptanceCriteria
        self.dependencies = dependencies
        self.dependencyKind = dependencyKind
        self.toolRequirements = toolRequirements
        self.fileOwnership = fileOwnership
        self.contextBudgetTokens = contextBudgetTokens
        self.estimatedMemoryMB = estimatedMemoryMB
        self.verificationStrategy = verificationStrategy
        self.state = state
        self.skipOrBlockReason = skipOrBlockReason
        self.dependencyReferences = dependencyReferences
        self.assignedHostID = assignedHostID
        self.assignedModel = assignedModel
        self.assignedProvider = assignedProvider
        self.fencingToken = fencingToken
        self.attemptHistory = attemptHistory
        self.outputText = outputText
        self.verifiedArtifacts = verifiedArtifacts
        self.commitSHAs = commitSHAs
        self.worktreePath = worktreePath
        self.updatedAt = updatedAt
    }
}

public struct StateTransitionEvent: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var workflowID: UUID
    public var taskID: String?
    public var fromState: String
    public var toState: String
    public var reason: String
    public var timestamp: Date

    public init(id: UUID = UUID(), workflowID: UUID, taskID: String?, fromState: String, toState: String, reason: String, timestamp: Date = Date()) {
        self.id = id
        self.workflowID = workflowID
        self.taskID = taskID
        self.fromState = fromState
        self.toState = toState
        self.reason = reason
        self.timestamp = timestamp
    }
}

public struct DurableWorkflowCheckpoint: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var objective: String
    public var objectiveCategory: ObjectiveCategory
    public var projectPath: String
    public var targetBranch: String
    public var specificationVersion: Int
    public var state: DurableWorkflowState
    public var tasks: [DurableTaskRecord]
    public var recoveryDecisions: [String]
    public var totalTokensConsumed: Int
    public var totalCostUSD: Double
    public var graphRepairRounds: Int
    public var terminationReason: String?
    public var createdAt: Date
    public var updatedAt: Date

    public init(
        id: UUID = UUID(),
        objective: String,
        objectiveCategory: ObjectiveCategory? = nil,
        projectPath: String = "",
        targetBranch: String = "main",
        specificationVersion: Int = 1,
        state: DurableWorkflowState = .planning,
        tasks: [DurableTaskRecord] = [],
        recoveryDecisions: [String] = [],
        totalTokensConsumed: Int = 0,
        totalCostUSD: Double = 0,
        graphRepairRounds: Int = 0,
        terminationReason: String? = nil,
        createdAt: Date = Date(),
        updatedAt: Date = Date()
    ) {
        self.id = id
        self.objective = objective
        self.objectiveCategory = objectiveCategory ?? ObjectiveIntentClassifier.classify(objective)
        self.projectPath = projectPath
        self.targetBranch = targetBranch
        self.specificationVersion = specificationVersion
        self.state = state
        self.tasks = tasks
        self.recoveryDecisions = recoveryDecisions
        self.totalTokensConsumed = totalTokensConsumed
        self.totalCostUSD = totalCostUSD
        self.graphRepairRounds = graphRepairRounds
        self.terminationReason = terminationReason
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var verifiedTasks: [DurableTaskRecord] { tasks.filter { $0.state == .verified } }
    public var failedOrBlockedTasks: [DurableTaskRecord] { tasks.filter { $0.state == .failed || $0.state == .blocked || $0.state == .exhausted } }
}

// MARK: - Durable Execution Store (Persistence + Fencing + Verification Gate)

public actor DurableExecutionStore {
    private let storage: FleetStorage
    private var workflows: [UUID: DurableWorkflowCheckpoint] = [:]
    private var transitions: [UUID: [StateTransitionEvent]] = [:]
    private var nextFence: UInt64 = 1

    public init(storage: FleetStorage = try! FleetStorage(location: .inMemory)) {
        self.storage = storage
    }

    public func createWorkflow(
        id: UUID = UUID(),
        objective: String,
        projectPath: String = "",
        targetBranch: String = "main"
    ) throws -> DurableWorkflowCheckpoint {
        let cp = DurableWorkflowCheckpoint(id: id, objective: objective, projectPath: projectPath, targetBranch: targetBranch)
        workflows[id] = cp
        try storage.save(cp, namespace: "workflows", id: id.uuidString)
        return cp
    }

    public func checkpoint(_ id: UUID) -> DurableWorkflowCheckpoint? {
        if let mem = workflows[id] { return mem }
        if let loaded = try? storage.load(DurableWorkflowCheckpoint.self, namespace: "workflows", id: id.uuidString) {
            workflows[id] = loaded
            return loaded
        }
        return nil
    }

    public func restoreWorkflow(id: UUID) throws -> DurableWorkflowCheckpoint? {
        if let loaded = try storage.load(DurableWorkflowCheckpoint.self, namespace: "workflows", id: id.uuidString) {
            workflows[id] = loaded
            return loaded
        }
        return workflows[id]
    }

    public func transitionWorkflow(_ id: UUID, to newState: DurableWorkflowState, reason: String) throws {
        guard var cp = checkpoint(id) else { throw FleetError("Workflow \(id) not found") }
        let old = cp.state.rawValue
        cp.state = newState
        cp.updatedAt = Date()
        if newState == .failed || newState == .blocked || newState == .partiallyCompleted || newState == .cancelled {
            cp.terminationReason = reason
        }
        workflows[id] = cp
        try storage.save(cp, namespace: "workflows", id: id.uuidString)
        let ev = StateTransitionEvent(workflowID: id, taskID: nil, fromState: old, toState: newState.rawValue, reason: reason)
        transitions[id, default: []].append(ev)
        try? storage.save(transitions[id] ?? [], namespace: "workflow_transitions", id: id.uuidString)
    }

    public func upsertTasks(_ tasks: [DurableTaskRecord], in workflowID: UUID) throws {
        guard var cp = checkpoint(workflowID) else { throw FleetError("Workflow \(workflowID) not found") }
        for t in tasks {
            if let idx = cp.tasks.firstIndex(where: { $0.id == t.id }) {
                cp.tasks[idx] = t
            } else {
                cp.tasks.append(t)
            }
        }
        cp.updatedAt = Date()
        workflows[workflowID] = cp
        try storage.save(cp, namespace: "workflows", id: workflowID.uuidString)
    }

    public func transitionTask(
        _ taskID: String,
        in workflowID: UUID,
        to newState: DurableTaskState,
        reason: String,
        dependencyReferences: [String] = []
    ) throws {
        guard var cp = checkpoint(workflowID),
              let idx = cp.tasks.firstIndex(where: { $0.id == taskID }) else {
            throw FleetError("Task \(taskID) not found in workflow \(workflowID)")
        }
        if newState == .verified {
            let t = cp.tasks[idx]
            let hasOutput = !(t.outputText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let hasArtifact = !t.verifiedArtifacts.isEmpty || !t.commitSHAs.isEmpty
            guard hasOutput || hasArtifact else {
                throw FleetError("Verification gate rejected transition to VERIFIED for \(taskID): missing evidence.")
            }
            if t.role == .executor && cp.objectiveCategory == .repositoryImplementation && !hasArtifact {
                throw FleetError("Verification gate rejected prose-only completion for implementation task \(taskID).")
            }
        }
        let old = cp.tasks[idx].state.rawValue
        cp.tasks[idx].state = newState
        cp.tasks[idx].updatedAt = Date()
        if newState == .blocked || newState == .cancelled || newState == .exhausted {
            cp.tasks[idx].skipOrBlockReason = reason
            cp.tasks[idx].dependencyReferences = dependencyReferences
        }
        cp.updatedAt = Date()
        workflows[workflowID] = cp
        try storage.save(cp, namespace: "workflows", id: workflowID.uuidString)
        let ev = StateTransitionEvent(workflowID: workflowID, taskID: taskID, fromState: old, toState: newState.rawValue, reason: reason)
        transitions[workflowID, default: []].append(ev)
        try? storage.save(transitions[workflowID] ?? [], namespace: "workflow_transitions", id: workflowID.uuidString)
    }

    /// Issues a monotonic fencing token for a task execution lease so stale workers cannot overwrite newer work.
    public func acquireFencedLease(taskID: String, in workflowID: UUID, hostID: String, model: String, provider: String) throws -> UInt64 {
        guard var cp = checkpoint(workflowID),
              let idx = cp.tasks.firstIndex(where: { $0.id == taskID }) else {
            throw FleetError("Task \(taskID) not found")
        }
        let token = nextFence
        nextFence += 1
        cp.tasks[idx].fencingToken = token
        cp.tasks[idx].assignedHostID = hostID
        cp.tasks[idx].assignedModel = model
        cp.tasks[idx].assignedProvider = provider
        cp.tasks[idx].state = .running
        cp.tasks[idx].updatedAt = Date()
        workflows[workflowID] = cp
        try storage.save(cp, namespace: "workflows", id: workflowID.uuidString)
        return token
    }

    /// Rejects stale workers whose fencing token no longer matches the authoritative task lease.
    public func commitFencedOutput(
        taskID: String,
        in workflowID: UUID,
        fencingToken: UInt64,
        outputText: String,
        artifacts: [String] = [],
        commitSHAs: [String] = []
    ) throws {
        guard var cp = checkpoint(workflowID),
              let idx = cp.tasks.firstIndex(where: { $0.id == taskID }) else {
            throw FleetError("Task \(taskID) not found")
        }
        guard cp.tasks[idx].fencingToken == fencingToken else {
            throw FleetError("Stale worker rejected: fencing token \(fencingToken) != active \(cp.tasks[idx].fencingToken)")
        }
        cp.tasks[idx].outputText = outputText
        cp.tasks[idx].verifiedArtifacts.append(contentsOf: artifacts)
        cp.tasks[idx].commitSHAs.append(contentsOf: commitSHAs)
        cp.tasks[idx].state = .outputReceived
        cp.tasks[idx].updatedAt = Date()
        workflows[workflowID] = cp
        try storage.save(cp, namespace: "workflows", id: workflowID.uuidString)
    }

    public func transitionHistory(for workflowID: UUID) -> [StateTransitionEvent] {
        transitions[workflowID] ?? []
    }
}
