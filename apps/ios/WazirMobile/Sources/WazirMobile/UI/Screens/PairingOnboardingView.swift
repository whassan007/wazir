import SwiftUI
#if canImport(AVFoundation) && canImport(UIKit)
import AVFoundation
import UIKit
#endif

struct PairingOnboardingView: View {
    @ObservedObject var viewModel: MainViewModel

    @State private var pastedUri = ""
    @State private var manualUrl = ""
    @State private var manualSessionId = ""
    @State private var manualSecret = ""
    @State private var manualFingerprint = ""
    @State private var manualName = ""
    @State private var showManualForm = false
    @State private var showQrScanner = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header

                    switch viewModel.state.pairingStage {
                    case .idle:
                        qrScanSection
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
            .sheet(isPresented: $showQrScanner) {
                QrCodeScannerSheet { scannedCode in
                    showQrScanner = false
                    pastedUri = scannedCode
                    viewModel.pairFromQrUri(scannedCode)
                } onCancel: {
                    showQrScanner = false
                }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Image("WazirLogo")
                .resizable()
                .scaledToFit()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 4) {
                Text("Welcome to Wazir Mobile")
                    .font(.title2.bold())
                Text("Connect to your Wazir installation to monitor and manage your AI agents from anywhere.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var qrScanSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Scan controller QR code").font(.headline)
            Button {
                showQrScanner = true
            } label: {
                Label("Scan QR Code with Camera", systemImage: "qrcode.viewfinder")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        }
    }

    private var pasteSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Or paste pairing link").font(.headline)
            TextField("wazir://pair?sessionId=...&secret=...", text: $pastedUri, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Pair") { viewModel.pairFromQrUri(pastedUri) }
                .buttonStyle(.bordered)
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

struct QrCodeScannerSheet: View {
    var onScanned: (String) -> Void
    var onCancel: () -> Void
    @State private var cameraError: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                #if canImport(AVFoundation) && canImport(UIKit)
                if let cameraError {
                    VStack(spacing: 12) {
                        Image(systemName: "camera.metering.unknown")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text(cameraError)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    QrCameraPreview(onScanned: onScanned, onError: { cameraError = $0 })
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .padding()
                }
                #else
                Text("Camera scanning is unavailable on this platform. Paste the wazir://pair URI instead.")
                    .foregroundStyle(.secondary)
                    .padding()
                #endif
                Text("Point your camera at the QR code shown by `wazir mobile pair` or the Wazir web dashboard.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)
                    .padding(.bottom)
            }
            .navigationTitle("Scan Pairing QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
    }
}

#if canImport(AVFoundation) && canImport(UIKit)
private struct QrCameraPreview: UIViewControllerRepresentable {
    var onScanned: (String) -> Void
    var onError: (String) -> Void

    func makeUIViewController(context: Context) -> QrScannerViewController {
        let vc = QrScannerViewController()
        vc.onScanned = onScanned
        vc.onError = onError
        return vc
    }

    func updateUIViewController(_ uiViewController: QrScannerViewController, context: Context) {}
}

private final class QrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScanned: ((String) -> Void)?
    var onError: ((String) -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmit = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureCaptureSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            session.stopRunning()
        }
    }

    private func configureCaptureSession() {
        guard let videoCaptureDevice = AVCaptureDevice.default(for: .video) else {
            onError?("No camera detected on this device. Paste the wazir://pair link on the previous screen.")
            return
        }
        guard let videoInput = try? AVCaptureDeviceInput(device: videoCaptureDevice),
              session.canAddInput(videoInput) else {
            onError?("Unable to access camera input. Check Camera permissions in Settings or paste the pairing link.")
            return
        }
        session.addInput(videoInput)

        let metadataOutput = AVCaptureMetadataOutput()
        guard session.canAddOutput(metadataOutput) else {
            onError?("Unable to configure QR code metadata detector.")
            return
        }
        session.addOutput(metadataOutput)
        metadataOutput.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        if metadataOutput.availableMetadataObjectTypes.contains(.qr) {
            metadataOutput.metadataObjectTypes = [.qr]
        }

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.frame = view.layer.bounds
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        previewLayer = layer

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.session.startRunning()
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !didEmit,
              let readableObject = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let stringValue = readableObject.stringValue,
              !stringValue.isEmpty else {
            return
        }
        didEmit = true
        session.stopRunning()
        onScanned?(stringValue)
    }
}
#endif
