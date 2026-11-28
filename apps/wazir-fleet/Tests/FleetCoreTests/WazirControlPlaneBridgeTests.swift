import Foundation
import Testing
@testable import FleetCore

@Suite("Wazir Control Plane Bridge")
struct WazirControlPlaneBridgeTests {
    @Test func wazirControlPlaneBridgeRoundTripsSharedFleetState() throws {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("wazir-bridge-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }

        let bridge = WazirControlPlaneBridge(environment: ["WAZIR_HOME": tmpDir.path])
        let config = DefaultFleet.config
        var state = FleetState()
        FleetReducer.reduce(&state, .configLoaded(config))
        if let first = config.hosts.first {
            FleetReducer.reduce(&state, .reachability(host: first.id, .online(latencyMS: 1.5, address: "127.0.0.1"), at: Date()))
        }

        try bridge.exportSnapshot(from: config, state: state)
        let loaded = try bridge.readSnapshot()
        #expect(loaded != nil)
        #expect(loaded?.hosts.count == config.hosts.count)
        #expect(loaded?.hosts.first?.online == true)
    }
}
