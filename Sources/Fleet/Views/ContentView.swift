import FleetCore
import SwiftUI

struct ContentView: View {
    @Environment(FleetStore.self) private var store

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 220, ideal: 250)
        } detail: {
            VStack(spacing: 0) {
                CommandBar()
                Divider()
                if let err = store.configError {
                    Banner(kind: .error, text: "Config error, using last good config: \(err)")
                } else if let notice = store.configNotice {
                    Banner(kind: .info, text: notice)
                }
                detail
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                ModeIndicator()
                Button {
                    Task { await store.refreshAll() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .help("Refresh all hosts (⌘R)")
                .disabled(store.isRefreshing)
            }
        }
        .sheet(item: $store.pendingPlan) { plan in
            PlanSheet(plan: plan)
        }
    }

    @ViewBuilder private var detail: some View {
        switch store.selection ?? .overview {
        case .overview: OverviewView()
        case .activity: ActivityView()
        case .flow: FlowView()
        case .host(let id):
            if let cfg = store.config.host(id: id), let hs = store.state.hosts[id] {
                HostDetailView(host: cfg, state: hs)
            } else {
                ContentUnavailableView("Host removed", systemImage: "questionmark.circle")
            }
        }
    }
}

struct ModeIndicator: View {
    @Environment(FleetStore.self) private var store
    var body: some View {
        let dry = store.config.dryRunByDefault
        Chip(text: dry ? "Dry-run default" : "Live default", color: dry ? .blue : .orange,
             systemImage: dry ? "shield.lefthalf.filled" : "bolt.fill")
            .help(dry ? "Plans default to dry-run. Choose Live in the plan sheet or add --live." :
                "Plans default to live execution (still confirmed). Change in Settings.")
    }
}

struct Banner: View {
    var kind: CommandMessage.Kind
    var text: String
    var body: some View {
        HStack(alignment: .top) {
            Image(systemName: kind == .error ? "exclamationmark.triangle.fill" : "info.circle")
            Text(text).textSelection(.enabled)
            Spacer()
        }
        .font(.callout)
        .padding(8)
        .background(kind == .error ? Color.red.opacity(0.12) : Color.blue.opacity(0.08))
        .foregroundStyle(kind == .error ? .red : .primary)
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @Environment(FleetStore.self) private var store

    var body: some View {
        @Bindable var store = store
        List(selection: $store.selection) {
            Section("Fleet") {
                Label("Overview", systemImage: "square.grid.2x2")
                    .badge("\(store.state.onlineCount)/\(store.state.hostOrder.count)")
                    .tag(SidebarItem.overview)
                Label("Activity", systemImage: "list.bullet.rectangle")
                    .badge(store.state.runningOperations.count)
                    .tag(SidebarItem.activity)
                Label("Flow", systemImage: "drop.halffull")
                    .tag(SidebarItem.flow)
            }
            Section("Machines") {
                ForEach(store.orderedHosts, id: \.0.id) { cfg, hs in
                    HostRow(host: cfg, state: hs).tag(SidebarItem.host(cfg.id))
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            HStack {
                if store.isRefreshing { ProgressView().controlSize(.small) }
                RelativeTime(date: store.lastFullRefresh, prefix: "Updated ")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            .padding(10)
        }
    }
}

struct HostRow: View {
    var host: HostConfig
    var state: HostState

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(color: state.reachability.color, pulsing: state.isProbing)
            VStack(alignment: .leading, spacing: 1) {
                Text(host.name).lineLimit(1)
                Text("\(host.id) · \(state.reachability.shortLabel)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if state.loadedCount > 0 {
                Image(systemName: "bolt.fill").foregroundStyle(.green).imageScale(.small)
                    .help("\(state.loadedCount) model(s) loaded")
            }
            if state.modelCount > 0 {
                Text("\(state.modelCount)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
