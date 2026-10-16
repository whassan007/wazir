import SwiftUI

enum Route: Hashable {
    case taskDetail(String)
}

struct RootView: View {
    @ObservedObject var viewModel: MainViewModel
    @Binding var pendingDeepLinkRoute: String?
    @State private var dashboardPath: [Route] = []
    @State private var tasksPath: [Route] = []
    @State private var showNewTask = false

    var body: some View {
        Group {
            if viewModel.state.activeController == nil {
                PairingOnboardingView(viewModel: viewModel)
            } else {
                mainTabs
            }
        }
        .onChange(of: pendingDeepLinkRoute) { route in
            guard let route else { return }
            switch route {
            case "approvals": selectedTab = .approvals
            case "tasks": selectedTab = .tasks
            case "workers": selectedTab = .workers
            case "resources": selectedTab = .models
            default: selectedTab = .dashboard
            }
            pendingDeepLinkRoute = nil
        }
    }

    enum Tab { case dashboard, tasks, approvals, models, workers }
    @State private var selectedTab: Tab = .dashboard

    private var mainTabs: some View {
        TabView(selection: $selectedTab) {
            dashboardTab.tabItem { Label("Home", systemImage: "square.grid.2x2") }.tag(Tab.dashboard)
            tasksTab.tabItem { Label("Tasks", systemImage: "checklist") }.tag(Tab.tasks)
            approvalsTab.tabItem { Label("Approvals", systemImage: "shield") }.tag(Tab.approvals)
                .badge(viewModel.state.pendingApprovals.count)
            modelsTab.tabItem { Label("Models", systemImage: "cpu") }.tag(Tab.models)
            workersTab.tabItem { Label("Workers", systemImage: "server.rack") }.tag(Tab.workers)
        }
        .sheet(isPresented: $showNewTask) {
            CreateTaskView(viewModel: viewModel, onSubmitted: { taskId in
                showNewTask = false
                dashboardPath = [.taskDetail(taskId)]
                tasksPath = [.taskDetail(taskId)]
                selectedTab = .tasks
            }, onCancel: { showNewTask = false })
        }
    }

    private var dashboardTab: some View {
        NavigationStack(path: $dashboardPath) {
            DashboardView(viewModel: viewModel, onOpenTask: { dashboardPath.append(.taskDetail($0)) }, onNewTask: { showNewTask = true })
                .navigationTitle("Wazir")
                .toolbar { topBarItems }
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .taskDetail(let id): TaskDetailView(viewModel: viewModel, taskId: id)
                    }
                }
            bannerOverlay
        }
    }

    private var tasksTab: some View {
        NavigationStack(path: $tasksPath) {
            TasksView(viewModel: viewModel, onOpenTask: { tasksPath.append(.taskDetail($0)) }, onNewTask: { showNewTask = true })
                .navigationTitle("Tasks")
                .toolbar { topBarItems }
                .navigationDestination(for: Route.self) { route in
                    switch route {
                    case .taskDetail(let id): TaskDetailView(viewModel: viewModel, taskId: id)
                    }
                }
        }
    }

    private var approvalsTab: some View {
        NavigationStack {
            ApprovalsView(viewModel: viewModel).toolbar { topBarItems }
        }
    }

    private var modelsTab: some View {
        NavigationStack {
            ModelsRuntimesView(viewModel: viewModel).toolbar { topBarItems }
        }
    }

    private var workersTab: some View {
        NavigationStack {
            ComputeWorkersView(viewModel: viewModel).toolbar { topBarItems }
        }
    }

    @ToolbarContentBuilder
    private var topBarItems: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            connectionIndicator
        }
        ToolbarItem(placement: .navigationBarTrailing) {
            Menu {
                ForEach(viewModel.state.controllers) { controller in
                    Button {
                        viewModel.selectController(controller.id)
                    } label: {
                        Label(controller.name, systemImage: viewModel.state.activeController?.id == controller.id ? "checkmark" : "")
                    }
                }
                Divider()
                Button("Refresh") { Task { await viewModel.refreshAll() } }
                if let active = viewModel.state.activeController {
                    Button("Unpair \(active.name)", role: .destructive) { viewModel.unpairController(active.id) }
                }
            } label: {
                Image(systemName: "antenna.radiowaves.left.and.right")
            }
        }
    }

    private var connectionIndicator: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(sseColor)
                .frame(width: 8, height: 8)
            Text(viewModel.state.activeController?.name ?? "Wazir")
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
        }
    }

    private var sseColor: Color {
        switch viewModel.state.sseState {
        case .connected: return WazirColor.emerald
        case .connecting, .reconnecting: return WazirColor.amber
        case .authError: return WazirColor.crimson
        case .disconnected: return .gray
        }
    }

    @ViewBuilder
    private var bannerOverlay: some View {
        if let message = viewModel.state.bannerMessage {
            Text(message)
                .font(.caption)
                .padding(8)
                .background(viewModel.state.bannerIsError ? WazirColor.crimson.opacity(0.85) : WazirColor.emerald.opacity(0.85))
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .padding()
                .onTapGesture { viewModel.clearBanner() }
        }
    }

}
