import SwiftUI

/// Read-only: load/unload/pin/reconcile are `auth.requireOperator`-gated server-side (a
/// paired device can never pass that check, and "pin" has no server route at all) — see
/// the equivalent Android screen and HANDOFF.md for why there's no mutate UI here.
struct ModelsRuntimesView: View {
    @ObservedObject var viewModel: MainViewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Load, unload, pin, and reconcile are operator-only on the Wazir host and can't be performed from a paired mobile device.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

                Text("Runtimes").font(.headline)
                if viewModel.state.runtimes.isEmpty {
                    Text("No runtimes reported.").foregroundStyle(.secondary)
                }
                ForEach(viewModel.state.runtimes) { runtime in
                    HStack {
                        VStack(alignment: .leading) {
                            Text("\(runtime.name) (\(runtime.type)\(runtime.version.map { " \($0)" } ?? ""))").bold()
                            Text("Computer: \(runtime.computerId)").font(.caption).foregroundStyle(.secondary)
                            if let msg = runtime.healthMessage { Text(msg).font(.caption2) }
                        }
                        Spacer()
                        StatusBadge(text: runtime.health)
                    }
                    .padding(10)
                    .background(.quaternary.opacity(0.18))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }

                Text("Models").font(.headline).padding(.top, 8)
                if viewModel.state.models.isEmpty {
                    Text("No models reported.").foregroundStyle(.secondary)
                }
                ForEach(viewModel.state.models) { model in
                    let instances = viewModel.state.modelInstances.filter { $0.modelId == model.id }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.name).bold()
                        Text([model.provider, model.parameters, model.quantization, "ctx \(model.configuredContext ?? model.contextMax)"].compactMap { $0 }.joined(separator: " • "))
                            .font(.caption).foregroundStyle(.secondary)
                        if instances.isEmpty {
                            Text("Installed, not loaded").font(.caption2)
                        }
                        ForEach(instances) { instance in
                            HStack {
                                StatusBadge(text: instance.loaded ? "loaded" : (instance.state ?? "installed"))
                                StatusBadge(text: instance.health)
                                if instance.pinned == true { StatusBadge(text: "pinned") }
                                Text("\(instance.runtimeId) @ \(instance.computerId ?? "local")").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(10)
                    .background(.quaternary.opacity(0.18))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding()
        }
        .navigationTitle("Models & Runtimes")
        .refreshable { await viewModel.refreshAll() }
    }
}
