import Foundation
import Testing
@testable import FleetCore

@Suite("Workload Fallback Chains & Mitigation")
struct WorkloadFallbackChainTests {
    let engine = WorkloadFallbackChainEngine()

    @Test func allNineWorkloadChainsExistWithOrderedSlots() {
        let chains = WorkloadFallbackChain.defaultChains
        #expect(chains.count == 9)
        for c in chains {
            #expect(!c.slots.isEmpty)
            #expect(c.slots.map(\.rank) == c.slots.map(\.rank).sorted())
        }
    }

    @Test func mitigatesOfflinePrimaryMachineToNextOnlineFallback() {
        // Standard coding 1st is dgx, 2nd is rtx, 3rd is studio
        let resolved = engine.resolve(
            activity: .standardFeatureAndTestCoding,
            onlineHostIDs: ["rtx", "jetson"],
            authenticatedCloudIDs: ["agy", "claude"]
        )
        #expect(resolved.selectedSlot?.hostOrProviderID == "rtx")
        #expect(resolved.skippedSlots.contains { $0.slot.hostOrProviderID == "dgx" })
    }

    @Test func privacyConstraintSkipsNonPrivateCloudAndRoutesToLocal() {
        let resolved = engine.resolve(
            activity: .standardFeatureAndTestCoding,
            onlineHostIDs: ["rtx"],
            authenticatedCloudIDs: ["claude"],
            requirePrivateLocal: true
        )
        #expect(resolved.selectedSlot?.hostOrProviderID == "rtx")
        #expect(resolved.fallbackQueue.allSatisfy { !$0.isNonPrivateCloudOnly })
    }

    @Test func exhaustedCloudBudgetMitigatesToLocalHardware() {
        let resolved = engine.resolve(
            activity: .complexMultiFile,
            onlineHostIDs: ["dgx", "rtx"],
            authenticatedCloudIDs: ["codex", "agy"],
            exhaustedCloudIDs: ["codex", "agy"]
        )
        #expect(resolved.selectedSlot?.hostOrProviderID == "dgx")
    }

    @Test func bidirectionalGroupingByMachineIncludesAllHosts() {
        let grouped = engine.groupByMachine()
        let ids = Set(grouped.map(\.hostOrProviderID))
        #expect(ids.contains("dgx"))
        #expect(ids.contains("jetson"))
        #expect(ids.contains("rtx"))
        #expect(ids.contains("agy"))
        #expect(ids.contains("codex"))
        #expect(ids.contains("claude"))
    }
}
