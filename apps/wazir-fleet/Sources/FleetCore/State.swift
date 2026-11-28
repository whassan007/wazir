import Foundation

// MARK: - Observed data

public struct ModelInfo: Equatable, Sendable, Hashable, Identifiable {
    public var name: String
    public var sizeBytes: Int64?
    public var parameterSize: String?
    public var quantization: String?
    public var family: String?
    public var isLoaded: Bool
    public var vramBytes: Int64?
    public var modifiedAt: Date?
    public var contextLength: Int?

    public var id: String { name }

    public init(name: String, sizeBytes: Int64? = nil, parameterSize: String? = nil, quantization: String? = nil,
                family: String? = nil, isLoaded: Bool = false, vramBytes: Int64? = nil, modifiedAt: Date? = nil,
                contextLength: Int? = nil) {
        self.name = name
        self.sizeBytes = sizeBytes
        self.parameterSize = parameterSize
        self.quantization = quantization
        self.family = family
        self.isLoaded = isLoaded
        self.vramBytes = vramBytes
        self.modifiedAt = modifiedAt
        self.contextLength = contextLength
    }

    /// Ollama-style name matching: `qwen2.5` matches `qwen2.5:latest`.
    public func matches(_ query: String) -> Bool {
        ModelInfo.normalize(name) == ModelInfo.normalize(query)
    }

    public static func normalize(_ name: String) -> String {
        let l = name.lowercased()
        if l.contains("/") { return l }  // HF repo ids: exact
        return l.contains(":") ? l : l + ":latest"
    }
}

public struct RuntimeSnapshot: Equatable, Sendable {
    public var version: String?
    public var models: [ModelInfo]
    public init(version: String? = nil, models: [ModelInfo]) {
        self.version = version
        self.models = models
    }
}

public struct GPUMetrics: Equatable, Sendable, Hashable {
    public var name: String
    public var utilizationPercent: Double?
    public var memoryUsedMB: Double?
    public var memoryTotalMB: Double?
    public var temperatureC: Double?
    public init(name: String, utilizationPercent: Double? = nil, memoryUsedMB: Double? = nil,
                memoryTotalMB: Double? = nil, temperatureC: Double? = nil) {
        self.name = name
        self.utilizationPercent = utilizationPercent
        self.memoryUsedMB = memoryUsedMB
        self.memoryTotalMB = memoryTotalMB
        self.temperatureC = temperatureC
    }
}

public struct HostMetrics: Equatable, Sendable {
    public var osVersion: String?
    public var chip: String?
    public var load1: Double?
    public var load5: Double?
    public var load15: Double?
    public var cpuCount: Int?
    public var memTotalBytes: Int64?
    public var memAvailableBytes: Int64?
    public var uptimeSeconds: Int?
    public var gpus: [GPUMetrics]

    public init(osVersion: String? = nil, chip: String? = nil, load1: Double? = nil, load5: Double? = nil,
                load15: Double? = nil, cpuCount: Int? = nil, memTotalBytes: Int64? = nil,
                memAvailableBytes: Int64? = nil, uptimeSeconds: Int? = nil, gpus: [GPUMetrics] = []) {
        self.osVersion = osVersion
        self.chip = chip
        self.load1 = load1
        self.load5 = load5
        self.load15 = load15
        self.cpuCount = cpuCount
        self.memTotalBytes = memTotalBytes
        self.memAvailableBytes = memAvailableBytes
        self.uptimeSeconds = uptimeSeconds
        self.gpus = gpus
    }

    public var memoryUsedFraction: Double? {
        guard let t = memTotalBytes, let a = memAvailableBytes, t > 0 else { return nil }
        return min(1, max(0, Double(t - a) / Double(t)))
    }

    public var loadFraction: Double? {
        guard let l = load1, let c = cpuCount, c > 0 else { return nil }
        return min(1, l / Double(c))
    }
}

public struct TailscalePeer: Equatable, Sendable {
    public var hostName: String
    public var dnsName: String?
    public var ips: [String]
    public var online: Bool
    public var lastSeen: Date?
    public var os: String?
    public var isSelf: Bool
    public init(hostName: String, dnsName: String? = nil, ips: [String], online: Bool, lastSeen: Date? = nil,
                os: String? = nil, isSelf: Bool = false) {
        self.hostName = hostName
        self.dnsName = dnsName
        self.ips = ips
        self.online = online
        self.lastSeen = lastSeen
        self.os = os
        self.isSelf = isSelf
    }
}

// MARK: - Host state

public enum Reachability: Equatable, Sendable {
    case unknown
    case online(latencyMS: Double, address: String)
    case offline(reason: String)

    public var isOnline: Bool { if case .online = self { true } else { false } }
}

public enum RuntimeStatus: Equatable, Sendable {
    case unknown
    case online
    case unreachable(String)
}

public struct RuntimeState: Equatable, Sendable {
    public var kind: RuntimeKind
    public var status: RuntimeStatus = .unknown
    public var version: String?
    /// Last known inventory; retained while unreachable and flagged `isStale`.
    public var models: [ModelInfo] = []
    public var lastUpdated: Date?
    public var isStale: Bool = false

    public init(kind: RuntimeKind) { self.kind = kind }

    public var loadedModels: [ModelInfo] { models.filter(\.isLoaded) }
}

