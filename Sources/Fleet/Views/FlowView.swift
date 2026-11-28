import FleetCore
import SwiftUI

enum FlowSource: Hashable {
    case operation(UUID)
    case demo
}

/// Liquid-cooling view of work moving through the fleet: real operations from the command
/// bar, or a simulated multi-agent run spread across the fleet's models.
struct FlowView: View {
    @Environment(FleetStore.self) private var store
    @State private var source: FlowSource?
    @State private var demo = AgentSimulation()
    @State private var live = LiveAgentRun()
    @State private var liveMode = false
    @State private var selectedNode: String?

    private var resolved: FlowSource {
        if let source { return source }
        if let id = store.selectedOperation ?? store.state.operations.first?.id { return .operation(id) }
        return .demo
    }

    private func snapshot(clock: Double) -> (FlowGraph, Double) {
        switch resolved {
        case .demo: return (agentRun.graph, agentRun.time)
        case .operation(let id):
            guard let op = store.state.operation(id) else { return (.empty, clock) }
            return (FleetFlow.graph(for: op), clock)
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                header
                TimelineView(.animation) { tl in
                    let clock = tl.date.timeIntervalSinceReferenceDate
                    let (graph, now) = snapshot(clock: clock)
                    VStack(spacing: 0) {
                        FlowCanvas(graph: graph, now: now, clock: clock, selection: $selectedNode)
                        Divider()
                        FlowTimelineStrip(graph: graph, now: now).frame(height: 130)
                    }
                }
            }
            Divider()
            inspector
                .frame(width: 290)
                .background(Color(red: 0.045, green: 0.05, blue: 0.07))
        }
        .background(FlowCanvas.background)
        .environment(\.colorScheme, .dark)
        .onChange(of: resolved) { selectedNode = nil }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            Picker("Source", selection: Binding(get: { resolved }, set: { source = $0 })) {
                Text(liveMode ? "Agent run (live)" : "Agent run (simulated)").tag(FlowSource.demo)
                if !store.state.operations.isEmpty {
                    Divider()
                    ForEach(store.state.operations) { op in
                        Text("\(op.dryRun ? "[dry] " : "")\(op.plan.summary)").tag(FlowSource.operation(op.id))
                    }
                }
            }
            .frame(maxWidth: 420)
            Spacer()
            legend
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(FlowCanvas.background)
    }

    private var legend: some View {
        HStack(spacing: 12) {
            ForEach([FlowStatus.running, .done, .retrying, .failed], id: \.label) { s in
                HStack(spacing: 4) {
                    Circle().fill(s.color).frame(width: 7, height: 7)
                    Text(s.label).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: Inspector

    @ViewBuilder private var inspector: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch resolved {
            case .demo: demoControls
            case .operation(let id):
                if let op = store.state.operation(id) { operationSummary(op) }
            }
            Divider()
            nodeDetail
            Spacer(minLength: 0)
        }
        .padding(16)
    }

    private var demoControls: some View {
        @Bindable var demo = demo
        return VStack(alignment: .leading, spacing: 10) {
            Text("Prompt").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $demo.prompt)
                .font(.system(size: 13))
                .scrollContentBackground(.hidden)
                .padding(6)
                .frame(height: 70)
                .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.05)))
            Picker("Mode", selection: $liveMode) {
                Text("Simulated").tag(false)
                Text("Live").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(agentRun.isRunning)
            HStack {
                if liveMode {
                    let workers = liveWorkers
                    Button(live.isRunning ? "Restart" : "Run") {
                        selectedNode = nil
                        live.start(prompt: demo.prompt, workers: workers)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(workers.isEmpty || demo.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Stop") { live.stop() }.disabled(!live.isRunning)
                    Spacer()
                } else {
                    Button(demo.isRunning ? "Restart" : "Run") { selectedNode = nil; demo.start(pool: fleetPool) }
                        .buttonStyle(.borderedProminent)
                    Button(demo.isPaused ? "Resume" : "Pause") { demo.isPaused.toggle() }
                        .disabled(!demo.isRunning)
                    Spacer()
                    Slider(value: $demo.speed, in: 0.25...4).frame(width: 70)
                    Text(String(format: "%.1f×", demo.speed)).font(.caption.monospacedDigit())
                }
            }
            if liveMode {
                let workers = liveWorkers
                Group {
                    if workers.isEmpty {
                        Text("No chat models found on online machines. Refresh, or load a model first.")
                    } else {
                        Text("Live: sends the prompt to \(workers.count) model\(workers.count == 1 ? "" : "s") on \(Set(workers.map(\.host)).count) machine\(Set(workers.map(\.host)).count == 1 ? "" : "s"). Models that aren't loaded will be loaded first.")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
                if let problem = live.problem {
                    Text(problem).font(.caption).foregroundStyle(FlowStatus.failed.color)
                }
                if live.finalAnswer != nil {
                    Button("Show answer") { selectedNode = "result" }.font(.caption)
                }
            } else {
                Text("Simulated: nothing is sent to your machines. Workers are assigned to models on the fleet.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            let run = agentRun
            let g = run.graph
            statGrid([("Agents", "\(g.nodes.count)"),
                      ("Running", "\(g.nodes.filter { $0.status.isActive }.count)"),
                      ("Done", "\(g.nodes.filter { $0.status == .done }.count)/\(g.nodes.count)"),
                      ("Retries", "\(run.retries)"),
                      ("Tokens", String(format: "%.1fk", Double(run.totalTokens) / 1000)),
                      ("Elapsed", String(format: "%.1fs", run.time))])
        }
    }

    private func operationSummary(_ op: OperationRecord) -> some View {
        let done = op.steps.values.filter { if case .succeeded = $0 { true } else { false } }.count
        let failed = op.steps.values.filter { if case .failed = $0 { true } else { false } }.count
        let elapsed = (op.finishedAt ?? Date()).timeIntervalSince(op.startedAt)
        return VStack(alignment: .leading, spacing: 10) {
            Text(op.plan.input).font(.system(size: 13, design: .monospaced)).textSelection(.enabled)
            HStack {
                Text(op.dryRun ? "Dry run" : "Live").font(.caption)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill((op.dryRun ? Color.blue : Color.orange).opacity(0.2)))
                Text(op.phase.label).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if op.phase == .running {
                    Button("Cancel") { store.cancel(op.id) }
                }
            }
            statGrid([("Steps", "\(op.plan.steps.count)"),
                      ("Done", "\(done)/\(op.plan.steps.count)"),
                      ("Failed", "\(failed)"),
                      ("Elapsed", String(format: "%.1fs", elapsed))])
        }
    }

    @ViewBuilder private var nodeDetail: some View {
        switch resolved {
        case .demo:
            if let a = agentRun.agent(selectedNode) {
                detailCard(title: a.node.title, status: a.node.status,
                           meta: "\(a.node.subtitle) · attempt \(a.attempt) · \(a.tokens.formatted()) tokens",
                           body: a.task, output: a.output, log: a.log)
            } else { hint }
        case .operation(let id):
            if let op = store.state.operation(id), let sel = selectedNode,
               let step = op.plan.steps.first(where: { "step-\($0.id)" == sel }) {
                let node = FleetFlow.graph(for: op).node(sel)
                detailCard(title: step.title, status: node?.status ?? .queued,
                           meta: "\(step.hostName) · \(step.runtime.displayName)",
                           body: step.detail,
                           log: op.log.filter { $0.stepID == step.id }.suffix(40).map(\.text))
            } else { hint }
        }
    }

    private var hint: some View {
        Text("Click a block to see its task and log.").font(.callout).foregroundStyle(.secondary)
    }

    private func detailCard(title: String, status: FlowStatus, meta: String, body: String, output: String = "",
                            log: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.headline).lineLimit(2)
                Spacer()
                Text(status.label).font(.caption).foregroundStyle(status.color)
            }
            Text(meta).font(.caption.monospaced()).foregroundStyle(.secondary)
            Text(body).font(.callout).textSelection(.enabled)
            ScrollView {
                VStack(alignment: .leading, spacing: 3) {
                    if !output.isEmpty {
                        HStack {
                            Text("Output").font(.caption2).foregroundStyle(.secondary)
                            Spacer()
                            Button("Copy") {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(output, forType: .string)
                            }
                            .buttonStyle(.borderless).font(.caption2)
                        }
                        Text(output).font(.callout).textSelection(.enabled)
                            .padding(.bottom, 8)
                        Text("Log").font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(Array(log.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func statGrid(_ items: [(String, String)]) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
            ForEach(items, id: \.0) { label, value in
                VStack(alignment: .leading, spacing: 2) {
                    Text(label).font(.caption2).foregroundStyle(.secondary)
                    Text(value).font(.system(size: 16, weight: .semibold).monospacedDigit())
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.05)))
            }
        }
    }

    private var agentRun: any AgentRunModel { liveMode ? live : demo }

    /// Chat-capable models on online machines: each machine's loaded models first, interleaved
    /// across machines so parallel workers land on different hardware.
    private var liveWorkers: [FleetWorker] {
        let nonChat = ["embed", "rerank", "whisper", "clip", "bge-", "minilm", "tts"]
        var perHost: [[FleetWorker]] = []
        for (cfg, hs) in store.orderedHosts where hs.reachability.isOnline {
            var list: [FleetWorker] = []
            for (kind, m) in hs.allModels {
                let lower = m.name.lowercased()
                guard !nonChat.contains(where: lower.contains),
                      let rt = cfg.enabledRuntimes.first(where: { $0.kind == kind }),
                      let base = Endpoint.baseURL(host: cfg, runtime: rt, state: hs) else { continue }
                list.append(FleetWorker(model: m.name, host: cfg.id, kind: kind, base: base, isLoaded: m.isLoaded))
            }
            list.sort { $0.isLoaded && !$1.isLoaded }
            if !list.isEmpty { perHost.append(list) }
        }
        perHost.sort { ($0.first?.isLoaded ?? false) && !($1.first?.isLoaded ?? false) }
        var out: [FleetWorker] = []
        var round = 0
        while out.count < 8, perHost.contains(where: { round < $0.count }) {
            for list in perHost where round < list.count && out.count < 8 { out.append(list[round]) }
            round += 1
        }
        return out
    }

    /// (model, host) pairs from the fleet's inventory, loaded models first.
    private var fleetPool: [(model: String, host: String)] {
        var loaded: [(String, String)] = [], other: [(String, String)] = []
        for (cfg, hs) in store.orderedHosts where hs.reachability.isOnline {
            for (_, m) in hs.allModels {
                if m.isLoaded { loaded.append((m.name, cfg.id)) } else { other.append((m.name, cfg.id)) }
            }
        }
        return Array((loaded + other).prefix(8))
    }
}
