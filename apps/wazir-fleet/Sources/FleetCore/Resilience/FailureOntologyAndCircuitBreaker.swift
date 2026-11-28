import Foundation

// MARK: - Section 6: Failure Ontology

public enum FailureDomain: String, Codable, Sendable, CaseIterable, Hashable {
    case infrastructure
    case modelExecution
    case task
    case orchestration
    case evaluation
}

public enum FailureCode: String, Codable, Sendable, CaseIterable, Hashable {
    // Infrastructure
    case machineOffline
    case networkDisconnected
    case dnsFailure
    case providerUnavailable
    case authenticationExpired
    case runtimeCrashed
    case subprocessTerminated
    case gpuUnavailable
    case outOfMemory
    case thermalOrResourceThrottling
    case insufficientStorage
    // Model execution
    case emptyResponse
    case reasoningBudgetExhausted
    case outputBudgetExhausted
    case invalidStructuredOutput
    case contextOverflow
    case unsupportedToolInvocation
    case truncatedResponse
    case repeatedNonproductiveBehavior
    case modelGeneratedCompletionWithoutEvidence
    // Task
    case excessiveTaskComplexity
    case missingContext
    case ambiguousRequirements
    case incorrectDecomposition
    case unsatisfiedDependencies
    case incompatibleToolRequirements
    case compilationFailure
    case testFailure
    case invalidArtifact
    // Orchestration
    case incorrectModelAssignment
    case invalidDependencyGraph
    case duplicateTaskDispatch
    case incorrectTimeout
    case lostTaskState
    case resourceOvercommitment
    case invalidCompletionDetection
    case correlatedWorkerFailures
    case prematureWorkflowTermination
    // Evaluation
    case reviewerUnavailable
    case inconsistentEvaluatorResults
    case invalidRubric
    case missingVerificationEvidence
    case deterministicValidatorFailure
}

// MARK: - Section 7: Intelligent Retry Interventions

public enum RecoveryIntervention: String, Codable, Sendable, CaseIterable, Hashable {
    case retryWithTimeoutAdjustment
    case inspectAdapterAndAdjustTokens
    case compressContextOrSplitTask
    case reserveCompletionCapacity
    case applySchemaConstrainedGeneration
    case reduceConcurrencyOrSelectSmallerModel
    case openCircuitBreakerAndReroute
    case blockEndpointPendingAuth
    case dispatchCompilerRepairTask
    case replanAndDecompose
    case completeOrRepairPrerequisite
    case deterministicToolFallback
    case reassignHealthierMachine
    case requestHumanIntervention
}

public struct FailureDiagnosis: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var taskID: String
    public var domain: FailureDomain
    public var code: FailureCode
    public var observedEvidence: String
    public var suspectedRootCause: String
    public var confidence: Double
    public var penalizeIntrinsicModelQuality: Bool
    public var recommendedIntervention: RecoveryIntervention
    public var timestamp: Date

    public init(
        id: UUID = UUID(),
        taskID: String,
        domain: FailureDomain,
        code: FailureCode,
        observedEvidence: String,
        suspectedRootCause: String,
        confidence: Double,
        penalizeIntrinsicModelQuality: Bool,
        recommendedIntervention: RecoveryIntervention,
        timestamp: Date = Date()
    ) {
        self.id = id
        self.taskID = taskID
        self.domain = domain
        self.code = code
        self.observedEvidence = observedEvidence
        self.suspectedRootCause = suspectedRootCause
        self.confidence = confidence
        self.penalizeIntrinsicModelQuality = penalizeIntrinsicModelQuality
        self.recommendedIntervention = recommendedIntervention
        self.timestamp = timestamp
    }
}

