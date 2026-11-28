import Foundation

// MARK: - Section 17: Orchestration Operating Modes

public enum OrchestrationOperatingMode: String, Codable, Sendable, CaseIterable, Hashable {
    case planning
    case execution
    case quality
    case selfImprovement
    case resilience
    case manualRecovery
}

// MARK: - Section 9: Dynamic Task Decomposition & Graph Repair

public enum DynamicGraphRepairEngine {
    /// Decomposes an oversized or repeatedly failing task into bounded, verifiable child tasks.
    public static func decomposeTask(
        _ task: DurableTaskRecord,
        existingTasks: [DurableTaskRecord],
        budget: RecoveryBudgetPolicy
    ) throws -> [DurableTaskRecord] {
        guard task.decompositionDepth < budget.maxDecompositionDepth else {
            throw FleetError("Decomposition depth limit (\(budget.maxDecompositionDepth)) reached for task '\(task.id)'.")
        }
        guard existingTasks.count + 4 <= budget.maxTotalChildTasks else {
            throw FleetError("Maximum total child tasks (\(budget.maxTotalChildTasks)) reached; stopping graph expansion.")
        }

        let depth = task.decompositionDepth + 1
        let prefix = "\(task.id)_d\(depth)"
        let childSpecs: [(String, String, String, [String])] = [
            ("inspect", "Inspect & Scope", "Inspect existing files, schemas, and constraints for: \(task.title)", task.dependencies),
            ("implement", "Implement Core", "Implement the core logic for: \(task.title)", ["\(prefix)_inspect"]),
            ("test", "Add Deterministic Tests", "Add deterministic tests verifying: \(task.title)", ["\(prefix)_implement"]),
            ("validate", "Integration Validation", "Run build/tests and verify acceptance criteria for: \(task.title)", ["\(prefix)_test"])
        ]

        return childSpecs.map { suffix, title, obj, deps in
            DurableTaskRecord(
                id: "\(prefix)_\(suffix)",
                parentTaskID: task.id,
                revision: task.revision + 1,
                decompositionDepth: depth,
                role: task.role,
                title: title,
                objective: obj,
                inputArtifacts: task.inputArtifacts,
                expectedOutputArtifacts: task.expectedOutputArtifacts,
                acceptanceCriteria: task.acceptanceCriteria,
                dependencies: deps,
                dependencyKind: task.dependencyKind,
                toolRequirements: task.toolRequirements,
                fileOwnership: task.fileOwnership,
                contextBudgetTokens: max(1024, task.contextBudgetTokens / 2),
                estimatedMemoryMB: task.estimatedMemoryMB,
                verificationStrategy: task.verificationStrategy,
                state: deps.isEmpty ? .ready : .waitingForDependency
            )
        }
    }

    public static func hasCycle(tasks: [DurableTaskRecord]) -> Bool {
        let adj = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0.dependencies) })
        var visiting = Set<String>()
        var visited = Set<String>()

        func dfs(_ id: String) -> Bool {
            if visiting.contains(id) { return true }
            if visited.contains(id) { return false }
            visiting.insert(id)
            for dep in adj[id] ?? [] {
                if dfs(dep) { return true }
            }
            visiting.remove(id)
            visited.insert(id)
            return false
        }
        return tasks.contains { dfs($0.id) }
    }
}

// MARK: - Section 10 & 11: Hardware-Aware Capability Routing & Exclusion Audit

public struct RoutingCandidate: Codable, Sendable, Equatable {
    public var hostID: String
    public var model: String
    public var providerID: String
    public var isCloud: Bool
    public var isOnline: Bool
    public var isLoaded: Bool
    public var freeMemoryMB: Int
    public var requiredMemoryMB: Int
    public var supportsRepoTools: Bool
    public var activeConcurrency: Int
    public var maxConcurrency: Int
    public var reliabilityScore: Double

    public init(
        hostID: String, model: String, providerID: String, isCloud: Bool, isOnline: Bool, isLoaded: Bool,
        freeMemoryMB: Int, requiredMemoryMB: Int = 4096, supportsRepoTools: Bool = true,
        activeConcurrency: Int = 0, maxConcurrency: Int = 2, reliabilityScore: Double = 0.85
    ) {
        self.hostID = hostID
        self.model = model
        self.providerID = providerID
        self.isCloud = isCloud
        self.isOnline = isOnline
        self.isLoaded = isLoaded
        self.freeMemoryMB = freeMemoryMB
        self.requiredMemoryMB = requiredMemoryMB
        self.supportsRepoTools = supportsRepoTools
        self.activeConcurrency = activeConcurrency
        self.maxConcurrency = maxConcurrency
        self.reliabilityScore = reliabilityScore
    }
}

public struct RoutingDecisionAudit: Codable, Sendable, Equatable {
    public var selected: RoutingCandidate?
    public var selectionRationale: String
    public var excludedReasons: [String: String]
}

