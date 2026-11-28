import FleetCore
import SwiftUI

struct OverviewView: View {
    @Environment(FleetStore.self) private var store
    @State private var groupByMachine = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                summary
                if !store.orderedCloudServices.isEmpty {
                    HStack {
                        Text("Frontier Cloud Services & Budgets").font(.headline)
                        Spacer()
                        Button("Manage Plans & Login") { store.selection = .cloudServices }
                            .buttonStyle(.borderless).font(.caption)
                    }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 12)], spacing: 12) {
                        ForEach(store.orderedCloudServices, id: \.0.id) { cfg, snap in
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    StatusDot(color: (snap?.isAuthenticated ?? false) ? .green : .orange)
                                    Text(cfg.displayName).font(.subheadline.weight(.semibold))
                                    Spacer()
                                    Text("$\(Int(cfg.totalBudgetCeilingUSD))").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                }
                                Text("\(snap?.discoveredModels.count ?? 0) frontier models · \(cfg.planName)")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(10)
                            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
                            .onTapGesture { store.selection = .cloudServices }
                        }
                    }
                }
                if let ts = store.state.tailscaleError {
                    Label("Tailscale status unavailable: \(ts)", systemImage: "network.slash")
                        .font(.caption).foregroundStyle(.orange)
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: 14)], spacing: 14) {
                    ForEach(store.orderedHosts, id: \.0.id) { cfg, hs in
                        HostCard(host: cfg, state: hs)
                            .onTapGesture { store.selection = .host(cfg.id) }
                    }
                }
                workloadRoutingSection
            }
            .padding(16)
        }
    }

    private var workloadRoutingSection: some View {
        let engine = WorkloadFallbackChainEngine()
        let onlineIDs = Set(store.orderedHosts.filter { $0.1.reachability.isOnline }.map(\.0.id))
        let cloudIDs = Set(store.orderedCloudServices.filter { $0.1?.isAuthenticated == true }.map(\.0.id))
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Workload Fallback Chains").font(.headline)
                Spacer()
                Picker("Group", selection: $groupByMachine) {
                    Text("By Activity").tag(false)
                    Text("By Machine").tag(true)
                }
                .pickerStyle(.segmented)
                .frame(width: 220)
            }
            if groupByMachine {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 280), spacing: 10)], spacing: 10) {
                    ForEach(engine.groupByMachine(), id: \.hostOrProviderID) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.hostOrProviderID).font(.subheadline.weight(.semibold))
                            ForEach(item.roles.prefix(4)) { role in
                                Text("#\(role.rank) \(role.activity.rawValue)")
                                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            } else {
                ForEach(WorkloadFallbackChain.defaultChains) { chain in
                    let resolved = engine.resolve(activity: chain.activity, onlineHostIDs: onlineIDs, authenticatedCloudIDs: cloudIDs)
                    HStack(spacing: 8) {
                        Text(chain.activity.rawValue).font(.caption.weight(.medium)).frame(width: 210, alignment: .leading)
                        if let sel = resolved.selectedSlot {
                            Chip(text: "#\(sel.rank) \(sel.displayName)", color: sel.rank == 1 ? .green : .orange)
                        } else {
                            Chip(text: "No online slot", color: .red)
                        }
                        Spacer()
                        Text("\(resolved.fallbackQueue.count) fallbacks").font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 3)
                }
            }
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }

    private var summary: some View {
        let hosts = store.state.hosts.values
        let models = hosts.reduce(0) { $0 + $1.modelCount }
        let loaded = hosts.reduce(0) { $0 + $1.loadedCount }
        return HStack(spacing: 12) {
            Stat(title: "Online", value: "\(store.state.onlineCount) / \(store.state.hostOrder.count)", symbol: "dot.radiowaves.left.and.right")
            Stat(title: "Models", value: "\(models)", symbol: "shippingbox")
            Stat(title: "Loaded", value: "\(loaded)", symbol: "bolt.fill")
            Stat(title: "Running ops", value: "\(store.state.runningOperations.count)", symbol: "gearshape.2")
        }
    }
}

