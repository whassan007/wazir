package ai.wazir.mobile.network

import ai.wazir.mobile.domain.ControllerProfile
import ai.wazir.mobile.domain.CreateTaskRequest
import ai.wazir.mobile.domain.PairingRequestPayload
import ai.wazir.mobile.domain.ResolveApprovalRequest
import ai.wazir.mobile.security.InMemoryCredentialVault
import ai.wazir.mobile.security.StoredDeviceCredential
import kotlinx.coroutines.test.runTest
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Pins every [WazirControllerApi] request to the exact path/method the real controller
 * (`apps/api/src/mobile.ts` -> `registerMobileRoutes`) exposes. A client/server path drift
 * here (e.g. "pairing/request" vs "pair/request") fails silently in the app as an opaque
 * 404 — these tests exist to catch that class of regression at build time instead.
 */
class WazirControllerApiTest {

    private lateinit var server: MockWebServer
    private lateinit var vault: InMemoryCredentialVault
    private lateinit var api: WazirControllerApi
    private lateinit var profile: ControllerProfile

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        vault = InMemoryCredentialVault()
        // clientOverride bypasses TLS/cert-pinning entirely so the plain-HTTP MockWebServer
        // can stand in for the controller without touching android.util.Base64.
        api = WazirControllerApi(vault, clientOverride = OkHttpClient())
        profile = ControllerProfile(
            id = "ctrl-1",
            name = "Test Controller",
            baseUrl = server.url("/").toString().trimEnd('/'),
            deviceId = "and-test",
        )
        vault.saveCredential(
            StoredDeviceCredential(
                controllerId = profile.id,
                deviceId = profile.deviceId,
                accessToken = "initial-access-token",
                refreshToken = "initial-refresh-token",
                expiresAt = System.currentTimeMillis() + 3_600_000L,
                scopes = listOf("read", "mutate", "execute"),
            ),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `requestPairing posts to pair request`() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"sessionId":"s1","status":"pending_operator_approval","confirmationCode":"123-456","controllerName":"Mac","expiresAt":1}"""))

        val result = api.requestPairing(
            baseUrl = profile.baseUrl,
            tlsCertFingerprint = null,
            payload = PairingRequestPayload(sessionId = "s1", pairingSecret = "secret", deviceId = "d1", deviceName = "Pixel"),
        )

        assertTrue(result.isSuccess)
        val recorded = server.takeRequest()
        assertEquals("/api/v1/mobile/pair/request", recorded.path)
        assertEquals("POST", recorded.method)
    }

    @Test
    fun `completePairing posts to pair complete`() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"status":"pending_operator_approval","expiresAt":1}"""))

        api.completePairing(
            baseUrl = profile.baseUrl,
            tlsCertFingerprint = null,
            sessionId = "s1",
            pairingSecret = "secret",
            deviceId = "d1",
        )

        val recorded = server.takeRequest()
        assertEquals("/api/v1/mobile/pair/complete", recorded.path)
        assertEquals("POST", recorded.method)
    }

    @Test
    fun `handshake gets the handshake endpoint with bearer auth`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))

        val result = api.handshake(profile)

        assertTrue(result.isSuccess)
        val recorded = server.takeRequest()
        assertEquals("/api/v1/mobile/handshake", recorded.path)
        assertEquals("GET", recorded.method)
        assertEquals("Bearer initial-access-token", recorded.getHeader("Authorization"))
    }

    @Test
    fun `getDashboard hits the dashboard endpoint`() = runTest {
        server.enqueue(MockResponse().setBody("""{"controller":{},"cards":{}}"""))
        val result = api.getDashboard(profile)
        assertTrue(result.isSuccess)
        assertEquals("/api/v1/mobile/dashboard", server.takeRequest().path)
    }

    @Test
    fun `listTasks applies a state filter query param`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.listTasks(profile, stateFilter = "running")
        assertEquals("/api/v1/mobile/tasks?state=running", server.takeRequest().path)
    }

    @Test
    fun `listTasks omits the query param for all`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.listTasks(profile, stateFilter = "all")
        assertEquals("/api/v1/mobile/tasks", server.takeRequest().path)
    }

    @Test
    fun `submitTask posts to tasks with an idempotency key header`() = runTest {
        server.enqueue(MockResponse().setBody("""{"taskId":"t1"}"""))

        api.submitTask(profile, CreateTaskRequest(input = "do the thing"), idempotencyKey = "idem-1")

        val recorded = server.takeRequest()
        assertEquals("/api/v1/mobile/tasks", recorded.path)
        assertEquals("POST", recorded.method)
        assertEquals("idem-1", recorded.getHeader("Idempotency-Key"))
    }

    @Test
    fun `cancelTask posts to the cancel sub-route`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.cancelTask(profile, "t1")
        val recorded = server.takeRequest()
        assertEquals("/api/v1/mobile/tasks/t1/cancel", recorded.path)
        assertEquals("POST", recorded.method)
    }

    @Test
    fun `retryTask posts to the retry sub-route`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.retryTask(profile, "t1")
        assertEquals("/api/v1/mobile/tasks/t1/retry", server.takeRequest().path)
    }

    @Test
    fun `resumeTask posts to the resume sub-route`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.resumeTask(profile, "t1")
        assertEquals("/api/v1/mobile/tasks/t1/resume", server.takeRequest().path)
    }

    @Test
    fun `listApprovals applies a status filter`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.listApprovals(profile, status = "pending")
        assertEquals("/api/v1/mobile/approvals?status=pending", server.takeRequest().path)
    }

    @Test
    fun `resolveApproval posts to the approval resolve sub-route`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.resolveApproval(profile, "appr-1", ResolveApprovalRequest(decision = "approve", argumentsHash = "hash"))
        val recorded = server.takeRequest()
        assertEquals("/api/v1/mobile/approvals/appr-1/resolve", recorded.path)
        assertEquals("POST", recorded.method)
    }

    @Test
    fun `getModels getRuntimes and getAgents hit the non-mobile catalog routes`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("{}"))
        server.enqueue(MockResponse().setBody("{}"))
        api.getModels(profile)
        api.getRuntimes(profile)
        api.getAgents(profile)
        assertEquals("/api/v1/models", server.takeRequest().path)
        assertEquals("/api/v1/runtimes", server.takeRequest().path)
        assertEquals("/api/v1/agents", server.takeRequest().path)
    }

    @Test
    fun `getComputers hits the mobile computers route`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.getComputers(profile)
        assertEquals("/api/v1/mobile/computers", server.takeRequest().path)
    }

    @Test
    fun `getResourceBudget hits the mobile resources route`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.getResourceBudget(profile)
        assertEquals("/api/v1/mobile/resources", server.takeRequest().path)
    }

    @Test
    fun `emergencyStop posts to resources emergency-stop`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.emergencyStop(profile, "testing")
        val recorded = server.takeRequest()
        assertEquals("/api/v1/mobile/resources/emergency-stop", recorded.path)
        assertEquals("POST", recorded.method)
    }

    @Test
    fun `emergencyResume posts to resources resume, not emergency-resume`() = runTest {
        server.enqueue(MockResponse().setBody("{}"))
        api.emergencyResume(profile)
        val recorded = server.takeRequest()
        assertEquals("/api/v1/mobile/resources/resume", recorded.path)
        assertEquals("POST", recorded.method)
    }

    @Test
    fun `a 401 triggers token rotation and a single retry with the new token`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401))
        server.enqueue(
            MockResponse().setBody(
                """{"ok":true,"deviceId":"and-test","accessToken":"rotated-access-token","refreshToken":"rotated-refresh-token","expiresAt":${System.currentTimeMillis() + 3_600_000L},"scopes":["read","mutate","execute"]}""",
            ),
        )
        server.enqueue(MockResponse().setBody("{}"))

        val result = api.getComputers(profile)

        assertTrue(result.isSuccess)
        val firstAttempt = server.takeRequest()
        assertEquals("/api/v1/mobile/computers", firstAttempt.path)
        assertEquals("Bearer initial-access-token", firstAttempt.getHeader("Authorization"))

        val rotate = server.takeRequest()
        assertEquals("/api/v1/mobile/auth/rotate", rotate.path)

        val retry = server.takeRequest()
        assertEquals("/api/v1/mobile/computers", retry.path)
        assertEquals("Bearer rotated-access-token", retry.getHeader("Authorization"))

        assertEquals("rotated-access-token", vault.getCredential(profile.id)?.accessToken)
    }

    @Test
    fun `a 401 with no refreshable credential surfaces as unauthorized`() = runTest {
        vault.removeCredential(profile.id)
        // No credential at all: executeAuthenticated should fail before issuing any request.
        val result = api.getComputers(profile)
        assertTrue(result.isFailure)
        assertNull(server.takeRequest(1, java.util.concurrent.TimeUnit.MILLISECONDS))
    }

    @Test
    fun `getAutonomy and updateAutonomy hit the mobile autonomy endpoint`() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"posture":"request-review","networkGuard":"normal"}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"posture":"auto-sandbox","networkGuard":"cellular-strict"}"""))

        val getRes = api.getAutonomy(profile)
        assertTrue(getRes.isSuccess)
        assertEquals("request-review", getRes.getOrThrow().posture)
        val req1 = server.takeRequest()
        assertEquals("/api/v1/mobile/autonomy", req1.path)
        assertEquals("GET", req1.method)

        val updateRes = api.updateAutonomy(
            profile,
            ai.wazir.mobile.domain.UpdateAutonomyRequest(posture = "auto-sandbox", networkGuard = "cellular-strict"),
        )
        assertTrue(updateRes.isSuccess)
        assertEquals("auto-sandbox", updateRes.getOrThrow().posture)
        assertEquals("cellular-strict", updateRes.getOrThrow().networkGuard)
        val req2 = server.takeRequest()
        assertEquals("/api/v1/mobile/autonomy", req2.path)
        assertEquals("POST", req2.method)
    }

    @Test
    fun `getTaskArtifacts and reviewTaskDiffFile hit mobile task artifact and diff-review routes`() = runTest {
        server.enqueue(
            MockResponse().setBody(
                """{"ok":true,"taskId":"t-100","executionId":"exec-100","artifacts":[{"id":"art-diff-exec-100","kind":"code_diff","title":"Code Diff Review","status":"pending","files":[{"path":"src/index.ts","changeType":"modified","additions":12,"deletions":3,"status":"pending","patch":"@@ -1,3 +1,12 @@"}]}]}""",
            ),
        )
        server.enqueue(
            MockResponse().setBody(
                """{"ok":true,"taskId":"t-100","executionId":"exec-100","reviews":[{"path":"src/index.ts","decision":"keep"}],"artifacts":[{"id":"art-diff-exec-100","kind":"code_diff","title":"Code Diff Review","status":"reviewed","files":[{"path":"src/index.ts","changeType":"modified","additions":12,"deletions":3,"status":"keep","patch":"@@ -1,3 +1,12 @@"}]}]}""",
            ),
        )

        val artRes = api.getTaskArtifacts(profile, "t-100")
        assertTrue(artRes.isSuccess)
        assertEquals(1, artRes.getOrThrow().artifacts.size)
        val req1 = server.takeRequest()
        assertEquals("/api/v1/mobile/tasks/t-100/artifacts", req1.path)
        assertEquals("GET", req1.method)

        val reviewRes = api.reviewTaskDiffFile(profile, "t-100", "src/index.ts", "keep")
        assertTrue(reviewRes.isSuccess)
        assertEquals("keep", reviewRes.getOrThrow().artifacts.first().files.first().status)
        val req2 = server.takeRequest()
        assertEquals("/api/v1/mobile/tasks/t-100/diff-review", req2.path)
        assertEquals("POST", req2.method)
    }

    @Test
    fun `schedule endpoints hit mobile schedules routes`() = runTest {
        server.enqueue(MockResponse().setBody("""{"schedules":[{"id":"sched-1","name":"Nightly Audit","prompt":"Audit repo","cronExpression":"0 9 * * *","enabled":true}],"count":1}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"schedule":{"id":"sched-2","name":"Daily Triage","prompt":"Triage","cronExpression":"*/30 * * * *","enabled":true}}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"schedule":{"id":"sched-2","name":"Daily Triage","prompt":"Triage","cronExpression":"*/30 * * * *","enabled":false}}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"executionId":"exec-sched-2"}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"deleted":true}"""))

        val listRes = api.listSchedules(profile)
        assertTrue(listRes.isSuccess)
        assertEquals(1, listRes.getOrThrow().schedules.size)
        assertEquals("/api/v1/mobile/schedules", server.takeRequest().path)

        val createRes = api.createSchedule(
            profile,
            ai.wazir.mobile.domain.CreateScheduleRequest(
                name = "Daily Triage",
                prompt = "Triage",
                cronExpression = "*/30 * * * *",
            ),
        )
        assertTrue(createRes.isSuccess)
        val createReq = server.takeRequest()
        assertEquals("/api/v1/mobile/schedules", createReq.path)
        assertEquals("POST", createReq.method)

        val toggleRes = api.toggleSchedule(profile, "sched-2", enabled = false)
        assertTrue(toggleRes.isSuccess)
        val toggleReq = server.takeRequest()
        assertEquals("/api/v1/mobile/schedules/sched-2/toggle", toggleReq.path)
        assertEquals("POST", toggleReq.method)

        val runRes = api.runScheduleNow(profile, "sched-2")
        assertTrue(runRes.isSuccess)
        val runReq = server.takeRequest()
        assertEquals("/api/v1/mobile/schedules/sched-2/run", runReq.path)
        assertEquals("POST", runReq.method)

        val deleteRes = api.deleteSchedule(profile, "sched-2")
        assertTrue(deleteRes.isSuccess)
        val deleteReq = server.takeRequest()
        assertEquals("/api/v1/mobile/schedules/sched-2", deleteReq.path)
        assertEquals("DELETE", deleteReq.method)
    }

    @Test
    fun `pushRelay endpoints hit mobile push status register unregister and test routes`() = runTest {
        server.enqueue(MockResponse().setBody("""{"ok":true,"registrations":[{"deviceId":"and-test","deviceName":"Pixel","platform":"android","provider":"fcm","pushTokenPreview":"wazi…test","registeredAt":1000,"lastUpdatedAt":1000}],"recentWakeups":[]}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"registration":{"deviceId":"and-test","deviceName":"Pixel","platform":"android","provider":"fcm","pushTokenPreview":"wazi…test","registeredAt":1000,"lastUpdatedAt":1001}}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"dispatched":[{"id":"push-wake-1","deviceId":"and-test","provider":"fcm","eventType":"push.test","title":"Test Push","body":"Wakeup","dispatchedAt":1002,"deliveryStatus":"relayed_local"}],"count":1}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true,"removed":true}"""))

        val statusRes = api.getPushRelayStatus(profile, deviceId = "and-test")
        assertTrue(statusRes.isSuccess)
        assertEquals(1, statusRes.getOrThrow().registrations.size)
        val statusReq = server.takeRequest()
        assertEquals("/api/v1/mobile/push/status?deviceId=and-test", statusReq.path)
        assertEquals("GET", statusReq.method)

        val regRes = api.registerPushRelay(
            profile,
            ai.wazir.mobile.domain.RegisterPushRelayRequest(
                deviceId = "and-test",
                deviceName = "Pixel",
                platform = "android",
                provider = "fcm",
                pushToken = "wazir-android-test",
            ),
        )
        assertTrue(regRes.isSuccess)
        assertEquals("fcm", regRes.getOrThrow().registration?.provider)
        val regReq = server.takeRequest()
        assertEquals("/api/v1/mobile/push/register", regReq.path)
        assertEquals("POST", regReq.method)

        val testRes = api.testPushWakeup(profile, deviceId = "and-test", title = "Test Push")
        assertTrue(testRes.isSuccess)
        assertEquals(1, testRes.getOrThrow().count)
        val testReq = server.takeRequest()
        assertEquals("/api/v1/mobile/push/test", testReq.path)
        assertEquals("POST", testReq.method)

        val unregRes = api.unregisterPushRelay(profile, "and-test")
        assertTrue(unregRes.isSuccess)
        val unregReq = server.takeRequest()
        assertEquals("/api/v1/mobile/push/unregister", unregReq.path)
        assertEquals("POST", unregReq.method)
    }
}