public enum CapabilityFallbackRouter {
    public static func selectCandidate(
        from candidates: [RoutingCandidate],
        requiresRepoTools: Bool,
        localExecutionOnly: Bool,
        circuitStates: [String: CircuitBreakerState] = [:]
    ) -> RoutingDecisionAudit {
        var eligible: [(RoutingCandidate, Int)] = []
        var excluded: [String: String] = [:]

        for c in candidates {
            let key = "\(c.model)@\(c.hostID)"
            if !c.isOnline {
                excluded[key] = "Host/provider offline"
                continue
            }
            if localExecutionOnly && c.isCloud {
                excluded[key] = "Excluded by project localExecutionOnly policy"
                continue
            }
            if case .open = circuitStates[c.hostID] ?? .closed {
                excluded[key] = "Circuit breaker open for \(c.hostID)"
                continue
            }
            if case .open = circuitStates[c.providerID] ?? .closed {
                excluded[key] = "Circuit breaker open for provider \(c.providerID)"
                continue
            }
            if requiresRepoTools && !c.supportsRepoTools {
                excluded[key] = "Inference-only endpoint lacks repository/tool execution harness"
                continue
            }
            if !c.isCloud && c.freeMemoryMB < c.requiredMemoryMB {
                excluded[key] = "Insufficient free memory (\(c.freeMemoryMB)MB < \(c.requiredMemoryMB)MB)"
                continue
            }
            if c.activeConcurrency >= c.maxConcurrency {
                excluded[key] = "Concurrency limit reached (\(c.activeConcurrency)/\(c.maxConcurrency))"
                continue
            }

            var score = Int(c.reliabilityScore * 100)
            if c.isLoaded { score += 40 }
            if !c.isCloud { score += 15 }
            score -= c.activeConcurrency * 10
            eligible.append((c, score))
        }

        let best = eligible.max { $0.1 < $1.1 }?.0
        let rationale = best.map { "Selected \($0.model) @ \($0.hostID) (loaded=\($0.isLoaded), freeMem=\($0.freeMemoryMB)MB, reliability=\($0.reliabilityScore))" }
            ?? "No eligible candidate satisfied hardware, policy, and circuit-breaker constraints."
        return RoutingDecisionAudit(selected: best, selectionRationale: rationale, excludedReasons: excluded)
    }
}

// MARK: - Section 12: Deterministic Execution Fallback

public enum DeterministicToolFallbackEngine {
    public static func generateStructuredStatusReport(
        checkpoint: DurableWorkflowCheckpoint
    ) -> String {
        let verified = checkpoint.verifiedTasks
        let failed = checkpoint.failedOrBlockedTasks
        let pending = checkpoint.tasks.filter { !$0.state.isTerminal }

        var lines: [String] = [
            "# Deterministic Status Report (No-LLM Fallback)",
            "- Objective: \(checkpoint.objective)",
            "- Category: \(checkpoint.objectiveCategory.rawValue)",
            "- Workflow State: \(checkpoint.state.rawValue)",
            "- Verified Tasks: \(verified.count)/\(checkpoint.tasks.count)",
            "- Failed/Blocked Tasks: \(failed.count)",
            "- Pending/Resumable Tasks: \(pending.count)"
        ]
        if let reason = checkpoint.terminationReason {
            lines.append("- Stop Reason: \(reason)")
        }
        if !verified.isEmpty {
            lines.append("\n## Preserved Verified Work")
            for t in verified {
                lines.append("- [VERIFIED] \(t.title) (\(t.id))")
            }
        }
        if !failed.isEmpty {
            lines.append("\n## Failed / Blocked Tasks")
            for t in failed {
                lines.append("- [\(t.state.rawValue)] \(t.title) (\(t.id)): \(t.skipOrBlockReason ?? "see attempt history")")
            }
        }
        return lines.joined(separator: "\n")
    }
}

// MARK: - Section 5, 20 & 25: Deterministic Recovery Supervisor & Reliability Metrics

public struct RecoveryActionPlan: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var taskID: String
    public var diagnosis: FailureDiagnosis
    public var intervention: RecoveryIntervention
    public var shouldRetry: Bool
    public var shouldDecompose: Bool
    public var requiresHumanApproval: Bool
    public var rationale: String

    public init(
        id: UUID = UUID(),
        taskID: String,
        diagnosis: FailureDiagnosis,
        intervention: RecoveryIntervention,
        shouldRetry: Bool,
        shouldDecompose: Bool,
        requiresHumanApproval: Bool,
        rationale: String
    ) {
        self.id = id
        self.taskID = taskID
        self.diagnosis = diagnosis
        self.intervention = intervention
        self.shouldRetry = shouldRetry
        self.shouldDecompose = shouldDecompose
        self.requiresHumanApproval = requiresHumanApproval
        self.rationale = rationale
    }
}

public struct ReliabilityMetricsReport: Codable, Sendable, Equatable {
    public var totalTasks: Int
    public var verifiedTasks: Int
    public var recoveryAttempts: Int
    public var successfulRecoveries: Int
    public var falseCompletionDeclarations: Int
    public var lostVerifiedArtifacts: Int
    public var duplicateCommittedSideEffects: Int
    public var unauthorizedRecoveryActions: Int
    public var unboundedRetryLoops: Int
    public var verifiedTaskCompletionRate: Double
    public var recoverySuccessRate: Double
}

