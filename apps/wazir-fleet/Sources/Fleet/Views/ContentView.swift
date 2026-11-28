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
                ProjectHeaderBar()
                Divider()
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
        .sheet(isPresented: $store.showPromptComposer) {
            PromptComposerView().environment(store).frame(width: 760, height: 580)
        }
        .navigationTitle("Fleet — \(URL(fileURLWithPath: store.projectFolderPath).lastPathComponent) [\(store.selectedTargetBranch)]")
    }

    @ViewBuilder private var detail: some View {
        switch store.selection ?? .overview {
        case .overview: OverviewView()
        case .cloudServices: CloudServicesView()
        case .activity: ActivityView()
        case .flow: FlowView()
        case .studio: VisualOrchestrationStudioView()
        case .host(let id):
            if let cfg = store.config.host(id: id), let hs = store.state.hosts[id] {
                HostDetailView(host: cfg, state: hs)
            } else {
                ContentUnavailableView("Host removed", systemImage: "questionmark.circle")
            }
        }
    }
}

struct ProjectHeaderBar: View {
    @Environment(FleetStore.self) private var store

    var body: some View {
        @Bindable var store = store
        let name = URL(fileURLWithPath: store.projectFolderPath).lastPathComponent
        HStack(spacing: 10) {
            Image(systemName: "folder.fill.badge.gearshape")
                .foregroundStyle(Color.accentColor)
            Text(name.isEmpty ? "No Project" : name)
                .font(.headline)
            Text(store.projectFolderPath)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let ctx = store.projectContext {
                Button {
                    store.showBranchesPopover = true
                } label: {
                    Chip(text: "\(store.selectedTargetBranch) (\(ctx.branches.count))", color: .green, systemImage: "arrow.triangle.branch")
                }
                .buttonStyle(.plain)
                .popover(isPresented: $store.showBranchesPopover, arrowEdge: .bottom) {
                    RepoBranchesPopoverView().environment(store)
                }
                Chip(text: ctx.detectedBuildSystem.rawValue, color: .blue)
                Chip(text: "\(ctx.trackedFiles.count) files · \(ctx.dirtyHumanFiles.count) modified", color: .secondary)
            }
            Spacer()
            if !store.discoveredCodeProjects.isEmpty {
                Menu("Switch Project") {
                    ForEach(store.discoveredCodeProjects, id: \.self) { path in
                        Button(URL(fileURLWithPath: path).lastPathComponent) {
                            store.loadProjectFolder(path: path)
                        }
                    }
                }
                .controlSize(.small)
            }
            Button {
                store.promptForProjectFolder()
            } label: {
                Label("Load Project Folder…", systemImage: "folder.badge.plus")
            }
            .controlSize(.small)
            Menu {
                Button("Choose Project Folder…") {
                    store.promptAndLaunchNewInstance()
                }
                if !store.discoveredCodeProjects.isEmpty {
                    Divider()
                    ForEach(store.discoveredCodeProjects, id: \.self) { path in
                        Button("Open \(URL(fileURLWithPath: path).lastPathComponent)") {
                            store.launchNewInstance(forProjectPath: path)
                        }
                    }
                }
            } label: {
                Label("New Instance…", systemImage: "plus.square.on.square")
            }
            .controlSize(.small)
            Button {
                store.showPromptComposer = true
            } label: {
                Label("AI Prompt Studio…", systemImage: "sparkles")
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(.bar)
    }
}

struct RepoBranchesPopoverView: View {
    @Environment(FleetStore.self) private var store
    @State private var newBranchName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Repository Branches & Active Prompts").font(.headline)
            let branches = store.projectContext?.branches ?? []
            if branches.isEmpty {
                Text("No local git branches discovered.").font(.caption).foregroundStyle(.secondary)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(branches) { br in
                            let sessions = store.promptBranchSessions.filter { $0.branchName == br.name }
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Image(systemName: br.isMainBranch ? "shield.fill" : "arrow.triangle.branch")
                                        .foregroundStyle(br.isCurrent ? .green : .secondary)
                                    Text(br.name).font(.callout.monospaced().weight(.semibold))
                                    if br.isCurrent { Chip(text: "HEAD", color: .green) }
                                    if br.name == store.selectedTargetBranch { Chip(text: "target", color: .blue) }
                                    Spacer()
                                    Text(br.shortSHA).font(.caption2.monospaced()).foregroundStyle(.secondary)
                                    Button("Target") { store.selectedTargetBranch = br.name }
                                        .controlSize(.mini)
                                }
                                if !br.subject.isEmpty {
                                    Text(br.subject).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                ForEach(sessions) { s in
                                    HStack(spacing: 6) {
                                        Chip(text: s.statusLabel, color: s.statusLabel == "Running" ? .blue : .green)
                                        Text(s.promptText).font(.caption).lineLimit(1)
                                        Spacer()
                                        if !s.assignedMachines.isEmpty {
                                            Text(s.assignedMachines.joined(separator: ", ")).font(.caption2.monospaced()).foregroundStyle(.secondary)
                                        }
                                    }
                                    .padding(.leading, 18)
                                }
                            }
                            .padding(8)
                            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                .frame(maxHeight: 260)
            }
            Divider()
            HStack {
                TextField("New branch for next prompt…", text: $newBranchName)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption.monospaced())
                Button("Create & Target") {
                    store.createAndSelectBranch(newBranchName)
                    newBranchName = ""
                }
                .controlSize(.small)
                .disabled(newBranchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .frame(width: 460)
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
                Label("Cloud & Budgets", systemImage: "cloud.fill")
                    .badge(store.allFrontierCloudModels.count)
                    .tag(SidebarItem.cloudServices)
                Label("Visual Studio", systemImage: "square.3.layers.3d")
                    .tag(SidebarItem.studio)
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
