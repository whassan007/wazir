import Foundation

public enum FleetSlashCommand: String, CaseIterable, Sendable, Codable {
    case goal, plan, execute, audit, evaluate, optimize, loop, workflow
    case ontology, framework, resources, machines, models, allocate, rebalance
    case benchmark, topology, compare, replay, release, project, history
    case pause, resume, stop
}

public struct ControlPlaneResponse: Codable, Sendable, Equatable {
    public var command: String
    public var status: String
    public var summary: String
    public var data: [String: String]

    public init(command: String, status: String = "ok", summary: String, data: [String: String] = [:]) {
        self.command = command
        self.status = status
        self.summary = summary
        self.data = data
    }
}

/// Shared runtime APIs invoked by the macOS UI, FleetCLI, Wazir, and coding agents.
public actor ControlPlaneRuntime {
    public let storage: FleetStorage
    public let scheduler: ResourceAwareScheduler
    public let evaluationEngine = EvaluationEngine()
    public let loopEngine = OptimizationLoopEngine()
    public let ontologyEngine = OntologyEngine()
    public let policyRegistry = FrameworkPolicyRegistry()
    public let workflowRegistry = WorkflowRegistry()
    public let projectEngine = ProjectIntelligenceEngine()
    public let orchestrator = MetaOrchestrator()
    public let extensionManager = ExtensionManager()
    public let worktreeCoordinator = GitWorktreeCoordinator()
    public let machineRegistry = PhysicalMachineRegistry()
    public let modelRegistry = InstalledModelRegistry()
    public let allocator = AutonomousResourceAllocator()
    public let modelSwitcher = DynamicModelSwitcher()
    public let resilience = ResilienceAndMigrationEngine()
    public let repoIntrospector = RepositoryIntrospector()
    public let repoExecutor = RepoCodeExecutor()

    public init(storage: FleetStorage = try! FleetStorage(location: .inMemory)) {
        self.storage = storage
        self.scheduler = ResourceAwareScheduler()
    }

    public func handleSlashCommand(_ raw: String) async -> ControlPlaneResponse {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: " ", maxSplits: 1).map(String.init)
        let head = (parts.first ?? "").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let arg = parts.count > 1 ? parts[1] : ""

        guard let cmd = FleetSlashCommand(rawValue: head) else {
            return ControlPlaneResponse(command: head, status: "error", summary: "Unknown slash command '/\(head)'")
        }

        switch cmd {
        case .project:
            return ControlPlaneResponse(command: "/project", summary: "Fleet Core Control Plane active (domain-agnostic)")
        case .ontology:
            let count = await ontologyEngine.allEntities().count
            return ControlPlaneResponse(command: "/ontology", summary: "Ontology registry: \(count) entities", data: ["entities": "\(count)"])
        case .framework:
            let count = await policyRegistry.allRules().count
            return ControlPlaneResponse(command: "/framework", summary: "Policy registry: \(count) rules", data: ["rules": "\(count)"])
        case .workflow:
            let count = await workflowRegistry.all().count
            return ControlPlaneResponse(command: "/workflow", summary: "Workflow registry: \(count) workflows", data: ["workflows": "\(count)"])
        case .resources:
            let snap = await scheduler.statusSnapshot()
            return ControlPlaneResponse(command: "/resources", summary: "Active: \(snap.active), Queued: \(snap.queued), Tokens: \(snap.totalTokens)")
        case .history:
            let decisions = await orchestrator.decisionJournal().count
            return ControlPlaneResponse(command: "/history", summary: "Recorded decisions: \(decisions)")
        case .machines:
            let count = await machineRegistry.allMachines().count
            return ControlPlaneResponse(command: "/machines", summary: "Registered physical machines: \(count)", data: ["machines": "\(count)"])
        case .models:
            return ControlPlaneResponse(command: "/models", summary: "Machine-scoped model registry active")
        default:
            return ControlPlaneResponse(command: "/\(cmd.rawValue)", summary: "Dispatched /\(cmd.rawValue)\(arg.isEmpty ? "" : " (\(arg))")")
        }
    }
}
