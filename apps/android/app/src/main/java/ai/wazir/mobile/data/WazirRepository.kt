package ai.wazir.mobile.data

import android.os.Build
import ai.wazir.mobile.domain.AgentDescriptorItem
import ai.wazir.mobile.domain.ApprovalListResponse
import ai.wazir.mobile.domain.ComputerTelemetryItem
import ai.wazir.mobile.domain.ComputersApiResponse
import ai.wazir.mobile.domain.ControllerProfile
import ai.wazir.mobile.domain.CreateScheduleRequest
import ai.wazir.mobile.domain.CreateTaskRequest
import ai.wazir.mobile.domain.DashboardSnapshot
import ai.wazir.mobile.domain.MobileApprovalRecord
import ai.wazir.mobile.domain.MobileAutonomyState
import ai.wazir.mobile.domain.MobileScheduleItem
import ai.wazir.mobile.domain.MobileStreamEvent
import ai.wazir.mobile.domain.MobileTaskDetail
import ai.wazir.mobile.domain.MobileTaskSummary
import ai.wazir.mobile.domain.MobileVerifiableArtifact
import ai.wazir.mobile.domain.ModelCatalogItem
import ai.wazir.mobile.domain.ModelInstanceItem
import ai.wazir.mobile.domain.ModelsApiResponse
import ai.wazir.mobile.domain.PairingCompleteResponse
import ai.wazir.mobile.domain.PairingRequestPayload
import ai.wazir.mobile.domain.PairingRequestResponse
import ai.wazir.mobile.domain.ResolveApprovalRequest
import ai.wazir.mobile.domain.ResolveApprovalResponse
import ai.wazir.mobile.domain.ResourceBudgetSnapshot
import ai.wazir.mobile.domain.RuntimeItem
import ai.wazir.mobile.domain.RuntimesApiResponse
import ai.wazir.mobile.domain.ScheduleMutationResponse
import ai.wazir.mobile.domain.SubmitTaskResponse
import ai.wazir.mobile.domain.TaskDiffReviewResponse
import ai.wazir.mobile.domain.TaskListResponse
import ai.wazir.mobile.domain.UpdateAutonomyRequest
import ai.wazir.mobile.network.WazirControllerApi
import ai.wazir.mobile.persistence.CachedControllerSnapshotEntity
import ai.wazir.mobile.persistence.CachedTaskDetailEntity
import ai.wazir.mobile.persistence.ControllerProfileEntity
import ai.wazir.mobile.persistence.WazirCacheDao
import ai.wazir.mobile.security.CredentialVault
import ai.wazir.mobile.security.StoredDeviceCredential
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

data class ControllerCachedState(
    val dashboard: DashboardSnapshot? = null,
    val tasks: List<MobileTaskSummary> = emptyList(),
    val approvals: List<MobileApprovalRecord> = emptyList(),
    val models: List<ModelCatalogItem> = emptyList(),
    val modelInstances: List<ModelInstanceItem> = emptyList(),
    val runtimes: List<RuntimeItem> = emptyList(),
    val agents: List<AgentDescriptorItem> = emptyList(),
    val computers: List<ComputerTelemetryItem> = emptyList(),
    val resources: ResourceBudgetSnapshot? = null,
    val autonomy: MobileAutonomyState = MobileAutonomyState(),
    val schedules: List<MobileScheduleItem> = emptyList(),
    val lastSequence: Long = 0L,
    val syncedAtMs: Long? = null,
)

