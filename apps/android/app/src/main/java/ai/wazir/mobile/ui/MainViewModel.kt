package ai.wazir.mobile.ui

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import ai.wazir.mobile.data.WazirRepository
import ai.wazir.mobile.domain.AgentDescriptorItem
import ai.wazir.mobile.domain.ComputerTelemetryItem
import ai.wazir.mobile.domain.ControllerProfile
import ai.wazir.mobile.domain.CreateTaskRequest
import ai.wazir.mobile.domain.DashboardSnapshot
import ai.wazir.mobile.domain.MobileApprovalRecord
import ai.wazir.mobile.domain.MobileStreamEvent
import ai.wazir.mobile.domain.MobileTaskDetail
import ai.wazir.mobile.domain.MobileTaskSummary
import ai.wazir.mobile.domain.ModelCatalogItem
import ai.wazir.mobile.domain.ModelInstanceItem
import ai.wazir.mobile.domain.ResolveApprovalRequest
import ai.wazir.mobile.domain.ResourceBudgetSnapshot
import ai.wazir.mobile.domain.RuntimeItem
import ai.wazir.mobile.network.DiscoveredWazirController
import ai.wazir.mobile.network.MdnsControllerDiscovery
import ai.wazir.mobile.network.MobileSseEventStream
import ai.wazir.mobile.network.PairingUriParser
import ai.wazir.mobile.network.SseConnectionState
import ai.wazir.mobile.notifications.WazirNotificationManager
import ai.wazir.mobile.persistence.WazirDatabase
import ai.wazir.mobile.security.CredentialVault
import ai.wazir.mobile.security.KeystoreCredentialVault
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.UUID

sealed class PairingStage {
    data object Idle : PairingStage()
    data object RequestingSession : PairingStage()
    data class AwaitingOperatorApproval(
        val sessionId: String,
        val pairingSecret: String,
        val confirmationCode: String,
        val controllerName: String,
        val baseUrl: String,
        val tlsCertFingerprint: String?,
        val expiresAt: Long,
    ) : PairingStage()
    data class Completed(val profile: ControllerProfile) : PairingStage()
    data class Failed(val message: String) : PairingStage()
}

data class WazirUiState(
    val controllers: List<ControllerProfile> = emptyList(),
    val activeController: ControllerProfile? = null,
    val pairingStage: PairingStage = PairingStage.Idle,
    val discoveredControllers: List<DiscoveredWazirController> = emptyList(),
    val isMdnsScanning: Boolean = false,
    val sseState: SseConnectionState = SseConnectionState.DISCONNECTED,
    val isRefreshing: Boolean = false,
    val isOfflineCached: Boolean = false,
    val lastSyncedAtMs: Long? = null,
    val bannerMessage: String? = null,
    val bannerIsError: Boolean = false,
    val dashboard: DashboardSnapshot? = null,
    val recentEvents: List<MobileStreamEvent> = emptyList(),
    val tasks: List<MobileTaskSummary> = emptyList(),
    val selectedTaskTab: String = "all",
    val activeTaskDetail: MobileTaskDetail? = null,
    val activeTaskDetailCached: Boolean = false,
    val isSubmittingTask: Boolean = false,
    val approvals: List<MobileApprovalRecord> = emptyList(),
    val models: List<ModelCatalogItem> = emptyList(),
    val modelInstances: List<ModelInstanceItem> = emptyList(),
    val runtimes: List<RuntimeItem> = emptyList(),
    val agents: List<AgentDescriptorItem> = emptyList(),
    val computers: List<ComputerTelemetryItem> = emptyList(),
    val resources: ResourceBudgetSnapshot? = null,
) {
    val pendingApprovals: List<MobileApprovalRecord>
        get() = approvals.filter { it.status == "pending" }
}

