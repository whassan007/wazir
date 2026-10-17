import Foundation
#if canImport(UIKit)
import UIKit
#endif

enum RepositoryError: Error, LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let m): return m }
    }
}

/// Mirrors Android's `WazirRepository`: ties `WazirControllerApi` (network),
/// `CredentialVault` (Keychain secrets), and `ControllerStore` (cached, non-secret
/// controller/task state) together behind one API the view model calls.
@MainActor
final class WazirRepository {
    let api: WazirControllerApi
    private let credentialVault: CredentialVault
    private let store: ControllerStore

    init(credentialVault: CredentialVault, store: ControllerStore) {
        self.credentialVault = credentialVault
        self.store = store
        self.api = WazirControllerApi(credentialVault: credentialVault)
    }

    var controllers: [ControllerProfile] { store.controllers }

    // MARK: - Pairing

    func initiatePairing(baseUrl: String, tlsCertFingerprint: String?, sessionId: String, pairingSecret: String, deviceNameOverride: String? = nil) async throws -> PairingRequestResponse {
        let (deviceId, publicKeyFp) = credentialVault.getOrCreateDeviceIdentity()
        let deviceName = deviceNameOverride?.nilIfBlank ?? Self.deviceDisplayName()
        let payload = PairingRequestPayload(
            sessionId: sessionId.trimmingCharacters(in: .whitespaces),
            pairingSecret: pairingSecret.trimmingCharacters(in: .whitespaces),
            deviceId: deviceId,
            deviceName: deviceName,
            deviceModel: Self.deviceModel(),
            osVersion: "iOS \(Self.osVersion())",
            publicKeyFingerprint: publicKeyFp
        )
        return try await api.requestPairing(baseUrl: baseUrl, tlsCertFingerprint: tlsCertFingerprint, payload: payload)
    }

    /// Returns nil while still awaiting operator approval (not an error — the caller keeps polling).
    func pollPairingCompletion(baseUrl: String, tlsCertFingerprint: String?, sessionId: String, pairingSecret: String, fallbackName: String) async throws -> ControllerProfile? {
        let (deviceId, _) = credentialVault.getOrCreateDeviceIdentity()
        let resp = try await api.completePairing(baseUrl: baseUrl, tlsCertFingerprint: tlsCertFingerprint, sessionId: sessionId, pairingSecret: pairingSecret, deviceId: deviceId)

        if resp.status == "awaiting_operator_approval" || resp.status == "pending_operator_approval" {
            return nil
        }
        guard resp.ok, let accessToken = resp.accessToken, !accessToken.isEmpty,
              let refreshToken = resp.refreshToken, !refreshToken.isEmpty else {
            throw RepositoryError.message(resp.error ?? "Pairing did not return valid device credentials")
        }

        let controllerMeta = resp.controller
        let controllerId = controllerMeta?.id.nilIfBlank ?? "ctrl-\(String(sessionId.prefix(8)))"
        let controllerName = controllerMeta?.name.nilIfBlank ?? fallbackName
        let issuedDeviceId = resp.deviceId ?? deviceId
        let scopes = resp.scopes.isEmpty ? ["read", "mutate", "execute"] : resp.scopes
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let expiresAt = resp.expiresAt ?? (nowMs + 24 * 3_600_000)

        credentialVault.saveCredential(StoredDeviceCredential(
            controllerId: controllerId, deviceId: issuedDeviceId, accessToken: accessToken,
            refreshToken: refreshToken, expiresAt: expiresAt, scopes: scopes
        ))

        var trimmedUrl = baseUrl
        while trimmedUrl.hasSuffix("/") { trimmedUrl.removeLast() }

        let profile = ControllerProfile(
            id: controllerId, name: controllerName, baseUrl: trimmedUrl, deviceId: issuedDeviceId,
            scopes: scopes, tlsCertFingerprint: tlsCertFingerprint,
            controllerVersion: controllerMeta?.version ?? "0.1.68", apiVersion: controllerMeta?.apiVersion ?? "1.0.0",
            pairedAt: nowMs, lastConnectedAt: nowMs
        )
        store.upsertController(profile)
        return profile
    }

