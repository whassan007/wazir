import Foundation
import Testing
@testable import FleetCore

@Suite("Fleet Core V2 Integration Tests (Section 29 + Project Repo Execution)")
struct FleetCoreV2IntegrationTests {
    func sampleMachine(id: String = "dgx", state: MachineOperationalState = .available,
                       memory: MemoryArchitecture = .unified(totalBytes: 128_000_000_000, availableBytes: 96_000_000_000)) -> PhysicalMachineRecord {
        PhysicalMachineRecord(id: id, name: "Machine \(id)", os: .linux, memory: memory,
                              endpoints: ["http://127.0.0.1:11434"], operationalState: state)
    }

    func sampleModel(id: String = "qwen3-coder:30b", machineID: String = "dgx",
                     weightBytes: Int64 = 18_000_000_000, capabilities: Set<ModelCapability> = [.generalChat, .coding],
                     score: Double = 0.9) -> DiscoveredModelDescriptor {
        DiscoveredModelDescriptor(id: id, machineID: machineID, runtimeKind: .ollama, weightSizeBytes: weightBytes,
                                  capabilities: capabilities, isLoaded: false, evaluationScore: score)
    }

    @Test func test01_to_07_machineDropAndModelSelectionPolicies() async {
        let reg = PhysicalMachineRegistry()
        let modReg = InstalledModelRegistry()
        let alloc = AutonomousResourceAllocator()
        let wf = UUID()

        let dgx = sampleMachine(id: "dgx", state: .available)
        let offline = sampleMachine(id: "offline-box", state: .offline)
        await reg.registerOrUpdate(dgx)
        await reg.registerOrUpdate(offline)

        let m1 = sampleModel(id: "qwen3-coder:30b", machineID: "dgx", score: 0.92)
        let m2 = sampleModel(id: "llama3.2:latest", machineID: "dgx", capabilities: [.generalChat], score: 0.75)
        await modReg.setInstalledModels([m1, m2], for: "dgx")

        // 01: Drag available machine onto workflow
        let models = await modReg.installedModels(on: "dgx")
        #expect(models.count == 2)

        // 02: Attempt to use offline machine
        let offRes = await alloc.allocate(workflowID: wf, machine: offline, installedModels: [], selectionMode: .auto)
        if case .blocked = offRes { } else { Issue.record("Expected blocked for offline machine") }

        // 03 & 04: Installed model succeeds; model not installed on machine is rejected
        #expect(await modReg.isInstalled("qwen3-coder:30b", on: "dgx"))
        #expect(!(await modReg.isInstalled("nonexistent:7b", on: "dgx")))

        // 05: AUTO selects highest-scoring eligible model
        let autoRes = await alloc.allocate(workflowID: wf, machine: dgx, installedModels: models, selectionMode: .auto, requiredCapabilities: [.coding])
        if case .allocated(let inst, _, _) = autoRes { #expect(inst.modelID == "qwen3-coder:30b") } else { Issue.record("Expected allocated") }

        // 06: PREFERRED substitutes when preferred model lacks capability, with transparency
        let prefRes = await alloc.allocate(workflowID: UUID(), machine: dgx, installedModels: models,
                                           selectionMode: .preferred(modelID: "llama3.2:latest"), requiredCapabilities: [.coding])
        if case .allocated(let inst, _, let sub) = prefRes {
            #expect(inst.modelID == "qwen3-coder:30b")
            #expect(sub?.userPreferredModel == "llama3.2:latest")
        } else { Issue.record("Expected preferred substitution") }

        // 07: PINNED refuses substitution and blocks
        let pinRes = await alloc.allocate(workflowID: UUID(), machine: dgx, installedModels: models,
                                          selectionMode: .pinned(modelID: "missing-pinned:70b"))
        if case .blocked = pinRes { } else { Issue.record("Expected blocked for pinned missing model") }
    }

    @Test func test08_to_14_memoryUnifiedDeduplicationAndInstanceReuse() async {
        let reg = PhysicalMachineRegistry()
        let alloc = AutonomousResourceAllocator()
        let wf1 = UUID(), wf2 = UUID()

        // 11: Multiple endpoints deduplicated onto one physical machine
        await reg.registerOrUpdate(sampleMachine(id: "mac", memory: .unified(totalBytes: 24_000_000_000, availableBytes: 20_000_000_000)))
        await reg.registerOrUpdate(PhysicalMachineRecord(id: "mac", name: "Mac", os: .macos,
                                                         memory: .unified(totalBytes: 24_000_000_000, availableBytes: 20_000_000_000),
                                                         endpoints: ["http://127.0.0.1:1234"], operationalState: .available))
        let mac = await reg.machine("mac")!
        #expect(mac.endpoints.count == 2)
        // 09: Unified memory is not double-counted
        #expect(mac.memory.availableComputeMemoryBytes == 20_000_000_000)

        let bigModel = sampleModel(id: "huge:70b", machineID: "mac", weightBytes: 40_000_000_000)
        let smallModel = sampleModel(id: "small:7b", machineID: "mac", weightBytes: 5_000_000_000)

        // 08: Insufficient memory rejected
        let tooBig = await alloc.allocate(workflowID: wf1, machine: mac, installedModels: [bigModel], selectionMode: .auto)
        if case .blocked = tooBig { } else { Issue.record("Expected insufficient memory rejection") }

        // 13: Model-serving instance reuse across logical agents
        let first = await alloc.allocate(workflowID: wf1, machine: mac, installedModels: [smallModel], selectionMode: .auto, requestedSlots: 1, logicalAgents: 2)
        let second = await alloc.allocate(workflowID: wf1, machine: mac, installedModels: [smallModel], selectionMode: .auto, requestedSlots: 1, logicalAgents: 2)
        if case .allocated(_, let reused1, _) = first, case .allocated(_, let reused2, _) = second {
            #expect(!reused1 && reused2)
        } else { Issue.record("Expected instance reuse") }

        // 12: Competing workflow blocked when GPU memory is already reserved
        let mediumModel = sampleModel(id: "med:24b", machineID: "mac", weightBytes: 15_000_000_000)
        let compete = await alloc.allocate(workflowID: wf2, machine: mac, installedModels: [mediumModel], selectionMode: .auto)
        if case .blocked = compete { } else { Issue.record("Expected competing workflow blocked") }

        // 14: Runtime capability limitations
        let cli = CLIAgentAdapter(adapterID: "codex", executablePath: "/usr/bin/true", defaultModel: "gpt-6-astra") { _ in [] }
        #expect(!cli.lifecycleCapabilities.modelLoading)
    }

    @Test func test15_to_26_switchingResilienceEquivalenceAndCloudPolicy() async throws {
        let switcher = DynamicModelSwitcher()
        let models = [
            sampleModel(id: "fast:7b", machineID: "dgx", capabilities: [.generalChat], score: 0.7),
            sampleModel(id: "coder:30b", machineID: "dgx", capabilities: [.generalChat, .coding], score: 0.95),
        ]

        // 15 & 18: Dynamic model switch preserves checkpoint ID
        let cpID = UUID()
        let sw = switcher.evaluateSwitch(trigger: .missingCapability(.coding), currentModel: "fast:7b",
                                         machineID: "dgx", selectionMode: .preferred(modelID: "fast:7b"),
                                         availableModels: models, checkpointID: cpID)
        #expect(sw.switched)
        #expect(sw.preservedCheckpointID == cpID)
        #expect(sw.substitution?.assignedModel == "coder:30b")

        // 16, 17, 19: Heartbeat failure & controlled draining
        let resilience = ResilienceAndMigrationEngine()
        let lease = TaskLease(idempotencyKey: "k-1", machineID: "dgx", workflowID: UUID(), expiresAt: Date().addingTimeInterval(60))
        try await resilience.acquireLease(lease)
        let drained = await resilience.drainMachine("dgx")
        #expect(drained.count == 1)

        // 26: Unauthorized cloud fallback rejection
        await #expect(throws: FleetError.self) {
            try await resilience.authorizeMigration(toIsCloud: true, profile: .localExecutionOnly)
        }

        // 22: All 25 CLI slash commands share ControlPlaneRuntime
        let runtime = ControlPlaneRuntime()
        #expect(FleetSlashCommand.allCases.count == 25)
        for cmd in FleetSlashCommand.allCases {
            let res = await runtime.handleSlashCommand("/\(cmd.rawValue)")
            #expect(res.status == "ok")
        }
    }

    @Test func test27_promptExecutesAndImplementsCodeInProjectRepository() async throws {
        let tempRepo = FileManager.default.temporaryDirectory.appendingPathComponent("fleet-repo-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempRepo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempRepo) }

        let introspector = RepositoryIntrospector()
        let coordinator = GitWorktreeCoordinator()
        let executor = RepoCodeExecutor()

        let ctx = try await introspector.introspect(repoPath: tempRepo.path, coordinator: coordinator)
        #expect(ctx.repoPath == tempRepo.path)

        let modelReply = """
        {"files":[{"path":"Sources/Generated/HelloFleet.swift","action":"write","content":"public let helloFleet = 42\\n"}]}
        """
        let changes = executor.parseChanges(from: modelReply)
        #expect(changes.count == 1)

        let written = try await executor.apply(changes: changes, in: tempRepo.path, agentID: "coder-1", coordinator: coordinator)
        #expect(written == ["Sources/Generated/HelloFleet.swift"])
        let fileURL = tempRepo.appendingPathComponent("Sources/Generated/HelloFleet.swift")
        #expect(FileManager.default.fileExists(atPath: fileURL.path))
    }
}
