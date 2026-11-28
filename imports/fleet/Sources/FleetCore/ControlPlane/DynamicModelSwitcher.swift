import Foundation

public enum ModelSwitchTrigger: Codable, Sendable, Equatable {
    case missingCapability(ModelCapability)
    case qualityGateBelowThreshold(actual: Double, required: Double)
    case repeatedModelFailure(count: Int)
    case memoryPressure(utilization: Double)
    case machineUnavailable(machineID: String)
    case fasterEligibleModelAvailable(candidateID: String)
    case specialistModelPreferred(taskCategory: String)
    case independentEvaluationDiversityRequired(authorModel: String)
}

public struct ModelSwitchOutcome: Codable, Sendable, Equatable {
    public var switched: Bool
    public var substitution: ModelSubstitutionRecord?
    public var preservedCheckpointID: UUID?
    public var reason: String

    public init(switched: Bool, substitution: ModelSubstitutionRecord? = nil,
                preservedCheckpointID: UUID? = nil, reason: String) {
        self.switched = switched
        self.substitution = substitution
        self.preservedCheckpointID = preservedCheckpointID
        self.reason = reason
    }
}

/// Handles dynamic model switching at safe task/checkpoint boundaries.
/// Never assumes KV-cache transfer between incompatible models; preserves external workflow state.
public struct DynamicModelSwitcher: Sendable {
    public init() {}

    public func evaluateSwitch(
        trigger: ModelSwitchTrigger,
        currentModel: String,
        machineID: String,
        selectionMode: NodeModelSelectionMode,
        availableModels: [DiscoveredModelDescriptor],
        checkpointID: UUID?
    ) -> ModelSwitchOutcome {
        if case .pinned(let pinnedID) = selectionMode {
            return ModelSwitchOutcome(
                switched: false,
                preservedCheckpointID: checkpointID,
                reason: "Model '\(pinnedID)' is PINNED; automatic substitution is prohibited."
            )
        }

        let candidates = availableModels.filter { $0.machineID == machineID && $0.id != currentModel }
        let replacement: DiscoveredModelDescriptor? = switch trigger {
        case .missingCapability(let cap):
            candidates.first { $0.capabilities.contains(cap) }
        case .independentEvaluationDiversityRequired(let author):
            candidates.first { $0.id != author }
        default:
            candidates.sorted { ($0.evaluationScore ?? 0.5) > ($1.evaluationScore ?? 0.5) }.first
        }

        guard let next = replacement else {
            return ModelSwitchOutcome(
                switched: false,
                preservedCheckpointID: checkpointID,
                reason: "No eligible replacement model available on '\(machineID)'."
            )
        }

        let sub = ModelSubstitutionRecord(
            machineID: machineID,
            userPreferredModel: currentModel,
            assignedModel: next.id,
            previousModel: currentModel,
            reason: "Dynamic switch triggered: \(trigger)",
            expectedBenefit: "Restores capability/quality/resilience at safe checkpoint boundary"
        )
        return ModelSwitchOutcome(
            switched: true,
            substitution: sub,
            preservedCheckpointID: checkpointID,
            reason: "Switched '\(currentModel)' → '\(next.id)' at checkpoint boundary."
        )
    }
}