    func removeController(_ controllerId: String) {
        credentialVault.removeCredential(controllerId: controllerId)
        store.removeController(controllerId)
    }

    // MARK: - State sync

    func loadCachedState(_ controllerId: String) -> ControllerCachedState {
        store.loadCachedState(controllerId)
    }

    /// Fetches everything in parallel. If both the dashboard and task list fail, the whole
    /// call fails (so the UI falls back to cached/offline state) — otherwise it merges
    /// whatever succeeded with the last-known cache, matching Android's partial-failure
    /// tolerance.
    func refreshControllerState(_ profile: ControllerProfile, lastKnownSequence: Int64) async throws -> ControllerCachedState {
        async let dashboardRes = try? api.getDashboard(profile)
        async let tasksRes = try? api.listTasks(profile)
        async let approvalsRes = try? api.listApprovals(profile)
        async let modelsRes = try? api.getModels(profile)
        async let runtimesRes = try? api.getRuntimes(profile)
        async let agentsRes = try? api.getAgents(profile)
        async let computersRes = try? api.getComputers(profile)
        async let resourcesRes = try? api.getResourceBudget(profile)
        async let autonomyRes = try? api.getAutonomy(profile)
        async let schedulesRes = try? api.listSchedules(profile)
        async let pushStatusRes = try? api.getPushRelayStatus(profile)

        let (dashboard, tasks, approvals, models, runtimes, agents, computers, resources, autonomy, schedules, pushStatus) =
            await (dashboardRes, tasksRes, approvalsRes, modelsRes, runtimesRes, agentsRes, computersRes, resourcesRes, autonomyRes, schedulesRes, pushStatusRes)

        if dashboard == nil && tasks == nil {
            throw RepositoryError.message("Unable to reach Wazir controller")
        }

        let existing = store.loadCachedState(profile.id)
        let maxSeqFromDashboard = dashboard?.recentActivity.map(\.sequence).max() ?? 0
        let nextSeq = max(lastKnownSequence, existing.lastSequence, maxSeqFromDashboard)
        let now = Int64(Date().timeIntervalSince1970 * 1000)

        let merged = ControllerCachedState(
            dashboard: dashboard ?? existing.dashboard,
            tasks: tasks?.tasks ?? existing.tasks,
            approvals: approvals?.approvals ?? existing.approvals,
            models: models?.models ?? existing.models,
            modelInstances: models?.instances ?? existing.modelInstances,
            runtimes: runtimes?.runtimes ?? existing.runtimes,
            agents: agents?.agents ?? existing.agents,
            computers: computers?.computers ?? existing.computers,
            resources: resources ?? existing.resources,
            autonomy: autonomy ?? existing.autonomy,
            schedules: schedules?.schedules ?? existing.schedules,
            pushRegistrations: pushStatus?.registrations ?? existing.pushRegistrations,
            recentPushWakeups: pushStatus?.recentWakeups ?? existing.recentPushWakeups,
            lastSequence: nextSeq,
            syncedAtMs: now
        )
        store.saveSnapshot(profile.id, state: merged)
        var updated = profile
        updated.lastConnectedAt = now
        store.upsertController(updated)
        return merged
    }

    func getTaskDetailWithOfflineFallback(_ profile: ControllerProfile, taskId: String) async -> (detail: MobileTaskDetail?, fromCache: Bool) {
        if let detail = try? await api.getTaskDetail(profile, taskId: taskId) {
            store.saveTaskDetail(profile.id, taskId, detail: detail)
            return (detail, false)
        }
        return (store.getTaskDetail(profile.id, taskId), true)
    }

    // MARK: - Task mutation

    func submitTask(_ profile: ControllerProfile, request: CreateTaskRequest, idempotencyKey: String) async throws -> SubmitTaskResponse {
        try await api.submitTask(profile, request: request, idempotencyKey: idempotencyKey)
    }

    func cancelTask(_ profile: ControllerProfile, taskId: String) async throws -> MobileTaskDetail? {
        try await api.cancelTask(profile, taskId: taskId)
    }

    func retryTask(_ profile: ControllerProfile, taskId: String) async throws -> SubmitTaskResponse {
        try await api.retryTask(profile, taskId: taskId)
    }

