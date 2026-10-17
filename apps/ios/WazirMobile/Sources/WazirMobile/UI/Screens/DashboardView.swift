import SwiftUI

struct DashboardView: View {
    @ObservedObject var viewModel: MainViewModel
    var onOpenTask: (String) -> Void
    var onNewTask: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
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

    private func cardsGrid(_ cards: DashboardCards) -> some View {
        let columns = [GridItem(.flexible()), GridItem(.flexible())]
        return LazyVGrid(columns: columns, spacing: 12) {
            statTile("Running", "\(cards.runningTasks)", WazirColor.cyan)
            statTile("Queued", "\(cards.queuedTasks)", WazirColor.amber)
            statTile("Completed", "\(cards.completedTasks)", WazirColor.emerald)
            statTile("Failed", "\(cards.failedTasks)", WazirColor.crimson)
            statTile("Needs Approval", "\(cards.tasksRequiringApproval)", WazirColor.amber)
            statTile("Workers", "\(cards.connectedWorkers)/\(cards.totalComputers)", WazirColor.cyan)
            statTile("Active Models", "\(cards.activeModels)/\(cards.availableModels)", WazirColor.cyan)
            statTile("Resource Mode", cards.resourceStatus.mode.capitalized, cards.resourceStatus.emergencyStop ? WazirColor.crimson : WazirColor.emerald)
        }
    }

    private func statTile(_ label: String, _ value: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value).font(.title2.bold()).foregroundStyle(color)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(.quaternary.opacity(0.25))
        .clipShape(RoundedRectangle(cornerRadius: 12))
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
