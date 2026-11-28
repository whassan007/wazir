import FleetCore
import SwiftUI

struct HostDetailView: View {
    @Environment(FleetStore.self) private var store
    var host: HostConfig
    var state: HostState

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                infoGrid
                if host.collectMetrics { metricsSection }
                ForEach(host.enabledRuntimes) { rt in
                    RuntimeSection(host: host, runtime: rt, state: state.runtimes[rt.kind] ?? RuntimeState(kind: rt.kind),
                                   baseURL: Endpoint.baseURL(host: host, runtime: rt, state: state))
                }
                if host.enabledRuntimes.isEmpty {
                    ContentUnavailableView("No runtimes configured", systemImage: "shippingbox",
                                           description: Text("Add Ollama, LM Studio, llama.cpp or MLX in Settings → Hosts."))
                }
            }
            .padding(18)
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            StatusDot(color: state.reachability.color, pulsing: state.isProbing, size: 14)
            VStack(alignment: .leading, spacing: 2) {
                Text(host.name).font(.title.weight(.semibold))
                Text([host.role, host.hardware].compactMap { $0 }.joined(separator: " · "))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                Task { await store.refresh(host.id) }
            } label: {
                Label(state.isProbing ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
            }
            .disabled(state.isProbing)
        }
    }

    private var infoGrid: some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 6) {
            row("Status") {
                switch state.reachability {
                case .online(let ms, let addr):
                    Text(ms < 1 ? "Online (this Mac)" : String(format: "Online · %.1f ms via %@", ms, addr))
                case .offline(let reason): Text("Offline: \(reason)").foregroundStyle(.red)
                case .unknown: Text(state.isProbing ? "Probing…" : "Not probed yet")
                }
            }
            row("Last seen") { RelativeTime(date: state.lastSeen) }
            row("Aliases") { Text(([host.id] + host.aliases).joined(separator: ", ")).textSelection(.enabled) }
            row("OS") { Label(host.os.displayName, systemImage: host.os.symbol) }
            if let ip = host.tailscaleIP { row("Tailscale") { HStack { CopyableText(text: ip); tailscaleBadge } } }
            if let ip = host.lanIP { row("LAN") { CopyableText(text: ip) } }
            row("SSH") { host.sshTarget.map { AnyView(CopyableText(text: "ssh \($0)")) } ?? AnyView(Text("not configured").foregroundStyle(.secondary)) }
            if let gb = host.memoryGB { row("Memory") { Text("\(gb) GB") } }
        }
        .font(.callout)
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder private var tailscaleBadge: some View {
        if let ts = state.tailscale {
            Chip(text: ts.online ? "tailnet online" : "tailnet offline", color: ts.online ? .green : .orange)
                .help("Tailscale name: \(ts.hostName)")
        }
    }

    private func row<V: View>(_ label: String, @ViewBuilder _ value: () -> V) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            value()
        }
    }

    @ViewBuilder private var metricsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Resources").font(.headline)
                Spacer()
                if let d = state.metricsUpdated { RelativeTime(date: d).font(.caption).foregroundStyle(.secondary) }
            }
            if let m = state.metrics {
                HStack(spacing: 18) {
                    MeterBar(label: "Memory", fraction: m.memoryUsedFraction, detail: m.memoryDetail)
                    MeterBar(label: "CPU load (1m)", fraction: m.loadFraction, detail: m.loadDetail)
                }
                ForEach(Array(m.gpus.enumerated()), id: \.offset) { _, g in
                    HStack(spacing: 18) {
                        MeterBar(label: g.name, fraction: g.utilizationPercent.map { $0 / 100 },
                                 detail: g.utilizationPercent.map { "\(Int($0))% util" } ?? "util n/a")
                        MeterBar(label: "VRAM", fraction: vramFraction(g),
                                 detail: g.memoryTotalMB == nil ? "unified memory" :
                                    "\(Int(g.memoryUsedMB ?? 0)) / \(Int(g.memoryTotalMB!)) MB")
                        Text(g.temperatureC.map { "\(Int($0)) °C" } ?? "—")
                            .font(.callout.monospacedDigit()).frame(width: 60)
                    }
                }
                HStack(spacing: 14) {
                    if let os = m.osVersion { Text(os) }
                    if let chip = m.chip { Text(chip) }
                    if let up = m.uptimeSeconds { Text("up \(Format.relative(Date().addingTimeInterval(-Double(up))).replacingOccurrences(of: " ago", with: ""))") }
                }
                .font(.caption).foregroundStyle(.secondary)
            } else if let e = state.metricsError {
                Label(e, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
            } else if host.sshTarget == nil && !host.isLocal {
                Text("Set an SSH target to collect CPU/memory/GPU metrics.").font(.caption).foregroundStyle(.secondary)
            } else {
                Text(state.reachability.isOnline ? "Collecting…" : "Unavailable while offline").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
    }

    private func vramFraction(_ g: GPUMetrics) -> Double? {
        guard let u = g.memoryUsedMB, let t = g.memoryTotalMB, t > 0 else { return nil }
        return u / t
    }
}

