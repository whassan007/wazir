import Foundation

public enum NodeModelSelectionMode: Codable, Sendable, Equatable {
    case auto
    case preferred(modelID: String)
    case pinned(modelID: String)
}

public struct ModelSubstitutionRecord: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var machineID: String
    public var userPreferredModel: String?
    public var assignedModel: String
    public var previousModel: String?
    public var reason: String
    public var expectedBenefit: String
    public var resourceConstraints: [String]
    public var evidenceID: UUID?
    public var timestamp: Date
    public var userOverrideAllowed: Bool

    public init(
        id: UUID = UUID(), machineID: String, userPreferredModel: String?, assignedModel: String,
        previousModel: String? = nil, reason: String, expectedBenefit: String,
        resourceConstraints: [String] = [], evidenceID: UUID? = nil, timestamp: Date = Date(),
        userOverrideAllowed: Bool = true
    ) {
        self.id = id
        self.machineID = machineID
        self.userPreferredModel = userPreferredModel
        self.assignedModel = assignedModel
        self.previousModel = previousModel
        self.reason = reason
        self.expectedBenefit = expectedBenefit
        self.resourceConstraints = resourceConstraints
        self.evidenceID = evidenceID
        self.timestamp = timestamp
        self.userOverrideAllowed = userOverrideAllowed
    }
}
