import XCTest
@testable import WazirMobile

/// Pins every `WazirControllerApi` request to the exact path/method the real controller
/// (`apps/api/src/mobile.ts` `registerMobileRoutes`) exposes — mirrors
/// `apps/android/.../WazirControllerApiTest.kt`, including the exact regression (a client
/// path drifting from the server's real route, e.g. "pairing/request" vs "pair/request")
/// that test suite caught on Android.
final class WazirControllerApiTests: XCTestCase {
    var vault: InMemoryCredentialVault!
    var api: WazirControllerApi!
    var profile: ControllerProfile!

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
        vault = InMemoryCredentialVault()
        api = WazirControllerApi(credentialVault: vault, sessionOverride: StubURLProtocol.makeSession())
        profile = ControllerProfile(id: "ctrl-1", name: "Test Controller", baseUrl: "https://controller.test", deviceId: "ios-test")
        vault.saveCredential(StoredDeviceCredential(
            controllerId: profile.id,
            deviceId: profile.deviceId,
            accessToken: "initial-access-token",
            refreshToken: "initial-refresh-token",
            expiresAt: Int64(Date().timeIntervalSince1970 * 1000) + 3_600_000,
            scopes: ["read", "mutate", "execute"]
        ))
    }

    private func lastPath() -> String? {
        StubURLProtocol.recorded.last?.url?.path
    }

    private func lastQueryPath() -> String? {
        guard let url = StubURLProtocol.recorded.last?.url else { return nil }
        return url.path + (url.query.map { "?\($0)" } ?? "")
    }

    func testRequestPairingPostsToPairRequest() async throws {
        StubURLProtocol.enqueue(body: #"{"ok":true,"sessionId":"s1","status":"pending_operator_approval","confirmationCode":"123-456","controllerName":"Mac","expiresAt":1}"#)
        _ = try await api.requestPairing(baseUrl: profile.baseUrl, tlsCertFingerprint: nil, payload: PairingRequestPayload(sessionId: "s1", pairingSecret: "secret", deviceId: "d1", deviceName: "iPhone"))
        XCTAssertEqual(lastPath(), "/api/v1/mobile/pair/request")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")
    }

    func testCompletePairingPostsToPairComplete() async throws {
        StubURLProtocol.enqueue(body: #"{"ok":true,"status":"pending_operator_approval","expiresAt":1}"#)
        _ = try await api.completePairing(baseUrl: profile.baseUrl, tlsCertFingerprint: nil, sessionId: "s1", pairingSecret: "secret", deviceId: "d1")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/pair/complete")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")
    }

    func testHandshakeGetsHandshakeWithBearerAuth() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.handshake(profile)
        XCTAssertEqual(lastPath(), "/api/v1/mobile/handshake")
        XCTAssertEqual(StubURLProtocol.recorded.last?.value(forHTTPHeaderField: "Authorization"), "Bearer initial-access-token")
    }

    func testGetDashboardHitsDashboardEndpoint() async throws {
        StubURLProtocol.enqueue(body: #"{"controller":{},"cards":{}}"#)
        _ = try await api.getDashboard(profile)
        XCTAssertEqual(lastPath(), "/api/v1/mobile/dashboard")
    }

    func testListTasksAppliesStateFilter() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.listTasks(profile, stateFilter: "running")
        XCTAssertEqual(lastQueryPath(), "/api/v1/mobile/tasks?state=running")
    }

    func testListTasksOmitsQueryForAll() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.listTasks(profile, stateFilter: "all")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/tasks")
    }

    func testSubmitTaskPostsWithIdempotencyKey() async throws {
        StubURLProtocol.enqueue(body: #"{"taskId":"t1"}"#)
        _ = try await api.submitTask(profile, request: CreateTaskRequest(input: "do the thing"), idempotencyKey: "idem-1")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/tasks")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")
        XCTAssertEqual(StubURLProtocol.recorded.last?.value(forHTTPHeaderField: "Idempotency-Key"), "idem-1")
    }

    func testCancelTaskPostsToCancelSubRoute() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.cancelTask(profile, taskId: "t1")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/tasks/t1/cancel")
    }

    func testRetryTaskPostsToRetrySubRoute() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.retryTask(profile, taskId: "t1")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/tasks/t1/retry")
    }

    func testResumeTaskPostsToResumeSubRoute() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.resumeTask(profile, taskId: "t1")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/tasks/t1/resume")
    }

    func testListApprovalsAppliesStatusFilter() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.listApprovals(profile, status: "pending")
        XCTAssertEqual(lastQueryPath(), "/api/v1/mobile/approvals?status=pending")
    }

    func testResolveApprovalPostsToResolveSubRoute() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.resolveApproval(profile, approvalId: "appr-1", request: ResolveApprovalRequest(decision: "approve", argumentsHash: "hash"))
        XCTAssertEqual(lastPath(), "/api/v1/mobile/approvals/appr-1/resolve")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")
    }

    func testCatalogRoutesAreNonMobilePrefixed() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.getModels(profile)
        XCTAssertEqual(lastPath(), "/api/v1/models")

        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.getRuntimes(profile)
        XCTAssertEqual(lastPath(), "/api/v1/runtimes")

        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.getAgents(profile)
        XCTAssertEqual(lastPath(), "/api/v1/agents")
    }

    func testGetComputersHitsMobileComputersRoute() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.getComputers(profile)
        XCTAssertEqual(lastPath(), "/api/v1/mobile/computers")
    }

    func testGetResourceBudgetHitsMobileResourcesRoute() async throws {
        StubURLProtocol.enqueue(body: "{}")
        _ = try await api.getResourceBudget(profile)
        XCTAssertEqual(lastPath(), "/api/v1/mobile/resources")
    }

    func testEmergencyStopPostsToResourcesEmergencyStop() async throws {
        StubURLProtocol.enqueue(body: "{}")
        try await api.emergencyStop(profile, reason: "testing")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/resources/emergency-stop")
    }

    func testEmergencyResumePostsToResourcesResumeNotEmergencyResume() async throws {
        StubURLProtocol.enqueue(body: "{}")
        try await api.emergencyResume(profile)
        XCTAssertEqual(lastPath(), "/api/v1/mobile/resources/resume")
    }

    func test401TriggersTokenRotationAndRetriesOnce() async throws {
        StubURLProtocol.enqueue(statusCode: 401, body: "{}")
        StubURLProtocol.enqueue(body: #"{"ok":true,"deviceId":"ios-test","accessToken":"rotated-access-token","refreshToken":"rotated-refresh-token","expiresAt":9999999999999,"scopes":["read","mutate","execute"]}"#)
        StubURLProtocol.enqueue(body: "{}")

        _ = try await api.getComputers(profile)

        XCTAssertEqual(StubURLProtocol.recorded.count, 3)
        XCTAssertEqual(StubURLProtocol.recorded[0].url?.path, "/api/v1/mobile/computers")
        XCTAssertEqual(StubURLProtocol.recorded[0].value(forHTTPHeaderField: "Authorization"), "Bearer initial-access-token")
        XCTAssertEqual(StubURLProtocol.recorded[1].url?.path, "/api/v1/mobile/auth/rotate")
        XCTAssertEqual(StubURLProtocol.recorded[2].url?.path, "/api/v1/mobile/computers")
        XCTAssertEqual(StubURLProtocol.recorded[2].value(forHTTPHeaderField: "Authorization"), "Bearer rotated-access-token")
        XCTAssertEqual(vault.getCredential(controllerId: profile.id)?.accessToken, "rotated-access-token")
    }

    func test401WithNoCredentialSurfacesAsUnauthorizedWithoutARequest() async throws {
        vault.removeCredential(controllerId: profile.id)
        do {
            _ = try await api.getComputers(profile)
            XCTFail("expected an error")
        } catch {
            XCTAssertTrue(error is ApiError)
        }
        XCTAssertEqual(StubURLProtocol.recorded.count, 0)
    }

    func testMultiSurfaceAutonomyRoutes() async throws {
        StubURLProtocol.enqueue(body: #"{"ok":true,"posture":"request-review","networkGuard":"normal"}"#)
        let current = try await api.getAutonomy(profile)
        XCTAssertEqual(lastPath(), "/api/v1/mobile/autonomy")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "GET")
        XCTAssertEqual(current.posture, "request-review")

        StubURLProtocol.enqueue(body: #"{"ok":true,"posture":"auto-sandbox","networkGuard":"strict-cellular"}"#)
        let updated = try await api.updateAutonomy(profile, request: UpdateAutonomyRequest(posture: "auto-sandbox", networkGuard: "strict-cellular"))
        XCTAssertEqual(lastPath(), "/api/v1/mobile/autonomy")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")
        XCTAssertEqual(updated.posture, "auto-sandbox")
        XCTAssertEqual(updated.networkGuard, "strict-cellular")
    }

    func testTaskArtifactsAndDiffReviewRoutes() async throws {
        StubURLProtocol.enqueue(body: #"{"ok":true,"taskId":"t-9","artifacts":[{"id":"art-1","kind":"code_diff","title":"Diff","files":[{"path":"src/app.ts","additions":4,"deletions":1}]}]}"#)
        let artifacts = try await api.getTaskArtifacts(profile, taskId: "t-9")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/tasks/t-9/artifacts")
        XCTAssertEqual(artifacts.artifacts.count, 1)

        StubURLProtocol.enqueue(body: #"{"ok":true,"taskId":"t-9","reviews":[{"path":"src/app.ts","decision":"accepted"}]}"#)
        let review = try await api.reviewTaskDiffFile(profile, taskId: "t-9", path: "src/app.ts", decision: "accepted")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/tasks/t-9/diff-review")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")
        XCTAssertEqual(review.reviews.first?.decision, "accepted")
    }

    func testScheduleManagementRoutes() async throws {
        StubURLProtocol.enqueue(body: #"{"schedules":[{"id":"sch-1","name":"Nightly","prompt":"Audit","cronExpression":"0 * * * *","enabled":true}],"count":1}"#)
        let listed = try await api.listSchedules(profile)
        XCTAssertEqual(lastPath(), "/api/v1/mobile/schedules")
        XCTAssertEqual(listed.schedules.count, 1)

        StubURLProtocol.enqueue(body: #"{"ok":true,"schedule":{"id":"sch-2","name":"Hourly","prompt":"Check","cronExpression":"0 * * * *"}}"#)
        _ = try await api.createSchedule(profile, request: CreateScheduleRequest(name: "Hourly", prompt: "Check", cronExpression: "0 * * * *"))
        XCTAssertEqual(lastPath(), "/api/v1/mobile/schedules")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")

        StubURLProtocol.enqueue(body: #"{"ok":true}"#)
        _ = try await api.toggleSchedule(profile, scheduleId: "sch-2", enabled: false)
        XCTAssertEqual(lastPath(), "/api/v1/mobile/schedules/sch-2/toggle")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")

        StubURLProtocol.enqueue(body: #"{"ok":true,"executionId":"exec-2"}"#)
        _ = try await api.runScheduleNow(profile, scheduleId: "sch-2")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/schedules/sch-2/run")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")

        StubURLProtocol.enqueue(body: #"{"ok":true,"deleted":true}"#)
        _ = try await api.deleteSchedule(profile, scheduleId: "sch-2")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/schedules/sch-2")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "DELETE")
    }

    func testPushRelayRoutes() async throws {
        StubURLProtocol.enqueue(body: #"{"registrations":[{"deviceId":"ios-test","provider":"apns"}],"recentWakeups":[]}"#)
        let status = try await api.getPushRelayStatus(profile, deviceId: "ios-test")
        XCTAssertEqual(lastQueryPath(), "/api/v1/mobile/push/status?deviceId=ios-test")
        XCTAssertEqual(status.registrations.count, 1)

        StubURLProtocol.enqueue(body: #"{"ok":true,"registration":{"deviceId":"ios-test","provider":"apns"}}"#)
        _ = try await api.registerPushRelay(profile, request: RegisterPushRelayRequest(deviceId: "ios-test", pushToken: "tok-123"))
        XCTAssertEqual(lastPath(), "/api/v1/mobile/push/register")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")

        StubURLProtocol.enqueue(body: #"{"ok":true,"wakeups":[{"id":"w-1","status":"delivered"}]}"#)
        let tested = try await api.testPushWakeup(profile, deviceId: "ios-test", title: "Ping")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/push/test")
        XCTAssertEqual(tested.wakeups.count, 1)

        StubURLProtocol.enqueue(body: #"{"ok":true}"#)
        try await api.unregisterPushRelay(profile, deviceId: "ios-test")
        XCTAssertEqual(lastPath(), "/api/v1/mobile/push/unregister")
        XCTAssertEqual(StubURLProtocol.recorded.last?.httpMethod, "POST")
    }
}
