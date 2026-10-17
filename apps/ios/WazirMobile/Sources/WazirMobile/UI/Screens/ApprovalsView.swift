import SwiftUI

struct ApprovalsView: View {
    @ObservedObject var viewModel: MainViewModel

    @State private var tab = 0
    @State private var confirming: (approval: MobileApprovalRecord, decision: String)?
    @State private var biometricError: String?

    private var pending: [MobileApprovalRecord] {
        viewModel.state.approvals.filter { $0.status == "pending" }
    }
    private var resolved: [MobileApprovalRecord] {
        viewModel.state.approvals.filter { $0.status != "pending" }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                Text("Pending (\(pending.count))").tag(0)
                Text("Resolved (\(resolved.count))").tag(1)
            }
            .pickerStyle(.segmented)
            .padding()

            let list = tab == 0 ? pending : resolved
            if list.isEmpty {
                Spacer()
                Text(tab == 0 ? "No pending approvals." : "No resolved approvals.").foregroundStyle(.secondary)
                Spacer()
            } else {
                List(list) { approval in
                    approvalRow(approval)
                }
                .listStyle(.plain)
                .refreshable { await viewModel.refreshAll() }
            }
        }
        .navigationTitle("Approvals")
        .alert("Confirm decision", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } })) {
            Button("Cancel", role: .cancel) { confirming = nil }
            Button(confirming?.decision == "approve" ? "Approve" : "Reject", role: confirming?.decision == "approve" ? .none : .destructive) {
                decide()
            }
        } message: {
            if let c = confirming {
                Text("\(c.approval.tool): \(c.approval.operation)")
            }
        }
        .alert("Authentication failed", isPresented: Binding(get: { biometricError != nil }, set: { if !$0 { biometricError = nil } })) {
            Button("OK", role: .cancel) { biometricError = nil }
        } message: {
            Text(biometricError ?? "")
        }
    }

    private func approvalRow(_ approval: MobileApprovalRecord) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("\(approval.tool): \(approval.operation)").font(.subheadline.weight(.semibold)).lineLimit(1)
                Spacer()
                StatusBadge(text: approval.riskClassification)
            }
            Text("Task: \(approval.taskTitle ?? approval.taskId ?? "—") • Agent: \(approval.agentId ?? "—")")
                .font(.caption).foregroundStyle(.secondary)
            if !approval.reasons.isEmpty {
                Text(approval.reasons.joined(separator: " • ")).font(.caption2).foregroundStyle(.secondary)
            }
            if !approval.expectedSideEffects.isEmpty {
                Text(approval.expectedSideEffects).font(.caption2).foregroundStyle(.secondary)
            }

            if approval.status == "pending" {
                if approval.requiresBiometric {
                    Label("Biometric confirmation required", systemImage: "faceid").font(.caption2).foregroundStyle(WazirColor.cyan)
                }
                if viewModel.state.canMutate {
                    HStack {
                        Button("Approve") { requestDecision(approval, "approve") }
                            .buttonStyle(.borderedProminent)
                        Button("Reject", role: .destructive) { requestDecision(approval, "reject") }
                            .buttonStyle(.bordered)
                    }
                } else {
                    Text("Read-only device: cannot resolve approvals").font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    StatusBadge(text: approval.status)
                    Text(formatShortTimestamp(approval.resolvedAt)).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func requestDecision(_ approval: MobileApprovalRecord, _ decision: String) {
        guard decision == "approve", approval.requiresBiometric else {
            confirming = (approval, decision)
            return
        }
        Task {
            let result = await BiometricAuthGate.authenticate(reason: "Approve \(approval.tool): \(approval.operation)")
            switch result {
            case .success:
                viewModel.resolveApproval(approval, decision: decision, biometricVerified: true)
            case .failure(let error):
                biometricError = error.localizedDescription
            }
        }
    }

    private func decide() {
        guard let c = confirming else { return }
        viewModel.resolveApproval(c.approval, decision: c.decision, biometricVerified: false)
        confirming = nil
    }
}
