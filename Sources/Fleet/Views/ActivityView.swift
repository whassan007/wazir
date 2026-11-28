import FleetCore
import SwiftUI

struct ActivityView: View {
    @Environment(FleetStore.self) private var store

    var body: some View {
        @Bindable var store = store
        if store.state.operations.isEmpty {
            ContentUnavailableView("No operations yet", systemImage: "list.bullet.rectangle",
                                   description: Text("Type a command above, e.g. `add model qwen2.5 on machine jetson`."))
        } else {
            HSplitView {
                List(selection: $store.selectedOperation) {
                    ForEach(store.state.operations) { op in
                        OperationRow(op: op).tag(op.id)
                    }
                }
                .frame(minWidth: 260, idealWidth: 300)
                .safeAreaInset(edge: .bottom) {
                    HStack {
                        Spacer()
                        Button("Clear Finished") { store.send(.clearFinishedOperations) }
                            .disabled(!store.state.operations.contains { $0.phase.isTerminal })
                    }
                    .padding(8)
                }

                Group {
                    if let id = store.selectedOperation ?? store.state.operations.first?.id,
                       let op = store.state.operation(id) {
                        OperationDetail(op: op)
                    } else {
                        ContentUnavailableView("Select an operation", systemImage: "sidebar.left")
                    }
                }
                .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

extension OperationPhase {
    var color: Color {
        switch self {
        case .running: .blue
        case .succeeded: .green
        case .failed: .red
        case .cancelled: .orange
        }
    }

    var symbol: String {
        switch self {
        case .running: "arrow.triangle.2.circlepath"
        case .succeeded: "checkmark.circle.fill"
        case .failed: "xmark.circle.fill"
        case .cancelled: "stop.circle.fill"
        }
    }
}

struct OperationRow: View {
    var op: OperationRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: op.phase.symbol).foregroundStyle(op.phase.color)
                Text(op.plan.summary).lineLimit(2)
            }
            HStack {
                if op.dryRun { Chip(text: "dry run", color: .blue) }
                Text(op.startedAt, style: .time).font(.caption).foregroundStyle(.secondary)
                Spacer()
                if op.phase == .running, let p = op.overallProgress {
                    ProgressView(value: p).frame(width: 70)
                }
            }
        }
        .padding(.vertical, 3)
    }
}

struct OperationDetail: View {
    @Environment(FleetStore.self) private var store
    var op: OperationRecord
    @State private var follow = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Image(systemName: op.phase.symbol).font(.title2).foregroundStyle(op.phase.color)
                VStack(alignment: .leading) {
                    Text(op.plan.summary).font(.headline)
                    HStack(spacing: 8) {
                        Text(op.phase.label).foregroundStyle(op.phase.color)
                        if op.dryRun { Text("· dry run") }
                        if let end = op.finishedAt {
                            Text("· \(String(format: "%.1fs", end.timeIntervalSince(op.startedAt)))")
                        }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if op.phase == .running {
                    Button("Cancel", role: .destructive) { store.cancel(op.id) }
                }
            }
            if case .failed(let why) = op.phase {
                Text(why).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
            if let p = op.overallProgress, op.phase == .running {
                ProgressView(value: p)
            }

            VStack(alignment: .leading, spacing: 6) {
                ForEach(op.plan.steps) { step in
                    StepRow(step: step, status: op.steps[step.id] ?? .pending)
                }
            }

            HStack {
                Text("Log").font(.headline)
                Spacer()
                Toggle("Follow", isOn: $follow).toggleStyle(.checkbox).controlSize(.small)
                Button("Copy Log") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(op.log.map { "[\($0.level.rawValue)] \($0.text)" }.joined(separator: "\n"), forType: .string)
                }
                .controlSize(.small)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(op.log) { line in
                            Text(line.text)
                                .font(.caption.monospaced())
                                .foregroundStyle(color(line.level))
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .textSelection(.enabled)
                                .id(line.id)
                        }
                    }
                    .padding(8)
                }
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                .onChange(of: op.log.last?.id) { _, last in
                    if follow, let last { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
        .padding(14)
    }

    private func color(_ l: LogLine.Level) -> Color {
        switch l {
        case .info: .primary
        case .output: .secondary
        case .warning: .orange
        case .error: .red
        }
    }
}

struct StepRow: View {
    var step: PlanStep
    var status: StepStatus

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            icon.frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.title).font(.callout)
                switch status {
                case .running(let p, let detail):
                    HStack {
                        if let p { ProgressView(value: p).frame(maxWidth: 260) } else { ProgressView().controlSize(.mini) }
                        if let detail { Text(detail).font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(1) }
                    }
                case .failed(let m): Text(m).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                case .skipped(let m): Text(m).font(.caption).foregroundStyle(.secondary)
                case .succeeded(let m?): Text(m).font(.caption).foregroundStyle(.secondary)
                default: EmptyView()
                }
            }
        }
    }

    @ViewBuilder private var icon: some View {
        switch status {
        case .pending: Image(systemName: "circle").foregroundStyle(.secondary)
        case .running: ProgressView().controlSize(.mini)
        case .succeeded: Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(.red)
        case .skipped: Image(systemName: "minus.circle").foregroundStyle(.secondary)
        }
    }
}
