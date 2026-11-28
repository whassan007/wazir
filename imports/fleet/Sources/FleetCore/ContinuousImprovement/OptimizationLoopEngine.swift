import Foundation

public struct OptimizationTarget: Codable, Sendable, Equatable {
    public var targetScore: Double
    public var maxIterations: Int
    public var convergenceEpsilon: Double
    public var diminishingReturnThreshold: Double
    public var requireHumanApprovalBeforeAccept: Bool

    public init(targetScore: Double = 0.90, maxIterations: Int = 5, convergenceEpsilon: Double = 0.01,
                diminishingReturnThreshold: Double = 0.005, requireHumanApprovalBeforeAccept: Bool = false) {
        self.targetScore = targetScore
        self.maxIterations = maxIterations
        self.convergenceEpsilon = convergenceEpsilon
        self.diminishingReturnThreshold = diminishingReturnThreshold
        self.requireHumanApprovalBeforeAccept = requireHumanApprovalBeforeAccept
    }
}

public struct CandidateSnapshot: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var iteration: Int
    public var artifactRef: String
    public var report: EvaluationReport
    public var accepted: Bool
    public var rejectionReason: String?

    public init(id: UUID = UUID(), iteration: Int, artifactRef: String, report: EvaluationReport,
                accepted: Bool, rejectionReason: String? = nil) {
        self.id = id
        self.iteration = iteration
        self.artifactRef = artifactRef
        self.report = report
        self.accepted = accepted
        self.rejectionReason = rejectionReason
    }
}

public enum LoopTerminationReason: String, Codable, Sendable, Equatable {
    case targetReached
    case converged
    case diminishingReturns
    case budgetExhausted
    case awaitingHumanApproval
}

public struct OptimizationLoopResult: Codable, Sendable, Equatable {
    public var loopID: UUID
    public var baseline: CandidateSnapshot
    public var bestCandidate: CandidateSnapshot
    public var history: [CandidateSnapshot]
    public var terminationReason: LoopTerminationReason
}

/// Reusable continuous-improvement loop engine.
/// Never assumes a newer candidate is superior to an older validated candidate;
/// rejects regressions and preserves the best validated candidate.
public struct OptimizationLoopEngine: Sendable {
    private let evaluator = EvaluationEngine()

    public init() {}

    public func run(
        loopID: UUID = UUID(),
        rubric: EvaluationRubric,
        target: OptimizationTarget,
        baselineArtifact: String,
        baselineEvidence: [EvaluationEvidence],
        proposeAndEvaluate: (Int, CandidateSnapshot) async throws -> (artifactRef: String, evidence: [EvaluationEvidence])
    ) async throws -> OptimizationLoopResult {
        let baseReport = evaluator.evaluate(rubric: rubric, executionOutcome: .completed, evidence: baselineEvidence)
        let baseline = CandidateSnapshot(iteration: 0, artifactRef: baselineArtifact, report: baseReport, accepted: baseReport.validationState.isVerifiedPass)
        var best = baseline
        var history: [CandidateSnapshot] = [baseline]
        var termination: LoopTerminationReason = .budgetExhausted

        for iter in 1...max(1, target.maxIterations) {
            let proposal = try await proposeAndEvaluate(iter, best)
            let report = evaluator.evaluate(rubric: rubric, executionOutcome: .completed, evidence: proposal.evidence)

            let bestScore = best.report.weightedScore ?? -1.0
            let newScore = report.weightedScore ?? -1.0

            if !report.validationState.isVerifiedPass {
                let snap = CandidateSnapshot(iteration: iter, artifactRef: proposal.artifactRef, report: report,
                                             accepted: false, rejectionReason: "Failed validation gates or missing evidence")
                history.append(snap)
                continue
            }

            if newScore + rubric.regressionThreshold < bestScore || newScore <= bestScore {
                let snap = CandidateSnapshot(iteration: iter, artifactRef: proposal.artifactRef, report: report,
                                             accepted: false, rejectionReason: "Regression or no improvement over best validated candidate (\(String(format: "%.3f", bestScore)))")
                history.append(snap)
                if (bestScore - newScore) <= target.convergenceEpsilon && iter >= 2 {
                    termination = .converged
                    break
                }
                continue
            }

            let delta = newScore - bestScore
            let accepted = CandidateSnapshot(iteration: iter, artifactRef: proposal.artifactRef, report: report, accepted: true)
            best = accepted
            history.append(accepted)

            if newScore >= target.targetScore {
                termination = target.requireHumanApprovalBeforeAccept ? .awaitingHumanApproval : .targetReached
                break
            }
            if delta < target.diminishingReturnThreshold && iter >= 2 {
                termination = .diminishingReturns
                break
            }
        }

        return OptimizationLoopResult(loopID: loopID, baseline: baseline, bestCandidate: best,
                                      history: history, terminationReason: termination)
    }
}
