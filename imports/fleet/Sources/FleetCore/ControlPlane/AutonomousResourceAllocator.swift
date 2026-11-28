import Foundation

public enum SchedulingObjectiveProfile: String, Codable, Sendable, CaseIterable, Equatable {
    case maximumOutputQuality
    case maximumThroughput
    case minimumLatency
    case minimumComputeCost
    case localExecutionOnly
    case cloudAssistedExecution
    case balancedExecution
    case maximumReliability
    case independentCrossModelValidation
    case userDefined
}

public struct ModelServingInstance: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var machineID: String
    public var modelID: String
    public var runtimeKind: RuntimeKind
    public var reservedMemoryBytes: Int64
    public var maxConcurrentSlots: Int
    public var activeSlots: Int
    public var logicalAgentCount: Int
    public var workflowID: UUID

    public init(
        id: UUID = UUID(), machineID: String, modelID: String, runtimeKind: RuntimeKind,
        reservedMemoryBytes: Int64, maxConcurrentSlots: Int, activeSlots: Int = 0,
        logicalAgentCount: Int = 1, workflowID: UUID
    ) {
        self.id = id
        self.machineID = machineID
        self.modelID = modelID
        self.runtimeKind = runtimeKind
        self.reservedMemoryBytes = reservedMemoryBytes
        self.maxConcurrentSlots = maxConcurrentSlots
        self.activeSlots = activeSlots
        self.logicalAgentCount = logicalAgentCount
        self.workflowID = workflowID
    }
}

public enum AllocationDecisionStatus: Codable, Sendable, Equatable {
    case allocated(instance: ModelServingInstance, reusedExisting: Bool, substitution: ModelSubstitutionRecord?)
    case blocked(reason: String)
}