struct Stat: View {
    var title: String
    var value: String
    var symbol: String
    var body: some View {
        HStack {
            Image(systemName: symbol).font(.title3).foregroundStyle(.secondary).frame(width: 26)
            VStack(alignment: .leading) {
                Text(value).font(.title2.weight(.semibold).monospacedDigit())
                Text(title).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(12)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct HostCard: View {
    var host: HostConfig
    var state: HostState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                StatusDot(color: state.reachability.color, pulsing: state.isProbing, size: 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text(host.name).font(.headline).lineLimit(1)
                    Text(([host.id] + host.aliases.prefix(2)).joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                Image(systemName: host.os.symbol).foregroundStyle(.secondary).help(host.os.displayName)
            }

            HStack(spacing: 10) {
                Label(host.tailscaleIP ?? host.lanIP ?? "—", systemImage: "network")
                    .font(.caption.monospaced())
                Spacer()
                statusText.font(.caption).foregroundStyle(.secondary)
            }

            HStack(spacing: 4) {
                ForEach(host.enabledRuntimes) { rt in
                    let rs = state.runtimes[rt.kind]
                    Chip(text: rt.kind.displayName + (rs.map { $0.models.isEmpty ? "" : " \($0.models.count)" } ?? ""),
                         color: rs?.color ?? .gray)
                        .help(runtimeHelp(rs))
                }
                Spacer()
            }

            if let m = state.metrics, state.reachability.isOnline {
                HStack(spacing: 12) {
                    MeterBar(label: "Mem", fraction: m.memoryUsedFraction, detail: m.memoryUsedFraction.map { "\(Int($0 * 100))%" } ?? "—")
                    MeterBar(label: "CPU", fraction: m.loadFraction, detail: m.load1.map { String(format: "%.1f", $0) } ?? "—")
                    if let g = m.gpus.first {
                        MeterBar(label: "GPU", fraction: g.utilizationPercent.map { $0 / 100 },
                                 detail: [g.utilizationPercent.map { "\(Int($0))%" }, g.temperatureC.map { "\(Int($0))°" }]
                                    .compactMap { $0 }.joined(separator: " "))
                    }
                }
            }

            let loaded = state.allModels.filter { $0.1.isLoaded }
            if !loaded.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(loaded.prefix(3), id: \.1.name) { kind, m in
                        Label("\(m.name)", systemImage: "bolt.fill")
                            .font(.caption).foregroundStyle(.green).lineLimit(1)
                            .help("Loaded in \(kind.displayName)")
                    }
                    if loaded.count > 3 { Text("+\(loaded.count - 3) more loaded").font(.caption2).foregroundStyle(.secondary) }
                }
            } else if state.modelCount > 0 {
                Text("\(state.modelCount) models available, none loaded").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(state.reachability.color.opacity(0.35)))
        .contentShape(Rectangle())
        .opacity(state.reachability.isOnline || state.reachability == .unknown ? 1 : 0.75)
    }

    @ViewBuilder private var statusText: some View {
        switch state.reachability {
        case .online(let ms, _):
            Text(ms < 1 ? "local" : String(format: "%.0f ms", ms))
        case .offline:
            RelativeTime(date: state.lastSeen, prefix: "offline · seen ")
        case .unknown:
            Text(state.isProbing ? "probing…" : "not probed")
        }
    }

    private func runtimeHelp(_ rs: RuntimeState?) -> String {
        guard let rs else { return "" }
        switch rs.status {
        case .online: return "\(rs.kind.displayName) online" + (rs.version.map { " v\($0)" } ?? "")
        case .unreachable(let e): return e + (rs.isStale ? " (showing last-known models)" : "")
        case .unknown: return "Not checked yet"
        }
    }
}
