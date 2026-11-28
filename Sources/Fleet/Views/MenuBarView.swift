import FleetCore
import SwiftUI

struct MenuBarView: View {
    @Environment(FleetStore.self) private var store
    @Environment(\.openWindow) private var openWindow
    @State private var quick = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Fleet").font(.headline)
                Text("\(store.state.onlineCount)/\(store.state.hostOrder.count) online")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                if store.isRefreshing { ProgressView().controlSize(.small) }
                Button {
                    Task { await store.refreshAll() }
                } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
                .disabled(store.isRefreshing)
            }

            VStack(spacing: 6) {
                ForEach(store.orderedHosts, id: \.0.id) { cfg, hs in
                    Button {
                        store.selection = .host(cfg.id)
                        showMain()
                    } label: {
                        HStack(spacing: 8) {
                            StatusDot(color: hs.reachability.color, pulsing: hs.isProbing)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(cfg.name).lineLimit(1)
                                Text(subtitle(hs)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            Text(hs.reachability.shortLabel).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }

            if !store.state.runningOperations.isEmpty {
                Divider()
                ForEach(store.state.runningOperations) { op in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(op.plan.summary).font(.caption).lineLimit(1)
                        ProgressView(value: op.overallProgress ?? 0)
                    }
                }
            }

            Divider()
            TextField("Command, e.g. add qwen2.5 on jetson", text: $quick)
                .textFieldStyle(.roundedBorder)
                .font(.callout.monospaced())
                .onSubmit {
                    store.commandText = quick
                    quick = ""
                    showMain()
                    store.submitCommand()
                }

            HStack {
                Button("Open Fleet") { showMain() }
                SettingsLink { Text("Settings…") }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
            .controlSize(.small)
        }
        .padding(12)
        .frame(width: 340)
    }

    private func subtitle(_ hs: HostState) -> String {
        switch hs.reachability {
        case .online:
            let loaded = hs.allModels.filter { $0.1.isLoaded }.map(\.1.name)
            return loaded.isEmpty ? "\(hs.modelCount) models" : "▶ " + loaded.joined(separator: ", ")
        case .offline:
            return hs.lastSeen.map { "offline · seen \(Format.relative($0))" } ?? "offline"
        case .unknown:
            return hs.isProbing ? "probing…" : "not probed"
        }
    }

    private func showMain() {
        openWindow(id: "main")
        NSApp.activate()
    }
}
