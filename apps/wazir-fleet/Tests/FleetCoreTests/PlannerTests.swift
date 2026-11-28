import Foundation
import Testing
@testable import FleetCore

@Suite("Planning")
struct PlannerTests {
    let config = DefaultFleet.config
    var planner: Planner { Planner(config: config) }
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func state(online: [String] = [], models: [String: [RuntimeKind: [ModelInfo]]] = [:]) -> FleetState {
        var s = FleetState()
        FleetReducer.reduce(&s, .configLoaded(config))
        for id in online {
            let addr = config.host(id: id)!.candidateAddresses.first!
            FleetReducer.reduce(&s, .reachability(host: id, .online(latencyMS: 3, address: addr), at: now))
        }
        for (id, byRuntime) in models {
            for (k, ms) in byRuntime {
                FleetReducer.reduce(&s, .inventory(host: id, k, .success(RuntimeSnapshot(models: ms)), at: now))
            }
        }
        return s
    }

    func cmd(_ s: String) throws -> ModelCommand {
        guard case .model(let m) = try CommandParser(config: config).parse(s) else { throw FleetError("not model") }
        return m
    }

    @Test func addOnJetsonUsesOllamaPull() throws {
        let p = try planner.plan(try cmd("add model qwen2.5 on machine jetson"), input: "", state: state(online: ["jetson"]))
        #expect(p.steps.count == 1)
        #expect(p.steps[0].action == .ollamaPull(model: "qwen2.5"))
        #expect(p.steps[0].baseURL?.absoluteString == "http://100.64.0.11:11434")
        #expect(p.steps[0].detail.contains("/api/pull"))
        #expect(p.dryRun)  // default config is dry-run
        #expect(!p.isDestructive)
        #expect(p.registryLookups == ["qwen2.5"])
    }

    @Test func liveFlagOverridesDefault() throws {
        let p = try planner.plan(try cmd("add qwen2.5 on jetson --live"), input: "", state: state(online: ["jetson"]))
        #expect(!p.dryRun)
    }

    @Test func aliasResolves() throws {
        let p = try planner.plan(try cmd("add qwen2.5 on spark"), input: "", state: state(online: ["dgx"]))
        #expect(p.steps.map(\.hostID) == ["dgx"])
    }

