import SwiftUI

struct TasksView: View {
    @ObservedObject var viewModel: MainViewModel
    var onOpenTask: (String) -> Void
    var onNewTask: () -> Void

    private let tabs = ["all", "running", "queued", "blocked", "completed", "failed"]

    var filtered: [MobileTaskSummary] {
        let tab = viewModel.state.selectedTaskTab
        guard tab != "all" else { return viewModel.state.tasks }
        return viewModel.state.tasks.filter { $0.state == tab }
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(tabs, id: \.self) { tab in
                        Button(tab.capitalized) { viewModel.setTaskTab(tab) }
                            .buttonStyle(.bordered)
                            .tint(viewModel.state.selectedTaskTab == tab ? WazirColor.cyan : .gray)
                    }
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
            }

            if filtered.isEmpty {
                Spacer()
                Text("No tasks in this view.").foregroundStyle(.secondary)
                Spacer()
            } else {
                List(filtered) { task in
                    Button {
                        onOpenTask(task.taskId)
                    } label: {
                        taskRow(task)
                    }
                    .buttonStyle(.plain)
                }
                .listStyle(.plain)
                .refreshable { await viewModel.refreshAll() }
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button(action: onNewTask) {
                    Image(systemName: "plus")
                }
                .disabled(!viewModel.state.canExecute)
            }
        }
    }

    private func taskRow(_ task: MobileTaskSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(task.title.isEmpty ? task.input : task.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer()
                StatusBadge(text: task.state)
            }
            Text("\(task.phase) • \(task.modelId) • \(formatShortTimestamp(task.lastActivityAt))")
                .font(.caption)
                .foregroundStyle(.secondary)
            if !task.pendingApprovalIds.isEmpty {
                Label("\(task.pendingApprovalIds.count) approval(s) pending", systemImage: "exclamationmark.shield.fill")
                    .font(.caption2)
                    .foregroundStyle(WazirColor.amber)
            }
        }
        .padding(.vertical, 4)
    }
}
