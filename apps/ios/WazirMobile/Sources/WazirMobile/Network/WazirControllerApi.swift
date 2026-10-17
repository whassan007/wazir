import Foundation

struct ApiError: Error, LocalizedError {
    let statusCode: Int
    let message: String
    let errorCode: String?

    var errorDescription: String? { "HTTP \(statusCode): \(message)" }
}

/// Mirrors `apps/android/.../network/WazirControllerApi.kt`. Every path below is pinned
/// to the real server route registered in `apps/api/src/mobile.ts` `registerMobileRoutes`
/// — the Android client shipped with three of these wrong (pairing/request vs pair/request,
/// pairing/complete vs pair/complete, emergency-resume vs resume) and it broke pairing
/// completely, so don't hand-edit a path here without checking that file.
actor WazirControllerApi {
    private let credentialVault: CredentialVault
    private let sessionOverride: URLSession?
    private var sessionCache: [String: URLSession] = [:]
    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        return e
    }()

    static let mobileAppVersion = "1.0.0"

    init(credentialVault: CredentialVault, sessionOverride: URLSession? = nil) {
        self.credentialVault = credentialVault
        self.sessionOverride = sessionOverride
    }

    private func session(for baseUrl: String, tlsCertFingerprint: String?, timeout: TimeInterval = 30) -> URLSession {
        if let override = sessionOverride { return override }
        let key = "\(baseUrl)|\(tlsCertFingerprint ?? "")|\(timeout)"
        if let cached = sessionCache[key] { return cached }
        let created = TlsPinningSessionFactory.makeSession(tlsCertFingerprint: tlsCertFingerprint, timeoutSeconds: timeout)
        sessionCache[key] = created
        return created
    }

    // MARK: - Pairing (public, pre-auth)

    func requestPairing(baseUrl: String, tlsCertFingerprint: String?, payload: PairingRequestPayload) async throws -> PairingRequestResponse {
        let cleanUrl = try unwrap(PairingUriParser.validateControllerBaseUrl(baseUrl, allowLoopbackHttp: true))
        var request = URLRequest(url: try url(cleanUrl, "/api/v1/mobile/pair/request"))
        request.httpMethod = "POST"
        request.setValue(Self.mobileAppVersion, forHTTPHeaderField: "X-Wazir-Mobile-Version")
        request.httpBody = try encoder.encode(payload)
        let (data, response) = try await session(for: cleanUrl, tlsCertFingerprint: tlsCertFingerprint).data(for: request)
        let parsed = try decodeOrEmpty(PairingRequestResponse.self, data: data)
        guard (response as? HTTPURLResponse)?.isSuccess == true, parsed.ok else {
            throw ApiError(statusCode: (response as? HTTPURLResponse)?.statusCode ?? 0, message: parsed.error ?? "Pairing request failed", errorCode: parsed.code)
        }
        return parsed
    }

    func completePairing(baseUrl: String, tlsCertFingerprint: String?, sessionId: String, pairingSecret: String, deviceId: String) async throws -> PairingCompleteResponse {
        let cleanUrl = try unwrap(PairingUriParser.validateControllerBaseUrl(baseUrl, allowLoopbackHttp: true))
        var request = URLRequest(url: try url(cleanUrl, "/api/v1/mobile/pair/complete"))
        request.httpMethod = "POST"
        request.setValue(Self.mobileAppVersion, forHTTPHeaderField: "X-Wazir-Mobile-Version")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["sessionId": sessionId, "pairingSecret": pairingSecret, "deviceId": deviceId])
        let (data, response) = try await session(for: cleanUrl, tlsCertFingerprint: tlsCertFingerprint).data(for: request)
        let parsed = try decodeOrEmpty(PairingCompleteResponse.self, data: data)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code >= 400 && parsed.status != "awaiting_operator_approval" && parsed.status != "pending_operator_approval" {
            throw ApiError(statusCode: code, message: parsed.error ?? "Pairing completion failed", errorCode: parsed.code)
        }
        return parsed
    }

    // MARK: - Authenticated reads

    func handshake(_ profile: ControllerProfile) async throws -> HandshakeResponse {
        try await executeAuthenticated(profile, method: "GET", path: "/api/v1/mobile/handshake")
    }

    func getDashboard(_ profile: ControllerProfile) async throws -> DashboardSnapshot {
        try await executeAuthenticated(profile, method: "GET", path: "/api/v1/mobile/dashboard")
    }

    func listTasks(_ profile: ControllerProfile, stateFilter: String? = nil) async throws -> TaskListResponse {
        var path = "/api/v1/mobile/tasks"
        if let f = stateFilter, !f.isEmpty, f != "all" {
            path += "?state=\(f.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? f)"
        }
        return try await executeAuthenticated(profile, method: "GET", path: path)
    }

    func getTaskDetail(_ profile: ControllerProfile, taskId: String) async throws -> MobileTaskDetail {
        let envelope: TaskDetailEnvelope = try await executeAuthenticated(profile, method: "GET", path: "/api/v1/mobile/tasks/\(encodePathComponent(taskId))")
        return envelope.task
    }

    // MARK: - Task mutation (device-reachable: auth.requireOperatorOrDevice server-side)

    func submitTask(_ profile: ControllerProfile, request: CreateTaskRequest, idempotencyKey: String = UUID().uuidString) async throws -> SubmitTaskResponse {
        try await executeAuthenticated(profile, method: "POST", path: "/api/v1/mobile/tasks", body: try encoder.encode(request), idempotencyKey: idempotencyKey)
    }

    func cancelTask(_ profile: ControllerProfile, taskId: String, idempotencyKey: String = UUID().uuidString) async throws -> MobileTaskDetail? {
        let resp: SubmitTaskResponse = try await executeAuthenticated(profile, method: "POST", path: "/api/v1/mobile/tasks/\(encodePathComponent(taskId))/cancel", body: Data("{}".utf8), idempotencyKey: idempotencyKey)
        return resp.task
    }

    func retryTask(_ profile: ControllerProfile, taskId: String, idempotencyKey: String = UUID().uuidString) async throws -> SubmitTaskResponse {
        try await executeAuthenticated(profile, method: "POST", path: "/api/v1/mobile/tasks/\(encodePathComponent(taskId))/retry", body: Data("{}".utf8), idempotencyKey: idempotencyKey)
    }

    func resumeTask(_ profile: ControllerProfile, taskId: String, idempotencyKey: String = UUID().uuidString) async throws -> SubmitTaskResponse {
        try await executeAuthenticated(profile, method: "POST", path: "/api/v1/mobile/tasks/\(encodePathComponent(taskId))/resume", body: Data("{}".utf8), idempotencyKey: idempotencyKey)
    }

    // MARK: - Approvals (device-reachable)

    func listApprovals(_ profile: ControllerProfile, status: String? = nil) async throws -> ApprovalListResponse {
        var path = "/api/v1/mobile/approvals"
        if let s = status, !s.isEmpty {
            path += "?status=\(s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s)"
        }
        return try await executeAuthenticated(profile, method: "GET", path: path)
    }

    func resolveApproval(_ profile: ControllerProfile, approvalId: String, request: ResolveApprovalRequest, idempotencyKey: String = UUID().uuidString) async throws -> ResolveApprovalResponse {
        try await executeAuthenticated(profile, method: "POST", path: "/api/v1/mobile/approvals/\(encodePathComponent(approvalId))/resolve", body: try encoder.encode(request), idempotencyKey: idempotencyKey)
    }

    // MARK: - Read-only catalog (non-mobile-prefixed routes)

    func getModels(_ profile: ControllerProfile) async throws -> ModelsApiResponse {
        try await executeAuthenticated(profile, method: "GET", path: "/api/v1/models")
    }

    func getRuntimes(_ profile: ControllerProfile) async throws -> RuntimesApiResponse {
        try await executeAuthenticated(profile, method: "GET", path: "/api/v1/runtimes")
    }

    func getAgents(_ profile: ControllerProfile) async throws -> AgentsApiResponse {
        try await executeAuthenticated(profile, method: "GET", path: "/api/v1/agents")
    }

    // MARK: - Operator-only (auth.requireOperator server-side — a device credential can
    // NEVER satisfy this, by design; kept here only so a future operator-mode client can
    // use the same client. Do not wire these into device-facing UI — see HANDOFF.md.)

    func reconcileModels(_ profile: ControllerProfile, idempotencyKey: String = UUID().uuidString) async throws {
        let _: EmptyOkResponse = try await executeAuthenticated(profile, method: "POST", path: "/api/v1/models/reconcile", body: Data("{}".utf8), idempotencyKey: idempotencyKey)
    }

    func getComputers(_ profile: ControllerProfile) async throws -> ComputersApiResponse {
        try await executeAuthenticated(profile, method: "GET", path: "/api/v1/mobile/computers")
    }

    func getResourceBudget(_ profile: ControllerProfile) async throws -> ResourceBudgetSnapshot {
        try await executeAuthenticated(profile, method: "GET", path: "/api/v1/mobile/resources")
    }

    func emergencyStop(_ profile: ControllerProfile, reason: String, idempotencyKey: String = UUID().uuidString) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["reason": reason])
        let _: EmptyOkResponse = try await executeAuthenticated(profile, method: "POST", path: "/api/v1/mobile/resources/emergency-stop", body: body, idempotencyKey: idempotencyKey)
    }

    func emergencyResume(_ profile: ControllerProfile, idempotencyKey: String = UUID().uuidString) async throws {
        // NOT "/emergency-resume" — the real route is "/resources/resume" (see mobile.ts).
        let _: EmptyOkResponse = try await executeAuthenticated(profile, method: "POST", path: "/api/v1/mobile/resources/resume", body: Data("{}".utf8), idempotencyKey: idempotencyKey)
    }

    // MARK: - Token rotation

    @discardableResult
    func rotateTokenIfNeeded(_ profile: ControllerProfile, force: Bool = false) async throws -> StoredDeviceCredential? {
        guard let current = credentialVault.getCredential(controllerId: profile.id) else { return nil }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        if !force && current.expiresAt > nowMs + 60_000 {
            return current
        }

        let cleanUrl = trimmedTrailingSlash(profile.baseUrl)
        var request = URLRequest(url: try url(cleanUrl, "/api/v1/mobile/auth/rotate"))
        request.httpMethod = "POST"
        request.setValue(Self.mobileAppVersion, forHTTPHeaderField: "X-Wazir-Mobile-Version")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["deviceId": current.deviceId, "refreshToken": current.refreshToken])

        guard let (data, response) = try? await session(for: cleanUrl, tlsCertFingerprint: profile.tlsCertFingerprint).data(for: request),
              (response as? HTTPURLResponse)?.isSuccess == true else {
            return nil
        }
        let rotated = try decodeOrEmpty(TokenRotationResponse.self, data: data)
        guard rotated.ok, let access = rotated.accessToken, !access.isEmpty, let refresh = rotated.refreshToken, !refresh.isEmpty else {
            return nil
        }
        let updated = StoredDeviceCredential(
            controllerId: profile.id,
            deviceId: rotated.deviceId ?? current.deviceId,
            accessToken: access,
            refreshToken: refresh,
            expiresAt: rotated.expiresAt ?? (nowMs + 24 * 3_600_000),
            scopes: rotated.scopes.isEmpty ? current.scopes : rotated.scopes
        )
        credentialVault.saveCredential(updated)
        return updated
    }

    // MARK: - Core authenticated request path

    private func executeAuthenticated<T: Decodable>(
        _ profile: ControllerProfile,
        method: String,
        path: String,
        body: Data? = nil,
        idempotencyKey: String? = nil
    ) async throws -> T {
        let cleanUrl = try unwrap(PairingUriParser.validateControllerBaseUrl(profile.baseUrl, allowLoopbackHttp: true))
        let initial = try await rotateTokenIfNeeded(profile, force: false) ?? credentialVault.getCredential(controllerId: profile.id)
        guard var cred = initial else {
            throw ApiError(statusCode: 401, message: "No stored device credential for controller \(profile.name)", errorCode: "missing_credential")
        }

        func buildRequest(token: String) throws -> URLRequest {
            var req = URLRequest(url: try url(cleanUrl, path))
            req.httpMethod = method
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue(Self.mobileAppVersion, forHTTPHeaderField: "X-Wazir-Mobile-Version")
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            if let idem = idempotencyKey, !idem.isEmpty {
                req.setValue(idem, forHTTPHeaderField: "Idempotency-Key")
            }
            if method == "POST" {
                req.httpBody = body ?? Data("{}".utf8)
                req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            }
            return req
        }

        let sessionForProfile = session(for: cleanUrl, tlsCertFingerprint: profile.tlsCertFingerprint)
        var (data, response) = try await sessionForProfile.data(for: buildRequest(token: cred.accessToken))
        if (response as? HTTPURLResponse)?.statusCode == 401 {
            if let rotated = try await rotateTokenIfNeeded(profile, force: true) {
                cred = rotated
                (data, response) = try await sessionForProfile.data(for: buildRequest(token: cred.accessToken))
            } else {
                throw ApiError(statusCode: 401, message: "Device session expired or revoked by controller", errorCode: "unauthorized")
            }
        }

        guard let http = response as? HTTPURLResponse else {
            throw ApiError(statusCode: 0, message: "No HTTP response", errorCode: nil)
        }
        guard http.isSuccess else {
            let (message, code) = extractErrorDetails(data: data, statusCode: http.statusCode)
            throw ApiError(statusCode: http.statusCode, message: message, errorCode: code)
        }
        return try decodeOrEmpty(T.self, data: data)
    }

    private func extractErrorDetails(data: Data, statusCode: Int) -> (String, String?) {
        guard !data.isEmpty, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ("HTTP \(statusCode)", nil)
        }
        let message = (obj["error"] as? String) ?? "HTTP \(statusCode)"
        let code = obj["code"] as? String
        return (message, code)
    }

    private func decodeOrEmpty<T: Decodable>(_ type: T.Type, data: Data) throws -> T {
        let effective = data.isEmpty ? Data("{}".utf8) : data
        return try JSONDecoder().decode(T.self, from: effective)
    }

    private func url(_ baseUrl: String, _ path: String) throws -> URL {
        guard let u = URL(string: baseUrl + path) else {
            throw ApiError(statusCode: 0, message: "Invalid URL: \(baseUrl + path)", errorCode: nil)
        }
        return u
    }

    private func encodePathComponent(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }

    private func trimmedTrailingSlash(_ s: String) -> String {
        var t = s
        while t.hasSuffix("/") { t.removeLast() }
        return t
    }

    private func unwrap<T>(_ result: Result<T, Error>) throws -> T {
        switch result {
        case .success(let v): return v
        case .failure(let e): throw e
        }
    }
}

/// Decodes `{"ok": true, ...}`-shaped responses where only success/failure matters.
struct EmptyOkResponse: Decodable {
    var ok: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok, default: true)
    }
    private enum CodingKeys: String, CodingKey { case ok }
}

private extension HTTPURLResponse {
    var isSuccess: Bool { (200...299).contains(statusCode) }
}
