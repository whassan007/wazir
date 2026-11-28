import Foundation

// MARK: - Validation vs Execution Separation

public enum ExecutionOutcome: String, Codable, Sendable, Equatable {
    case completed
    case failed
    case cancelled
}

public enum ValidationState: Codable, Sendable, Equatable {
    case validatedPass
    case validatedFail(reasons: [String])
    case unverified(reason: String)
    case unknown

    public var isVerifiedPass: Bool {
        if case .validatedPass = self { return true }
        return false
    }
}

public struct RubricCriterion: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var weight: Double
    public var minimumPassingScore: Double
    public var isNonNegotiableGate: Bool

    public init(id: String, name: String, weight: Double, minimumPassingScore: Double = 0.7, isNonNegotiableGate: Bool = false) {
        self.id = id
        self.name = name
        self.weight = weight
        self.minimumPassingScore = minimumPassingScore
        self.isNonNegotiableGate = isNonNegotiableGate
    }
}

public struct EvaluationRubric: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var version: String
    public var title: String
    public var criteria: [RubricCriterion]
    public var regressionThreshold: Double

    public init(id: String, version: String = "1.0.0", title: String, criteria: [RubricCriterion], regressionThreshold: Double = 0.02) {
        self.id = id
        self.version = version
        self.title = title
        self.criteria = criteria
        self.regressionThreshold = regressionThreshold
    }
}

public struct EvaluationEvidence: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var criterionID: String
    public var evaluatorID: String
    public var score: Double?
    public var passed: Bool?
    public var summary: String
    public var artifactHashes: [String]
    public var timestamp: Date

    public init(id: UUID = UUID(), criterionID: String, evaluatorID: String, score: Double?, passed: Bool?,
                summary: String, artifactHashes: [String] = [], timestamp: Date = Date()) {
        self.id = id
        self.criterionID = criterionID
        self.evaluatorID = evaluatorID
        self.score = score
        self.passed = passed
        self.summary = summary
        self.artifactHashes = artifactHashes
        self.timestamp = timestamp
    }
}

public struct EvaluationReport: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var rubricID: String
    public var rubricVersion: String
    public var executionOutcome: ExecutionOutcome
    public var validationState: ValidationState
    public var weightedScore: Double?
    public var confidence: Double
    public var evidence: [EvaluationEvidence]
    public var createdAt: Date

    public init(id: UUID = UUID(), rubricID: String, rubricVersion: String, executionOutcome: ExecutionOutcome,
                validationState: ValidationState, weightedScore: Double?, confidence: Double,
                evidence: [EvaluationEvidence], createdAt: Date = Date()) {
        self.id = id
        self.rubricID = rubricID
        self.rubricVersion = rubricVersion
        self.executionOutcome = executionOutcome
        self.validationState = validationState
        self.weightedScore = weightedScore
        self.confidence = confidence
        self.evidence = evidence
        self.createdAt = createdAt
    }
}

// MARK: - Evaluation Engine

public struct EvaluationEngine: Sendable {
    public init() {}

    /// Evaluates a candidate strictly from observed evidence.
    /// Missing evidence for any criterion results in `.unverified`, never an invented score.
    public func evaluate(rubric: EvaluationRubric, executionOutcome: ExecutionOutcome,
                         evidence: [EvaluationEvidence]) -> EvaluationReport {
        guard executionOutcome == .completed else {
            return EvaluationReport(
                rubricID: rubric.id,
                rubricVersion: rubric.version,
                executionOutcome: executionOutcome,
                validationState: .unverified(reason: "Execution did not complete (\(executionOutcome.rawValue))."),
                weightedScore: nil,
                confidence: 0,
                evidence: evidence
            )
        }

        var missingCriteria: [String] = []
        var failedGates: [String] = []
        var totalWeight = 0.0
        var weightedSum = 0.0

        for criterion in rubric.criteria {
            let matching = evidence.filter { $0.criterionID == criterion.id }
            guard !matching.isEmpty else {
                missingCriteria.append(criterion.id)
                continue
            }
            let scores = matching.compactMap(\.score)
            guard !scores.isEmpty else {
                missingCriteria.append(criterion.id)
                continue
            }
            let avgScore = scores.reduce(0, +) / Double(scores.count)
            totalWeight += criterion.weight
            weightedSum += avgScore * criterion.weight

            let gatePassed = matching.allSatisfy { $0.passed ?? (avgScore >= criterion.minimumPassingScore) }
            if criterion.isNonNegotiableGate && (!gatePassed || avgScore < criterion.minimumPassingScore) {
                failedGates.append("\(criterion.name) (\(String(format: "%.2f", avgScore)) < \(criterion.minimumPassingScore))")
            }
        }

        if !missingCriteria.isEmpty {
            return EvaluationReport(
                rubricID: rubric.id,
                rubricVersion: rubric.version,
                executionOutcome: executionOutcome,
                validationState: .unverified(reason: "Missing evidence for criteria: \(missingCriteria.joined(separator: ", "))"),
                weightedScore: nil,
                confidence: 0,
                evidence: evidence
            )
        }

        let finalScore = totalWeight > 0 ? weightedSum / totalWeight : nil
        let confidence = crossModelAgreement(evidence: evidence)

        if !failedGates.isEmpty {
            return EvaluationReport(
                rubricID: rubric.id,
                rubricVersion: rubric.version,
                executionOutcome: executionOutcome,
                validationState: .validatedFail(reasons: failedGates),
                weightedScore: finalScore,
                confidence: confidence,
                evidence: evidence
            )
        }

        return EvaluationReport(
            rubricID: rubric.id,
            rubricVersion: rubric.version,
            executionOutcome: executionOutcome,
            validationState: .validatedPass,
            weightedScore: finalScore,
            confidence: confidence,
            evidence: evidence
        )
    }

    /// Computes inter-evaluator agreement (1.0 - normalized std dev across judges).
    public func crossModelAgreement(evidence: [EvaluationEvidence]) -> Double {
        let byCriterion = Dictionary(grouping: evidence, by: \.criterionID)
        var agreements: [Double] = []
        for (_, items) in byCriterion {
            let scores = items.compactMap(\.score)
            guard scores.count >= 2 else { continue }
            let mean = scores.reduce(0, +) / Double(scores.count)
            let variance = scores.reduce(0) { $0 + pow($1 - mean, 2) } / Double(scores.count)
            let stdDev = sqrt(variance)
            agreements.append(max(0, min(1, 1.0 - stdDev * 2.0)))
        }
        guard !agreements.isEmpty else { return evidence.isEmpty ? 0 : 0.85 }
        return agreements.reduce(0, +) / Double(agreements.count)
    }
}
