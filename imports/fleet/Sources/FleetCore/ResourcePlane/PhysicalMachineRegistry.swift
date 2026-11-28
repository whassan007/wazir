import Foundation

public enum MachineOperationalState: String, Codable, Sendable, CaseIterable, Equatable {
    case available
    case idle
    case partiallyUtilized
    case fullyUtilized
    case reserved
    case overloaded
    case draining
    case offline
    case unreachable
    case maintenance
    case unknown

    public var displayName: String {
        switch self {
        case .available: "Available"
        case .idle: "Idle"
        case .partiallyUtilized: "Partially Utilized"
        case .fullyUtilized: "Fully Utilized"
        case .reserved: "Reserved"
        case .overloaded: "Overloaded"
        case .draining: "Draining"
        case .offline: "Offline"
        case .unreachable: "Unreachable"
        case .maintenance: "Maintenance"
        case .unknown: "Unknown"
        }
    }
}

public enum MemoryArchitecture: Codable, Sendable, Equatable {
    case unified(totalBytes: Int64?, availableBytes: Int64?)
    case discrete(ramTotalBytes: Int64?, ramAvailableBytes: Int64?, vramTotalBytes: Int64?, vramAvailableBytes: Int64?)
    case unknown

    /// Effective GPU-accessible memory pool in bytes. Unified memory is never summed twice.
    public var availableComputeMemoryBytes: Int64? {
        switch self {
        case .unified(_, let avail): avail
        case .discrete(_, _, _, let vramAvail): vramAvail
        case .unknown: nil
        }
    }

    public var totalComputeMemoryBytes: Int64? {
        switch self {
        case .unified(let total, _): total
        case .discrete(_, _, let vramTotal, _): vramTotal
        case .unknown: nil
        }
    }
}

public struct PhysicalMachineRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var name: String
    public var os: HostOS
    public var cpuArchitecture: String?
    public var cpuModel: String?
    public var cpuCores: Int?
    public var gpuType: String?
    public var gpuCount: Int?
    public var memory: MemoryArchitecture
    public var memoryUtilization: Double?
    public var gpuUtilization: Double?
    public var cpuUtilization: Double?
    public var temperatureC: Double?
    public var networkLatencyMS: Double?
    public var endpoints: [String]
    public var installedModelCount: Int
    public var loadedModelCount: Int
    public var activeModelInstances: Int
    public var activeLogicalAgents: Int
    public var concurrentRequests: Int
    public var pendingRequests: Int
    public var lastHeartbeat: Date?
    public var operationalState: MachineOperationalState

    public init(
        id: String, name: String, os: HostOS, cpuArchitecture: String? = nil, cpuModel: String? = nil,
        cpuCores: Int? = nil, gpuType: String? = nil, gpuCount: Int? = nil,
        memory: MemoryArchitecture = .unknown, memoryUtilization: Double? = nil,
        gpuUtilization: Double? = nil, cpuUtilization: Double? = nil, temperatureC: Double? = nil,
        networkLatencyMS: Double? = nil, endpoints: [String] = [],
        installedModelCount: Int = 0, loadedModelCount: Int = 0,
        activeModelInstances: Int = 0, activeLogicalAgents: Int = 0,
        concurrentRequests: Int = 0, pendingRequests: Int = 0,
        lastHeartbeat: Date? = nil, operationalState: MachineOperationalState = .unknown
    ) {
        self.id = id
        self.name = name
        self.os = os
        self.cpuArchitecture = cpuArchitecture
        self.cpuModel = cpuModel
        self.cpuCores = cpuCores
        self.gpuType = gpuType
        self.gpuCount = gpuCount
        self.memory = memory
        self.memoryUtilization = memoryUtilization
        self.gpuUtilization = gpuUtilization
        self.cpuUtilization = cpuUtilization
        self.temperatureC = temperatureC
        self.networkLatencyMS = networkLatencyMS
        self.endpoints = endpoints
        self.installedModelCount = installedModelCount
        self.loadedModelCount = loadedModelCount
        self.activeModelInstances = activeModelInstances
        self.activeLogicalAgents = activeLogicalAgents
        self.concurrentRequests = concurrentRequests
        self.pendingRequests = pendingRequests
        self.lastHeartbeat = lastHeartbeat
        self.operationalState = operationalState
    }
}

/// Persistent, deduplicated physical machine registry.
/// Multiple inference endpoints on the same physical machine are consolidated
/// so memory and GPU capacity are never double-counted.
public actor PhysicalMachineRegistry {
    private var machines: [String: PhysicalMachineRecord] = [:]

    public init() {}

    public func registerOrUpdate(_ record: PhysicalMachineRecord) {
        if var existing = machines[record.id] {
            var mergedEndpoints = existing.endpoints
            for ep in record.endpoints where !mergedEndpoints.contains(ep) {
                mergedEndpoints.append(ep)
            }
            existing = record
            existing.endpoints = mergedEndpoints
            machines[record.id] = existing
        } else {
            machines[record.id] = record
        }
    }

    public func setState(_ state: MachineOperationalState, for machineID: String) {
        machines[machineID]?.operationalState = state
    }

    public func recordHeartbeat(for machineID: String, at date: Date = Date()) {
        machines[machineID]?.lastHeartbeat = date
        if machines[machineID]?.operationalState == .unreachable || machines[machineID]?.operationalState == .offline {
            machines[machineID]?.operationalState = .available
        }
    }

    public func machine(_ id: String) -> PhysicalMachineRecord? { machines[id] }
    public func allMachines() -> [PhysicalMachineRecord] { machines.values.sorted { $0.id < $1.id } }
}
