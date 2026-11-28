import Foundation

public struct WorkflowStage: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var promptTemplate: String
    public var dependsOn: [String]
    public var requiredCapabilities: Set<ModelCapability>
    public var subWorkflowID: String?

    public init(id: String, title: String, promptTemplate: String, dependsOn: [String] = [],
                requiredCapabilities: Set<ModelCapability> = [.generalChat], subWorkflowID: String? = nil) {
        self.id = id
        self.title = title
        self.promptTemplate = promptTemplate
        self.dependsOn = dependsOn
        self.requiredCapabilities = requiredCapabilities
        self.subWorkflowID = subWorkflowID
    }
}

public struct WorkflowSpecification: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var version: String
    public var objective: String
    public var inputs: [String]
    public var outputs: [String]
    public var stages: [WorkflowStage]
    public var applicablePolicyIDs: [String]
    public var rubricID: String?
    public var maxIterations: Int
    public var requireHumanApproval: Bool

    public init(id: String, version: String = "1.0.0", objective: String, inputs: [String] = [], outputs: [String] = [],
                stages: [WorkflowStage], applicablePolicyIDs: [String] = [], rubricID: String? = nil,
                maxIterations: Int = 3, requireHumanApproval: Bool = false) {
        self.id = id
        self.version = version
        self.objective = objective
        self.inputs = inputs
        self.outputs = outputs
        self.stages = stages
        self.applicablePolicyIDs = applicablePolicyIDs
        self.rubricID = rubricID
        self.maxIterations = maxIterations
        self.requireHumanApproval = requireHumanApproval
    }
}

public actor WorkflowRegistry {
    private var workflows: [String: WorkflowSpecification] = [:]

    public init() {}

    public func register(_ spec: WorkflowSpecification) {
        workflows[spec.id] = spec
    }

    public func get(_ id: String) -> WorkflowSpecification? {
        workflows[id]
    }

    public func all() -> [WorkflowSpecification] {
        workflows.values.sorted { $0.id < $1.id }
    }

    /// Imports a raw legacy prompt into a structured, policy-governed workflow without rewriting it.
    public func importLegacyPrompt(id: String, objective: String, prompt: String,
                                   defaultPolicyIDs: [String] = ["platform.security.default"]) -> WorkflowSpecification {
        let stage = WorkflowStage(id: "stage-1", title: "Execute Prompt", promptTemplate: prompt)
        let spec = WorkflowSpecification(id: id, objective: objective, inputs: ["context"], outputs: ["result"],
                                         stages: [stage], applicablePolicyIDs: defaultPolicyIDs)
        register(spec)
        return spec
    }
}
