import Foundation

public struct ProjectRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var description: String
    public var activeExtensionIDs: [String]

    public init(id: String, name: String, description: String = "", activeExtensionIDs: [String] = []) {
        self.id = id
        self.name = name
        self.description = description
        self.activeExtensionIDs = activeExtensionIDs
    }
}

public struct Finding: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var rootCauseKey: String
    public var title: String
    public var componentID: String
    public var isCriticalBlocker: Bool
    public var sourceAgentID: String
    public var evidenceID: UUID?

    public init(id: UUID = UUID(), rootCauseKey: String, title: String, componentID: String,
                isCriticalBlocker: Bool = false, sourceAgentID: String, evidenceID: UUID? = nil) {
        self.id = id
        self.rootCauseKey = rootCauseKey
        self.title = title
        self.componentID = componentID
        self.isCriticalBlocker = isCriticalBlocker
        self.sourceAgentID = sourceAgentID
        self.evidenceID = evidenceID
    }
}

public struct CanonicalFinding: Codable, Sendable, Equatable, Identifiable {
    public var id: String { rootCauseKey }
    public var rootCauseKey: String
    public var title: String
    public var affectedComponents: [String]
    public var isCriticalBlocker: Bool
    public var occurrenceCount: Int
    public var sourceFindingIDs: [UUID]
}

public struct WorkItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var impact: Double
    public var confidence: Double
    public var urgency: Double
    public var reusePotential: Double
    public var effort: Double
    public var validationCost: Double
    public var hasCriticalBlocker: Bool

    public init(id: String, title: String, impact: Double, confidence: Double, urgency: Double,
                reusePotential: Double = 0, effort: Double = 1, validationCost: Double = 1, hasCriticalBlocker: Bool = false) {
        self.id = id
        self.title = title
        self.impact = impact
        self.confidence = confidence
        self.urgency = urgency
        self.reusePotential = reusePotential
        self.effort = max(0.1, effort)
        self.validationCost = max(0.1, validationCost)
        self.hasCriticalBlocker = hasCriticalBlocker
    }

    public var priorityScore: Double {
        if hasCriticalBlocker { return 1_000_000.0 }
        return (impact * confidence * urgency * (1.0 + 0.5 * reusePotential)) / (effort + validationCost)
    }
}

public struct ProjectIntelligenceEngine: Sendable {
    public init() {}

    /// Consolidates duplicate or overlapping findings into shared canonical root causes.
    public func consolidateFindings(_ findings: [Finding]) -> [CanonicalFinding] {
        let grouped = Dictionary(grouping: findings, by: { $0.rootCauseKey.lowercased() })
        return grouped.values.compactMap { group -> CanonicalFinding? in
            guard let first = group.first else { return nil }
            return CanonicalFinding(
                rootCauseKey: first.rootCauseKey,
                title: first.title,
                affectedComponents: Array(Set(group.map(\.componentID))).sorted(),
                isCriticalBlocker: group.contains(where: \.isCriticalBlocker),
                occurrenceCount: group.count,
                sourceFindingIDs: group.map(\.id)
            )
        }.sorted { $0.rootCauseKey < $1.rootCauseKey }
    }

    /// Prioritizes work items; critical blockers strictly override ordinary priority scores.
    public func prioritize(_ items: [WorkItem]) -> [WorkItem] {
        items.sorted { lhs, rhs in
            if lhs.hasCriticalBlocker != rhs.hasCriticalBlocker { return lhs.hasCriticalBlocker }
            return lhs.priorityScore > rhs.priorityScore
        }
    }
}
