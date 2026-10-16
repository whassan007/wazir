import Foundation
import Combine

enum PairingStage: Equatable {
    case idle
    case requestingSession
    case awaitingOperatorApproval(sessionId: String, pairingSecret: String, confirmationCode: String, controllerName: String, baseUrl: String, tlsCertFingerprint: String?, expiresAtMs: Int64)
    case completed(ControllerProfile)
    case failed(String)
}

struct WazirUiState {
    var controllers: [ControllerProfile] = []
    var activeController: ControllerProfile?
    var pairingStage: PairingStage = .idle
    var discoveredControllers: [DiscoveredWazirController] = []
    var isMdnsScanning = false
    var sseState: SseConnectionState = .disconnected
    var isRefreshing = false
    var isOfflineCached = false
    var lastSyncedAtMs: Int64?
    var bannerMessage: String?
    var bannerIsError = false
    var dashboard: DashboardSnapshot?
    var recentEvents: [MobileStreamEvent] = []
    var tasks: [MobileTaskSummary] = []
    var selectedTaskTab = "all"
    var activeTaskDetail: MobileTaskDetail?
    var activeTaskDetailCached = false
    var isSubmittingTask = false
    var approvals: [MobileApprovalRecord] = []
    var models: [ModelCatalogItem] = []
    var modelInstances: [ModelInstanceItem] = []
    var runtimes: [RuntimeItem] = []
    var agents: [AgentDescriptorItem] = []
    var computers: [ComputerTelemetryItem] = []
    var resources: ResourceBudgetSnapshot?

    var pendingApprovals: [MobileApprovalRecord] { approvals.filter { $0.status == "pending" } }
    var canMutate: Bool { activeController?.canMutate ?? false }
    var canExecute: Bool { activeController?.canExecute ?? false }
}

/// Mirrors Android's `MainViewModel`: one `@Published` UI state, fed by the repository
/// (REST polling + offline cache), the SSE stream, mDNS discovery, and local notifications.
@MainActor
final class MainViewModel: ObservableObject {
    @Published private(set) var state = WazirUiState()

    private let repository: WazirRepository
    private let store: ControllerStore
    let sseStream: MobileSseEventStream
    let mdnsDiscovery: MdnsControllerDiscovery
    private let notificationManager: WazirNotificationManager

    private var cancellables: Set<AnyCancellable> = []
    private var pairingPollTask: Task<Void, Never>?
    private var taskMonitorTask: Task<Void, Never>?

    init(repository: WazirRepository, store: ControllerStore, sseStream: MobileSseEventStream, mdnsDiscovery: MdnsControllerDiscovery, notificationManager: WazirNotificationManager) {
        self.repository = repository
        self.store = store
        self.sseStream = sseStream
        self.mdnsDiscovery = mdnsDiscovery
        self.notificationManager = notificationManager

        store.$controllers
            .sink { [weak self] list in
                self?.onControllersChanged(list)
            }
            .store(in: &cancellables)

        sseStream.$connectionState
            .sink { [weak self] s in self?.state.sseState = s }
            .store(in: &cancellables)

        sseStream.onEvent = { [weak self] event in
            Task { @MainActor in self?.handleIncomingStreamEvent(event) }
        }

        mdnsDiscovery.$discovered
            .sink { [weak self] list in self?.state.discoveredControllers = list }
            .store(in: &cancellables)

        mdnsDiscovery.$isScanning
            .sink { [weak self] scanning in self?.state.isMdnsScanning = scanning }
            .store(in: &cancellables)

        onControllersChanged(store.controllers)
    }

    private func onControllersChanged(_ list: [ControllerProfile]) {
        let current = state.activeController
        let next: ControllerProfile?
        if list.isEmpty {
            next = nil
        } else if let current, let match = list.first(where: { $0.id == current.id }) {
            next = match
        } else {
            next = list.first
        }
        let switched = current?.id != next?.id
        state.controllers = list
        state.activeController = next
        if switched {
            if let next {
                Task { await activateController(next) }
            } else {
                sseStream.disconnect()
            }
        }
    }

    func selectController(_ controllerId: String) {
        guard let target = state.controllers.first(where: { $0.id == controllerId }) else { return }
        guard state.activeController?.id != target.id else { return }
        state.activeController = target
        state.activeTaskDetail = nil
        state.bannerMessage = nil
        Task { await activateController(target) }
    }

    private func activateController(_ profile: ControllerProfile) async {
        let cached = repository.loadCachedState(profile.id)
        state.dashboard = cached.dashboard
        state.recentEvents = cached.dashboard?.recentActivity ?? []
        state.tasks = cached.tasks
        state.approvals = cached.approvals
        state.models = cached.models
        state.modelInstances = cached.modelInstances
        state.runtimes = cached.runtimes
        state.agents = cached.agents
        state.computers = cached.computers
        state.resources = cached.resources
        state.lastSyncedAtMs = cached.syncedAtMs
        state.isOfflineCached = cached.syncedAtMs != nil

        sseStream.connect(profile: profile, initialCursor: cached.lastSequence)
        await refreshAll(silent: false)
    }