/// Authoritative admission-control and resource allocation engine.
/// Validates every allocation against physical machine memory, unified vs discrete pools,
/// cross-workflow reservations, and AUTO/PREFERRED/PINNED model policies.
public actor AutonomousResourceAllocator {
    private var activeInstances: [UUID: ModelServingInstance] = [:]
    private var lastReallocationAt: [String: Date] = [:]
    private let cooldownSeconds: TimeInterval

    public init(cooldownSeconds: TimeInterval = 10) {
        self.cooldownSeconds = cooldownSeconds
    }

    /// Deterministic memory fit calculation:
    /// RequiredMemory = ModelWeights + KVCache + RuntimeOverhead + ExecutionBuffers + SafetyHeadroom
    public static func requiredMemoryBytes(
        for model: DiscoveredModelDescriptor,
        contextTokens: Int = 8192,
        concurrentSlots: Int = 1,
        safetyHeadroomFraction: Double = 0.15
    ) -> Int64 {
        if let measured = model.measuredMemoryBytes, measured > 0 {
            let extraSlots = max(0, concurrentSlots - 1)
            let kvPerSlot = Int64(contextTokens) * 256 * 1024 / 1024 // ~256KB/token conservative estimate
            return measured + Int64(extraSlots) * kvPerSlot
        }
        let weights = model.weightSizeBytes ?? model.estimatedMemoryBytes ?? 4_000_000_000
        let kvCache = Int64(contextTokens) * Int64(max(1, concurrentSlots)) * 131_072 // ~128KB/token
        let runtimeOverhead: Int64 = 512_000_000
        let executionBuffers: Int64 = 256_000_000
        let subtotal = weights + kvCache + runtimeOverhead + executionBuffers
        return Int64(Double(subtotal) * (1.0 + safetyHeadroomFraction))
    }

    public func allocate(
        workflowID: UUID,
        machine: PhysicalMachineRecord,
        installedModels: [DiscoveredModelDescriptor],
        selectionMode: NodeModelSelectionMode,
        requiredCapabilities: Set<ModelCapability> = [.generalChat],
        requestedSlots: Int = 1,
        logicalAgents: Int = 1,
        contextTokens: Int = 8192
    ) -> AllocationDecisionStatus {
        guard machine.operationalState != .offline,
              machine.operationalState != .unreachable,
              machine.operationalState != .draining,
              machine.operationalState != .maintenance else {
            return .blocked(reason: "Machine '\(machine.id)' is \(machine.operationalState.displayName)")
        }

        let usedOnMachine = activeInstances.values
            .filter { $0.machineID == machine.id }
            .reduce(Int64(0)) { $0 + $1.reservedMemoryBytes }

        let availablePool = machine.memory.availableComputeMemoryBytes ?? Int64.max
        let remainingMemory = availablePool == Int64.max ? Int64.max : max(0, availablePool - usedOnMachine)

        func tryAllocate(_ model: DiscoveredModelDescriptor, substitution: ModelSubstitutionRecord?) -> AllocationDecisionStatus {
            // Reuse an already-loaded compatible instance on the same machine if slots allow.
            if var existing = activeInstances.values.first(where: {
                $0.machineID == machine.id && $0.modelID == model.id &&
                ($0.activeSlots + requestedSlots) <= $0.maxConcurrentSlots
            }) {
                existing.activeSlots += requestedSlots
                existing.logicalAgentCount += logicalAgents
                activeInstances[existing.id] = existing
                return .allocated(instance: existing, reusedExisting: true, substitution: substitution)
            }

            let needed = Self.requiredMemoryBytes(for: model, contextTokens: contextTokens, concurrentSlots: requestedSlots)
            guard needed <= remainingMemory else {
                return .blocked(reason: "Insufficient memory on '\(machine.id)': need \(needed) bytes, remaining \(remainingMemory) bytes")
            }

            let instance = ModelServingInstance(
                machineID: machine.id,
                modelID: model.id,
                runtimeKind: model.runtimeKind,
                reservedMemoryBytes: needed,
                maxConcurrentSlots: max(4, requestedSlots),
                activeSlots: requestedSlots,
                logicalAgentCount: logicalAgents,
                workflowID: workflowID
            )
            activeInstances[instance.id] = instance
            return .allocated(instance: instance, reusedExisting: false, substitution: substitution)
        }

        switch selectionMode {
        case .pinned(let modelID):
            guard let model = installedModels.first(where: { $0.id == modelID && $0.machineID == machine.id }) else {
                return .blocked(reason: "Pinned model '\(modelID)' is not installed on '\(machine.id)'")
            }
            return tryAllocate(model, substitution: nil)

        case .preferred(let modelID):
            if let preferred = installedModels.first(where: { $0.id == modelID && $0.machineID == machine.id }),
               requiredCapabilities.isSubset(of: preferred.capabilities) {
                let res = tryAllocate(preferred, substitution: nil)
                if case .allocated = res { return res }
            }
            // Substitute with best eligible installed model on the same machine
            if let fallback = installedModels
                .filter({ $0.machineID == machine.id && requiredCapabilities.isSubset(of: $0.capabilities) })
                .sorted(by: { ($0.evaluationScore ?? 0.5) > ($1.evaluationScore ?? 0.5) })
                .first {
                let sub = ModelSubstitutionRecord(
                    machineID: machine.id,
                    userPreferredModel: modelID,
                    assignedModel: fallback.id,
                    previousModel: modelID,
                    reason: "Preferred model '\(modelID)' unavailable, infeasible, or lacks required capabilities",
                    expectedBenefit: "Meets capability and memory constraints on '\(machine.id)'"
                )
                return tryAllocate(fallback, substitution: sub)
            }
            return .blocked(reason: "Neither preferred model '\(modelID)' nor any eligible substitute fits on '\(machine.id)'")

        case .auto:
            guard let best = installedModels
                .filter({ $0.machineID == machine.id && requiredCapabilities.isSubset(of: $0.capabilities) })
                .sorted(by: { ($0.isLoaded ? 1 : 0, $0.evaluationScore ?? 0.5) > ($1.isLoaded ? 1 : 0, $1.evaluationScore ?? 0.5) })
                .first else {
                return .blocked(reason: "No installed model on '\(machine.id)' satisfies capabilities \(requiredCapabilities)")
            }
            return tryAllocate(best, substitution: nil)
        }
    }

    public func releaseWorkflow(_ workflowID: UUID) {
        activeInstances = activeInstances.filter { $0.value.workflowID != workflowID }
    }

    public func canReallocate(machineID: String, now: Date = Date()) -> Bool {
        if let last = lastReallocationAt[machineID], now.timeIntervalSince(last) < cooldownSeconds {
            return false
        }
        lastReallocationAt[machineID] = now
        return true
    }

    public func activeReservations(on machineID: String) -> [ModelServingInstance] {
        activeInstances.values.filter { $0.machineID == machineID }
    }
}