    @Test func unknownHostSuggests() throws {
        #expect {
            try planner.plan(try cmd("add qwen2.5 on jetsn"), input: "", state: state())
        } throws: { e in
            (e as? PlanError)?.problems.first?.contains("Did you mean 'jetson'") == true
        }
    }

    @Test func removeIsDestructiveAndUsesInventoryName() throws {
        let s = state(online: ["dgx"], models: ["dgx": [.ollama: [ModelInfo(name: "qwen2.5:latest", sizeBytes: 4_700_000_000)]]])
        let p = try planner.plan(try cmd("remove qwen2.5 from dgx"), input: "", state: s)
        #expect(p.isDestructive)
        #expect(p.steps[0].action == .ollamaDelete(model: "qwen2.5:latest"))
        #expect(p.warnings.contains { $0.contains("frees about") })
    }

    @Test func removePicksRuntimeHoldingModel() throws {
        let s = state(online: ["dgx"], models: ["dgx": [.lmstudio: [ModelInfo(name: "google/gemma-3-12b")]]])
        // Host has Ollama + LM Studio; the model only lives in LM Studio, but LM Studio has no
        // default remove command → planner must refuse rather than silently using Ollama.
        #expect(throws: PlanError.self) {
            try planner.plan(try cmd("remove google/gemma-3-12b from dgx"), input: "", state: s)
        }
        let r = try planner.plan(try cmd("reload google/gemma-3-12b on dgx"), input: "", state: s)
        #expect(r.steps[0].runtime == .lmstudio)
        guard case .ssh(let target, let command, _) = r.steps[0].action else { Issue.record("expected ssh"); return }
        #expect(target == "dgx")
        #expect(command == "lms unload google/gemma-3-12b ; lms load google/gemma-3-12b --yes")
    }

    @Test func reloadOllamaIsUnloadThenLoad() throws {
        let s = state(online: ["gb10"], models: ["gb10": [.ollama: [ModelInfo(name: "qwen3:8b", isLoaded: true)]]])
        let p = try planner.plan(try cmd("reload qwen3:8b on gb10"), input: "", state: s)
        #expect(p.steps.map(\.action) == [.ollamaUnload(model: "qwen3:8b"), .ollamaLoad(model: "qwen3:8b")])
        #expect(p.steps.map(\.id) == [0, 1])
    }

    @Test func offlineHostWarns() throws {
        var s = state()
        FleetReducer.reduce(&s, .reachability(host: "studio", .offline(reason: "asleep"), at: now))
        let p = try planner.plan(try cmd("add qwen2.5 on studio"), input: "", state: s)
        #expect(p.warnings.contains { $0.contains("unreachable") })
    }

    @Test func alreadyInstalledWarns() throws {
        let s = state(online: ["jetson"], models: ["jetson": [.ollama: [ModelInfo(name: "qwen2.5:latest")]]])
        let p = try planner.plan(try cmd("add qwen2.5 on jetson"), input: "", state: s)
        #expect(p.warnings.contains { $0.contains("already on") })
    }

    @Test func explicitMissingRuntimeFails() throws {
        #expect(throws: PlanError.self) {
            try planner.plan(try cmd("add qwen2.5 on jetson via mlx"), input: "", state: state(online: ["jetson"]))
        }
    }

    @Test func allHostsFansOutAndSkipsIncapable() throws {
        let p = try planner.plan(try cmd("add qwen2.5 on all"), input: "", state: state())
        #expect(Set(p.steps.map(\.hostID)) == Set(config.hosts.map(\.id)))  // every host has Ollama
        #expect(Set(p.steps.map(\.id)).count == p.steps.count)
    }

    @Test func mlxRepoOnStudioUsesSSHTemplate() throws {
        let p = try planner.plan(try cmd("add mlx-community/Qwen3-4B-4bit on studio"), input: "", state: state(online: ["studio"]))
        #expect(p.steps[0].runtime == .mlx)
        #expect(p.steps[0].action == .ssh(target: "studio", command: "hf download mlx-community/Qwen3-4B-4bit", posix: true))
        #expect(p.registryLookups.isEmpty)
    }

    @Test func localHostRunsLocally() throws {
        var cfg = config
        let i = cfg.hosts.firstIndex { $0.id == "macbook" }!
        cfg.hosts[i].runtimes = [RuntimeConfig(kind: .llamacpp, modelsDir: "~/models")]
        let p = try Planner(config: cfg).plan(try cmd("add unsloth/Qwen3-8B-GGUF:Q4_K_M on macbook"), input: "", state: state())
        guard case .local(let command) = p.steps[0].action else { Issue.record("expected local"); return }
        #expect(command.contains("--include '*Q4_K_M*.gguf'"))
        #expect(command.contains(#""$HOME"/models/unsloth__Qwen3-8B-GGUF"#))
    }

    @Test func llamaCppWithoutModelsDirFails() throws {
        var cfg = config
        let i = cfg.hosts.firstIndex { $0.id == "macbook" }!
        cfg.hosts[i].runtimes = [RuntimeConfig(kind: .llamacpp)]
        #expect(throws: PlanError.self) {
            try Planner(config: cfg).plan(try cmd("add unsloth/Qwen3-8B-GGUF on macbook"), input: "", state: state())
        }
    }

    @Test func windowsHostRefusesPosixTemplates() throws {
        var cfg = config
        let i = cfg.hosts.firstIndex { $0.id == "legion" }!
        cfg.hosts[i].sshTarget = "legion"
        cfg.hosts[i].runtimes = [RuntimeConfig(kind: .lmstudio)]
        #expect(throws: PlanError.self) {
            try Planner(config: cfg).plan(try cmd("add qwen2.5 on legion"), input: "", state: state())
        }
    }

    @Test func enrichmentAddsSizeAndBlocksUnknownModels() throws {
        let s = state(online: ["jetson", "dgx"])
        let p = try planner.plan(try cmd("add qwen2.2, qwen2.5 on jetson and dgx"), input: "", state: s)
        let e = PlanEnricher.apply(["qwen2.2": .notFound, "qwen2.5": .found(bytes: 6 * 1_073_741_824)],
                                   to: p, config: config, inventory: [])
        #expect(e.estimatedBytes == Int64(12) * 1_073_741_824)
        #expect(e.blockers.count == 1)
        #expect(e.blockers[0].contains("Did you mean 'qwen2.5'"))
        #expect(e.warnings.contains { $0.contains("Large download") })
    }

    @Test func enrichmentWarnsWhenModelExceedsMemory() throws {
        let p = try planner.plan(try cmd("add llama3.3:70b on macbook"), input: "", state: state())
        let e = PlanEnricher.apply(["llama3.3:70b": .found(bytes: 42 * 1_073_741_824)], to: p, config: config, inventory: [])
        #expect(e.warnings.contains { $0.contains("may not fit") })
    }

    @Test func fuzzy() {
        #expect(Fuzzy.distance("kitten", "sitting") == 3)
        #expect(Fuzzy.suggest("jetsn", among: ["jetson", "dgx"]) == "jetson")
        #expect(Fuzzy.suggest("zzz", among: ["jetson", "dgx"]) == nil)
        #expect(ModelCatalog.suggest("qwen2.2", inventory: []) == "qwen2.5")
        #expect(ModelCatalog.suggest("lama3.2:3b", inventory: []) == "llama3.2:3b")
    }

    @Test func registryURL() {
        #expect(OllamaRegistry.manifestURL(for: "qwen2.5")?.absoluteString == "https://registry.ollama.ai/v2/library/qwen2.5/manifests/latest")
        #expect(OllamaRegistry.manifestURL(for: "user/thing:7b")?.absoluteString == "https://registry.ollama.ai/v2/user/thing/manifests/7b")
    }
}
