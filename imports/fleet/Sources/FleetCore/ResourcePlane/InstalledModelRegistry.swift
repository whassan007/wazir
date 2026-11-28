import Foundation

public struct DiscoveredModelDescriptor: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var machineID: String
    public var runtimeKind: RuntimeKind
    public var family: String?
    public var version: String?
    public var totalParametersBillions: Double?
    public var activeMoEParametersBillions: Double?
    public var quantization: String?
    public var weightSizeBytes: Int64?
    public var maxContextLength: Int?
    public var capabilities: Set<ModelCapability>
    public var isLoaded: Bool
    public var estimatedMemoryBytes: Int64?
    public var measuredMemoryBytes: Int64?
    public var historicalLatencyMS: Double?
    public var measuredTokensPerSecond: Double?
    public var evaluationScore: Double?

    public init(
        id: String, machineID: String, runtimeKind: RuntimeKind, family: String? = nil, version: String? = nil,
        totalParametersBillions: Double? = nil, activeMoEParametersBillions: Double? = nil,
        quantization: String? = nil, weightSizeBytes: Int64? = nil, maxContextLength: Int? = nil,
        capabilities: Set<ModelCapability> = [.generalChat], isLoaded: Bool = false,
        estimatedMemoryBytes: Int64? = nil, measuredMemoryBytes: Int64? = nil,
        historicalLatencyMS: Double? = nil, measuredTokensPerSecond: Double? = nil,
        evaluationScore: Double? = nil
    ) {
        self.id = id
        self.machineID = machineID
        self.runtimeKind = runtimeKind
        self.family = family
        self.version = version
        self.totalParametersBillions = totalParametersBillions
        self.activeMoEParametersBillions = activeMoEParametersBillions
        self.quantization = quantization
        self.weightSizeBytes = weightSizeBytes
        self.maxContextLength = maxContextLength
        self.capabilities = capabilities
        self.isLoaded = isLoaded
        self.estimatedMemoryBytes = estimatedMemoryBytes
        self.measuredMemoryBytes = measuredMemoryBytes
        self.historicalLatencyMS = historicalLatencyMS
        self.measuredTokensPerSecond = measuredTokensPerSecond
        self.evaluationScore = evaluationScore
    }
}

/// Machine-scoped installed model registry.
/// Strictly returns only models discovered on the requested machine.
public actor InstalledModelRegistry {
    private var modelsByMachine: [String: [DiscoveredModelDescriptor]] = [:]

    public init() {}

    public func setInstalledModels(_ models: [DiscoveredModelDescriptor], for machineID: String) {
        modelsByMachine[machineID] = models.filter { $0.machineID == machineID }
    }

    public func installedModels(on machineID: String) -> [DiscoveredModelDescriptor] {
        modelsByMachine[machineID] ?? []
    }

    public func isInstalled(_ modelID: String, on machineID: String) -> Bool {
        installedModels(on: machineID).contains { $0.id == modelID }
    }

    public func findModel(_ modelID: String, on machineID: String) -> DiscoveredModelDescriptor? {
        installedModels(on: machineID).first { $0.id == modelID }
    }
}
