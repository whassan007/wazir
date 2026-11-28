import Foundation
import Testing
@testable import FleetCore

@Suite("State transitions")
struct StateTests {
    let config = DefaultFleet.config
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func loaded() -> FleetState {
        var s = FleetState()
        FleetReducer.reduce(&s, .configLoaded(config))
        return s
    }

    @Test func configCreatesHostsInOrder() {
        let s = loaded()
        #expect(s.hostOrder == config.hosts.map(\.id))
        #expect(s.hosts["dgx"]?.runtimes.keys.sorted { $0.rawValue < $1.rawValue } == [.lmstudio, .ollama])
        #expect(s.hosts.values.allSatisfy { $0.reachability == .unknown })
    }

    @Test func reconcileKeepsStateAndDropsRemoved() {
        var s = loaded()
        FleetReducer.reduce(&s, .reachability(host: "dgx", .online(latencyMS: 4, address: "100.64.0.12"), at: t0))
        var cfg = config
        cfg.hosts.removeAll { $0.id == "legion" }
        cfg.hosts[cfg.hosts.firstIndex { $0.id == "dgx" }!].runtimes = [RuntimeConfig(kind: .ollama)]
        FleetReducer.reduce(&s, .configLoaded(cfg))
        #expect(s.hosts["legion"] == nil)
        #expect(s.hosts["dgx"]?.reachability.isOnline == true)
        #expect(s.hosts["dgx"]?.runtimes[.lmstudio] == nil)
    }

    @Test func probeLifecycle() {
        var s = loaded()
        FleetReducer.reduce(&s, .probeStarted(host: "jetson"))
        #expect(s.hosts["jetson"]!.isProbing)
        FleetReducer.reduce(&s, .reachability(host: "jetson", .online(latencyMS: 12.5, address: "100.64.0.11"), at: t0))
        FleetReducer.reduce(&s, .probeFinished(host: "jetson", at: t0))
        let h = s.hosts["jetson"]!
        #expect(!h.isProbing)
        #expect(h.lastSeen == t0)
        #expect(h.reachability == .online(latencyMS: 12.5, address: "100.64.0.11"))
    }

    @Test func goingOfflineKeepsStaleInventory() {
        var s = loaded()
        let models = [ModelInfo(name: "qwen3:8b", isLoaded: true)]
        FleetReducer.reduce(&s, .inventory(host: "gb10", .ollama, .success(RuntimeSnapshot(version: "0.12", models: models)), at: t0))
        #expect(s.hosts["gb10"]!.runtimes[.ollama]!.status == .online)
        FleetReducer.reduce(&s, .reachability(host: "gb10", .offline(reason: "timeout"), at: t0.addingTimeInterval(60)))
        let rt = s.hosts["gb10"]!.runtimes[.ollama]!
        #expect(rt.isStale)
        #expect(rt.models.map(\.name) == ["qwen3:8b"])
        #expect(rt.models[0].isLoaded == false)
        #expect(s.hosts["gb10"]!.lastSeen == nil)  // never answered directly
    }

    @Test func inventoryFailureMarksStaleButKeepsModels() {
        var s = loaded()
        FleetReducer.reduce(&s, .inventory(host: "dgx", .ollama, .success(RuntimeSnapshot(models: [ModelInfo(name: "a")])), at: t0))
        FleetReducer.reduce(&s, .inventory(host: "dgx", .ollama, .failure(FleetError("refused")), at: t0))
        let rt = s.hosts["dgx"]!.runtimes[.ollama]!
        #expect(rt.status == .unreachable("refused"))
        #expect(rt.isStale)
        #expect(rt.models.count == 1)
    }

    @Test func tailscaleMatchesByIPAndUpdatesLastSeen() {
        var s = loaded()
        let seen = t0.addingTimeInterval(-86400)
        let peers = [
            TailscalePeer(hostName: "studio", ips: ["100.64.0.14"], online: false, lastSeen: seen),
            TailscalePeer(hostName: "dgx-spark", ips: ["100.64.0.12"], online: true),
        ]
        FleetReducer.reduce(&s, .tailscale(.success(peers), at: t0))
        #expect(s.hosts["studio"]!.tailscale?.online == false)
        #expect(s.hosts["studio"]!.lastSeen == seen)
        #expect(s.hosts["dgx"]!.lastSeen == nil)  // tailnet-online alone is not "seen"
        #expect(s.hosts["jetson"]!.tailscale == nil)
    }

    @Test func unknownHostEventIsDiagnosedNotCrashing() {
        var s = loaded()
        FleetReducer.reduce(&s, .probeStarted(host: "nope"))
        #expect(s.diagnostics.last?.contains("unknown host 'nope'") == true)
    }

    // MARK: Operations

    func plan(steps: Int) -> ExecutionPlan {
        let st = (0..<steps).map {
            PlanStep(id: $0, hostID: "jetson", hostName: "Jetson", runtime: .ollama, model: "m", verb: .add,
                     title: "Step \($0)", detail: "", action: .ollamaPull(model: "m"), baseURL: nil)
        }
        return ExecutionPlan(id: UUID(), input: "", command: ModelCommand(verb: .add, models: ["m"], target: .hosts(["jetson"])),
                             dryRun: false, steps: st, warnings: [], estimatedBytes: nil, registryLookups: [])
    }

