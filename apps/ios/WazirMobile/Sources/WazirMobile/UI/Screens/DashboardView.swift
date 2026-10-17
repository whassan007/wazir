import SwiftUI

struct DashboardView: View {
    @ObservedObject var viewModel: MainViewModel
    var onOpenTask: (String) -> Void
    var onNewTask: () -> Void
    var onOpenApprovals: (() -> Void)? = nil
    var onOpenResources: (() -> Void)? = nil
    var onOpenModels: (() -> Void)? = nil
    var onOpenWorkers: (() -> Void)? = nil
    var onOpenTasks: (() -> Void)? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !viewModel.state.pendingApprovals.isEmpty {
                    pendingApprovalsBanner(count: viewModel.state.pendingApprovals.count)
                }

                autonomyBar

                if let cards = viewModel.state.dashboard?.cards {
                    cardsGrid(cards)
                } else {
                    Text("No dashboard data yet.").foregroundStyle(.secondary)
                }

                Button(action: onNewTask) {
                    Label("New Task", systemImage: "plus.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!viewModel.state.canExecute)

                Text("Recent Activity").font(.headline)
                if viewModel.state.recentEvents.isEmpty {
                    Text("No recent activity.").foregroundStyle(.secondary)
                } else {
                    ForEach(viewModel.state.recentEvents.prefix(20)) { event in
                        Button {
                            if let taskId = event.taskId { onOpenTask(taskId) }
                        } label: {
                            eventRow(event)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding()
        }
        .refreshable { await viewModel.refreshAll() }
    }

    private func pendingApprovalsBanner(count: Int) -> some View {
        Button {
            onOpenApprovals?()
        } label: {
            HStack {
                Image(systemName: "exclamationmark.shield.fill")
                    .foregroundStyle(WazirColor.amber)
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(count) Pending Approval\(count == 1 ? "" : "s")")
                        .font(.subheadline.bold())
                    Text("High-risk tool execution is paused awaiting review.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(12)
            .background(WazirColor.amber.opacity(0.16))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }

    private var autonomyBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Autonomy: \(viewModel.state.autonomy.posture)", systemImage: "dial.medium.fill")
                    .font(.caption.weight(.semibold))
                Spacer()
                Button {
                    viewModel.toggleNetworkGuard()
                } label: {
                    Label(
                        viewModel.state.autonomy.networkGuard == "strict-cellular" ? "Cellular Guard: Strict" : "Cellular Guard: Normal",
                        systemImage: viewModel.state.autonomy.networkGuard == "strict-cellular" ? "antenna.radiowaves.left.and.right.slash" : "antenna.radiowaves.left.and.right"
                    )
                    .font(.caption2)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(!viewModel.state.canMutate)
            }
            if viewModel.state.canMutate {
                HStack(spacing: 6) {
                    ForEach(["read-only", "request-review", "auto-sandbox"], id: \.self) { posture in
                        let selected = viewModel.state.autonomy.posture == posture
                        Button(posture) {
                            viewModel.updateAutonomyPosture(posture)
                        }
                        .font(.caption2.weight(selected ? .bold : .regular))
                        .buttonStyle(.bordered)
                        .tint(selected ? WazirColor.cyan : .secondary)
                        .controlSize(.mini)
                    }
                }
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.18))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func cardsGrid(_ cards: DashboardCards) -> some View {
        let columns = [GridItem(.flexible()), GridItem(.flexible())]
        return LazyVGrid(columns: columns, spacing: 12) {
            statTile("Running", "\(cards.runningTasks)", WazirColor.cyan, action: onOpenTasks)
            statTile("Queued", "\(cards.queuedTasks)", WazirColor.amber, action: onOpenTasks)
            statTile("Completed", "\(cards.completedTasks)", WazirColor.emerald, action: onOpenTasks)
            statTile("Failed", "\(cards.failedTasks)", WazirColor.crimson, action: onOpenTasks)
            statTile("Needs Approval", "\(cards.tasksRequiringApproval)", WazirColor.amber, action: onOpenApprovals)
            statTile("Workers", "\(cards.connectedWorkers)/\(cards.totalComputers)", WazirColor.cyan, action: onOpenWorkers)
            statTile("Active Models", "\(cards.activeModels)/\(cards.availableModels)", WazirColor.cyan, action: onOpenModels)
            statTile("Resource Mode", cards.resourceStatus.mode.capitalized, cards.resourceStatus.emergencyStop ? WazirColor.crimson : WazirColor.emerald, action: onOpenResources)
        }
    }

    private func statTile(_ label: String, _ value: String, _ color: Color, action: (() -> Void)? = nil) -> some View {
        Button {
            action?()
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(value).font(.title2.bold()).foregroundStyle(color)
                Text(label).font(.caption).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(.quaternary.opacity(0.25))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }

    private func eventRow(_ event: MobileStreamEvent) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(event.summary).font(.subheadline)
                Text("\(event.type) • \(formatShortTimestamp(event.timestamp))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background(.quaternary.opacity(0.18))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