public enum FailureClassifier {
    public static func classify(
        taskID: String,
        errorMessage: String,
        repeatedEquivalentFailures: Int = 0
    ) -> FailureDiagnosis {
        let lower = errorMessage.lowercased()

        if repeatedEquivalentFailures >= 2 {
            return FailureDiagnosis(
                taskID: taskID, domain: .task, code: .excessiveTaskComplexity,
                observedEvidence: errorMessage,
                suspectedRootCause: "Repeated equivalent failures (\(repeatedEquivalentFailures)) indicate task complexity or prompt structure defect.",
                confidence: 0.9, penalizeIntrinsicModelQuality: false, recommendedIntervention: .replanAndDecompose
            )
        }
        if lower.contains("unauthorized") || lower.contains("401") || lower.contains("403") || lower.contains("auth") || lower.contains("login") {
            return FailureDiagnosis(
                taskID: taskID, domain: .infrastructure, code: .authenticationExpired,
                observedEvidence: errorMessage, suspectedRootCause: "Provider or endpoint authentication failed or expired.",
                confidence: 0.95, penalizeIntrinsicModelQuality: false, recommendedIntervention: .blockEndpointPendingAuth
            )
        }
        if lower.contains("out of memory") || lower.contains("oom") || lower.contains("cuda") || lower.contains("vram") || lower.contains("metal") {
            return FailureDiagnosis(
                taskID: taskID, domain: .infrastructure, code: .outOfMemory,
                observedEvidence: errorMessage, suspectedRootCause: "GPU or system memory exhausted on target host.",
                confidence: 0.92, penalizeIntrinsicModelQuality: false, recommendedIntervention: .reduceConcurrencyOrSelectSmallerModel
            )
        }
        if lower.contains("connection refused") || lower.contains("offline") || lower.contains("network") || lower.contains("dns") || lower.contains("cannot connect") {
            return FailureDiagnosis(
                taskID: taskID, domain: .infrastructure, code: .machineOffline,
                observedEvidence: errorMessage, suspectedRootCause: "Host or runtime endpoint unreachable.",
                confidence: 0.92, penalizeIntrinsicModelQuality: false, recommendedIntervention: .openCircuitBreakerAndReroute
            )
        }
        if lower.contains("timed out") || lower.contains("timeout") {
            return FailureDiagnosis(
                taskID: taskID, domain: .orchestration, code: .incorrectTimeout,
                observedEvidence: errorMessage, suspectedRootCause: "Execution exceeded configured deadline or stalled.",
                confidence: 0.85, penalizeIntrinsicModelQuality: false, recommendedIntervention: .retryWithTimeoutAdjustment
            )
        }
        if lower.contains("reasoning") || lower.contains("think") {
            return FailureDiagnosis(
                taskID: taskID, domain: .modelExecution, code: .reasoningBudgetExhausted,
                observedEvidence: errorMessage, suspectedRootCause: "Reasoning tokens consumed the completion budget.",
                confidence: 0.9, penalizeIntrinsicModelQuality: false, recommendedIntervention: .reserveCompletionCapacity
            )
        }
        if lower.contains("context") || lower.contains("too long") || lower.contains("max_tokens") {
            return FailureDiagnosis(
                taskID: taskID, domain: .modelExecution, code: .contextOverflow,
                observedEvidence: errorMessage, suspectedRootCause: "Prompt/context exceeded model context window.",
                confidence: 0.88, penalizeIntrinsicModelQuality: false, recommendedIntervention: .compressContextOrSplitTask
            )
        }
        if lower.contains("json") || lower.contains("decode") || lower.contains("schema") {
            return FailureDiagnosis(
                taskID: taskID, domain: .modelExecution, code: .invalidStructuredOutput,
                observedEvidence: errorMessage, suspectedRootCause: "Model emitted invalid or unparseable structured output.",
                confidence: 0.88, penalizeIntrinsicModelQuality: true, recommendedIntervention: .applySchemaConstrainedGeneration
            )
        }
        if lower.contains("compile") || lower.contains("syntax") || lower.contains("swiftc") {
            return FailureDiagnosis(
                taskID: taskID, domain: .task, code: .compilationFailure,
                observedEvidence: errorMessage, suspectedRootCause: "Generated code failed compilation.",
                confidence: 0.9, penalizeIntrinsicModelQuality: true, recommendedIntervention: .dispatchCompilerRepairTask
            )
        }
        if lower.contains("empty") || lower.contains("no output") || lower.contains("no answer") {
            return FailureDiagnosis(
                taskID: taskID, domain: .modelExecution, code: .emptyResponse,
                observedEvidence: errorMessage, suspectedRootCause: "Adapter or model returned an empty response.",
                confidence: 0.84, penalizeIntrinsicModelQuality: false, recommendedIntervention: .inspectAdapterAndAdjustTokens
            )
        }
        return FailureDiagnosis(
            taskID: taskID, domain: .modelExecution, code: .truncatedResponse,
            observedEvidence: errorMessage, suspectedRootCause: "Execution failed with runtime error.",
            confidence: 0.7, penalizeIntrinsicModelQuality: true, recommendedIntervention: .reassignHealthierMachine
        )
    }
}

// MARK: - Section 8: Correlated Failure Detection & Circuit Breakers

public struct FailureDomainContext: Codable, Sendable, Equatable, Hashable {
    public var taskID: String
    public var modelFamily: String
    public var machineID: String
    public var runtimeKind: String
    public var providerID: String
    public var endpoint: String
    public var adapterID: String
    public var promptTemplateID: String