    func resumeTask(_ profile: ControllerProfile, taskId: String) async throws -> SubmitTaskResponse {
        try await api.resumeTask(profile, taskId: taskId)
    }

    func resolveApproval(_ profile: ControllerProfile, approvalId: String, request: ResolveApprovalRequest) async throws -> ResolveApprovalResponse {
        try await api.resolveApproval(profile, approvalId: approvalId, request: request)
    }

    // MARK: - Multi-Surface & Push Relay

    func updateAutonomy(_ profile: ControllerProfile, posture: String? = nil, networkGuard: String? = nil) async throws -> MobileAutonomyState {
        try await api.updateAutonomy(profile, request: UpdateAutonomyRequest(posture: posture, networkGuard: networkGuard))
    }

    func getTaskArtifacts(_ profile: ControllerProfile, taskId: String) async throws -> TaskArtifactsResponse {
        try await api.getTaskArtifacts(profile, taskId: taskId)
    }

    func reviewTaskDiffFile(_ profile: ControllerProfile, taskId: String, path: String, decision: String) async throws -> TaskDiffReviewResponse {
        try await api.reviewTaskDiffFile(profile, taskId: taskId, path: path, decision: decision)
    }

    func createSchedule(_ profile: ControllerProfile, request: CreateScheduleRequest) async throws -> ScheduleMutationResponse {
        try await api.createSchedule(profile, request: request)
    }

    func toggleSchedule(_ profile: ControllerProfile, scheduleId: String, enabled: Bool) async throws -> ScheduleMutationResponse {
        try await api.toggleSchedule(profile, scheduleId: scheduleId, enabled: enabled)
    }

    func runScheduleNow(_ profile: ControllerProfile, scheduleId: String) async throws -> ScheduleMutationResponse {
        try await api.runScheduleNow(profile, scheduleId: scheduleId)
    }

    func deleteSchedule(_ profile: ControllerProfile, scheduleId: String) async throws -> ScheduleMutationResponse {
        try await api.deleteSchedule(profile, scheduleId: scheduleId)
    }

    func registerPushRelay(
        _ profile: ControllerProfile,
        provider: String = "apns",
        pushToken: String? = nil,
        relayEndpointUrl: String? = nil,
        enabled: Bool = true,
        notifyApprovals: Bool = true,
        notifyTaskTerminal: Bool = true
    ) async throws -> RegisterPushRelayResponse {
        let (deviceId, _) = credentialVault.getOrCreateDeviceIdentity()
        let effectiveToken = pushToken?.nilIfBlank ?? "wazir-apns-token-\(deviceId)"
        let request = RegisterPushRelayRequest(
            deviceId: deviceId,
            deviceName: Self.deviceDisplayName(),
            provider: provider,
            pushToken: effectiveToken,
            relayEndpointUrl: relayEndpointUrl?.nilIfBlank,
            enabled: enabled,
            notifyApprovals: notifyApprovals,
            notifyTaskTerminal: notifyTaskTerminal
        )
        return try await api.registerPushRelay(profile, request: request)
    }

    func unregisterPushRelay(_ profile: ControllerProfile) async throws {
        let (deviceId, _) = credentialVault.getOrCreateDeviceIdentity()
        try await api.unregisterPushRelay(profile, deviceId: deviceId)
    }

    func testPushWakeup(_ profile: ControllerProfile, title: String? = nil) async throws -> TestPushWakeupResponse {
        let (deviceId, _) = credentialVault.getOrCreateDeviceIdentity()
        return try await api.testPushWakeup(profile, deviceId: deviceId, title: title)
    }

    private static func deviceDisplayName() -> String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return "iPhone"
        #endif
    }

    private static func deviceModel() -> String {
        #if canImport(UIKit)
        return UIDevice.current.model
        #else
        return "iOS Device"
        #endif
    }

    private static func osVersion() -> String {
        #if canImport(UIKit)
        return UIDevice.current.systemVersion
        #else
        return ProcessInfo.processInfo.operatingSystemVersionString
        #endif
    }
}

private extension String {
    var nilIfBlank: String? {
        trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self
    }
}

private extension Optional where Wrapped == String {
    var nilIfBlank: String? {
        guard let self else { return nil }
        return self.nilIfBlank
    }
}
