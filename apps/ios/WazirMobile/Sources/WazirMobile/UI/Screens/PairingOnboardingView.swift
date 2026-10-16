import SwiftUI

/// Pairing has no camera-based QR scan yet (see HANDOFF.md) — a paired controller's `wa
/// mobile pair` output includes the same `wazir://pair?...` URI the QR code encodes, so
/// pasting it here or opening it as a link (the registered `wazir://` URL scheme) both
/// work today; only the camera capture itself is missing.
struct PairingOnboardingView: View {
    @ObservedObject var viewModel: MainViewModel

    @State private var pastedUri = ""
    @State private var manualUrl = ""
    @State private var manualSessionId = ""
    @State private var manualSecret = ""
    @State private var manualFingerprint = ""
    @State private var manualName = ""
    @State private var showManualForm = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header

                    switch viewModel.state.pairingStage {
                    case .idle:
                        pasteSection
                        if !viewModel.state.discoveredControllers.isEmpty {
                            discoveredSection
                        }
                        manualSection
                    case .requestingSession:
                        ProgressView("Requesting pairing session…")
                            .frame(maxWidth: .infinity)
                            .padding(.top, 40)
                    case .awaitingOperatorApproval(_, _, let code, let controllerName, _, _, let expiresAtMs):
                        awaitingApprovalSection(code: code, controllerName: controllerName, expiresAtMs: expiresAtMs)
                    case .completed:
                        EmptyView() // RootView switches away once activeController is set
                    case .failed(let message):
                        failedSection(message: message)
                    }

                    if !viewModel.state.controllers.isEmpty {
                        existingControllersSection
                    }
                }
                .padding()
            }
            .navigationTitle("Connect to Wazir")
            .onAppear { viewModel.startMdnsScan() }
            .onDisappear { viewModel.stopMdnsScan() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Welcome to Wazir Mobile")
                .font(.title2.bold())
            Text("Connect to your Wazir installation to monitor and manage your AI agents from anywhere.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private var pasteSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Paste pairing link").font(.headline)
            TextField("wazir://pair?sessionId=...&secret=...", text: $pastedUri, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Pair") { viewModel.pairFromQrUri(pastedUri) }
                .buttonStyle(.borderedProminent)
                .disabled(pastedUri.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private var discoveredSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Discovered on this network").font(.headline)
            ForEach(viewModel.state.discoveredControllers) { controller in
                Button {
                    manualUrl = controller.httpsUrl
                    showManualForm = true
                } label: {
                    HStack {
                        Image(systemName: "dot.radiowaves.left.and.right")
                        VStack(alignment: .leading) {
                            Text(controller.serviceName).bold()
                            Text(controller.httpsUrl).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .padding(10)
                    .background(.quaternary.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var manualSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                showManualForm.toggle()
            } label: {
                Label(showManualForm ? "Hide manual entry" : "Enter pairing details manually", systemImage: "square.and.pencil")
            }
            if showManualForm {
                VStack(alignment: .leading, spacing: 8) {
                    TextField("Controller URL (https://host:port)", text: $manualUrl)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    TextField("Session ID", text: $manualSessionId)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                    TextField("Pairing secret", text: $manualSecret)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                    TextField("TLS certificate fingerprint (optional, self-hosted)", text: $manualFingerprint)
                        .textFieldStyle(.roundedBorder)
                        .textInputAutocapitalization(.never)
                    TextField("Controller display name (optional)", text: $manualName)
                        .textFieldStyle(.roundedBorder)
                    Button("Request pairing") {
                        viewModel.startPairingSession(
                            baseUrl: manualUrl,
                            tlsCertFingerprint: manualFingerprint.isEmpty ? nil : manualFingerprint,
                            sessionId: manualSessionId,
                            pairingSecret: manualSecret,
                            controllerName: manualName.isEmpty ? "Wazir Controller" : manualName
                        )
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(manualUrl.isEmpty || manualSessionId.isEmpty || manualSecret.isEmpty)
                }
            }
        }
    }

    private func awaitingApprovalSection(code: String, controllerName: String, expiresAtMs: Int64) -> some View {
        VStack(spacing: 16) {
            ProgressView()
            Text("Waiting for approval on \(controllerName)").font(.headline)
            Text(code)
                .font(.system(.largeTitle, design: .monospaced).bold())
                .padding()
                .background(.quaternary.opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            Text("Confirm this code matches what's shown on the Wazir host, then approve the pairing request there.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Cancel", role: .cancel) { viewModel.resetPairingStage() }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 20)
    }

    private func failedSection(message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.largeTitle)
                .foregroundStyle(WazirColor.crimson)
            Text(message)
                .multilineTextAlignment(.center)
            Button("Try again") { viewModel.resetPairingStage() }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 20)
    }

    private var existingControllersSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Paired controllers").font(.headline)
            ForEach(viewModel.state.controllers) { controller in
                Button {
                    viewModel.selectController(controller.id)
                } label: {
                    HStack {
                        VStack(alignment: .leading) {
                            Text(controller.name).bold()
                            Text(controller.baseUrl).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if viewModel.state.activeController?.id == controller.id {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(WazirColor.emerald)
                        }
                    }
                    .padding(10)
                    .background(.quaternary.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
        }
    }
}
