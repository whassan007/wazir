import SwiftUI

struct ApprovalsView: View {
    @ObservedObject var viewModel: MainViewModel

    @State private var tab = 0
    @State private var confirming: (approval: MobileApprovalRecord, decision: String)?
    @State private var biometricError: String?
    @State private var showCreateSchedule = false
    @State private var scheduleName = ""
    @State private var schedulePrompt = ""
    @State private var scheduleCron = "0 * * * *"
    @State private var schedulePosture = "request-review"

    private var pending: [MobileApprovalRecord] {
        viewModel.state.approvals.filter { $0.status == "pending" }
    }
    private var resolved: [MobileApprovalRecord] {
        viewModel.state.approvals.filter { $0.status != "pending" }
    }
    private var schedules: [MobileScheduleItem] {
        viewModel.state.schedules
    }

    var body: some View {
        VStack(spacing: 0) {
            autonomyAndPushHeader
                .padding(.horizontal)
                .padding(.top, 8)

            Picker("", selection: $tab) {
                Text("Pending (\(pending.count))").tag(0)
                Text("Resolved (\(resolved.count))").tag(1)
                Text("Schedules (\(schedules.count))").tag(2)
            }
            .pickerStyle(.segmented)
            .padding()

            if tab == 2 {
                schedulesContent
            } else {
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
        }
        .navigationTitle("Approvals & Governance")
        .sheet(isPresented: $showCreateSchedule) {
            createScheduleSheet
        }
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

    private var autonomyAndPushHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Autonomy: \(viewModel.state.autonomy.posture)")
                    .font(.caption.weight(.semibold))
                Spacer()
                Button {
                    viewModel.toggleNetworkGuard()
                } label: {
                    Text(viewModel.state.autonomy.networkGuard == "strict-cellular" ? "Cellular: Strict" : "Cellular: Normal")
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

            Divider()

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Out-of-Band Push Relay (\(viewModel.state.pushRegistrations.count) active)")
                        .font(.caption.weight(.semibold))
                    if let latestWakeup = viewModel.state.recentPushWakeups.first {
                        Text("Last wakeup: \(latestWakeup.title) (\(latestWakeup.status))")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    } else {
                        Text("APNs/webhook wakeup for high-risk approvals & terminal tasks")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if viewModel.state.canMutate {
                    HStack(spacing: 6) {
                        Button(viewModel.state.pushRegistrations.isEmpty ? "Enable" : "Re-sync") {
                            viewModel.registerPushRelay(provider: "apns")
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.mini)

                        Button("Test") {
                            viewModel.testPushWakeup()
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)

                        if !viewModel.state.pushRegistrations.isEmpty {
                            Button("Disable", role: .destructive) {
                                viewModel.unregisterPushRelay()
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                        }
                    }
                }
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.18))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private var schedulesContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if viewModel.state.canMutate {
                Button {
                    showCreateSchedule = true
                } label: {
                    Label("New Scheduled Task", systemImage: "calendar.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal)
            }

            if schedules.isEmpty {
                Spacer()
                Text("No scheduled tasks configured.").foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                Spacer()
            } else {
                List(schedules) { item in
                    scheduleRow(item)
                }
                .listStyle(.plain)
                .refreshable { await viewModel.refreshAll() }
            }
        }
    }

    private func scheduleRow(_ item: MobileScheduleItem) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(item.name).font(.subheadline.weight(.semibold))
                Spacer()
                StatusBadge(text: item.enabled ? "enabled" : "paused")
            }
            Text(item.prompt).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            Text("Cron: \(item.cronExpression) • Posture: \(item.autonomyPosture)")
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
            if !item.nextRunDescription.isEmpty {
                Text("Next: \(item.nextRunDescription)").font(.caption2).foregroundStyle(.secondary)
            }
            if viewModel.state.canMutate {
                HStack(spacing: 8) {
                    Button("Run Now") {
                        viewModel.runScheduleNow(scheduleId: item.id)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.mini)

                    Button(item.enabled ? "Pause" : "Enable") {
                        viewModel.toggleSchedule(scheduleId: item.id, enabled: !item.enabled)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)

                    Button("Delete", role: .destructive) {
                        viewModel.deleteSchedule(scheduleId: item.id)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var createScheduleSheet: some View {
        NavigationStack {
            Form {
                Section("Schedule Details") {
                    TextField("Name (e.g. Nightly Security Audit)", text: $scheduleName)
                    TextField("Task Prompt", text: $schedulePrompt, axis: .vertical)
                    TextField("Cron Expression (e.g. 0 * * * *)", text: $scheduleCron)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Picker("Autonomy Posture", selection: $schedulePosture) {
                        Text("read-only").tag("read-only")
                        Text("request-review").tag("request-review")
                        Text("auto-sandbox").tag("auto-sandbox")
                    }
                }
            }
            .navigationTitle("New Schedule")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showCreateSchedule = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        viewModel.createSchedule(
                            name: scheduleName,
                            prompt: schedulePrompt,
                            cronExpression: scheduleCron,
                            autonomyPosture: schedulePosture
                        )
                        scheduleName = ""
                        schedulePrompt = ""
                        showCreateSchedule = false
                    }
                    .disabled(scheduleName.trimmingCharacters(in: .whitespaces).isEmpty || schedulePrompt.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
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