struct RuntimeSection: View {
    @Environment(FleetStore.self) private var store
    var host: HostConfig
    var runtime: RuntimeConfig
    var state: RuntimeState
    var baseURL: URL?
    @State private var showingAdd = false
    @State private var newModel = ""
    @State private var selectedModel: ModelInfo.ID?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                StatusDot(color: state.color)
                Text(runtime.kind.displayName).font(.headline)
                if let v = state.version { Text("v\(v)").font(.caption).foregroundStyle(.secondary) }
                if let u = baseURL { CopyableText(text: u.absoluteString).font(.caption.monospaced()).foregroundStyle(.secondary) }
                if state.isStale { Chip(text: "stale", color: .orange, systemImage: "clock") }
                Spacer()
                if let d = state.lastUpdated { RelativeTime(date: d).font(.caption).foregroundStyle(.secondary) }
                Button {
                    showingAdd = true
                } label: {
                    Label("Add Model", systemImage: "plus")
                }
                .popover(isPresented: $showingAdd, arrowEdge: .bottom) { addPopover }
            }
            if case .unreachable(let e) = state.status {
                Label(e, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(state.isStale ? .orange : .red)
            }
            if state.models.isEmpty {
                Text(state.status == .online ? "No models installed." : "No inventory yet.")
                    .font(.callout).foregroundStyle(.secondary).padding(.vertical, 6)
            } else {
                modelTable
            }
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
    }

    private var modelTable: some View {
        Table(state.models, selection: $selectedModel) {
            TableColumn("Model") { m in
                HStack(spacing: 6) {
                    if m.isLoaded { Image(systemName: "bolt.fill").foregroundStyle(.green).help("Loaded in memory") }
                    Text(m.name).font(.body.monospaced()).textSelection(.enabled)
                }
            }
            .width(min: 220, ideal: 320)
            TableColumn("Params") { m in Text(m.parameterSize ?? "—") }.width(70)
            TableColumn("Quant") { m in Text(m.quantization ?? "—") }.width(90)
            TableColumn("Size") { m in Text(m.sizeBytes.map(Format.bytes) ?? "—").monospacedDigit() }.width(80)
            TableColumn("VRAM") { m in Text(m.vramBytes.map(Format.bytes) ?? (m.isLoaded ? "loaded" : "—")).monospacedDigit() }.width(80)
            TableColumn("Modified") { m in Text(m.modifiedAt.map { Format.relative($0) } ?? "—") }.width(80)
        }
        .contextMenu(forSelectionType: ModelInfo.ID.self) { ids in
            if let name = ids.first {
                Button("Reload \(name)") { store.prepare(.reload, model: name, host: host.id, runtime: runtime.kind) }
                Button("Update \(name)") { store.prepare(.update, model: name, host: host.id, runtime: runtime.kind) }
                Divider()
                Button("Remove \(name)…", role: .destructive) { store.prepare(.remove, model: name, host: host.id, runtime: runtime.kind) }
                Divider()
                Button("Copy Name") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(name, forType: .string)
                }
            }
        }
        .frame(height: min(360, CGFloat(state.models.count) * 26 + 32))
    }

    private var addPopover: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Add model to \(host.name) · \(runtime.kind.displayName)").font(.headline)
            TextField(runtime.kind == .ollama ? "e.g. qwen2.5:7b" : "e.g. org/repo or org/repo:Q4_K_M", text: $newModel)
                .textFieldStyle(.roundedBorder)
                .font(.body.monospaced())
                .frame(width: 320)
                .onSubmit(plan)
            HStack {
                Spacer()
                Button("Cancel") { showingAdd = false }
                Button("Plan…", action: plan).keyboardShortcut(.defaultAction)
                    .disabled(newModel.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(14)
    }

    private func plan() {
        let m = newModel.trimmingCharacters(in: .whitespaces)
        guard !m.isEmpty else { return }
        showingAdd = false
        newModel = ""
        store.prepare(.add, model: m, host: host.id, runtime: runtime.kind)
    }
}