    @Test func operationHappyPath() throws {
        var op = OperationRecord(plan: plan(steps: 2), dryRun: false, startedAt: t0)
        #expect(op.overallProgress == 0)
        try FleetReducer.apply(.stepStarted(0), to: &op, at: t0)
        try FleetReducer.apply(.stepProgress(0, 0.5, "half"), to: &op, at: t0)
        #expect(op.overallProgress == 0.25)
        try FleetReducer.apply(.stepSucceeded(0, nil), to: &op, at: t0)
        try FleetReducer.apply(.stepStarted(1), to: &op, at: t0)
        try FleetReducer.apply(.stepSucceeded(1, "ok"), to: &op, at: t0)
        try FleetReducer.apply(.finished, to: &op, at: t0)
        #expect(op.phase == .succeeded)
        #expect(op.overallProgress == 1)
        #expect(op.finishedAt == t0)
    }

    @Test func stepTimestampsAreRecorded() throws {
        var op = OperationRecord(plan: plan(steps: 3), dryRun: false, startedAt: t0)
        let t1 = t0.addingTimeInterval(1), t2 = t0.addingTimeInterval(2), t3 = t0.addingTimeInterval(3)
        try FleetReducer.apply(.stepStarted(0), to: &op, at: t1)
        try FleetReducer.apply(.stepSucceeded(0, nil), to: &op, at: t2)
        try FleetReducer.apply(.stepStarted(1), to: &op, at: t2)
        try FleetReducer.apply(.stepFailed(1, "boom"), to: &op, at: t3)
        try FleetReducer.apply(.finished, to: &op, at: t3)
        #expect(op.stepStartedAt[0] == t1)
        #expect(op.stepFinishedAt[0] == t2)
        #expect(op.stepStartedAt[1] == t2)
        #expect(op.stepFinishedAt[1] == t3)
        #expect(op.stepStartedAt[2] == nil)
        #expect(op.stepFinishedAt[2] == t3)  // skipped as "Not run" when the operation finished
    }

    @Test func failedStepFailsOperationButOthersStillRun() throws {
        var op = OperationRecord(plan: plan(steps: 2), dryRun: false, startedAt: t0)
        try FleetReducer.apply(.stepStarted(0), to: &op, at: t0)
        try FleetReducer.apply(.stepFailed(0, "HTTP 500"), to: &op, at: t0)
        try FleetReducer.apply(.stepStarted(1), to: &op, at: t0)
        try FleetReducer.apply(.stepSucceeded(1, nil), to: &op, at: t0)
        try FleetReducer.apply(.finished, to: &op, at: t0)
        #expect(op.phase == .failed("Step 0: HTTP 500"))
    }

    @Test func illegalTransitionsAreRejected() throws {
        var op = OperationRecord(plan: plan(steps: 1), dryRun: false, startedAt: t0)
        #expect(throws: FleetError.self) { try FleetReducer.apply(.stepSucceeded(0, nil), to: &op, at: t0) }  // not started
        #expect(throws: FleetError.self) { try FleetReducer.apply(.stepProgress(0, 0.1, nil), to: &op, at: t0) }
        #expect(throws: FleetError.self) { try FleetReducer.apply(.stepStarted(7), to: &op, at: t0) }  // unknown step
        try FleetReducer.apply(.stepStarted(0), to: &op, at: t0)
        #expect(throws: FleetError.self) { try FleetReducer.apply(.stepStarted(0), to: &op, at: t0) }  // twice
        try FleetReducer.apply(.cancelled, to: &op, at: t0)
        #expect(op.phase == .cancelled)
        #expect(op.steps[0] == .skipped("Cancelled"))
        #expect(throws: FleetError.self) { try FleetReducer.apply(.finished, to: &op, at: t0) }  // terminal
        try FleetReducer.apply(.stepLog(nil, .info, "late log ok"), to: &op, at: t0)  // logs still accepted
    }

    @Test func finishMarksUnrunStepsSkipped() throws {
        var op = OperationRecord(plan: plan(steps: 3), dryRun: true, startedAt: t0)
        try FleetReducer.apply(.stepStarted(0), to: &op, at: t0)
        try FleetReducer.apply(.stepSucceeded(0, nil), to: &op, at: t0)
        try FleetReducer.apply(.finished, to: &op, at: t0)
        #expect(op.steps[1] == .skipped("Not run"))
        #expect(op.phase == .succeeded)
    }

    @Test func reducerRoutesOperationEventsAndRecordsBadOnes() {
        var s = loaded()
        let op = OperationRecord(plan: plan(steps: 1), dryRun: false, startedAt: t0)
        FleetReducer.reduce(&s, .operationStarted(op))
        FleetReducer.reduce(&s, .operationStarted(op))
        #expect(s.operations.count == 1)
        FleetReducer.reduce(&s, .operation(op.id, .stepSucceeded(0, nil), at: t0))
        #expect(s.diagnostics.count == 2)
        FleetReducer.reduce(&s, .operation(op.id, .stepStarted(0), at: t0))
        FleetReducer.reduce(&s, .operation(op.id, .stepSucceeded(0, nil), at: t0))
        FleetReducer.reduce(&s, .operation(op.id, .finished, at: t0))
        #expect(s.operations[0].phase == .succeeded)
        FleetReducer.reduce(&s, .clearFinishedOperations)
        #expect(s.operations.isEmpty)
    }

    @Test func logIsBounded() throws {
        var op = OperationRecord(plan: plan(steps: 1), dryRun: false, startedAt: t0)
        for i in 0..<(OperationRecord.maxLogLines + 50) {
            try FleetReducer.apply(.stepLog(0, .output, "\(i)"), to: &op, at: t0)
        }
        #expect(op.log.count == OperationRecord.maxLogLines)
        #expect(op.log.last?.text == "\(OperationRecord.maxLogLines + 49)")
    }
}
