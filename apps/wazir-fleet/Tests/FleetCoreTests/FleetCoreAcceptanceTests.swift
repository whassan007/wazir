import Foundation
import Testing
@testable import FleetCore

@Suite("Fleet Core Acceptance Criteria")
struct FleetCoreAcceptanceTests {
    @Test func evaluationSeparatesExecutionFromValidationAndRejectsMissingEvidence() {
        let engine = EvaluationEngine()
        let rubric = EvaluationRubric(
            id: "r1",
            title: "Test Rubric",
            criteria: [
                RubricCriterion(id: "c1", name: "Accuracy", weight: 0.5, minimumPassingScore: 0.7),
                RubricCriterion(id: "c2", name: "Safety", weight: 0.5, minimumPassingScore: 0.9, isNonNegotiableGate: true),
            ]
        )

        // Execution completed, but c2 evidence is missing -> must be .unverified, score nil
        let partial = engine.evaluate(
            rubric: rubric,
            executionOutcome: .completed,
            evidence: [EvaluationEvidence(criterionID: "c1", evaluatorID: "judge-a", score: 0.95, passed: true, summary: "ok")]
        )
        #expect(partial.weightedScore == nil)
        if case .unverified = partial.validationState { } else { Issue.record("Expected .unverified for missing evidence") }

        // Complete evidence -> .validatedPass
        let full = engine.evaluate(
            rubric: rubric,
            executionOutcome: .completed,
            evidence: [
                EvaluationEvidence(criterionID: "c1", evaluatorID: "judge-a", score: 0.9, passed: true, summary: "ok"),
                EvaluationEvidence(criterionID: "c2", evaluatorID: "judge-b", score: 0.95, passed: true, summary: "safe"),
            ]
        )
        #expect(full.validationState.isVerifiedPass)
        #expect((full.weightedScore ?? 0) > 0.9)
    }

    @Test func optimizationLoopRejectsRegressionAndRetainsBestCandidate() async throws {
        let loop = OptimizationLoopEngine()
        let rubric = EvaluationRubric(
            id: "opt",
            title: "Opt",
            criteria: [RubricCriterion(id: "q", name: "Quality", weight: 1.0, minimumPassingScore: 0.5)]
        )
        let target = OptimizationTarget(targetScore: 0.95, maxIterations: 3)
        let result = try await loop.run(
            rubric: rubric,
            target: target,
            baselineArtifact: "v0",
            baselineEvidence: [EvaluationEvidence(criterionID: "q", evaluatorID: "j", score: 0.70, passed: true, summary: "base")]
        ) { iter, _ in
            switch iter {
            case 1: ("v1", [EvaluationEvidence(criterionID: "q", evaluatorID: "j", score: 0.85, passed: true, summary: "better")])
            case 2: ("v2-regressed", [EvaluationEvidence(criterionID: "q", evaluatorID: "j", score: 0.60, passed: true, summary: "worse")])
            default: ("v3", [EvaluationEvidence(criterionID: "q", evaluatorID: "j", score: 0.96, passed: true, summary: "target")])
            }
        }
        #expect(result.terminationReason == .targetReached)
        #expect(result.bestCandidate.artifactRef == "v3")
        #expect(result.history.contains { $0.artifactRef == "v2-regressed" && !$0.accepted })
    }

    @Test func policyRegistryBlocksUntrustedOverrideOfPlatformSecurity() async throws {
        let registry = FrameworkPolicyRegistry()
        await #expect(throws: FleetError.self) {
            try await registry.register(PolicyRule(
                id: "platform.security.default",
                scope: .project,
                category: .security,
                title: "Weaken security",
                mandatory: false
            ))
        }
    }

    @Test func extensionsLoadDisableAndSupportTwoSyntheticProjects() throws {
        let manager = ExtensionManager()
        let robotics = SyntheticRoboticsExtension()
        let dataEng = SyntheticDataEngineeringExtension()
        try manager.load(robotics)
        try manager.load(dataEng)
        #expect(manager.activePlugins().count == 2)

        manager.setEnabled(false, for: robotics.manifest.id)
        #expect(manager.activePlugins().count == 1)
        #expect(manager.activePlugins().first?.manifest.id == dataEng.manifest.id)
    }

    @Test func findingsConsolidatorAndCriticalBlockerPriority() {
        let engine = ProjectIntelligenceEngine()
        let f1 = Finding(rootCauseKey: "auth-timeout", title: "Auth timeout", componentID: "api", sourceAgentID: "a1")
        let f2 = Finding(rootCauseKey: "auth-timeout", title: "Auth timeout", componentID: "cli", isCriticalBlocker: true, sourceAgentID: "a2")
        let consolidated = engine.consolidateFindings([f1, f2])
        #expect(consolidated.count == 1)
        #expect(consolidated[0].occurrenceCount == 2)
        #expect(consolidated[0].isCriticalBlocker)

        let normal = WorkItem(id: "w1", title: "Nice to have", impact: 10, confidence: 1, urgency: 10)
        let blocker = WorkItem(id: "w2", title: "Critical gate", impact: 1, confidence: 1, urgency: 1, hasCriticalBlocker: true)
        let sorted = engine.prioritize([normal, blocker])
        #expect(sorted.first?.id == "w2")
    }

    @Test func gitWorktreeCoordinatorProtectsHumanFilesAndPreventsConflicts() async throws {
        let coord = GitWorktreeCoordinator()
        await coord.protectHumanModifications(["Sources/Fleet/Flow/FlowCanvas.swift"])
        await #expect(throws: FleetError.self) {
            try await coord.claimOwnership(files: ["Sources/Fleet/Flow/FlowCanvas.swift"], agentID: "agent-1", worktreePath: "/tmp/wt1")
        }
        try await coord.claimOwnership(files: ["Sources/FleetCore/NewFile.swift"], agentID: "agent-1", worktreePath: "/tmp/wt1")
        await #expect(throws: FleetError.self) {
            try await coord.claimOwnership(files: ["Sources/FleetCore/NewFile.swift"], agentID: "agent-2", worktreePath: "/tmp/wt2")
        }
    }

    @Test func slashCommandsShareControlPlaneRuntime() async {
        let runtime = ControlPlaneRuntime()
        for cmd in FleetSlashCommand.allCases {
            let resp = await runtime.handleSlashCommand("/\(cmd.rawValue)")
            #expect(resp.status == "ok")
        }
    }

    @Test func wazirControlPlaneBridgeRoundTripsSharedFleetState() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("wazir-bridge-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let bridge = WazirControlPlaneBridge(environment: ["WAZIR_HOME": tmpDir.path])
        let config = DefaultFleet.config
        var state = FleetState()
        FleetReducer.reduce(&state, .configLoaded(config))
        if let first = config.hosts.first {
            FleetReducer.reduce(&state, .reachability(host: first.id, .online(latencyMS: 1.5, address: "127.0.0.1"), at: Date()))
        }

        try bridge.exportSnapshot(from: config, state: state)
        let loaded = try bridge.readSnapshot()
        #expect(loaded != nil)
        #expect(loaded?.hosts.count == config.hosts.count)
        #expect(loaded?.hosts.first?.online == true)
    }
}