class MainViewModel(
    private val repository: WazirRepository,
    credentialVault: CredentialVault,
    private val notificationManager: WazirNotificationManager? = null,
    private val mdnsDiscovery: MdnsControllerDiscovery? = null,
) : ViewModel() {

    private val _uiState = MutableStateFlow(WazirUiState())
    val uiState: StateFlow<WazirUiState> = _uiState.asStateFlow()

    private val sseStream = MobileSseEventStream(credentialVault, viewModelScope)
    private var pairingPollJob: Job? = null
    private var activeTaskMonitorJob: Job? = null

    init {
        viewModelScope.launch {
            repository.observeControllers().collect { list ->
                val currentActive = _uiState.value.activeController
                val nextActive = when {
                    list.isEmpty() -> null
                    currentActive != null && list.any { it.id == currentActive.id } ->
                        list.first { it.id == currentActive.id }
                    else -> list.first()
                }
                val switched = currentActive?.id != nextActive?.id
                _uiState.update {
                    it.copy(
                        controllers = list,
                        activeController = nextActive,
                    )
                }
                if (switched) {
                    if (nextActive != null) {
                        activateController(nextActive)
                    } else {
                        sseStream.disconnect()
                    }
                }
            }
        }

        viewModelScope.launch {
            sseStream.connectionState.collect { state ->
                _uiState.update { it.copy(sseState = state) }
            }
        }

        viewModelScope.launch {
            sseStream.events.collect { event ->
                handleIncomingStreamEvent(event)
            }
        }

        if (mdnsDiscovery != null) {
            viewModelScope.launch {
                mdnsDiscovery.discovered.collect { list ->
                    _uiState.update { it.copy(discoveredControllers = list) }
                }
            }
            viewModelScope.launch {
                mdnsDiscovery.isScanning.collect { scanning ->
                    _uiState.update { it.copy(isMdnsScanning = scanning) }
                }
            }
        }
    }

    fun selectController(controllerId: String) {
        val target = _uiState.value.controllers.firstOrNull { it.id == controllerId } ?: return
        if (_uiState.value.activeController?.id == target.id) return
        _uiState.update {
            it.copy(
                activeController = target,
                activeTaskDetail = null,
                bannerMessage = null,
            )
        }
        viewModelScope.launch {
            activateController(target)
        }
    }

    private suspend fun activateController(profile: ControllerProfile) {
        val cached = repository.loadCachedState(profile.id)
        _uiState.update {
            it.copy(
                dashboard = cached.dashboard,
                recentEvents = cached.dashboard?.recentActivity.orEmpty(),
                tasks = cached.tasks,
                approvals = cached.approvals,
                models = cached.models,
                modelInstances = cached.modelInstances,
                runtimes = cached.runtimes,
                agents = cached.agents,
                computers = cached.computers,
                resources = cached.resources,
                lastSyncedAtMs = cached.syncedAtMs,
                isOfflineCached = cached.syncedAtMs != null,
            )
        }
        sseStream.connect(profile, initialCursor = cached.lastSequence)
        refreshAll(silent = false)
    }

    fun refreshAll(silent: Boolean = false) {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            if (!silent) {
                _uiState.update { it.copy(isRefreshing = true) }
            }
            val cursor = sseStream.currentCursor()
            val result = repository.refreshControllerState(profile, cursor)
            result.onSuccess { fresh ->
                _uiState.update { state ->
                    val mergedEvents = mergeEvents(state.recentEvents, fresh.dashboard?.recentActivity.orEmpty())
                    state.copy(
                        isRefreshing = false,
                        isOfflineCached = false,
                        lastSyncedAtMs = fresh.syncedAtMs ?: System.currentTimeMillis(),
                        dashboard = fresh.dashboard,
                        recentEvents = mergedEvents,
                        tasks = fresh.tasks,
                        approvals = fresh.approvals,
                        models = fresh.models,
                        modelInstances = fresh.modelInstances,
                        runtimes = fresh.runtimes,
                        agents = fresh.agents,
                        computers = fresh.computers,
                        resources = fresh.resources,
                    )
                }
                val activeTaskId = _uiState.value.activeTaskDetail?.taskId
                if (activeTaskId != null) {
                    loadTaskDetail(activeTaskId)
                }
            }.onFailure { err ->
                _uiState.update {
                    it.copy(
                        isRefreshing = false,
                        isOfflineCached = true,
                        bannerMessage = "Showing cached controller state (${err.message ?: "offline"})",
                        bannerIsError = true,
                    )
                }
            }
        }
    }

    private fun handleIncomingStreamEvent(event: MobileStreamEvent) {
        val profile = _uiState.value.activeController ?: return
        notificationManager?.onStreamEvent(profile.id, profile.name, event)

        _uiState.update { state ->
            val updatedEvents = mergeEvents(listOf(event), state.recentEvents)
            state.copy(
                recentEvents = updatedEvents,
                isOfflineCached = false,
                lastSyncedAtMs = System.currentTimeMillis(),
            )
        }

        // Trigger targeted state refresh based on event type
        refreshAll(silent = true)
    }

    private fun mergeEvents(
        primary: List<MobileStreamEvent>,
        secondary: List<MobileStreamEvent>,
    ): List<MobileStreamEvent> {
        val byId = LinkedHashMap<String, MobileStreamEvent>()
        for (item in primary + secondary) {
            val key = item.eventId.ifBlank { "seq:${item.sequence}:${item.timestamp}" }
            if (!byId.containsKey(key)) {
                byId[key] = item
            }
        }
        return byId.values.sortedByDescending { it.sequence }.take(80)
    }

    // ─── Pairing & Discovery ─────────────────────────────────────────

    fun startMdnsScan() {
        mdnsDiscovery?.startDiscovery()
    }

    fun stopMdnsScan() {
        mdnsDiscovery?.stopDiscovery()
    }

    fun resetPairingStage() {
        pairingPollJob?.cancel()
        _uiState.update { it.copy(pairingStage = PairingStage.Idle) }
    }

    fun pairFromQrUri(rawQrUri: String, overrideControllerUrl: String? = null) {
        val parsedResult = PairingUriParser.parse(rawQrUri)
        parsedResult.onFailure { err ->
            _uiState.update {
                it.copy(
                    pairingStage = PairingStage.Failed(err.message ?: "Invalid QR pairing code"),
                )
            }
            return
        }
        val parsed = parsedResult.getOrThrow()
        val targetUrl = overrideControllerUrl?.takeIf { it.isNotBlank() } ?: parsed.controllerUrl
        if (targetUrl.isNullOrBlank()) {
            _uiState.update {
                it.copy(
                    pairingStage = PairingStage.Failed(
                        "QR code does not include a controller URL. Enter the HTTPS controller address manually."
                    )
                )
            }
            return
        }

        startPairingSession(
            baseUrl = targetUrl,
            tlsCertFingerprint = parsed.tlsCertFingerprint,
            sessionId = parsed.sessionId,
            pairingSecret = parsed.pairingSecret,
            controllerName = parsed.controllerName,
        )
    }

    fun startPairingSession(
        baseUrl: String,
        tlsCertFingerprint: String?,
        sessionId: String,
        pairingSecret: String,
        controllerName: String = "Wazir Controller",
        deviceNameOverride: String? = null,
    ) {
        pairingPollJob?.cancel()
        _uiState.update { it.copy(pairingStage = PairingStage.RequestingSession, bannerMessage = null) }

        viewModelScope.launch {
            val reqResult = repository.initiatePairing(
                baseUrl = baseUrl,
                tlsCertFingerprint = tlsCertFingerprint,
                sessionId = sessionId,
                pairingSecret = pairingSecret,
                deviceNameOverride = deviceNameOverride,
            )

            reqResult.onFailure { err ->
                _uiState.update {
                    it.copy(
                        pairingStage = PairingStage.Failed(err.message ?: "Pairing request failed"),
                    )
                }
                return@launch
            }

            val reqResp = reqResult.getOrThrow()
            val code = reqResp.confirmationCode ?: "------"
            val name = reqResp.controllerName ?: controllerName
            val expiresAt = reqResp.expiresAt ?: (System.currentTimeMillis() + 300_000L)

            _uiState.update {
                it.copy(
                    pairingStage = PairingStage.AwaitingOperatorApproval(
                        sessionId = sessionId,
                        pairingSecret = pairingSecret,
                        confirmationCode = code,
                        controllerName = name,
                        baseUrl = baseUrl,
                        tlsCertFingerprint = tlsCertFingerprint,
                        expiresAt = expiresAt,
                    )
                )
            }

            pairingPollJob = viewModelScope.launch {
                while (isActive && System.currentTimeMillis() < expiresAt) {
                    delay(1_500L)
                    val pollRes = repository.pollPairingCompletion(
                        baseUrl = baseUrl,
                        tlsCertFingerprint = tlsCertFingerprint,
                        sessionId = sessionId,
                        pairingSecret = pairingSecret,
                        fallbackName = name,
                    )
                    if (pollRes.isFailure) {
                        val err = pollRes.exceptionOrNull()
                        _uiState.update {
                            it.copy(
                                pairingStage = PairingStage.Failed(
                                    err?.message ?: "Operator rejected or pairing session expired"
                                )
                            )
                        }
                        break
                    }
                    val completedProfile = pollRes.getOrNull()
                    if (completedProfile != null) {
                        _uiState.update {
                            it.copy(
                                pairingStage = PairingStage.Completed(completedProfile),
                                activeController = completedProfile,
                                bannerMessage = "Paired securely with ${completedProfile.name}",
                                bannerIsError = false,
                            )
                        }
                        activateController(completedProfile)
                        break
                    }
                }
            }
        }
    }

    fun unpairController(controllerId: String) {
        viewModelScope.launch {
            repository.removeController(controllerId)
            _uiState.update {
                it.copy(
                    bannerMessage = "Controller unpaired and device credentials wiped from Keystore.",
                    bannerIsError = false,
                )
            }
        }
    }

    // ─── Tasks ───────────────────────────────────────────────────────

    fun setTaskTab(tab: String) {
        _uiState.update { it.copy(selectedTaskTab = tab) }
    }

    fun loadTaskDetail(taskId: String, startLivePolling: Boolean = false) {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            val (detail, fromCache) = repository.getTaskDetailWithOfflineFallback(profile, taskId)
            if (detail != null) {
                _uiState.update {
                    it.copy(
                        activeTaskDetail = detail,
                        activeTaskDetailCached = fromCache,
                    )
                }
            }
        }
        if (startLivePolling) {
            startTaskLivePolling(taskId)
        }
    }

    fun startTaskLivePolling(taskId: String) {
        activeTaskMonitorJob?.cancel()
        activeTaskMonitorJob = viewModelScope.launch {
            while (isActive) {
                val profile = _uiState.value.activeController ?: break
                val (detail, fromCache) = repository.getTaskDetailWithOfflineFallback(profile, taskId)
                if (detail != null) {
                    _uiState.update {
                        it.copy(
                            activeTaskDetail = detail,
                            activeTaskDetailCached = fromCache,
                        )
                    }
                    if (detail.state in listOf("completed", "failed", "cancelled")) {
                        break
                    }
                }
                delay(2_000L)
            }
        }
    }

    fun stopTaskLivePolling() {
        activeTaskMonitorJob?.cancel()
        activeTaskMonitorJob = null
    }

    fun submitNewTask(
        request: CreateTaskRequest,
        idempotencyKey: String = UUID.randomUUID().toString(),
        onSubmitted: (String) -> Unit,
    ) {
        val profile = _uiState.value.activeController ?: return
        if (_uiState.value.isSubmittingTask) return
        _uiState.update { it.copy(isSubmittingTask = true, bannerMessage = null) }

        viewModelScope.launch {
            val result = repository.submitTask(profile, request, idempotencyKey)
            result.onSuccess { resp ->
                val taskId = resp.taskId ?: resp.task?.taskId
                _uiState.update {
                    it.copy(
                        isSubmittingTask = false,
                        activeTaskDetail = resp.task ?: it.activeTaskDetail,
                        bannerMessage = if (resp.duplicate) "Duplicate submission prevented (idempotent)" else "Task submitted",
                        bannerIsError = false,
                    )
                }
                refreshAll(silent = true)
                if (!taskId.isNullOrBlank()) {
                    onSubmitted(taskId)
                }
            }.onFailure { err ->
                _uiState.update {
                    it.copy(
                        isSubmittingTask = false,
                        bannerMessage = err.message ?: "Failed to submit task",
                        bannerIsError = true,
                    )
                }
            }
        }
    }

    fun cancelTask(taskId: String) {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            repository.cancelTask(profile, taskId)
                .onSuccess { updated ->
                    _uiState.update {
                        it.copy(
                            activeTaskDetail = updated ?: it.activeTaskDetail,
                            bannerMessage = "Task $taskId cancelled",
                            bannerIsError = false,
                        )
                    }
                    refreshAll(silent = true)
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(bannerMessage = err.message ?: "Cancel failed", bannerIsError = true)
                    }
                }
        }
    }

    fun retryTask(taskId: String, onNewTaskCreated: ((String) -> Unit)? = null) {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            repository.retryTask(profile, taskId)
                .onSuccess { resp ->
                    val newId = resp.taskId ?: resp.task?.taskId
                    _uiState.update {
                        it.copy(
                            activeTaskDetail = resp.task ?: it.activeTaskDetail,
                            bannerMessage = "Task retried (${newId ?: taskId})",
                            bannerIsError = false,
                        )
                    }
                    refreshAll(silent = true)
                    if (!newId.isNullOrBlank()) {
                        onNewTaskCreated?.invoke(newId)
                    }
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(bannerMessage = err.message ?: "Retry failed", bannerIsError = true)
                    }
                }
        }
    }

    fun resumeTask(taskId: String) {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            repository.resumeTask(profile, taskId)
                .onSuccess { resp ->
                    _uiState.update {
                        it.copy(
                            activeTaskDetail = resp.task ?: it.activeTaskDetail,
                            bannerMessage = "Task resumed",
                            bannerIsError = false,
                        )
                    }
                    refreshAll(silent = true)
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(bannerMessage = err.message ?: "Resume failed", bannerIsError = true)
                    }
                }
        }
    }

    // ─── Approvals ───────────────────────────────────────────────────

    fun resolveApproval(
        approval: MobileApprovalRecord,
        decision: String,
        biometricVerified: Boolean,
        note: String? = null,
    ) {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            val req = ResolveApprovalRequest(
                decision = decision,
                argumentsHash = approval.argumentsHash,
                taskId = approval.taskId,
                biometricVerified = biometricVerified,
                note = note,
            )
            repository.resolveApproval(profile, approval.id, req)
                .onSuccess {
                    _uiState.update {
                        it.copy(
                            bannerMessage = "Approval ${approval.id} ${if (decision == "approve") "approved" else "rejected"}",
                            bannerIsError = false,
                        )
                    }
                    refreshAll(silent = true)
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(
                            bannerMessage = err.message ?: "Approval resolution failed",
                            bannerIsError = true,
                        )
                    }
                }
        }
    }

    // ─── Models & Runtimes ───────────────────────────────────────────

    fun loadModel(modelId: String, runtimeId: String = "ollama", computerId: String = "local") {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            repository.loadModel(profile, modelId, runtimeId, computerId)
                .onSuccess {
                    _uiState.update {
                        it.copy(bannerMessage = "Loaded model $modelId on $computerId", bannerIsError = false)
                    }
                    refreshAll(silent = true)
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(bannerMessage = err.message ?: "Load model failed", bannerIsError = true)
                    }
                }
        }
    }

    fun unloadModel(modelId: String, runtimeId: String = "ollama", computerId: String = "local") {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            repository.unloadModel(profile, modelId, runtimeId, computerId)
                .onSuccess {
                    _uiState.update {
                        it.copy(bannerMessage = "Unloaded model $modelId on $computerId", bannerIsError = false)
                    }
                    refreshAll(silent = true)
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(bannerMessage = err.message ?: "Unload model failed", bannerIsError = true)
                    }
                }
        }
    }

    fun reconcileModels() {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            repository.reconcileModels(profile)
                .onSuccess {
                    _uiState.update {
                        it.copy(bannerMessage = "Model residency reconciled with runtimes", bannerIsError = false)
                    }
                    refreshAll(silent = true)
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(bannerMessage = err.message ?: "Reconcile failed", bannerIsError = true)
                    }
                }
        }
    }

    // ─── Resource Budgets & Emergency Stop ───────────────────────────

    fun triggerEmergencyStop(reason: String) {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            repository.triggerEmergencyStop(profile, reason)
                .onSuccess {
                    _uiState.update {
                        it.copy(
                            bannerMessage = "Emergency Stop activated on ${profile.name}",
                            bannerIsError = true,
                        )
                    }
                    refreshAll(silent = true)
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(bannerMessage = err.message ?: "Emergency stop failed", bannerIsError = true)
                    }
                }
        }
    }

    fun resumeEmergencyStop() {
        val profile = _uiState.value.activeController ?: return
        viewModelScope.launch {
            repository.resumeEmergencyStop(profile)
                .onSuccess {
                    _uiState.update {
                        it.copy(
                            bannerMessage = "Emergency Stop cleared on ${profile.name}",
                            bannerIsError = false,
                        )
                    }
                    refreshAll(silent = true)
                }
                .onFailure { err ->
                    _uiState.update {
                        it.copy(bannerMessage = err.message ?: "Emergency resume failed", bannerIsError = true)
                    }
                }
        }
    }

    fun clearBanner() {
        _uiState.update { it.copy(bannerMessage = null) }
    }

    override fun onCleared() {
        super.onCleared()
        sseStream.disconnect()
        mdnsDiscovery?.stopDiscovery()
    }

    class Factory(private val appContext: Context) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            val db = WazirDatabase.getInstance(appContext)
            val vault = KeystoreCredentialVault(appContext)
            val repo = WazirRepository(db.cacheDao(), vault)
            val notifications = WazirNotificationManager(appContext)
            val mdns = MdnsControllerDiscovery(appContext)
            return MainViewModel(repo, vault, notifications, mdns) as T
        }
    }
}
