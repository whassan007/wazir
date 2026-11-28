import FleetCore
import SwiftUI

enum FlowSource: Hashable {
    case operation(UUID)
    case demo
}

/// Liquid-cooling view of work moving through the fleet: real operations from the command
/// bar, or a multi-agent run (simulated or live) spread across the fleet's models.
///
/// The canvas is interactive: drag empty space to pan, drag blocks or the Prompt pump to
/// move them, pinch to zoom. Clicking the pump picks the machine and model that plans.
struct FlowView: View {
    @Environment(FleetStore.self) private var store
    @State private var source: FlowSource?
    @State private var demo = AgentSimulation()
    @State private var live = LiveAgentRun()
    @State private var liveMode = true
    @State private var selectedNode: String?
    @State private var viewport = FlowViewport()
    @State private var showPlannerPicker = false
    /// The user's planner choice; nil means "pick a sensible default".
    @State private var plannerChoice: FleetWorker?

    private var resolved: FlowSource {
        if let source { return source }
        return .demo
    }

    private func snapshot(clock: Double) -> (FlowGraph, Double) {
        switch resolved {
        case .demo:
            var g = agentRun.graph
            if !liveMode, g.sourceSubtitle.isEmpty { g.sourceSubtitle = planner?.label ?? "" }
            return (g, agentRun.time)
        case .operation(let id):
            guard let op = store.state.operation(id) else { return (.empty, clock) }
            return (FleetFlow.graph(for: op), clock)
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                header
                if resolved == .demo { StageBar(stage: currentStage) }
                TimelineView(.animation) { tl in
                    let clock = tl.date.timeIntervalSinceReferenceDate
                    let (graph, now) = snapshot(clock: clock)
                    VStack(spacing: 0) {
                        FlowCanvas(graph: graph, now: now, clock: clock, selection: $selectedNode,
                                   viewport: $viewport, pumpHint: pumpHint,
                                   showPumpPopover: Binding(get: { showPlannerPicker && resolved == .demo },
                                                            set: { showPlannerPicker = $0 })) {
                            PlannerPicker(models: chatModels, selection: Binding(get: { planner }, set: { setPlanner($0) }),
                                          reviewPlan: Binding(get: { live.reviewPlan }, set: { live.reviewPlan = $0 }),
                                          liveMode: $liveMode, isRunning: agentRun.isRunning)
                        }
                        .overlay(alignment: .bottom) { reviewBanner }
                        .overlay(alignment: .bottomTrailing) { canvasControls }
                        Divider()
                        FlowTimelineStrip(graph: graph, now: now).frame(height: 130)
                    }
                }
            }
            Divider()
            inspector
                .frame(width: 300)
                .background(Color(red: 0.045, green: 0.05, blue: 0.07))
        }
        .background(FlowTheme.background)
        .environment(\.colorScheme, .dark)
        .onChange(of: resolved) { selectedNode = nil }
        .onChange(of: liveMode) { refreshPreview() }
        .onChange(of: planner) { refreshPreview() }
        .onChange(of: live.finalAnswer) { if live.finalAnswer != nil { selectedNode = "result" } }
        .onAppear { refreshPreview() }
    }

    // MARK: Header & canvas chrome

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
        .background(FlowTheme.background)
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

    private var canvasControls: some View {
        HStack(spacing: 2) {
            Button { viewport.zoom(to: viewport.zoom / 1.2, around: .zero) } label: { Image(systemName: "minus.magnifyingglass") }
            Text("\(Int(viewport.zoom * 100))%").font(.caption.monospacedDigit()).frame(width: 40)
            Button { viewport.zoom(to: viewport.zoom * 1.2, around: .zero) } label: { Image(systemName: "plus.magnifyingglass") }
            Divider().frame(height: 14)
            Button("Reset layout") { withAnimation(.snappy) { viewport = FlowViewport() } }
        }
        .buttonStyle(.borderless)
        .font(.caption)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Capsule().fill(.black.opacity(0.45)))
        .padding(10)
    }

    private var pumpHint: String? {
        guard resolved == .demo, !agentRun.isRunning, agentRun.graph.nodes.count <= 1 else { return nil }
        return planner == nil ? "Click to choose a planner machine" : "Click to change the planner"
    }

    @ViewBuilder private var reviewBanner: some View {
        if resolved == .demo, liveMode, live.stage == .review {
            let n = live.agents.filter { $0.node.wave == 1 }.count
            HStack(spacing: 12) {
                Image(systemName: "list.bullet.indent").foregroundStyle(FlowStatus.running.color)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Plan ready: \(n) subtask\(n == 1 ? "" : "s")").font(.system(size: 13, weight: .semibold))
                    Text("Drag blocks to arrange them. Click one to move it to another machine.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button("Run plan") { live.approve() }.buttonStyle(.borderedProminent)
                Button("Cancel") { live.stop() }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(red: 0.07, green: 0.08, blue: 0.11)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(FlowStatus.running.color.opacity(0.4)))
            .padding(.bottom, 54)
        }
    }

    private var currentStage: StageBar.Stage {
        if liveMode {
            switch live.stage {
            case .idle: return .prompt
            case .planning: return .plan
            case .review: return .review
            case .running, .finished:
                if live.finalAnswer != nil { return .result }
                let assembling = ["synth", "critic"].contains { live.agent($0)?.node.status.isActive == true }
                return assembling ? .assemble : (live.stage == .finished ? .result : .run)
            }
        }
        let g = demo.graph
        guard !g.nodes.isEmpty else { return .prompt }
        if g.node("result")?.status == .done { return .result }
        if ["synth", "critic"].contains(where: { g.node($0)?.status.isActive == true }) { return .assemble }
        if g.nodes.count > 1 { return .run }
        return .plan
    }

    // MARK: Inspector

    @ViewBuilder private var inspector: some View {
        VStack(alignment: .leading, spacing: 14) {
            switch resolved {
            case .demo: runControls
            case .operation(let id):
                if let op = store.state.operation(id) { operationSummary(op) }
            }
            Divider()
            nodeDetail
            Spacer(minLength: 0)
        }
        .padding(16)
    }

    private var runControls: some View {
        @Bindable var demo = demo
        return VStack(alignment: .leading, spacing: 10) {
            Picker("Mode", selection: $liveMode) {
                Text("Simulated").tag(false)
                Text("Live").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(agentRun.isRunning)

            Text("Prompt").font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $demo.prompt)
                .font(.system(size: 13))
                .scrollContentBackground(.hidden)
                .padding(6)
                .frame(height: 70)
                .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.05)))

            Button { showPlannerPicker = true } label: {
                HStack {
                    Image(systemName: "cpu")
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Planner").font(.caption2).foregroundStyle(.secondary)
                        Text(planner?.label ?? "Choose a machine…").font(.caption.monospaced()).lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
                }
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 8).fill(.white.opacity(0.05)))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(agentRun.isRunning)

            HStack {
                if liveMode {
                    Button(live.isRunning ? "Restart" : "Run") { runLive() }
                        .buttonStyle(.borderedProminent)
                        .disabled(planner == nil || demo.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Stop") { live.stop(); refreshPreview(keepResults: true) }.disabled(!live.isRunning)
                    Spacer()
                    Toggle("Review plan", isOn: Binding(get: { live.reviewPlan }, set: { live.reviewPlan = $0 }))
                        .toggleStyle(.checkbox).font(.caption)
                } else {
                    Button(demo.isRunning ? "Restart" : "Run") {
                        selectedNode = nil
                        viewport.offsets = [:]
                        let pool = planner.map { [($0.model, $0.host)] } ?? []
                        demo.start(pool: pool + fleetPool.filter { $0.model != planner?.model || $0.host != planner?.host })
                    }
                    .buttonStyle(.borderedProminent)
                    Button(demo.isPaused ? "Resume" : "Pause") { demo.isPaused.toggle() }
                        .disabled(!demo.isRunning)
                    Spacer()
                    Slider(value: $demo.speed, in: 0.25...4).frame(width: 70)
                    Text(String(format: "%.1f×", demo.speed)).font(.caption.monospacedDigit())
                }
            }
            if liveMode {
                let workers = workerPool
                Group {
                    if chatModels.isEmpty {
                        Text("No chat models found on online machines. Refresh, or load a model first.")
                    } else {
                        let hosts = Set(workers.map(\.host)).count
                        Text("Live: the planner splits the prompt, then \(workers.count) model\(workers.count == 1 ? "" : "s") on \(hosts) machine\(hosts == 1 ? "" : "s") work in parallel. Models that aren't loaded are loaded first.")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
                if let problem = live.problem {
                    Text(problem).font(.caption).foregroundStyle(FlowStatus.failed.color)
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

    private func runLive() {
        guard let planner else { showPlannerPicker = true; return }
        selectedNode = nil
        viewport.offsets = viewport.offsets.filter { $0.key == FlowLayout.pumpID }
        live.start(prompt: demo.prompt, planner: planner, workers: workerPool)
    }

    private func refreshPreview(keepResults: Bool = false) {
        guard liveMode, !live.isRunning, !(keepResults || live.stage == .finished) else { return }
        live.preview(planner: planner)
    }

    private func setPlanner(_ w: FleetWorker?) {
        plannerChoice = w
        if liveMode, !live.isRunning { live.preview(planner: w) }
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
                VStack(alignment: .leading, spacing: 8) {
                    if liveMode, live.canReassign(selectedNode), let id = selectedNode {
                        reassignMenu(id: id, current: a.worker)
                    }
                    detailCard(title: a.node.title, status: a.node.status,
                               meta: "\(a.node.subtitle) · attempt \(a.attempt) · \(a.tokens.formatted()) tokens",
                               body: a.task, output: a.output, log: a.log)
                }
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

    private func reassignMenu(id: String, current: FleetWorker?) -> some View {
        Menu {
            ForEach(WorkerPool.byHost(chatModels), id: \.host) { group in
                Menu(group.host) {
                    ForEach(group.models, id: \.self) { w in
                        Button {
                            if id == "planner" { setPlanner(w) } else { live.reassign(id, to: w) }
                        } label: {
                            Text("\(w == current ? "✓ " : "")\(w.model)\(w.isLoaded ? "  ● loaded" : "")")
                        }
                    }
                }
            }
        } label: {
            Label("Run on: \(current?.label ?? "—")", systemImage: "arrow.triangle.swap")
                .font(.caption)
        }
        .menuStyle(.button)
        .fixedSize()
    }

    private var hint: some View {
        Text(resolved == .demo
             ? "Click a block to see its task, output and log. Before it starts, you can move it to another machine."
             : "Click a block to see its task and log.")
            .font(.callout).foregroundStyle(.secondary)
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

    // MARK: Models

    private var agentRun: any AgentRunModel { liveMode ? live : demo }

    private var chatModels: [FleetWorker] { WorkerPool.chatModels(store.orderedHosts) }

    /// The chosen planner if it's still available, else the default pick.
    private var planner: FleetWorker? {
        let models = chatModels
        if let c = plannerChoice, let m = models.first(where: { $0.model == c.model && $0.host == c.host && $0.kind == c.kind }) {
            return m
        }
        return WorkerPool.defaultPlanner(models, localHost: store.config.hosts.first(where: \.isLocal)?.id)
    }

    private var workerPool: [FleetWorker] { WorkerPool.workers(chatModels, memoryGB: memoryByHost) }

    private var memoryByHost: [String: Int] {
        Dictionary(store.config.hosts.compactMap { h in h.memoryGB.map { (h.id, $0) } }, uniquingKeysWith: { a, _ in a })
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

// MARK: - Worker selection

enum WorkerPool {
    static let nonChat = ["embed", "rerank", "whisper", "clip", "bge-", "minilm", "tts", "text_encoder"]
    /// Models the planner picker suggests first: agentic and Nemotron models.
    static let preferredPlanners = ["agentworld", "antigravity", "nemotron"]

    /// Every chat-capable model on an online machine.
    @MainActor
    static func chatModels(_ hosts: [(HostConfig, HostState)]) -> [FleetWorker] {
        var out: [FleetWorker] = []
        for (cfg, hs) in hosts where hs.reachability.isOnline {
            for (kind, m) in hs.allModels {
                let lower = m.name.lowercased()
                guard !nonChat.contains(where: lower.contains), lower != "transformer",
                      let rt = cfg.enabledRuntimes.first(where: { $0.kind == kind }),
                      let base = Endpoint.baseURL(host: cfg, runtime: rt, state: hs) else { continue }
                out.append(FleetWorker(model: m.name, host: cfg.id, kind: kind, base: base,
                                       isLoaded: m.isLoaded, sizeBytes: m.sizeBytes))
            }
        }
        return out
    }

    static func byHost(_ models: [FleetWorker]) -> [(host: String, models: [FleetWorker])] {
        var order: [String] = []
        var groups: [String: [FleetWorker]] = [:]
        for m in models {
            if groups[m.host] == nil { order.append(m.host) }
            groups[m.host, default: []].append(m)
        }
        return order.map { h in (h, groups[h]!.sorted { rank($0) < rank($1) }) }
    }

    /// Lower is better: loaded first, then suggested planners, then name.
    static func rank(_ w: FleetWorker) -> (Int, Int, String) {
        let lower = w.model.lowercased()
        return (w.isLoaded ? 0 : 1, preferredPlanners.contains(where: lower.contains) ? 0 : 1, lower)
    }

    static func isSuggested(_ w: FleetWorker) -> Bool {
        let lower = w.model.lowercased()
        return preferredPlanners.contains(where: lower.contains)
    }

    /// The local machine's best model: a loaded agentic/Nemotron model, else any loaded one.
    static func defaultPlanner(_ models: [FleetWorker], localHost: String?) -> FleetWorker? {
        let local = models.filter { $0.host == localHost }
        let pool = local.isEmpty ? models : local
        return pool.min { rank($0) < rank($1) }
    }

    /// Parallel workers: per machine, its loaded models; if none are loaded, its smallest model
    /// that fits in memory. Interleaved across machines, at most 8.
    static func workers(_ models: [FleetWorker], memoryGB: [String: Int]) -> [FleetWorker] {
        var perHost: [[FleetWorker]] = []
        for (host, list) in byHost(models) {
            let loaded = list.filter(\.isLoaded)
            if !loaded.isEmpty { perHost.append(loaded); continue }
            let limit = memoryGB[host].map { Int64($0) * 1_000_000_000 * 6 / 10 }
            let fits = list.filter { m in
                guard let s = m.sizeBytes else { return false }
                return limit.map { s <= $0 } ?? true
            }
            if let smallest = fits.min(by: { ($0.sizeBytes ?? 0) < ($1.sizeBytes ?? 0) }) { perHost.append([smallest]) }
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
}

// MARK: - Planner picker (popover on the Prompt pump)

struct PlannerPicker: View {
    var models: [FleetWorker]
    @Binding var selection: FleetWorker?
    @Binding var reviewPlan: Bool
    @Binding var liveMode: Bool
    var isRunning: Bool
    @State private var host: String?
    @State private var filter = ""

    var body: some View {
        let groups = WorkerPool.byHost(models)
        let activeHost = host ?? selection?.host ?? groups.first?.host
        VStack(alignment: .leading, spacing: 10) {
            Text("Who breaks down the prompt?").font(.headline)
            Text("The planner splits your prompt into subtasks. Workers on other machines then run them in parallel.")
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if groups.isEmpty {
                Text("No online machine has a chat model. Refresh the fleet, or start a runtime.")
                    .font(.callout).foregroundStyle(.secondary)
            } else {
                Picker("Machine", selection: Binding(get: { activeHost ?? "" }, set: { host = $0 })) {
                    ForEach(groups, id: \.host) { g in
                        Text("\(g.host)  (\(g.models.count))").tag(g.host)
                    }
                }
                TextField("Filter models", text: $filter).textFieldStyle(.roundedBorder)
                let list = (groups.first { $0.host == activeHost }?.models ?? [])
                    .filter { filter.isEmpty || $0.model.localizedCaseInsensitiveContains(filter) }
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(list, id: \.self) { w in row(w) }
                    }
                }
                .frame(height: min(300, CGFloat(max(list.count, 1)) * 34))
            }
            Divider()
            Toggle("Pause to review the plan before running it", isOn: $reviewPlan).font(.caption)
            Picker("", selection: $liveMode) {
                Text("Simulated").tag(false)
                Text("Live").tag(true)
            }
            .pickerStyle(.segmented)
            .disabled(isRunning)
        }
        .padding(16)
        .frame(width: 360)
        .environment(\.colorScheme, .dark)
    }

    private func row(_ w: FleetWorker) -> some View {
        let selected = w == selection
        return Button { selection = w } label: {
            HStack(spacing: 8) {
                Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(selected ? FlowStatus.running.color : .secondary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(w.model).font(.system(size: 12, design: .monospaced)).lineLimit(1)
                    HStack(spacing: 6) {
                        Text(w.kind.displayName)
                        if let s = w.sizeBytes { Text(ByteCountFormatter.string(fromByteCount: s, countStyle: .file)) }
                    }
                    .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                if WorkerPool.isSuggested(w) {
                    Text("agentic").font(.caption2)
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(Color.purple.opacity(0.3)))
                }
                if w.isLoaded {
                    Text("loaded").font(.caption2).foregroundStyle(FlowStatus.done.color)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.08) : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Stage bar

/// Prompt → Plan → Review → Run → Assemble → Result, with the current stage lit.
struct StageBar: View {
    enum Stage: Int, CaseIterable {
        case prompt, plan, review, run, assemble, result
        var label: String {
            switch self {
            case .prompt: "Prompt"
            case .plan: "Break down"
            case .review: "Review"
            case .run: "Run in parallel"
            case .assemble: "Assemble"
            case .result: "Result"
            }
        }
    }
    var stage: Stage

    var body: some View {
        HStack(spacing: 6) {
            ForEach(Stage.allCases, id: \.self) { s in
                let state: FlowStatus = s.rawValue < stage.rawValue ? .done : (s == stage ? .running : .queued)
                HStack(spacing: 5) {
                    Circle().fill(state.color.opacity(state == .queued ? 0.4 : 1)).frame(width: 7, height: 7)
                    Text(s.label).font(.caption.weight(s == stage ? .semibold : .regular))
                        .foregroundStyle(state == .queued ? Color.secondary : Color.primary)
                }
                if s != .result {
                    Rectangle().fill(state == .done ? FlowStatus.done.color.opacity(0.6) : .white.opacity(0.1))
                        .frame(height: 1.5).frame(maxWidth: 40)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
        .background(FlowTheme.background)
    }
}
