import SwiftUI

struct ComputeWorkersView: View {
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if viewModel.state.computers.isEmpty {
                    Text("No computers registered.").foregroundStyle(.secondary)
                }
                ForEach(viewModel.state.computers) { computer in
                    computerCard(computer)
                }
            }
            .padding()
        }
        .navigationTitle("Compute & Workers")
        .refreshable { await viewModel.refreshAll() }
    }

    private func computerCard(_ computer: ComputerTelemetryItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(computer.name + (computer.local ? " (controller)" : "")).bold()
                Spacer()
                StatusBadge(text: computer.status)
            }
            Text("\(computer.type) • \(computer.os?.platform ?? "") \(computer.os?.architecture ?? "")")
                .font(.caption).foregroundStyle(.secondary)
            Text("Last heartbeat: \(formatShortTimestamp(computer.lastHeartbeat))")
                .font(.caption2).foregroundStyle(.secondary)
            Text("CPU: \(computer.hardware.cpuModel ?? "unknown") (\(computer.hardware.cpuCores.map(String.init) ?? "?") cores)")
                .font(.caption)
            if !computer.telemetry.telemetryAvailable {
                Text("Live telemetry: Unavailable").font(.caption)
            } else {
                Text("CPU utilization: \(computer.telemetry.cpuUtilizationPercent.map { String(format: "%.0f%%", $0) } ?? "Unavailable")")
                    .font(.caption)
                Text("RAM: \(computer.telemetry.memoryUsedGB.map { String(format: "%.1f", $0) } ?? "?") / \(computer.telemetry.memoryTotalGB.map { String(format: "%.1f", $0) } ?? "?") GB")
                    .font(.caption)
            }
            if computer.hardware.gpus.isEmpty {
                Text("GPU: none reported").font(.caption)
            }
            ForEach(computer.hardware.gpus) { gpu in
                Text("GPU: \(gpu.vendor) \(gpu.model) • VRAM \(gpu.vramGB.map { String(format: "%.0f GB", $0) } ?? "unknown")")
                    .font(.caption)
            }
            if !computer.runningTasks.isEmpty {
                Text("Running tasks:").font(.caption.weight(.semibold))
                ForEach(computer.runningTasks) { task in
                    Text("• \(task.title) (\(task.taskId))").font(.caption2)
                }
            }
            if !computer.modelAssignments.isEmpty {
                Text("Models:").font(.caption.weight(.semibold))
                ForEach(computer.modelAssignments) { assignment in
                    Text("• \(assignment.modelId) — \(assignment.loaded ? "loaded" : assignment.state)").font(.caption2)
                }
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.18))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