public struct HostState: Equatable, Sendable, Identifiable {
    public var id: String
    public var reachability: Reachability = .unknown
    public var isProbing = false
    public var lastProbe: Date?
    /// Last time the host answered us directly (or Tailscale saw it, whichever is newer).
    public var lastSeen: Date?
    public var tailscale: TailscalePeer?
    public var runtimes: [RuntimeKind: RuntimeState] = [:]
    public var metrics: HostMetrics?
    public var metricsError: String?
    public var metricsUpdated: Date?

    public init(id: String, runtimes: [RuntimeKind]) {
        self.id = id
        for k in runtimes { self.runtimes[k] = RuntimeState(kind: k) }
    }

    public var allModels: [(RuntimeKind, ModelInfo)] {
        runtimes.keys.sorted { $0.rawValue < $1.rawValue }.flatMap { k in runtimes[k]!.models.map { (k, $0) } }
    }

    public var modelCount: Int { runtimes.values.reduce(0) { $0 + $1.models.count } }
    public var loadedCount: Int { runtimes.values.reduce(0) { $0 + $1.loadedModels.count } }
}

// MARK: - Operations

public enum OperationPhase: Equatable, Sendable {
    case running
    case succeeded
    case failed(String)
    case cancelled

    public var isTerminal: Bool { self != .running }

    public var label: String {
        switch self {
        case .running: "Running"
        case .succeeded: "Succeeded"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        }
    }
}

public enum StepStatus: Equatable, Sendable {
    case pending
    case running(progress: Double?, detail: String?)
    case succeeded(String?)
    case failed(String)
    case skipped(String)

    public var isTerminal: Bool {
        switch self {
        case .pending, .running: false
        default: true
        }
    }
}

public struct LogLine: Equatable, Sendable, Identifiable {
    public enum Level: String, Sendable { case info, output, warning, error }
    public var id: Int
    public var date: Date
    public var stepID: Int?
    public var level: Level
    public var text: String
}

public struct OperationRecord: Equatable, Sendable, Identifiable {
    public var id: UUID
    public var plan: ExecutionPlan
    public var dryRun: Bool
    public var phase: OperationPhase = .running
    public var steps: [Int: StepStatus] = [:]
    /// When each step started and reached a terminal status (used by the Flow view).
    public var stepStartedAt: [Int: Date] = [:]
    public var stepFinishedAt: [Int: Date] = [:]
    public var log: [LogLine] = []
    public var startedAt: Date
    public var finishedAt: Date?
    public static let maxLogLines = 3000
    var nextLogID = 0

    public init(id: UUID = UUID(), plan: ExecutionPlan, dryRun: Bool, startedAt: Date) {
        self.id = id
        self.plan = plan
        self.dryRun = dryRun
        self.startedAt = startedAt
        for s in plan.steps { steps[s.id] = .pending }
    }

    public var overallProgress: Double? {
        guard !plan.steps.isEmpty else { return nil }
        var total = 0.0
        for s in plan.steps {
            switch steps[s.id] ?? .pending {
            case .pending: break
            case .running(let p, _): total += p ?? 0
            default: total += 1
            }
        }
        return total / Double(plan.steps.count)
    }

    mutating func appendLog(_ level: LogLine.Level, _ text: String, step: Int?, at date: Date) {
        log.append(LogLine(id: nextLogID, date: date, stepID: step, level: level, text: text))
        nextLogID += 1
        if log.count > Self.maxLogLines { log.removeFirst(log.count - Self.maxLogLines) }
    }
}

public enum OperationEvent: Equatable, Sendable {
    case stepStarted(Int)
    case stepProgress(Int, Double?, String?)
    case stepLog(Int?, LogLine.Level, String)
    case stepSucceeded(Int, String?)
    case stepFailed(Int, String)
    case stepSkipped(Int, String)
    case finished
    case cancelled
}

// MARK: - Fleet state + events

public struct FleetState: Equatable, Sendable {
    public var hosts: [String: HostState] = [:]
    public var hostOrder: [String] = []
    public var operations: [OperationRecord] = []
    public var tailscaleError: String?
    public var tailscaleUpdated: Date?
    /// Rejected transitions and other internal anomalies, kept for explicit reporting.
    public var diagnostics: [String] = [] {
        didSet { if diagnostics.count > 200 { diagnostics.removeFirst(diagnostics.count - 200) } }
    }
    /// Per-host keys used to match Tailscale peers (derived from config).
    public var tailscaleConfig: [String: TailscaleMatchKey] = [:]
    /// Discovered cloud service snapshots (budgets, token spend, frontier models).
    public var cloudSnapshots: [String: CloudServiceSnapshot] = [:]

    public init() {}

    public func operation(_ id: UUID) -> OperationRecord? { operations.first { $0.id == id } }
    public var runningOperations: [OperationRecord] { operations.filter { $0.phase == .running } }
    public var onlineCount: Int { hosts.values.filter { $0.reachability.isOnline }.count }
}

public enum FleetEvent: Equatable, Sendable {
    case configLoaded(FleetConfig)
    case probeStarted(host: String)
    case reachability(host: String, Reachability, at: Date)
    case tailscale(Result<[TailscalePeer], FleetError>, at: Date)
    case inventory(host: String, RuntimeKind, Result<RuntimeSnapshot, FleetError>, at: Date)
    case metrics(host: String, Result<HostMetrics, FleetError>, at: Date)
    case probeFinished(host: String, at: Date)
    case operationStarted(OperationRecord)
    case operation(UUID, OperationEvent, at: Date)
    case clearFinishedOperations
    case cloudServicesUpdated([CloudServiceSnapshot], at: Date)
}