    public init(
        taskID: String,
        modelFamily: String,
        machineID: String,
        runtimeKind: String,
        providerID: String,
        endpoint: String,
        adapterID: String,
        promptTemplateID: String = "default"
    ) {
        self.taskID = taskID
        self.modelFamily = modelFamily
        self.machineID = machineID
        self.runtimeKind = runtimeKind
        self.providerID = providerID
        self.endpoint = endpoint
        self.adapterID = adapterID
        self.promptTemplateID = promptTemplateID
    }
}

public struct CorrelatedIncident: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var sharedDimension: String
    public var sharedValue: String
    public var affectedTaskIDs: [String]
    public var summary: String
    public var detectedAt: Date

    public init(id: UUID = UUID(), sharedDimension: String, sharedValue: String, affectedTaskIDs: [String], summary: String, detectedAt: Date = Date()) {
        self.id = id
        self.sharedDimension = sharedDimension
        self.sharedValue = sharedValue
        self.affectedTaskIDs = affectedTaskIDs
        self.summary = summary
        self.detectedAt = detectedAt
    }
}

public actor CorrelatedFailureDetector {
    private var recentFailures: [FailureDomainContext] = []

    public init() {}

    public func recordFailure(_ ctx: FailureDomainContext) -> CorrelatedIncident? {
        recentFailures.append(ctx)
        if recentFailures.count > 100 { recentFailures.removeFirst(recentFailures.count - 100) }

        // Check if >= 3 models failed on the same machine
        let sameMachine = recentFailures.filter { $0.machineID == ctx.machineID }
        if Set(sameMachine.map(\.modelFamily)).count >= 3 {
            return CorrelatedIncident(
                sharedDimension: "machine",
                sharedValue: ctx.machineID,
                affectedTaskIDs: Array(Set(sameMachine.map(\.taskID))),
                summary: "Correlated failure on machine '\(ctx.machineID)' across multiple models; investigate host health before downgrading models."
            )
        }
        // Check if >= 2 providers failed through the same CLI adapter
        let sameAdapter = recentFailures.filter { $0.adapterID == ctx.adapterID }
        if Set(sameAdapter.map(\.providerID)).count >= 2 {
            return CorrelatedIncident(
                sharedDimension: "adapter",
                sharedValue: ctx.adapterID,
                affectedTaskIDs: Array(Set(sameAdapter.map(\.taskID))),
                summary: "Correlated failure on shared adapter '\(ctx.adapterID)' across multiple providers; inspect adapter invocation."
            )
        }
        // Check if >= 2 different providers failed on the same task
        let sameTask = recentFailures.filter { $0.taskID == ctx.taskID }
        if Set(sameTask.map(\.providerID)).count >= 2 {
            return CorrelatedIncident(
                sharedDimension: "task",
                sharedValue: ctx.taskID,
                affectedTaskIDs: [ctx.taskID],
                summary: "Task '\(ctx.taskID)' failed across multiple providers; investigate prompt, complexity, or execution contract."
            )
        }
        return nil
    }

    public func clear() { recentFailures.removeAll() }
}

public enum CircuitBreakerScope: String, Codable, Sendable, Hashable {
    case machine
    case runtime
    case provider
    case endpoint
}

public enum CircuitBreakerState: Codable, Sendable, Equatable {
    case closed
    case open(openedAt: Date, cooldownSeconds: Double)
    case halfOpen(probeInFlight: Bool)
}

