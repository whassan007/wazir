import Foundation

/// Synthetic reference extension #1: Robotics telemetry & control-loop optimization.
public struct SyntheticRoboticsExtension: FleetExtensionPlugin {
    public let manifest = FleetExtensionManifest(
        id: "synthetic.robotics",
        name: "Synthetic Robotics Telemetry & Control",
        version: "1.0.0",
        permissions: [.registerOntology, .registerPolicy, .registerEvaluator, .registerWorkflow, .registerCommand]
    )

    public init() {}

    public func registerWorkflows() -> [WorkflowSpecification] {
        [
            WorkflowSpecification(
                id: "robotics.control-loop.optimize",
                objective: "Optimize PID control loop latency while preserving safety envelope",
                inputs: ["sensorTelemetry", "safetyEnvelope"],
                outputs: ["tunedParameters", "simulationReport"],
                stages: [
                    WorkflowStage(id: "baseline", title: "Measure Control Latency", promptTemplate: "Measure baseline loop jitter"),
                    WorkflowStage(id: "tune", title: "Tune Parameters", promptTemplate: "Propose PID gains", dependsOn: ["baseline"]),
                    WorkflowStage(id: "verify", title: "Verify Safety Envelope", promptTemplate: "Check overshoot <= 5%", dependsOn: ["tune"])
                ],
                rubricID: "robotics.safety.rubric"
            )
        ]
    }

    public func registerRubrics() -> [EvaluationRubric] {
        [
            EvaluationRubric(
                id: "robotics.safety.rubric",
                title: "Robotics Control Loop Safety & Latency",
                criteria: [
                    RubricCriterion(id: "latency_ms", name: "Control Loop Latency", weight: 0.5, minimumPassingScore: 0.8),
                    RubricCriterion(id: "safety_envelope", name: "Safety Envelope Compliance", weight: 0.5, minimumPassingScore: 1.0, isNonNegotiableGate: true)
                ]
            )
        ]
    }

    public func registerCustomCommands() -> [String] { ["sim-tune"] }
}

/// Synthetic reference extension #2: Data engineering pipeline & schema-drift repair.
public struct SyntheticDataEngineeringExtension: FleetExtensionPlugin {
    public let manifest = FleetExtensionManifest(
        id: "synthetic.data-engineering",
        name: "Synthetic Data Pipeline & Schema Guard",
        version: "1.0.0",
        permissions: [.registerOntology, .registerPolicy, .registerEvaluator, .registerWorkflow, .registerCommand]
    )

    public init() {}

    public func registerWorkflows() -> [WorkflowSpecification] {
        [
            WorkflowSpecification(
                id: "data.pipeline.repair",
                objective: "Detect and repair upstream schema drift in ETL transform jobs",
                inputs: ["datasetSchema", "transformJob"],
                outputs: ["repairedTransform", "rowValidationReport"],
                stages: [
                    WorkflowStage(id: "inspect", title: "Inspect Schema Drift", promptTemplate: "Diff incoming schema"),
                    WorkflowStage(id: "repair", title: "Repair Transform", promptTemplate: "Update mapping", dependsOn: ["inspect"])
                ],
                rubricID: "data.quality.rubric"
            )
        ]
    }

    public func registerRubrics() -> [EvaluationRubric] {
        [
            EvaluationRubric(
                id: "data.quality.rubric",
                title: "ETL Pipeline Quality & Schema Integrity",
                criteria: [
                    RubricCriterion(id: "schema_match", name: "Schema Compatibility", weight: 0.6, minimumPassingScore: 1.0, isNonNegotiableGate: true),
                    RubricCriterion(id: "row_completeness", name: "Row Completeness", weight: 0.4, minimumPassingScore: 0.95)
                ]
            )
        ]
    }

    public func registerCustomCommands() -> [String] { ["etl-repair"] }
}
