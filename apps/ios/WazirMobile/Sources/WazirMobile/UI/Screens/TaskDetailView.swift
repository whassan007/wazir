import SwiftUI

struct TaskDetailView: View {
    @ObservedObject var viewModel: MainViewModel
    let taskId: String

    var body: some View {
        ScrollView {
            if let task = viewModel.state.activeTaskDetail, task.taskId == taskId {
                content(task)
            } else {
                ProgressView("Loading task…").padding(.top, 40)
            }
        }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await viewModel.loadTaskDetail(taskId, startLivePolling: true)
        }
        .onDisappear {
            viewModel.stopTaskLivePolling()
        }
    }

    @ViewBuilder
    private func content(_ task: MobileTaskDetail) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            if viewModel.state.activeTaskDetailCached {
                Label("Showing cached data — offline", systemImage: "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(WazirColor.amber)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(task.title.isEmpty ? task.input : task.title).font(.title3.bold())
                HStack {
                    StatusBadge(text: task.state)
                    StatusBadge(text: task.verificationStatus)
                    Spacer()
                    Text(formatDurationMs(task.elapsedMs)).font(.caption).foregroundStyle(.secondary)
                }
                Text("\(task.agentId) • \(task.modelId) • \(task.computerId)")
                    .font(.caption).foregroundStyle(.secondary)
            }

            actionButtons(task)

            if !viewModel.state.activeTaskArtifacts.isEmpty {
                verifiableArtifactsSection(taskId: task.taskId, artifacts: viewModel.state.activeTaskArtifacts)
            }

            if !task.timeline.isEmpty {
                sectionHeader("Timeline")
                ForEach(task.timeline) { step in
                    HStack(alignment: .top) {
                        StatusBadge(text: step.status)
                        VStack(alignment: .leading) {
                            Text(step.title).font(.subheadline)
                            if let detail = step.detail { Text(detail).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }

            if !task.toolCalls.isEmpty {
                sectionHeader("Tool Calls")
                ForEach(task.toolCalls) { call in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(call.tool).font(.subheadline.weight(.semibold))
                            StatusBadge(text: call.status)
                        }
                        if let output = call.output { Text(output).font(.caption).lineLimit(3) }
                        if let error = call.error { Text(error).font(.caption).foregroundStyle(WazirColor.crimson) }
                    }
                    .padding(8)
                    .background(.quaternary.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }

            if !task.filesChanged.isEmpty {
                sectionHeader("Files Changed")
                ForEach(task.filesChanged, id: \.self) { path in
                    Text(path).font(.system(.caption, design: .monospaced))
                }
            }

            if let report = task.verificationReport {
                sectionHeader("Verification")
                StatusBadge(text: report.status)
                ForEach(report.checks) { check in
                    HStack {
                        StatusBadge(text: check.status)
                        Text(check.name).font(.caption)
                    }
                }
            }

            if !task.errors.isEmpty {
                sectionHeader("Errors")
                ForEach(task.errors, id: \.self) { err in
                    Text(err).font(.caption).foregroundStyle(WazirColor.crimson)
                }
            }

            if let output = task.finalOutput, !output.isEmpty {
                sectionHeader("Final Output")
                Text(output).font(.system(.caption, design: .monospaced))
            }

            if !task.logs.isEmpty {
                sectionHeader("Logs")
                ForEach(task.logs) { log in
                    Text("[\(log.level.uppercased())] \(log.message)")
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(log.level == "error" ? WazirColor.crimson : .secondary)
                }
            }
        }
        .padding()
    }

    @ViewBuilder
    private func verifiableArtifactsSection(taskId: String, artifacts: [MobileVerifiableArtifact]) -> some View {
        sectionHeader("Verifiable Artifacts (\(artifacts.count))")
        ForEach(artifacts) { artifact in
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(artifact.title).font(.subheadline.weight(.semibold))
                    Spacer()
                    StatusBadge(text: artifact.status)
                }
                if !artifact.summary.isEmpty {
                    Text(artifact.summary).font(.caption).foregroundStyle(.secondary)
                }

                if !artifact.steps.isEmpty {
                    ForEach(artifact.steps) { step in
                        HStack(spacing: 6) {
                            StatusBadge(text: step.status)
                            Text(step.title).font(.caption)
                        }
                    }
                }

                if !artifact.files.isEmpty {
                    ForEach(artifact.files) { file in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(file.path)
                                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                                    .lineLimit(1)
                                Spacer()
                                Text("+\(file.additions) / -\(file.deletions)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                StatusBadge(text: file.status)
                            }
                            if !file.patch.isEmpty {
                                Text(file.patch)
                                    .font(.system(.caption2, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(6)
                                    .padding(6)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .background(.black.opacity(0.08))
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                            if viewModel.state.canMutate {
                                HStack(spacing: 8) {
                                    Button("Keep") {
                                        viewModel.reviewTaskDiffFile(taskId: taskId, path: file.path, decision: "accepted")
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .controlSize(.mini)

                                    Button("Skip", role: .destructive) {
                                        viewModel.reviewTaskDiffFile(taskId: taskId, path: file.path, decision: "rejected")
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.mini)
                                }
                            }
                        }
                        .padding(8)
                        .background(.quaternary.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }

                if !artifact.checks.isEmpty {
                    ForEach(artifact.checks) { check in
                        HStack {
                            StatusBadge(text: check.status)
                            Text(check.name).font(.caption)
                            Spacer()
                            Text("\(check.durationMs) ms").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .padding(10)
            .background(.quaternary.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text).font(.headline).padding(.top, 8)
    }

    @ViewBuilder
    private func actionButtons(_ task: MobileTaskDetail) -> some View {
        if viewModel.state.canMutate {
            HStack {
                if task.supportedActions.contains("cancel") {
                    Button("Cancel", role: .destructive) { viewModel.cancelTask(task.taskId) }
                        .buttonStyle(.bordered)
                }
                if task.supportedActions.contains("retry") {
                    Button("Retry") { viewModel.retryTask(task.taskId) }
                        .buttonStyle(.bordered)
                }
                if task.supportedActions.contains("resume") {
                    Button("Resume") { viewModel.resumeTask(task.taskId) }
                        .buttonStyle(.bordered)
                }
            }
        }
    }
}
