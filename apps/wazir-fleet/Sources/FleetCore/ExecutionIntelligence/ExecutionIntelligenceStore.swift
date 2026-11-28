import Foundation

public struct ExecutionHistoryRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var taskClass: String
    public var hostID: String
    public var model: String
    public var workflowID: String
    public var validatedScore: Double?
    public var costUnits: Double
    public var durationSeconds: Double
    public var timestamp: Date

    public init(id: UUID = UUID(), taskClass: String, hostID: String, model: String, workflowID: String,
                validatedScore: Double?, costUnits: Double, durationSeconds: Double, timestamp: Date = Date()) {
        self.id = id
        self.taskClass = taskClass
        self.hostID = hostID
        self.model = model
        self.workflowID = workflowID
        self.validatedScore = validatedScore
        self.costUnits = costUnits
        self.durationSeconds = durationSeconds
        self.timestamp = timestamp
    }
}

/// Persistent execution intelligence store.
/// Uses historical evidence to recommend empirical model routing (never confused with model training).
public actor ExecutionIntelligenceStore {
    private var records: [ExecutionHistoryRecord] = []

    public init() {}

    public func record(_ entry: ExecutionHistoryRecord) {
        records.append(entry)
    }

    public func recommend(for taskClass: String) -> (hostID: String, model: String, avgScore: Double)? {
        let matching = records.filter { $0.taskClass == taskClass && $0.validatedScore != nil }
        guard !matching.isEmpty else { return nil }
        let grouped = Dictionary(grouping: matching, by: { "\($0.hostID)|\($0.model)" })
        let ranked = grouped.compactMap { (_, group) -> (String, String, Double)? in
            guard let first = group.first else { return nil }
            let avg = group.compactMap(\.validatedScore).reduce(0, +) / Double(group.count)
            return (first.hostID, first.model, avg)
        }.sorted { $0.2 > $1.2 }
        return ranked.first
    }

    public func allRecords() -> [ExecutionHistoryRecord] { records }
}
