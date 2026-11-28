import Foundation

public enum BackpressurePolicy: String, Codable, Sendable {
    case reject
    case dropLowestPriority
}

public struct ResourceBudget: Codable, Sendable, Equatable {
    public var maxConcurrentTasks: Int
    public var maxQueuedTasks: Int
    public var maxTokens: Int
    public var maxCostUnits: Double

    public init(maxConcurrentTasks: Int = 4, maxQueuedTasks: Int = 32, maxTokens: Int = 500_000, maxCostUnits: Double = 100.0) {
        self.maxConcurrentTasks = maxConcurrentTasks
        self.maxQueuedTasks = maxQueuedTasks
        self.maxTokens = maxTokens
        self.maxCostUnits = maxCostUnits
    }
}

public struct ComputeAccountingRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var taskID: UUID
    public var hostID: String
    public var model: String
    public var promptTokens: Int
    public var completionTokens: Int
    public var durationSeconds: Double
    public var estimatedCostUnits: Double
    public var timestamp: Date

    public init(id: UUID = UUID(), taskID: UUID, hostID: String, model: String,
                promptTokens: Int, completionTokens: Int, durationSeconds: Double,
                estimatedCostUnits: Double, timestamp: Date = Date()) {
        self.id = id
        self.taskID = taskID
        self.hostID = hostID
        self.model = model
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.durationSeconds = durationSeconds
        self.estimatedCostUnits = estimatedCostUnits
        self.timestamp = timestamp
    }
}

public struct ScheduledTask: Sendable, Identifiable, Equatable {
    public var id: UUID
    public var priority: Int
    public var requiredCapabilities: Set<ModelCapability>
    public var preferredHostID: String?
    public var enqueuedAt: Date

    public init(id: UUID = UUID(), priority: Int = 50, requiredCapabilities: Set<ModelCapability> = [.generalChat],
                preferredHostID: String? = nil, enqueuedAt: Date = Date()) {
        self.id = id
        self.priority = priority
        self.requiredCapabilities = requiredCapabilities
        self.preferredHostID = preferredHostID
        self.enqueuedAt = enqueuedAt
    }
}

/// Resource-aware scheduler managing dynamic concurrency limits, priority queues,
/// backpressure, host health, and token/compute accounting.
public actor ResourceAwareScheduler {
    private var budget: ResourceBudget
    private var backpressure: BackpressurePolicy
    private var activeCount: Int = 0
    private var hostActiveCounts: [String: Int] = [:]
    private var hostLimits: [String: Int] = [:]
    private var queue: [ScheduledTask] = []
    private var accounting: [ComputeAccountingRecord] = []
    private var totalTokensUsed: Int = 0
    private var totalCostUsed: Double = 0

    public init(budget: ResourceBudget = ResourceBudget(), backpressure: BackpressurePolicy = .reject) {
        self.budget = budget
        self.backpressure = backpressure
    }

    public func setHostConcurrencyLimit(_ limit: Int, for hostID: String) {
        hostLimits[hostID] = max(1, limit)
    }

    public func enqueue(_ task: ScheduledTask) throws(FleetError) {
        if totalTokensUsed >= budget.maxTokens || totalCostUsed >= budget.maxCostUnits {
            throw FleetError("Resource budget exhausted (tokens: \(totalTokensUsed)/\(budget.maxTokens), cost: \(totalCostUsed)/\(budget.maxCostUnits))")
        }
        if queue.count >= budget.maxQueuedTasks {
            switch backpressure {
            case .reject:
                throw FleetError("Task queue full (\(budget.maxQueuedTasks)); backpressure rejected task \(task.id)")
            case .dropLowestPriority:
                if let minIdx = queue.indices.min(by: { queue[$0].priority < queue[$1].priority }),
                   queue[minIdx].priority < task.priority {
                    queue.remove(at: minIdx)
                } else {
                    throw FleetError("Task queue full and incoming task priority \(task.priority) is not higher than queued tasks")
                }
            }
        }
        queue.append(task)
        queue.sort { $0.priority > $1.priority }
    }

    public func leaseNext(availableHosts: [String]) -> ScheduledTask? {
        guard activeCount < budget.maxConcurrentTasks else { return nil }
        guard let idx = queue.firstIndex(where: { t in
            if let pref = t.preferredHostID {
                guard availableHosts.contains(pref) else { return false }
                let limit = hostLimits[pref] ?? 2
                return (hostActiveCounts[pref] ?? 0) < limit
            }
            return availableHosts.contains { h in (hostActiveCounts[h] ?? 0) < (hostLimits[h] ?? 2) }
        }) else { return nil }

        let task = queue.remove(at: idx)
        activeCount += 1
        let host = task.preferredHostID ?? availableHosts.first ?? "local"
        hostActiveCounts[host, default: 0] += 1
        return task
    }

    public func release(hostID: String, record: ComputeAccountingRecord? = nil) {
        activeCount = max(0, activeCount - 1)
        hostActiveCounts[hostID] = max(0, (hostActiveCounts[hostID] ?? 1) - 1)
        if let record {
            accounting.append(record)
            totalTokensUsed += record.promptTokens + record.completionTokens
            totalCostUsed += record.estimatedCostUnits
        }
    }

    public func statusSnapshot() -> (active: Int, queued: Int, totalTokens: Int, totalCost: Double) {
        (activeCount, queue.count, totalTokensUsed, totalCostUsed)
    }

    public func accountingHistory() -> [ComputeAccountingRecord] { accounting }
}