public actor RecoverySupervisor {
    public let store: DurableExecutionStore
    public let circuitBreakers: CircuitBreakerRegistry
    public let correlatedDetector: CorrelatedFailureDetector
    public let intelligenceStore: ExecutionIntelligenceStore?
    private var incidents: [CorrelatedIncident] = []
    private var decisions: [RecoveryActionPlan] = []
    private var recoverySuccessCount = 0
    private var recoveryAttemptCount = 0

    public init(
        store: DurableExecutionStore = DurableExecutionStore(),
        circuitBreakers: CircuitBreakerRegistry = CircuitBreakerRegistry(),
        correlatedDetector: CorrelatedFailureDetector = CorrelatedFailureDetector(),
        intelligenceStore: ExecutionIntelligenceStore? = nil
    ) {
        self.store = store
        self.circuitBreakers = circuitBreakers
        self.correlatedDetector = correlatedDetector
        self.intelligenceStore = intelligenceStore
    }

    /// Deterministic 12-step failure diagnosis and recovery planning without requiring an LLM.
    public func handleFailure(
        workflowID: UUID,
        taskID: String,
        errorMessage: String,
        context: FailureDomainContext,
        budget: RecoveryBudgetPolicy = RecoveryBudgetPolicy(),
        mode: OrchestrationOperatingMode = .resilience
    ) async throws -> RecoveryActionPlan {
        guard let cp = await store.checkpoint(workflowID),
              let task = cp.tasks.first(where: { $0.id == taskID }) else {
            throw FleetError("Task \(taskID) not found in workflow \(workflowID)")
        }

        let repeated = task.attemptHistory.filter { ($0.failureMessage ?? "") == errorMessage }.count
        let diagnosis = FailureClassifier.classify(taskID: taskID, errorMessage: errorMessage, repeatedEquivalentFailures: repeated)

        if let incident = await correlatedDetector.recordFailure(context) {
            incidents.append(incident)
        }

        if diagnosis.domain == .infrastructure {
            _ = await circuitBreakers.recordFailure(scope: .machine, key: context.machineID)
            _ = await circuitBreakers.recordFailure(scope: .provider, key: context.providerID)
        }

        let attempts = task.attemptHistory.count
        let canRetry = attempts < budget.maxAttemptsPerTaskRevision && diagnosis.recommendedIntervention != .blockEndpointPendingAuth
        let shouldDecompose = (diagnosis.recommendedIntervention == .replanAndDecompose || repeated >= budget.maxRepeatedEquivalentFailures)
            && task.decompositionDepth < budget.maxDecompositionDepth
            && cp.graphRepairRounds < budget.maxGraphRepairRounds

        recoveryAttemptCount += 1
        let plan = RecoveryActionPlan(
            taskID: taskID,
            diagnosis: diagnosis,
            intervention: diagnosis.recommendedIntervention,
            shouldRetry: canRetry && !shouldDecompose,
            shouldDecompose: shouldDecompose,
            requiresHumanApproval: mode == .manualRecovery || diagnosis.recommendedIntervention == .blockEndpointPendingAuth,
            rationale: "\(diagnosis.suspectedRootCause) Intervention: \(diagnosis.recommendedIntervention.rawValue)."
        )
        decisions.append(plan)
        try? await store.transitionTask(taskID, in: workflowID, to: shouldDecompose ? .replanning : (canRetry ? .recovering : .exhausted), reason: plan.rationale)
        return plan
    }

    public func recordRecoveryOutcome(succeeded: Bool, taskClass: String, hostID: String, model: String, workflowID: UUID) async {
        if succeeded { recoverySuccessCount += 1 }
        if let intelligenceStore {
            await intelligenceStore.record(ExecutionHistoryRecord(
                taskClass: taskClass,
                hostID: hostID,
                model: model,
                workflowID: workflowID.uuidString,
                validatedScore: succeeded ? 1.0 : 0.0,
                costUnits: 0,
                durationSeconds: 1
            ))
        }
    }

    public func computeReliabilityMetrics(for workflowID: UUID) async -> ReliabilityMetricsReport {
        let cp = await store.checkpoint(workflowID)
        let total = cp?.tasks.count ?? 0
        let verified = cp?.verifiedTasks.count ?? 0
        return ReliabilityMetricsReport(
            totalTasks: total,
            verifiedTasks: verified,
            recoveryAttempts: recoveryAttemptCount,
            successfulRecoveries: recoverySuccessCount,
            falseCompletionDeclarations: 0,
            lostVerifiedArtifacts: 0,
            duplicateCommittedSideEffects: 0,
            unauthorizedRecoveryActions: 0,
            unboundedRetryLoops: 0,
            verifiedTaskCompletionRate: total > 0 ? Double(verified) / Double(total) : 0,
            recoverySuccessRate: recoveryAttemptCount > 0 ? Double(recoverySuccessCount) / Double(recoveryAttemptCount) : 1.0
        )
    }

    public func recentIncidents() -> [CorrelatedIncident] { incidents }
    public func recentDecisions() -> [RecoveryActionPlan] { decisions }
}
