package ai.wazir.mobile.network

import ai.wazir.mobile.domain.AgentsApiResponse
import ai.wazir.mobile.domain.ApprovalListResponse
import ai.wazir.mobile.domain.ComputersApiResponse
import ai.wazir.mobile.domain.ControllerProfile
import ai.wazir.mobile.domain.CreateScheduleRequest
import ai.wazir.mobile.domain.CreateTaskRequest
import ai.wazir.mobile.domain.DashboardSnapshot
import ai.wazir.mobile.domain.DiffReviewRequest
import ai.wazir.mobile.domain.HandshakeResponse
import ai.wazir.mobile.domain.MobileAutonomyState
import ai.wazir.mobile.domain.MobileTaskDetail
import ai.wazir.mobile.domain.ModelsApiResponse
import ai.wazir.mobile.domain.PairingCompleteResponse
import ai.wazir.mobile.domain.PairingRequestPayload
import ai.wazir.mobile.domain.PairingRequestResponse
import ai.wazir.mobile.domain.ResolveApprovalRequest
import ai.wazir.mobile.domain.ResolveApprovalResponse
import ai.wazir.mobile.domain.ResourceBudgetSnapshot
import ai.wazir.mobile.domain.RuntimesApiResponse
import ai.wazir.mobile.domain.ScheduleListResponse
import ai.wazir.mobile.domain.ScheduleMutationResponse
import ai.wazir.mobile.domain.SubmitTaskResponse
import ai.wazir.mobile.domain.TaskArtifactsResponse
import ai.wazir.mobile.domain.TaskDetailEnvelope
import ai.wazir.mobile.domain.TaskDiffReviewResponse
import ai.wazir.mobile.domain.TaskListResponse
import ai.wazir.mobile.domain.TokenRotationResponse
import ai.wazir.mobile.domain.UpdateAutonomyRequest
import ai.wazir.mobile.security.CredentialVault
import ai.wazir.mobile.security.StoredDeviceCredential
import ai.wazir.mobile.security.TlsPinningClientFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class ApiException(
    val statusCode: Int,
    override val message: String,
    val errorCode: String? = null,
) : IOException("HTTP $statusCode: $message")

