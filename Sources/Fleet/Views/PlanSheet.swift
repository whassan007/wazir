import FleetCore
import SwiftUI

/// Preview/confirmation for a plan. Nothing touches a host until the user presses Execute,
/// and live destructive operations need an explicit acknowledgement.
struct PlanSheet: View {
    @Environment(FleetStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var plan: ExecutionPlan
    @State private var dryRun: Bool
    @State private var acknowledged = false

    init(plan: ExecutionPlan) {
        self.plan = plan
        _dryRun = State(initialValue: plan.dryRun)
    }

    private var canExecute: Bool {
        if dryRun { return true }
        if !plan.blockers.isEmpty { return false }
        if plan.isDestructive && !acknowledged { return false }
        return true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                Image(systemName: plan.isDestructive ? "trash.circle.fill" : "arrow.down.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(plan.isDestructive ? .red : .accentColor)
                VStack(alignment: .leading, spacing: 3) {
                    Text(plan.summary).font(.title3.weight(.semibold))
                    if !plan.input.isEmpty {
                        Text(plan.input).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
                Spacer()
            }

            Picker("Mode", selection: $dryRun) {
                Label("Dry run (preview only)", systemImage: "shield.lefthalf.filled").tag(true)
                Label("Live", systemImage: "bolt.fill").tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            HStack(spacing: 16) {
                Label("\(plan.steps.count) step\(plan.steps.count == 1 ? "" : "s")", systemImage: "list.number")
                Label("\(plan.touchedHosts.count) host\(plan.touchedHosts.count == 1 ? "" : "s")", systemImage: "server.rack")
                if store.isCheckingRegistry {
                    HStack(spacing: 4) { ProgressView().controlSize(.mini); Text("Checking registry…") }
                } else if let b = plan.estimatedBytes {
                    Label("≈ \(Format.bytes(b)) download", systemImage: "arrow.down.to.line")
                }
            }
            .font(.callout)
            .foregroundStyle(.secondary)

            if !plan.blockers.isEmpty {
                messages(plan.blockers, symbol: "xmark.octagon.fill", color: .red)
            }
            if !plan.warnings.isEmpty {
                messages(plan.warnings, symbol: "exclamationmark.triangle.fill", color: .orange)
            }

            Text("Plan").font(.headline)
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(plan.steps) { step in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(step.id + 1).").monospacedDigit().foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(step.title)
                                Text(step.detail)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
            }
            .frame(minHeight: 80, maxHeight: 260)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 8))

            if plan.isDestructive && !dryRun {
                Toggle(isOn: $acknowledged) {
                    Text("I understand this permanently deletes model files from \(Set(plan.steps.map(\.hostName)).sorted().joined(separator: ", ")).")
                }
                .toggleStyle(.checkbox)
            }

            HStack {
                Text(dryRun ? "Dry run sends nothing to any host." : "Live mode changes remote state.")
                    .font(.caption).foregroundStyle(dryRun ? Color.secondary : Color.orange)
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(executeTitle) {
                    store.execute(plan, dryRun: dryRun)
                }
                .keyboardShortcut(.defaultAction)
                .tint(plan.isDestructive && !dryRun ? .red : .accentColor)
                .disabled(!canExecute)
            }
        }
        .padding(20)
        .frame(width: 640)
    }

    private var executeTitle: String {
        if dryRun { return "Run Dry Run" }
        return plan.isDestructive ? "Delete" : "Execute"
    }

    private func messages(_ items: [String], symbol: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(items, id: \.self) { w in
                Label(w, systemImage: symbol).foregroundStyle(color).font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }
}