class WazirRepository(
    private val cacheDao: WazirCacheDao,
    private val credentialVault: CredentialVault,
    val api: WazirControllerApi = WazirControllerApi(credentialVault),
) {
    private val json: Json = api.json

    fun observeControllers(): Flow<List<ControllerProfile>> =
        cacheDao.observeControllers().map { list -> list.map { it.toDomain(json) } }

    suspend fun listControllers(): List<ControllerProfile> =
        cacheDao.listControllers().map { it.toDomain(json) }

    suspend fun initiatePairing(
        baseUrl: String,
        tlsCertFingerprint: String?,
        sessionId: String,
        pairingSecret: String,
        deviceNameOverride: String? = null,
    ): Result<PairingRequestResponse> {
        val (deviceId, publicKeyFp) = credentialVault.getOrCreateDeviceIdentity()
        val deviceName = deviceNameOverride?.takeIf { it.isNotBlank() }
            ?: "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
        val payload = PairingRequestPayload(
            sessionId = sessionId.trim(),
            pairingSecret = pairingSecret.trim(),
            deviceId = deviceId,
            deviceName = deviceName,
            deviceModel = Build.MODEL,
            osVersion = "Android ${Build.VERSION.RELEASE ?: "14"}",
            publicKeyFingerprint = publicKeyFp,
        )
        return api.requestPairing(
            baseUrl = baseUrl,
            tlsCertFingerprint = tlsCertFingerprint,
            payload = payload,
        )
    }

    suspend fun pollPairingCompletion(
        baseUrl: String,
        tlsCertFingerprint: String?,
        sessionId: String,
        pairingSecret: String,
        fallbackName: String,
    ): Result<ControllerProfile?> {
        val (deviceId, _) = credentialVault.getOrCreateDeviceIdentity()
        val responseResult = api.completePairing(
            baseUrl = baseUrl,
            tlsCertFingerprint = tlsCertFingerprint,
            sessionId = sessionId,
            pairingSecret = pairingSecret,
            deviceId = deviceId,
        )
        return responseResult.map { resp: PairingCompleteResponse ->
            if (resp.status == "awaiting_operator_approval") {
                return@map null
            }
            if (!resp.ok || resp.accessToken.isNullOrBlank() || resp.refreshToken.isNullOrBlank()) {
                throw IllegalStateException(resp.error ?: "Pairing did not return valid device credentials")
            }

            val controllerMeta = resp.controller
            val controllerId = controllerMeta?.id?.takeIf { it.isNotBlank() }
                ?: "ctrl-${sessionId.take(8)}"
            val controllerName = controllerMeta?.name?.takeIf { it.isNotBlank() }
                ?: fallbackName

            val issuedDeviceId = resp.deviceId ?: deviceId
            val scopes = resp.scopes.ifEmpty { listOf("read", "mutate", "execute") }
            val expiresAt = resp.expiresAt ?: (System.currentTimeMillis() + 24 * 3600_000L)

            credentialVault.saveCredential(
                StoredDeviceCredential(
                    controllerId = controllerId,
                    deviceId = issuedDeviceId,
                    accessToken = resp.accessToken,
                    refreshToken = resp.refreshToken,
                    expiresAt = expiresAt,
                    scopes = scopes,
                )
            )

            val profile = ControllerProfile(
                id = controllerId,
                name = controllerName,
                baseUrl = baseUrl.trimEnd('/'),
                deviceId = issuedDeviceId,
                scopes = scopes,
                tlsCertFingerprint = tlsCertFingerprint,
                controllerVersion = controllerMeta?.version ?: "0.1.63",
                apiVersion = controllerMeta?.apiVersion ?: "1.0.0",
                pairedAt = System.currentTimeMillis(),
                lastConnectedAt = System.currentTimeMillis(),
            )

            cacheDao.upsertController(ControllerProfileEntity.fromDomain(profile, json))
            profile
        }
    }

    suspend fun removeController(controllerId: String) = withContext(Dispatchers.IO) {
        credentialVault.removeCredential(controllerId)
        cacheDao.deleteTaskDetailsForController(controllerId)
        cacheDao.deleteSnapshot(controllerId)
        cacheDao.deleteController(controllerId)
    }

    suspend fun loadCachedState(controllerId: String): ControllerCachedState = withContext(Dispatchers.IO) {
        val snap = cacheDao.getSnapshot(controllerId) ?: return@withContext ControllerCachedState()
        val dashboard = snap.dashboardJson?.let { runCatching { json.decodeFromString<DashboardSnapshot>(it) }.getOrNull() }
        val tasks = snap.tasksJson?.let { runCatching { json.decodeFromString<TaskListResponse>(it).tasks }.getOrNull() }.orEmpty()
        val approvals = snap.approvalsJson?.let { runCatching { json.decodeFromString<ApprovalListResponse>(it).approvals }.getOrNull() }.orEmpty()
        val modelsResp = snap.modelsJson?.let { runCatching { json.decodeFromString<ModelsApiResponse>(it) }.getOrNull() }
        val runtimes = snap.runtimesJson?.let { runCatching { json.decodeFromString<RuntimesApiResponse>(it).runtimes }.getOrNull() }.orEmpty()
        val agents = snap.agentsJson?.let { runCatching { json.decodeFromString< List<AgentDescriptorItem>>(it) }.getOrNull() }.orEmpty()
        val computers = snap.computersJson?.let { runCatching { json.decodeFromString<ComputersApiResponse>(it).computers }.getOrNull() }.orEmpty()
        val resources = snap.resourcesJson?.let { runCatching { json.decodeFromString<ResourceBudgetSnapshot>(it) }.getOrNull() }

        ControllerCachedState(
            dashboard = dashboard,
            tasks = tasks,
            approvals = approvals,
            models = modelsResp?.models.orEmpty(),
            modelInstances = modelsResp?.instances.orEmpty(),
            runtimes = runtimes,
            agents = agents,
            computers = computers,
            resources = resources,
            lastSequence = snap.lastSequence,
            syncedAtMs = snap.syncedAtMs,
        )
    }

    suspend fun refreshControllerState(profile: ControllerProfile, lastKnownSequence: Long): Result<ControllerCachedState> =
        withContext(Dispatchers.IO) {
            val dashboardRes = api.getDashboard(profile)
            val tasksRes = api.listTasks(profile)
            val approvalsRes = api.listApprovals(profile)
            val modelsRes = api.getModels(profile)
            val runtimesRes = api.getRuntimes(profile)
            val agentsRes = api.getAgents(profile)
            val computersRes = api.getComputers(profile)
            val resourcesRes = api.getResourceBudget(profile)
            val autonomyRes = api.getAutonomy(profile)
            val schedulesRes = api.listSchedules(profile)

            // If the primary dashboard + tasks endpoints both failed, surface the error so the UI
            // marks the view as offline/cached.
            if (dashboardRes.isFailure && tasksRes.isFailure) {
                return@withContext Result.failure(
                    dashboardRes.exceptionOrNull() ?: IllegalStateException("Unable to reach Wazir controller")
                )
            }

            val existingSnap = cacheDao.getSnapshot(profile.id)
            val dashboard = dashboardRes.getOrNull()
            val tasksResp = tasksRes.getOrNull()
            val approvalsResp = approvalsRes.getOrNull()
            val modelsResp = modelsRes.getOrNull()
            val runtimesResp = runtimesRes.getOrNull()
            val agentsResp = agentsRes.getOrNull()
            val computersResp = computersRes.getOrNull()
            val resourcesResp = resourcesRes.getOrNull()

            val maxSeqFromDashboard = dashboard?.recentActivity?.maxOfOrNull { it.sequence } ?: 0L
            val nextSeq = maxOf(lastKnownSequence, existingSnap?.lastSequence ?: 0L, maxSeqFromDashboard)
            val now = System.currentTimeMillis()

            val updatedSnap = CachedControllerSnapshotEntity(
                controllerId = profile.id,
                dashboardJson = dashboard?.let { json.encodeToString(it) } ?: existingSnap?.dashboardJson,
                tasksJson = tasksResp?.let { json.encodeToString(it) } ?: existingSnap?.tasksJson,
                approvalsJson = approvalsResp?.let { json.encodeToString(it) } ?: existingSnap?.approvalsJson,
                modelsJson = modelsResp?.let { json.encodeToString(it) } ?: existingSnap?.modelsJson,
                runtimesJson = runtimesResp?.let { json.encodeToString(it) } ?: existingSnap?.runtimesJson,
                agentsJson = agentsResp?.let { json.encodeToString(it.agents) } ?: existingSnap?.agentsJson,
                computersJson = computersResp?.let { json.encodeToString(it) } ?: existingSnap?.computersJson,
                resourcesJson = resourcesResp?.let { json.encodeToString(it) } ?: existingSnap?.resourcesJson,
                lastSequence = nextSeq,
                syncedAtMs = now,
            )
            cacheDao.upsertSnapshot(updatedSnap)
            cacheDao.upsertController(
                ControllerProfileEntity.fromDomain(
                    profile.copy(lastConnectedAt = now),
                    json,
                )
            )

            val loaded = loadCachedState(profile.id)
            Result.success(
                loaded.copy(
                    autonomy = autonomyRes.getOrNull() ?: loaded.autonomy,
                    schedules = schedulesRes.getOrNull()?.schedules ?: loaded.schedules,
                )
            )
        }

    suspend fun getTaskDetailWithOfflineFallback(
        profile: ControllerProfile,
        taskId: String,
    ): Pair<MobileTaskDetail?, Boolean> = withContext(Dispatchers.IO) {
        val networkResult = api.getTaskDetail(profile, taskId)
        if (networkResult.isSuccess) {
            val detail = networkResult.getOrThrow()
            cacheDao.upsertTaskDetail(
                CachedTaskDetailEntity(
                    controllerId = profile.id,
                    taskId = taskId,
                    detailJson = json.encodeToString(detail),
                    syncedAtMs = System.currentTimeMillis(),
                )
            )
            cacheDao.pruneTaskDetails(profile.id, maxCount = 50)
            return@withContext detail to false
        }

        val cached = cacheDao.getTaskDetail(profile.id, taskId)?.let {
            runCatching { json.decodeFromString<MobileTaskDetail>(it.detailJson) }.getOrNull()
        }
        cached to true
    }

    suspend fun submitTask(
        profile: ControllerProfile,
        request: CreateTaskRequest,
        idempotencyKey: String,
    ): Result<SubmitTaskResponse> = api.submitTask(profile, request, idempotencyKey)

    suspend fun cancelTask(
        profile: ControllerProfile,
        taskId: String,
    ): Result<MobileTaskDetail?> = api.cancelTask(profile, taskId)

    suspend fun retryTask(
        profile: ControllerProfile,
        taskId: String,
    ): Result<SubmitTaskResponse> = api.retryTask(profile, taskId)

    suspend fun resumeTask(
        profile: ControllerProfile,
        taskId: String,
    ): Result<SubmitTaskResponse> = api.resumeTask(profile, taskId)

    suspend fun resolveApproval(
        profile: ControllerProfile,
        approvalId: String,
        request: ResolveApprovalRequest,
    ): Result<ResolveApprovalResponse> = api.resolveApproval(profile, approvalId, request)

    suspend fun loadModel(
        profile: ControllerProfile,
        modelId: String,
        runtimeId: String,
        computerId: String,
        contextTokens: Int? = null,
    ): Result<Boolean> = api.loadModel(profile, modelId, runtimeId, computerId, contextTokens)

    suspend fun unloadModel(
        profile: ControllerProfile,
        modelId: String,
        runtimeId: String,
        computerId: String,
    ): Result<Boolean> = api.unloadModel(profile, modelId, runtimeId, computerId)

    suspend fun reconcileModels(profile: ControllerProfile): Result<Boolean> =
        api.reconcileModels(profile)

    suspend fun triggerEmergencyStop(profile: ControllerProfile, reason: String): Result<Boolean> =
        api.emergencyStop(profile, reason)

    suspend fun resumeEmergencyStop(profile: ControllerProfile): Result<Boolean> =
        api.emergencyResume(profile)

    suspend fun getAutonomy(profile: ControllerProfile): Result<MobileAutonomyState> =
        api.getAutonomy(profile)

    suspend fun updateAutonomy(
        profile: ControllerProfile,
        posture: String? = null,
        networkGuard: String? = null,
    ): Result<MobileAutonomyState> =
        api.updateAutonomy(profile, UpdateAutonomyRequest(posture = posture, networkGuard = networkGuard))

    suspend fun getTaskArtifacts(
        profile: ControllerProfile,
        taskId: String,
    ): Result<List<MobileVerifiableArtifact>> =
        api.getTaskArtifacts(profile, taskId).map { it.artifacts }

    suspend fun reviewTaskDiffFile(
        profile: ControllerProfile,
        taskId: String,
        path: String,
        decision: String,
    ): Result<TaskDiffReviewResponse> =
        api.reviewTaskDiffFile(profile, taskId, path, decision)

    suspend fun listSchedules(profile: ControllerProfile): Result<List<MobileScheduleItem>> =
        api.listSchedules(profile).map { it.schedules }

    suspend fun createSchedule(
        profile: ControllerProfile,
        request: CreateScheduleRequest,
    ): Result<ScheduleMutationResponse> =
        api.createSchedule(profile, request)

    suspend fun toggleSchedule(
        profile: ControllerProfile,
        scheduleId: String,
        enabled: Boolean,
    ): Result<ScheduleMutationResponse> =
        api.toggleSchedule(profile, scheduleId, enabled)

    suspend fun runScheduleNow(
        profile: ControllerProfile,
        scheduleId: String,
    ): Result<ScheduleMutationResponse> =
        api.runScheduleNow(profile, scheduleId)

    suspend fun deleteSchedule(
        profile: ControllerProfile,
        scheduleId: String,
    ): Result<ScheduleMutationResponse> =
        api.deleteSchedule(profile, scheduleId)
}
