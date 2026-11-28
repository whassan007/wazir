import Foundation
import Testing
@testable import FleetCore

@Suite("Cloud Service Budgets & Token Spend")
struct CloudServiceBudgetTests {
    @Test func defaultCloudPlansMatchUserBudgets() {
        let services = CloudServicePlanConfig.defaultServices
        let agy = services.first { $0.id == "agy" }
        let codex = services.first { $0.id == "codex" }
        let claude = services.first { $0.id == "claude" }

        #expect(agy?.monthlyPlanBudgetUSD == 200.0)
        #expect(codex?.monthlyPlanBudgetUSD == 20.0)
        #expect(claude?.monthlyPlanBudgetUSD == 20.0)
        #expect(claude?.additionalSpendLimitUSD == 50.0)
        #expect(claude?.totalBudgetCeilingUSD == 70.0)
    }

    @Test func configBackwardCompatibilitySeedsDefaultCloudServices() throws {
        let minimal = #"{"hosts":[{"id":"box","tailscaleIP":"100.1.2.3","runtimes":[{"kind":"ollama"}]}]}"#
        let cfg = try JSONDecoder().decode(FleetConfig.self, from: Data(minimal.utf8))
        #expect(cfg.cloudServices.count == 3)
        #expect(cfg.cloudServices.map(\.id) == ["agy", "codex", "claude"])
    }

    @Test func engineParsesClaudeStatsAndEnforcesBudget() throws {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("fleet-cloud-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp.appendingPathComponent(".claude"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let stats = """
        {
          "version": 2,
          "totalSessions": 12,
          "totalMessages": 340,
          "modelUsage": {
            "claude-opus-5-5": {
              "inputTokens": 1000000,
              "outputTokens": 2000000,
              "cacheReadInputTokens": 500000,
              "cacheCreationInputTokens": 100000
            }
          }
        }
        """
        try Data(stats.utf8).write(to: tmp.appendingPathComponent(".claude/stats-cache.json"))

        let engine = CloudServiceBudgetEngine(homeDirectory: tmp.path)
        let claudeCfg = CloudServicePlanConfig.defaultServices.first { $0.id == "claude" }!
        let snap = engine.discover(config: claudeCfg)

        #expect(snap.totalSessions == 12)
        #expect(snap.totalMessages == 340)
        #expect(snap.totalInputTokens == 1_000_000)
        #expect(snap.totalOutputTokens == 2_000_000)
        #expect(snap.discoveredModels.contains { $0.id == "claude-opus-5-5" })
        #expect(snap.estimatedPlanSpendUSD == 20.0)
        #expect(snap.estimatedExtraSpendUSD > 0)
        #expect(!engine.canAllocateWithinBudget(snapshot: snap, estimatedCostUSD: 100.0))
    }
}
