import AppKit
import FleetCore
import SwiftUI

struct CloudServicesView: View {
    @Environment(FleetStore.self) private var store

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                summaryHeader
                ForEach(store.orderedCloudServices, id: \.0.id) { cfg, snap in
                    CloudServiceCard(config: cfg, snapshot: snap)
                }
            }
            .padding(18)
        }
    }

    private var summaryHeader: some View {
        let snaps = store.orderedCloudServices.compactMap(\.1)
        let totalPlan = store.config.cloudServices.reduce(0.0) { $0 + $1.monthlyPlanBudgetUSD }
        let totalExtra = store.config.cloudServices.reduce(0.0) { $0 + $1.additionalSpendLimitUSD }
        let totalFrontier = store.allFrontierCloudModels.count
        let totalTokens = snaps.reduce(Int64(0)) { $0 + $1.totalInputTokens + $1.totalOutputTokens }

        return HStack(spacing: 12) {
            Stat(title: "Monthly Plans", value: "$\(Int(totalPlan))", symbol: "creditcard")
            Stat(title: "Extra Limit", value: "+$\(Int(totalExtra))", symbol: "plus.circle")
            Stat(title: "Frontier Models", value: "\(totalFrontier)", symbol: "sparkles")
            Stat(title: "Tokens Tracked", value: formatTokens(totalTokens), symbol: "gauge.with.dots.needle.67percent")
        }
    }

    private func formatTokens(_ n: Int64) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
        return "\(n)"
    }
}

struct CloudServiceCard: View {
    @Environment(FleetStore.self) private var store
    var config: CloudServicePlanConfig
    var snapshot: CloudServiceSnapshot?

    @State private var planDraft: Double = 0
    @State private var extraDraft: Double = 0
    @State private var initialized = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 10) {
                StatusDot(color: (snapshot?.isAuthenticated ?? false) ? .green : .orange, size: 10)
                VStack(alignment: .leading, spacing: 2) {
                    Text(config.displayName).font(.headline)
                    Text("\(config.planName) · \(snapshot?.authSourceDescription ?? "Checking…")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Chip(text: "$\(Int(config.monthlyPlanBudgetUSD)) plan" + (config.additionalSpendLimitUSD > 0 ? " + $\(Int(config.additionalSpendLimitUSD)) limit" : ""),
                     color: .blue)
            }

            // 1-Click Weblink & Config File Login Bar
            HStack(spacing: 8) {
                Button { store.openCloudWebLogin(config) } label: {
                    Label("Sign In via Weblink", systemImage: "safari")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)

                Button { store.openCloudBillingPortal(config) } label: {
                    Label("Billing & Spend", systemImage: "dollarsign.circle")
                }
                .controlSize(.small)

                Button { store.revealCloudConfigFile(config) } label: {
                    Label("Open Config File", systemImage: "doc.text")
                }
                .controlSize(.small)

                Spacer()
                HStack(spacing: 6) {
                    Text("Plan $").font(.caption).foregroundStyle(.secondary)
                    TextField("Plan", value: $planDraft, format: .number).frame(width: 54).textFieldStyle(.roundedBorder)
                    Text("Extra $").font(.caption).foregroundStyle(.secondary)
                    TextField("Extra", value: $extraDraft, format: .number).frame(width: 54).textFieldStyle(.roundedBorder)
                    Button("Save") {
                        store.updateCloudBudget(id: config.id, monthlyPlanUSD: planDraft, additionalLimitUSD: extraDraft)
                    }
                    .controlSize(.small)
                }
            }

            if let snap = snapshot {
                HStack(spacing: 16) {
                    MeterBar(
                        label: "Budget Ceiling ($\(String(format: "%.0f", snap.totalBudgetCeilingUSD)))",
                        fraction: snap.budgetUtilizationFraction,
                        detail: String(format: "$%.2f used · $%.2f left", snap.estimatedPlanSpendUSD + snap.estimatedExtraSpendUSD, snap.remainingBudgetUSD)
                    )
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Token Spend").font(.caption).foregroundStyle(.secondary)
                        Text("In: \(snap.totalInputTokens.formatted()) · Out: \(snap.totalOutputTokens.formatted()) · Cache: \(snap.totalCachedTokens.formatted())")
                            .font(.caption.monospacedDigit())
                    }
                }

                if !snap.discoveredModels.isEmpty {
                    Text("Available Frontier Models (\(snap.discoveredModels.count))").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: 8)], spacing: 8) {
                        ForEach(snap.discoveredModels) { m in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(m.displayName).font(.caption.monospaced()).lineLimit(1)
                                    if m.inputTokensUsed + m.outputTokensUsed > 0 {
                                        Text("In \(m.inputTokensUsed.formatted()) · Out \(m.outputTokensUsed.formatted())")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if m.isActiveDefault {
                                    Chip(text: "default", color: .green)
                                }
                            }
                            .padding(8)
                            .background(.background, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
        .padding(14)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .onAppear {
            if !initialized {
                planDraft = config.monthlyPlanBudgetUSD
                extraDraft = config.additionalSpendLimitUSD
                initialized = true
            }
        }
    }
}