public actor CircuitBreakerRegistry {
    private struct Entry {
        var scope: CircuitBreakerScope
        var key: String
        var consecutiveFailures: Int = 0
        var state: CircuitBreakerState = .closed
    }

    private var entries: [String: Entry] = [:]
    private let failureThreshold: Int
    private let baseCooldownSeconds: Double

    public init(failureThreshold: Int = 2, baseCooldownSeconds: Double = 15) {
        self.failureThreshold = max(1, failureThreshold)
        self.baseCooldownSeconds = max(1, baseCooldownSeconds)
    }

    private func compositeKey(_ scope: CircuitBreakerScope, _ key: String) -> String {
        "\(scope.rawValue):\(key)"
    }

    public func state(scope: CircuitBreakerScope, key: String, now: Date = Date()) -> CircuitBreakerState {
        let ck = compositeKey(scope, key)
        guard var entry = entries[ck] else { return .closed }
        if case .open(let openedAt, let cooldown) = entry.state, now.timeIntervalSince(openedAt) >= cooldown {
            entry.state = .halfOpen(probeInFlight: false)
            entries[ck] = entry
        }
        return entry.state
    }

    public func canAttempt(scope: CircuitBreakerScope, key: String, now: Date = Date()) -> Bool {
        switch state(scope: scope, key: key, now: now) {
        case .closed: return true
        case .open: return false
        case .halfOpen(let inFlight): return !inFlight
        }
    }

    public func recordSuccess(scope: CircuitBreakerScope, key: String) {
        let ck = compositeKey(scope, key)
        entries[ck] = Entry(scope: scope, key: key, consecutiveFailures: 0, state: .closed)
    }

    public func recordFailure(scope: CircuitBreakerScope, key: String, now: Date = Date()) -> CircuitBreakerState {
        let ck = compositeKey(scope, key)
        var entry = entries[ck] ?? Entry(scope: scope, key: key)
        entry.consecutiveFailures += 1
        if entry.consecutiveFailures >= failureThreshold {
            let exponent = min(5, entry.consecutiveFailures - failureThreshold)
            let cooldown = baseCooldownSeconds * pow(2.0, Double(exponent))
            entry.state = .open(openedAt: now, cooldownSeconds: cooldown)
        }
        entries[ck] = entry
        return entry.state
    }

    public func trip(scope: CircuitBreakerScope, key: String, cooldownSeconds: Double = 60, now: Date = Date()) {
        let ck = compositeKey(scope, key)
        var entry = entries[ck] ?? Entry(scope: scope, key: key)
        entry.state = .open(openedAt: now, cooldownSeconds: cooldownSeconds)
        entries[ck] = entry
    }

    public func reset(scope: CircuitBreakerScope, key: String) {
        let ck = compositeKey(scope, key)
        entries[ck] = Entry(scope: scope, key: key, consecutiveFailures: 0, state: .closed)
    }

    public func allStates() -> [(scope: CircuitBreakerScope, key: String, state: CircuitBreakerState)] {
        entries.values.map { ($0.scope, $0.key, $0.state) }.sorted { $0.key < $1.key }
    }
}

// MARK: - Section 15 & 16: Adaptive Timeouts & Hierarchical Recovery Budgets

public struct AdaptiveTimeoutPolicy: Codable, Sendable, Equatable {
    public var connectionTimeoutSeconds: Double
    public var timeToFirstTokenSeconds: Double
    public var streamingInactivitySeconds: Double
    public var toolExecutionSeconds: Double
    public var totalTaskDeadlineSeconds: Double
    public var queueWaitingSeconds: Double
    public var workflowDeadlineSeconds: Double

    public static func forExecution(
        isLocal: Bool,
        isModelLoaded: Bool,
        isReasoningModel: Bool,
        contextTokens: Int,
        complexityScore: Int
    ) -> AdaptiveTimeoutPolicy {
        let loadGrace = isModelLoaded ? 0.0 : 90.0
        let speedMultiplier = isLocal ? 1.5 : 1.0
        let reasoningGrace = isReasoningModel ? 60.0 : 0.0
        let contextGrace = Double(contextTokens / 4096) * 15.0
        let complexityGrace = Double(max(1, complexityScore)) * 20.0

        return AdaptiveTimeoutPolicy(
            connectionTimeoutSeconds: isLocal ? 8 : 15,
            timeToFirstTokenSeconds: 20 + loadGrace + reasoningGrace,
            streamingInactivitySeconds: isReasoningModel ? 45 : 25,
            toolExecutionSeconds: 120,
            totalTaskDeadlineSeconds: (60 + loadGrace + reasoningGrace + contextGrace + complexityGrace) * speedMultiplier,
            queueWaitingSeconds: 180,
            workflowDeadlineSeconds: 1800
        )
    }
}

public struct RecoveryBudgetPolicy: Codable, Sendable, Equatable {
    public var maxAttemptsPerTaskRevision: Int
    public var maxRepeatedEquivalentFailures: Int
    public var maxGraphRepairRounds: Int
    public var maxDecompositionDepth: Int
    public var maxTotalChildTasks: Int
    public var recoveryTimeBudgetSeconds: Double
    public var authorizedCloudSpendUSD: Double

    public init(
        maxAttemptsPerTaskRevision: Int = 4,
        maxRepeatedEquivalentFailures: Int = 2,
        maxGraphRepairRounds: Int = 3,
        maxDecompositionDepth: Int = 3,
        maxTotalChildTasks: Int = 24,
        recoveryTimeBudgetSeconds: Double = 600,
        authorizedCloudSpendUSD: Double = 20.0
    ) {
        self.maxAttemptsPerTaskRevision = maxAttemptsPerTaskRevision
        self.maxRepeatedEquivalentFailures = maxRepeatedEquivalentFailures
        self.maxGraphRepairRounds = maxGraphRepairRounds
        self.maxDecompositionDepth = maxDecompositionDepth
        self.maxTotalChildTasks = maxTotalChildTasks
        self.recoveryTimeBudgetSeconds = recoveryTimeBudgetSeconds
        self.authorizedCloudSpendUSD = authorizedCloudSpendUSD
    }
}