class WazirControllerApi(
    private val credentialVault: CredentialVault,
    private val clientOverride: OkHttpClient? = null,
) {
    val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    private val clientCache = ConcurrentHashMap<String, OkHttpClient>()
    private val rotationMutex = Mutex()

    fun clientFor(baseUrl: String, tlsCertFingerprint: String? = null, readTimeoutSeconds: Long = 30): OkHttpClient {
        if (clientOverride != null) return clientOverride
        val key = "$baseUrl|${tlsCertFingerprint.orEmpty()}|$readTimeoutSeconds"
        return clientCache.getOrPut(key) {
            TlsPinningClientFactory.createClient(
                baseUrl = baseUrl,
                tlsCertFingerprint = tlsCertFingerprint,
                readTimeoutSeconds = readTimeoutSeconds,
            )
        }
    }

    suspend fun requestPairing(
        baseUrl: String,
        tlsCertFingerprint: String?,
        payload: PairingRequestPayload,
    ): Result<PairingRequestResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val cleanUrl = PairingUriParser.validateControllerBaseUrl(baseUrl, allowLoopbackHttp = true).getOrThrow()
            val bodyStr = json.encodeToString(payload)
            val request = Request.Builder()
                .url("$cleanUrl/api/v1/mobile/pair/request")
                .header("X-Wazir-Mobile-Version", MOBILE_APP_VERSION)
                .post(bodyStr.toRequestBody(JSON_MEDIA_TYPE))
                .build()

            val client = clientFor(cleanUrl, tlsCertFingerprint)
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                val parsed = json.decodeFromString<PairingRequestResponse>(raw.ifBlank { "{}" })
                if (!response.isSuccessful || !parsed.ok) {
                    throw ApiException(
                        statusCode = response.code,
                        message = parsed.error ?: "Pairing request failed (${response.code})",
                        errorCode = parsed.code,
                    )
                }
                parsed
            }
        }
    }

    suspend fun completePairing(
        baseUrl: String,
        tlsCertFingerprint: String?,
        sessionId: String,
        pairingSecret: String,
        deviceId: String,
    ): Result<PairingCompleteResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val cleanUrl = PairingUriParser.validateControllerBaseUrl(baseUrl, allowLoopbackHttp = true).getOrThrow()
            val payload = buildJsonObject {
                put("sessionId", sessionId)
                put("pairingSecret", pairingSecret)
                put("deviceId", deviceId)
            }
            val request = Request.Builder()
                .url("$cleanUrl/api/v1/mobile/pair/complete")
                .header("X-Wazir-Mobile-Version", MOBILE_APP_VERSION)
                .post(json.encodeToString(payload).toRequestBody(JSON_MEDIA_TYPE))
                .build()

            val client = clientFor(cleanUrl, tlsCertFingerprint)
            client.newCall(request).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                val parsed = json.decodeFromString<PairingCompleteResponse>(raw.ifBlank { "{}" })
                if (response.code >= 400 && parsed.status != "awaiting_operator_approval") {
                    throw ApiException(
                        statusCode = response.code,
                        message = parsed.error ?: "Pairing completion failed (${response.code})",
                        errorCode = parsed.code,
                    )
                }
                parsed
            }
        }
    }

    suspend fun handshake(profile: ControllerProfile): Result<HandshakeResponse> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/handshake",
            decode = { json.decodeFromString(it) },
        )

    suspend fun getDashboard(profile: ControllerProfile): Result<DashboardSnapshot> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/dashboard",
            decode = { json.decodeFromString(it) },
        )

    suspend fun listTasks(profile: ControllerProfile, stateFilter: String? = null): Result<TaskListResponse> {
        val query = if (!stateFilter.isNullOrBlank() && stateFilter != "all") {
            "?state=${URLEncoder.encode(stateFilter, "UTF-8")}"
        } else {
            ""
        }
        return executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/tasks$query",
            decode = { json.decodeFromString(it) },
        )
    }

    suspend fun getTaskDetail(profile: ControllerProfile, taskId: String): Result<MobileTaskDetail> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/tasks/${URLEncoder.encode(taskId, "UTF-8")}",
            decode = { raw ->
                val envelope = json.decodeFromString<TaskDetailEnvelope>(raw)
                envelope.task
            },
        )

    suspend fun submitTask(
        profile: ControllerProfile,
        request: CreateTaskRequest,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<SubmitTaskResponse> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/tasks",
            bodyJson = json.encodeToString(request),
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun cancelTask(
        profile: ControllerProfile,
        taskId: String,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<MobileTaskDetail?> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/tasks/${URLEncoder.encode(taskId, "UTF-8")}/cancel",
            bodyJson = "{}",
            idempotencyKey = idempotencyKey,
            decode = { raw ->
                val obj = json.decodeFromString<SubmitTaskResponse>(raw)
                obj.task
            },
        )

    suspend fun retryTask(
        profile: ControllerProfile,
        taskId: String,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<SubmitTaskResponse> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/tasks/${URLEncoder.encode(taskId, "UTF-8")}/retry",
            bodyJson = "{}",
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun resumeTask(
        profile: ControllerProfile,
        taskId: String,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<SubmitTaskResponse> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/tasks/${URLEncoder.encode(taskId, "UTF-8")}/resume",
            bodyJson = "{}",
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun listApprovals(profile: ControllerProfile, status: String? = null): Result<ApprovalListResponse> {
        val query = if (!status.isNullOrBlank()) {
            "?status=${URLEncoder.encode(status, "UTF-8")}"
        } else {
            ""
        }
        return executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/approvals$query",
            decode = { json.decodeFromString(it) },
        )
    }

    suspend fun resolveApproval(
        profile: ControllerProfile,
        approvalId: String,
        request: ResolveApprovalRequest,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<ResolveApprovalResponse> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/approvals/${URLEncoder.encode(approvalId, "UTF-8")}/resolve",
            bodyJson = json.encodeToString(request),
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun getModels(profile: ControllerProfile): Result<ModelsApiResponse> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/models",
            decode = { json.decodeFromString(it) },
        )

    suspend fun getRuntimes(profile: ControllerProfile): Result<RuntimesApiResponse> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/runtimes",
            decode = { json.decodeFromString(it) },
        )

    suspend fun getAgents(profile: ControllerProfile): Result<AgentsApiResponse> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/agents",
            decode = { json.decodeFromString(it) },
        )

    suspend fun loadModel(
        profile: ControllerProfile,
        modelId: String,
        runtimeId: String = "ollama",
        computerId: String = "local",
        contextTokens: Int? = null,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<Boolean> {
        val body = buildJsonObject {
            put("runtimeId", runtimeId)
            put("computerId", computerId)
            if (contextTokens != null) {
                put("contextTokens", contextTokens)
            }
        }
        return executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/models/${URLEncoder.encode(modelId, "UTF-8")}/load",
            bodyJson = json.encodeToString(body),
            idempotencyKey = idempotencyKey,
            decode = { true },
        )
    }

    suspend fun unloadModel(
        profile: ControllerProfile,
        modelId: String,
        runtimeId: String = "ollama",
        computerId: String = "local",
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<Boolean> {
        val body = buildJsonObject {
            put("runtimeId", runtimeId)
            put("computerId", computerId)
        }
        return executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/models/${URLEncoder.encode(modelId, "UTF-8")}/unload",
            bodyJson = json.encodeToString(body),
            idempotencyKey = idempotencyKey,
            decode = { true },
        )
    }

    suspend fun reconcileModels(
        profile: ControllerProfile,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<Boolean> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/models/reconcile",
            bodyJson = "{}",
            idempotencyKey = idempotencyKey,
            decode = { true },
        )

    suspend fun getComputers(profile: ControllerProfile): Result<ComputersApiResponse> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/computers",
            decode = { json.decodeFromString(it) },
        )

    suspend fun getResourceBudget(profile: ControllerProfile): Result<ResourceBudgetSnapshot> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/resources",
            decode = { json.decodeFromString(it) },
        )

    suspend fun emergencyStop(
        profile: ControllerProfile,
        reason: String,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<Boolean> {
        val body = buildJsonObject { put("reason", reason) }
        return executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/resources/emergency-stop",
            bodyJson = json.encodeToString(body),
            idempotencyKey = idempotencyKey,
            decode = { true },
        )
    }

    suspend fun emergencyResume(
        profile: ControllerProfile,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<Boolean> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/resources/resume",
            bodyJson = "{}",
            idempotencyKey = idempotencyKey,
            decode = { true },
        )

    suspend fun getAutonomy(profile: ControllerProfile): Result<MobileAutonomyState> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/autonomy",
            decode = { json.decodeFromString(it) },
        )

    suspend fun updateAutonomy(
        profile: ControllerProfile,
        request: UpdateAutonomyRequest,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<MobileAutonomyState> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/autonomy",
            bodyJson = json.encodeToString(request),
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun getTaskArtifacts(profile: ControllerProfile, taskId: String): Result<TaskArtifactsResponse> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/tasks/${URLEncoder.encode(taskId, "UTF-8")}/artifacts",
            decode = { json.decodeFromString(it) },
        )

    suspend fun reviewTaskDiffFile(
        profile: ControllerProfile,
        taskId: String,
        path: String,
        decision: String,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<TaskDiffReviewResponse> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/tasks/${URLEncoder.encode(taskId, "UTF-8")}/diff-review",
            bodyJson = json.encodeToString(DiffReviewRequest(path = path, decision = decision)),
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun listSchedules(profile: ControllerProfile): Result<ScheduleListResponse> =
        executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/schedules",
            decode = { json.decodeFromString(it) },
        )

    suspend fun createSchedule(
        profile: ControllerProfile,
        request: CreateScheduleRequest,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<ScheduleMutationResponse> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/schedules",
            bodyJson = json.encodeToString(request),
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun toggleSchedule(
        profile: ControllerProfile,
        scheduleId: String,
        enabled: Boolean,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<ScheduleMutationResponse> {
        val body = buildJsonObject { put("enabled", enabled) }
        return executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/schedules/${URLEncoder.encode(scheduleId, "UTF-8")}/toggle",
            bodyJson = json.encodeToString(body),
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )
    }

    suspend fun runScheduleNow(
        profile: ControllerProfile,
        scheduleId: String,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<ScheduleMutationResponse> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/schedules/${URLEncoder.encode(scheduleId, "UTF-8")}/run",
            bodyJson = "{}",
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun deleteSchedule(
        profile: ControllerProfile,
        scheduleId: String,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<ScheduleMutationResponse> =
        executeAuthenticated(
            profile = profile,
            method = "DELETE",
            path = "/api/v1/mobile/schedules/${URLEncoder.encode(scheduleId, "UTF-8")}",
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun getPushRelayStatus(
        profile: ControllerProfile,
        deviceId: String? = null,
    ): Result<PushRelayStatusResponse> {
        val query = if (!deviceId.isNullOrBlank()) "?deviceId=${URLEncoder.encode(deviceId, "UTF-8")}" else ""
        return executeAuthenticated(
            profile = profile,
            method = "GET",
            path = "/api/v1/mobile/push/status$query",
            decode = { json.decodeFromString(it) },
        )
    }

    suspend fun registerPushRelay(
        profile: ControllerProfile,
        request: RegisterPushRelayRequest,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<RegisterPushRelayResponse> =
        executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/push/register",
            bodyJson = json.encodeToString(request),
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )

    suspend fun unregisterPushRelay(
        profile: ControllerProfile,
        deviceId: String,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<Boolean> {
        val body = buildJsonObject { put("deviceId", deviceId) }
        return executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/push/unregister",
            bodyJson = json.encodeToString(body),
            idempotencyKey = idempotencyKey,
            decode = { true },
        )
    }

    suspend fun testPushWakeup(
        profile: ControllerProfile,
        deviceId: String? = null,
        title: String? = null,
        idempotencyKey: String = UUID.randomUUID().toString(),
    ): Result<TestPushWakeupResponse> {
        val body = buildJsonObject {
            if (!deviceId.isNullOrBlank()) put("deviceId", deviceId)
            if (!title.isNullOrBlank()) put("title", title)
        }
        return executeAuthenticated(
            profile = profile,
            method = "POST",
            path = "/api/v1/mobile/push/test",
            bodyJson = json.encodeToString(body),
            idempotencyKey = idempotencyKey,
            decode = { json.decodeFromString(it) },
        )
    }


    suspend fun rotateTokenIfNeeded(
        profile: ControllerProfile,
        force: Boolean = false,
    ): StoredDeviceCredential? = rotationMutex.withLock {
        val current = credentialVault.getCredential(profile.id) ?: return@withLock null
        val now = System.currentTimeMillis()
        if (!force && current.expiresAt > now + 60_000L) {
            return@withLock current
        }

        val cleanUrl = profile.baseUrl.trimEnd('/')
        val body = buildJsonObject {
            put("deviceId", current.deviceId)
            put("refreshToken", current.refreshToken)
        }
        val request = Request.Builder()
            .url("$cleanUrl/api/v1/mobile/auth/rotate")
            .header("X-Wazir-Mobile-Version", MOBILE_APP_VERSION)
            .post(json.encodeToString(body).toRequestBody(JSON_MEDIA_TYPE))
            .build()

        val client = clientFor(cleanUrl, profile.tlsCertFingerprint)
        return@withLock try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    return@use null
                }
                val raw = response.body?.string().orEmpty()
                val rotated = json.decodeFromString<TokenRotationResponse>(raw)
                if (rotated.ok && !rotated.accessToken.isNullOrBlank() && !rotated.refreshToken.isNullOrBlank()) {
                    val updated = StoredDeviceCredential(
                        controllerId = profile.id,
                        deviceId = rotated.deviceId ?: current.deviceId,
                        accessToken = rotated.accessToken,
                        refreshToken = rotated.refreshToken,
                        expiresAt = rotated.expiresAt ?: (now + 24 * 3600_000L),
                        scopes = rotated.scopes.ifEmpty { current.scopes },
                    )
                    credentialVault.saveCredential(updated)
                    updated
                } else {
                    null
                }
            }
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun <T> executeAuthenticated(
        profile: ControllerProfile,
        method: String,
        path: String,
        bodyJson: String? = null,
        idempotencyKey: String? = null,
        decode: (String) -> T,
    ): Result<T> = withContext(Dispatchers.IO) {
        runCatching {
            val cleanUrl = PairingUriParser.validateControllerBaseUrl(profile.baseUrl, allowLoopbackHttp = true)
                .getOrThrow()
            var credential = rotateTokenIfNeeded(profile, force = false)
                ?: credentialVault.getCredential(profile.id)
                ?: throw ApiException(401, "No stored device credential for controller ${profile.name}", "missing_credential")

            val client = clientFor(cleanUrl, profile.tlsCertFingerprint)

            fun buildReq(token: String): Request {
                val builder = Request.Builder()
                    .url("$cleanUrl$path")
                    .header("Authorization", "Bearer $token")
                    .header("X-Wazir-Mobile-Version", MOBILE_APP_VERSION)
                    .header("Accept", "application/json")

                if (!idempotencyKey.isNullOrBlank()) {
                    builder.header("Idempotency-Key", idempotencyKey)
                }

                when (method) {
                    "POST" -> builder.post((bodyJson ?: "{}").toRequestBody(JSON_MEDIA_TYPE))
                    "DELETE" -> builder.delete()
                    else -> builder.get()
                }
                return builder.build()
            }

            var response = client.newCall(buildReq(credential.accessToken)).execute()
            if (response.code == 401) {
                response.close()
                val rotated = rotateTokenIfNeeded(profile, force = true)
                if (rotated != null) {
                    credential = rotated
                    response = client.newCall(buildReq(credential.accessToken)).execute()
                } else {
                    throw ApiException(401, "Device session expired or revoked by controller", "unauthorized")
                }
            }

            response.use { resp ->
                val rawBody = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    val (errMsg, errCode) = extractErrorDetails(rawBody, resp.code)
                    throw ApiException(resp.code, errMsg, errCode)
                }
                decode(rawBody.ifBlank { "{}" })
            }
        }
    }

    private fun extractErrorDetails(rawBody: String, statusCode: Int): Pair<String, String?> {
        if (rawBody.isBlank()) return "HTTP $statusCode" to null
        return try {
            val obj = json.decodeFromString<JsonObject>(rawBody)
            val err = obj["error"]?.jsonPrimitive?.content ?: "HTTP $statusCode"
            val code = obj["code"]?.jsonPrimitive?.content
            err to code
        } catch (_: Exception) {
            rawBody.take(200) to null
        }
    }

    companion object {
        const val MOBILE_APP_VERSION = "1.0.0"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