    func refreshAll(silent: Bool = false) async {
        guard let profile = state.activeController else { return }
        if !silent { state.isRefreshing = true }
        let cursor = sseStream.currentCursor()
        do {
            let fresh = try await repository.refreshControllerState(profile, lastKnownSequence: cursor)
            state.isRefreshing = false
            state.isOfflineCached = false
            state.lastSyncedAtMs = fresh.syncedAtMs ?? Int64(Date().timeIntervalSince1970 * 1000)
            state.dashboard = fresh.dashboard
            state.recentEvents = mergeEvents(state.recentEvents, fresh.dashboard?.recentActivity ?? [])
            state.tasks = fresh.tasks
            state.approvals = fresh.approvals
            state.models = fresh.models
            state.modelInstances = fresh.modelInstances
            state.runtimes = fresh.runtimes
            state.agents = fresh.agents
            state.computers = fresh.computers
            state.resources = fresh.resources

            if let activeTaskId = state.activeTaskDetail?.taskId {
                await loadTaskDetail(activeTaskId)
            }
        } catch {
            state.isRefreshing = false
            state.isOfflineCached = true
            state.bannerMessage = "Showing cached controller state (\(error.localizedDescription))"
            state.bannerIsError = true
        }
    }

    private func handleIncomingStreamEvent(_ event: MobileStreamEvent) {
        guard let profile = state.activeController else { return }
        notificationManager.onStreamEvent(controllerId: profile.id, controllerName: profile.name, event: event)
        state.recentEvents = mergeEvents([event], state.recentEvents)
        state.isOfflineCached = false
        state.lastSyncedAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        Task { await refreshAll(silent: true) }
    }

    private func mergeEvents(_ primary: [MobileStreamEvent], _ secondary: [MobileStreamEvent]) -> [MobileStreamEvent] {
        var byId: [String: MobileStreamEvent] = [:]
        var order: [String] = []
        for item in primary + secondary {
            let key = item.eventId.isEmpty ? "seq:\(item.sequence):\(item.timestamp)" : item.eventId
            if byId[key] == nil {
                byId[key] = item
                order.append(key)
            }
        }
        return order.compactMap { byId[$0] }.sorted { $0.sequence > $1.sequence }.prefix(80).map { $0 }
    }

    // MARK: - Pairing & discovery

    func startMdnsScan() { mdnsDiscovery.startDiscovery() }
    func stopMdnsScan() { mdnsDiscovery.stopDiscovery() }

    func resetPairingStage() {
        pairingPollTask?.cancel()
        state.pairingStage = .idle
    }

    func pairFromQrUri(_ rawQrUri: String, overrideControllerUrl: String? = nil) {
        switch PairingUriParser.parse(rawQrUri) {
        case .failure(let err):
            state.pairingStage = .failed(err.localizedDescription)
        case .success(let parsed):
            let targetUrl = overrideControllerUrl?.nilIfBlank ?? parsed.controllerUrl
            guard let targetUrl, !targetUrl.isEmpty else {
                state.pairingStage = .failed("QR code does not include a controller URL. Enter the HTTPS controller address manually.")
                return
            }
            startPairingSession(baseUrl: targetUrl, tlsCertFingerprint: parsed.tlsCertFingerprint, sessionId: parsed.sessionId, pairingSecret: parsed.pairingSecret, controllerName: parsed.controllerName)
        }
    }

    func startPairingSession(baseUrl: String, tlsCertFingerprint: String?, sessionId: String, pairingSecret: String, controllerName: String = "Wazir Controller", deviceNameOverride: String? = nil) {
        pairingPollTask?.cancel()
        state.pairingStage = .requestingSession
        state.bannerMessage = nil

        pairingPollTask = Task { [weak self] in
            guard let self else { return }
            do {
                let reqResp = try await repository.initiatePairing(baseUrl: baseUrl, tlsCertFingerprint: tlsCertFingerprint, sessionId: sessionId, pairingSecret: pairingSecret, deviceNameOverride: deviceNameOverride)
                let code = reqResp.confirmationCode ?? "------"
                let name = reqResp.controllerName ?? controllerName
                let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
                let expiresAt = reqResp.expiresAt ?? (nowMs + 300_000)

                state.pairingStage = .awaitingOperatorApproval(sessionId: sessionId, pairingSecret: pairingSecret, confirmationCode: code, controllerName: name, baseUrl: baseUrl, tlsCertFingerprint: tlsCertFingerprint, expiresAtMs: expiresAt)

                while !Task.isCancelled, Int64(Date().timeIntervalSince1970 * 1000) < expiresAt {
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    if Task.isCancelled { break }
                    do {
                        if let profile = try await repository.pollPairingCompletion(baseUrl: baseUrl, tlsCertFingerprint: tlsCertFingerprint, sessionId: sessionId, pairingSecret: pairingSecret, fallbackName: name) {
                            state.pairingStage = .completed(profile)
                            state.activeController = profile
                            state.bannerMessage = "Paired securely with \(profile.name)"
                            state.bannerIsError = false
                            await activateController(profile)
                            break
                        }
                    } catch {
                        state.pairingStage = .failed(error.localizedDescription)
                        break
                    }
                }
            } catch {
                state.pairingStage = .failed(error.localizedDescription)
            }
        }
    }

