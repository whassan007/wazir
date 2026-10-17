import SwiftUI

/// Read-only: emergency-stop/resume are `auth.requireOperator`-gated server-side, same
/// exclusion as ModelsRuntimesView — see HANDOFF.md.
struct ResourcesView: View {
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        ScrollView {
            if let resources = viewModel.state.resources {
                content(resources)
            } else {
                Text("Resource data unavailable.").foregroundStyle(.secondary).padding()
            }
        }
        .navigationTitle("Resources & Budgets")
        .refreshable { await viewModel.refreshAll() }
    }

    private func content(_ resources: ResourceBudgetSnapshot) -> some View {
        let stopped = resources.emergencyStop != nil
        return VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Resources & Budgets").font(.title3.bold())
                Spacer()
                StatusBadge(text: stopped ? "blocked" : resources.overallMode)
            }

            VStack(alignment: .leading, spacing: 4) {
                let t = resources.totals
                Text("Tokens: \(t.totalTokens) (in \(t.inputTokens), out \(t.outputTokens))")
                Text(String(format: "Cost: $%.4f (provider-reported $%.4f, estimated $%.4f)", t.totalCostUsd, t.providerReportedCostUsd, t.estimatedCostUsd))
                    .font(.caption)
                let lh = resources.localVsHosted
                Text("Local: \(lh.localTokens) tok / \(lh.localRequests) req • Hosted: \(lh.hostedTokens) tok / \(lh.hostedRequests) req")
                    .font(.caption)
                Text("Active reservations: \(t.activeReservations)").font(.caption)
            }
            .padding(10)
            .background(.quaternary.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: 10))

            ForEach(resources.warnings) { warning in
                HStack {
                    StatusBadge(text: warning.severity)
                    Text(warning.message).font(.caption)
                }
                .padding(8)
                .background(WazirColor.crimson.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            Text("Accounts & Quotas").font(.headline)
            ForEach(resources.accounts) { account in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text("\(account.provider) (\(account.kind))").bold()
                        Spacer()
                        StatusBadge(text: account.throttlingMode)
                    }
                    ForEach(account.limits) { limit in
                        Text("\(limit.unit)/\(limit.window): \(Int(limit.used))\(limit.limit.map { " of \(Int($0))" } ?? "") (\(limit.source))\(limit.utilizationPercent.map { " • \($0)%" } ?? "")")
                            .font(.caption)
                    }
                }
                .padding(10)
                .background(.quaternary.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }

            Text("Active Reservations").font(.headline)
            if resources.reservations.isEmpty {
                Text("None").font(.caption)
            }
            ForEach(resources.reservations) { reservation in
                Text("• \(reservation.modelId) (\(reservation.workload)) ~\(reservation.estimatedInputTokens + reservation.estimatedOutputTokens) tok")
                    .font(.caption)
            }

            Text(stopped
                 ? "Emergency stop is active. Resuming requires operator access on the Wazir host — not available from a paired mobile device."
                 : "Emergency Stop is operator-only on the Wazir host and can't be triggered from a paired mobile device.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}