    func unpairController(_ controllerId: String) {
        repository.removeController(controllerId)
        state.bannerMessage = "Controller unpaired and device credentials wiped from Keychain."
        state.bannerIsError = false
    }

    // MARK: - Tasks

    func setTaskTab(_ tab: String) { state.selectedTaskTab = tab }

    func loadTaskDetail(_ taskId: String, startLivePolling: Bool = false) async {
        guard let profile = state.activeController else { return }
        let (detail, fromCache) = await repository.getTaskDetailWithOfflineFallback(profile, taskId: taskId)
        if let detail {
            state.activeTaskDetail = detail
            state.activeTaskDetailCached = fromCache
        }
        if startLivePolling { startTaskLivePolling(taskId) }
    }

    func startTaskLivePolling(_ taskId: String) {
        taskMonitorTask?.cancel()
        taskMonitorTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                guard let profile = state.activeController else { break }
                let (detail, fromCache) = await repository.getTaskDetailWithOfflineFallback(profile, taskId: taskId)
                if let detail {
                    state.activeTaskDetail = detail
                    state.activeTaskDetailCached = fromCache
                    if ["completed", "failed", "cancelled"].contains(detail.state) { break }
                }
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
    }

    func stopTaskLivePolling() {
        taskMonitorTask?.cancel()
        taskMonitorTask = nil
    }

    func submitNewTask(_ request: CreateTaskRequest, idempotencyKey: String = UUID().uuidString, onSubmitted: @escaping (String) -> Void) {
        guard let profile = state.activeController, !state.isSubmittingTask else { return }
        state.isSubmittingTask = true
        state.bannerMessage = nil
        Task {
            do {
                let resp = try await repository.submitTask(profile, request: request, idempotencyKey: idempotencyKey)
                let taskId = resp.taskId ?? resp.task?.taskId
                state.isSubmittingTask = false
                if let task = resp.task { state.activeTaskDetail = task }
                state.bannerMessage = resp.duplicate ? "Duplicate submission prevented (idempotent)" : "Task submitted"
                state.bannerIsError = false
                await refreshAll(silent: true)
                if let taskId, !taskId.isEmpty { onSubmitted(taskId) }
            } catch {
                state.isSubmittingTask = false
                state.bannerMessage = error.localizedDescription
                state.bannerIsError = true
            }
        }
    }

    func cancelTask(_ taskId: String) {
        guard let profile = state.activeController else { return }
        Task {
            do {
                let updated = try await repository.cancelTask(profile, taskId: taskId)
                if let updated { state.activeTaskDetail = updated }
                state.bannerMessage = "Task \(taskId) cancelled"
                state.bannerIsError = false
                await refreshAll(silent: true)
            } catch {
                state.bannerMessage = error.localizedDescription
                state.bannerIsError = true
            }
        }
    }

    func retryTask(_ taskId: String, onNewTaskCreated: ((String) -> Void)? = nil) {
        guard let profile = state.activeController else { return }
        Task {
            do {
                let resp = try await repository.retryTask(profile, taskId: taskId)
                let newId = resp.taskId ?? resp.task?.taskId
                if let task = resp.task { state.activeTaskDetail = task }
                state.bannerMessage = "Task retried (\(newId ?? taskId))"
                state.bannerIsError = false
                await refreshAll(silent: true)
                if let newId, !newId.isEmpty { onNewTaskCreated?(newId) }
            } catch {
                state.bannerMessage = error.localizedDescription
                state.bannerIsError = true
            }
        }
    }

    func resumeTask(_ taskId: String) {
        guard let profile = state.activeController else { return }
        Task {
            do {
                let resp = try await repository.resumeTask(profile, taskId: taskId)
                if let task = resp.task { state.activeTaskDetail = task }
                state.bannerMessage = "Task resumed"
                state.bannerIsError = false
                await refreshAll(silent: true)
            } catch {
                state.bannerMessage = error.localizedDescription
                state.bannerIsError = true
            }
        }
    }

    // MARK: - Approvals

    func resolveApproval(_ approval: MobileApprovalRecord, decision: String, biometricVerified: Bool, note: String? = nil) {
        guard let profile = state.activeController else { return }
        Task {
            let req = ResolveApprovalRequest(decision: decision, argumentsHash: approval.argumentsHash, taskId: approval.taskId, biometricVerified: biometricVerified, note: note)
            do {
                _ = try await repository.resolveApproval(profile, approvalId: approval.id, request: req)
                state.bannerMessage = "Approval \(approval.id) \(decision == "approve" ? "approved" : "rejected")"
                state.bannerIsError = false
                await refreshAll(silent: true)
            } catch {
                state.bannerMessage = error.localizedDescription
                state.bannerIsError = true
            }
        }
    }

    func clearBanner() { state.bannerMessage = nil }

    func teardown() {
        sseStream.disconnect()
        mdnsDiscovery.stopDiscovery()
    }
}

private extension String {
    var nilIfBlank: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}
