package ai.wazir.mobile.domain

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

@Serializable
data class ControllerProfile(
    val id: String,
    val name: String,
    val baseUrl: String,
    val deviceId: String,
    val scopes: List<String> = listOf("read", "mutate", "execute"),
    val tlsCertFingerprint: String? = null,
    val controllerVersion: String = "0.1.63",
    val apiVersion: String = "1.0.0",
    val pairedAt: Long = System.currentTimeMillis(),
    val lastConnectedAt: Long? = null,
) {
    val canMutate: Boolean get() = scopes.contains("mutate")
    val canExecute: Boolean get() = scopes.contains("execute")
}

@Serializable
data class ParsedPairingUri(
    val sessionId: String,
    val pairingSecret: String,
    val controllerName: String,
    val controllerUrl: String?,
    val tlsCertFingerprint: String?,
    val apiVersion: String,
)

@Serializable
data class PairingRequestPayload(
    val sessionId: String,
    val pairingSecret: String,
    val deviceId: String,
    val deviceName: String,
    val deviceModel: String? = null,
    val osVersion: String? = null,
    val publicKeyFingerprint: String? = null,
)

@Serializable
data class PairingRequestResponse(
    val ok: Boolean = false,
    val sessionId: String? = null,
    val status: String? = null,
    val confirmationCode: String? = null,
    val controllerName: String? = null,
    val expiresAt: Long? = null,
    val error: String? = null,
    val code: String? = null,
)

@Serializable
data class PairingCompleteResponse(
    val ok: Boolean = false,
    val status: String? = null,
    val confirmationCode: String? = null,
    val deviceId: String? = null,
    val accessToken: String? = null,
    val refreshToken: String? = null,
    val expiresAt: Long? = null,
    val scopes: List<String> = emptyList(),
    val controller: PairedControllerMetadata? = null,
    val error: String? = null,
    val code: String? = null,
)

@Serializable
data class PairedControllerMetadata(
    val id: String,
    val name: String,
    val version: String = "0.1.63",
    val apiVersion: String = "1.0.0",
)

@Serializable
data class TokenRotationResponse(
    val ok: Boolean = false,
    val deviceId: String? = null,
    val accessToken: String? = null,
    val refreshToken: String? = null,
    val expiresAt: Long? = null,
    val scopes: List<String> = emptyList(),
    val error: String? = null,
)

@Serializable
data class HandshakeResponse(
    val compatible: Boolean = true,
    val apiVersion: String = "1.0.0",
    val minMobileVersion: String = "1.0.0",
    val controllerVersion: String = "0.1.63",
    val controllerId: String = "local",
    val hostname: String = "localhost",
    val principal: HandshakePrincipal? = null,
)

@Serializable
data class HandshakePrincipal(
    val id: String,
    val kind: String,
    val scopes: List<String> = emptyList(),
)

@Serializable
data class DashboardSnapshot(
    val controller: DashboardControllerInfo,
    val cards: DashboardCards,
    val recentActivity: List<MobileStreamEvent> = emptyList(),
)

@Serializable
data class DashboardControllerInfo(
    val id: String = "local",
    val hostname: String = "localhost",
    val version: String = "0.1.63",
    val apiVersion: String = "1.0.0",
    val timestamp: String = "",
)

@Serializable
data class DashboardCards(
    val runningTasks: Int = 0,
    val queuedTasks: Int = 0,
    val completedTasks: Int = 0,
    val failedTasks: Int = 0,
    val tasksRequiringApproval: Int = 0,
    val connectedWorkers: Int = 0,
    val totalComputers: Int = 0,
    val activeModels: Int = 0,
    val availableModels: Int = 0,
    val resourceStatus: DashboardResourceStatus = DashboardResourceStatus(),
)

@Serializable
data class DashboardResourceStatus(
    val mode: String = "normal",
    val emergencyStop: Boolean = false,
    val inFlightRequests: Int = 0,
    val totalTokensConsumed: Long = 0,
    val estimatedCostUsd: Double = 0.0,
)

@Serializable
data class MobileStreamEvent(
    val sequence: Long,
    val eventId: String,
    val timestamp: String,
    val type: String,
    val taskId: String? = null,
    val executionId: String? = null,
    val computerId: String? = null,
    val approvalId: String? = null,
    val agentId: String? = null,
    val modelId: String? = null,
    val status: String? = null,
    val summary: String,
    val payload: JsonObject = JsonObject(emptyMap()),
)

@Serializable
data class RecentEventsResponse(
    val cursor: Long = 0,
    val events: List<MobileStreamEvent> = emptyList(),
)

@Serializable
data class TaskListResponse(
    val tasks: List<MobileTaskSummary> = emptyList(),
    val timestamp: String = "",
)

@Serializable
data class MobileTaskSummary(
    val taskId: String,
    val executionId: String? = null,
    val jobId: String? = null,
    val title: String,
    val input: String,
    val agentId: String = "coding-agent",
    val modelId: String = "local-default",
    val runtimeId: String = "ollama",
    val computerId: String = "local",
    val priority: String = "normal",
    val state: String = "queued",
    val phase: String = "Queued",
    val currentOperation: String? = null,
    val createdAt: String = "",
    val startedAt: String? = null,
    val completedAt: String? = null,
    val lastActivityAt: String = "",
    val elapsedMs: Long = 0,
    val verificationStatus: String = "PENDING",
    val pendingApprovalIds: List<String> = emptyList(),
    val supportedActions: List<String> = emptyList(),
)

@Serializable
data class TaskDetailEnvelope(
    val task: MobileTaskDetail,
)

@Serializable
data class MobileTaskDetail(
    val taskId: String,
    val executionId: String? = null,
    val jobId: String? = null,
    val title: String,
    val input: String,
    val repository: String? = null,
    val agentId: String = "coding-agent",
    val modelId: String = "local-default",
    val runtimeId: String = "ollama",
    val computerId: String = "local",
    val priority: String = "normal",
    val state: String = "queued",
    val phase: String = "Queued",
    val currentOperation: String? = null,
    val createdAt: String = "",
    val startedAt: String? = null,
    val completedAt: String? = null,
    val lastActivityAt: String = "",
    val elapsedMs: Long = 0,
    val verificationStatus: String = "PENDING",
    val pendingApprovalIds: List<String> = emptyList(),
    val supportedActions: List<String> = emptyList(),
    val timeline: List<TimelineStep> = emptyList(),
    val reasoningSummaries: List<String> = emptyList(),
    val toolCalls: List<ToolCallRecord> = emptyList(),
    val filesChanged: List<String> = emptyList(),
    val verificationReport: VerificationReport? = null,
    val errors: List<String> = emptyList(),
    val resourceConsumption: TaskResourceConsumption = TaskResourceConsumption(),
    val finalOutput: String? = null,
    val logs: List<TaskLogEntry> = emptyList(),
)

@Serializable
data class TimelineStep(
    val id: String,
    val phase: String,
    val title: String,
    val status: String,
    val timestamp: String,
    val durationMs: Long? = null,
    val detail: String? = null,
)

@Serializable
data class ToolCallRecord(
    val callId: String,
    val tool: String,
    val status: String,
    val input: JsonObject = JsonObject(emptyMap()),
    val output: String? = null,
    val error: String? = null,
    val durationMs: Long = 0,
    val timestamp: String = "",
)

@Serializable
data class VerificationReport(
    val status: String,
    val checks: List<VerificationCheckItem> = emptyList(),
    val reasons: List<String> = emptyList(),
    val workspaceRevision: String? = null,
    val completedAt: String? = null,
)

@Serializable
data class VerificationCheckItem(
    val name: String,
    val status: String,
    val durationMs: Long = 0,
    val output: String? = null,
    val error: String? = null,
)

@Serializable
data class TaskResourceConsumption(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val totalTokens: Long = 0,
    val estimatedCostUsd: Double = 0.0,
    val durationMs: Long = 0,
    val source: String = "estimated",
)

@Serializable
data class TaskLogEntry(
    val sequence: Int,
    val timestamp: String,
    val level: String,
    val phase: String,
    val message: String,
)

@Serializable
data class CreateTaskRequest(
    val input: String,
    val title: String? = null,
    val repository: String? = null,
    val modelId: String? = null,
    val agentId: String? = null,
    val computerId: String? = null,
    val priority: String = "normal",
    val resourceBudget: TaskResourceBudgetRequest? = null,
    val policy: TaskPolicyRequest? = null,
)

@Serializable
data class TaskResourceBudgetRequest(
    val maxTokens: Long? = null,
    val maxCostUsd: Double? = null,
    val maxExecutionTimeSeconds: Int? = null,
)

@Serializable
data class TaskPolicyRequest(
    val localOnly: Boolean = true,
    val networkAccess: Boolean = false,
    val toolAccess: Boolean = true,
    val dataClassification: String = "internal",
)

@Serializable
data class SubmitTaskResponse(
    val taskId: String? = null,
    val duplicate: Boolean = false,
    val task: MobileTaskDetail? = null,
    val error: String? = null,
    val code: String? = null,
)

@Serializable
data class ApprovalListResponse(
    val approvals: List<MobileApprovalRecord> = emptyList(),
    val pendingCount: Int = 0,
    val timestamp: String = "",
)

@Serializable
data class MobileApprovalRecord(
    val id: String,
    val taskId: String? = null,
    val taskTitle: String? = null,
    val executionId: String? = null,
    val agentId: String? = null,
    val tool: String,
    val operation: String,
    val redactedArguments: JsonObject = JsonObject(emptyMap()),
    val argumentsHash: String,
    val relevantResources: List<String> = emptyList(),
    val riskClassification: String = "medium",
    val requiresBiometric: Boolean = false,
    val rule: String = "",
    val reasons: List<String> = emptyList(),
    val expectedSideEffects: String = "",
    val createdAt: String = "",
    val expiresAt: Long = 0,
    val status: String = "pending",
    val resolvedAt: String? = null,
    val resolvedBy: String? = null,
    val resolutionNote: String? = null,
)

@Serializable
data class ResolveApprovalRequest(
    val decision: String,
    val argumentsHash: String,
    val taskId: String? = null,
    val biometricVerified: Boolean = false,
    val note: String? = null,
)

@Serializable
data class ResolveApprovalResponse(
    val ok: Boolean = false,
    val approval: MobileApprovalRecord? = null,
    val error: String? = null,
    val code: String? = null,
)

@Serializable
data class ModelsApiResponse(
    val models: List<ModelCatalogItem> = emptyList(),
    val instances: List<ModelInstanceItem> = emptyList(),
)

@Serializable
data class ModelCatalogItem(
    val id: String,
    val name: String,
    val provider: String = "ollama",
    val family: String = "other",
    val parameters: String? = null,
    val quantization: String? = null,
    val contextMax: Int = 32768,
    val configuredContext: Int? = null,
    val capabilities: List<String> = emptyList(),
    val toolCalling: Boolean = false,
    val reasoning: Boolean = false,
    val vision: Boolean = false,
    val local: Boolean = true,
)

@Serializable
data class ModelInstanceItem(
    val id: String,
    val modelId: String,
    val computerId: String? = null,
    val runtimeId: String,
    val loaded: Boolean = false,
    val state: String? = null,
    val health: String = "healthy",
    val contextTokens: Int? = null,
    val pinned: Boolean? = false,
    val residentMemoryBytes: Long? = null,
)

@Serializable
data class RuntimesApiResponse(
    val runtimes: List<RuntimeItem> = emptyList(),
)

@Serializable
data class RuntimeItem(
    val id: String,
    val name: String,
    val type: String = "ollama",
    val version: String? = null,
    val url: String? = null,
    val computerId: String = "local",
    val health: String = "unavailable",
    val healthMessage: String? = null,
)

@Serializable
data class AgentsApiResponse(
    val agents: List<AgentDescriptorItem> = emptyList(),
)

@Serializable
data class AgentDescriptorItem(
    val name: String,
    val description: String = "",
    val source: String = "native",
)

@Serializable
data class ComputersApiResponse(
    val computers: List<ComputerTelemetryItem> = emptyList(),
    val timestamp: String = "",
)

@Serializable
data class ComputerTelemetryItem(
    val id: String,
    val name: String,
    val type: String = "workstation",
    val local: Boolean = false,
    val status: String = "online",
    val lastHeartbeat: String? = null,
    val sseConnected: Boolean = true,
    val os: ComputerOsInfo? = null,
    val hardware: ComputerHardwareSummary = ComputerHardwareSummary(),
    val telemetry: ComputerLiveTelemetry = ComputerLiveTelemetry(),
    val runningTasks: List<MobileTaskSummary> = emptyList(),
    val modelAssignments: List<ComputerModelAssignment> = emptyList(),
)

@Serializable
data class ComputerOsInfo(
    val platform: String = "",
    val architecture: String = "",
    val version: String = "",
)

@Serializable
data class ComputerHardwareSummary(
    val cpuModel: String? = null,
    val cpuCores: Int? = null,
    val memoryTotalGB: Double? = null,
    val unifiedMemory: Boolean = false,
    val gpus: List<ComputerGpuSummary> = emptyList(),
)

@Serializable
data class ComputerGpuSummary(
    val vendor: String = "unknown",
    val model: String = "",
    val vramGB: Double? = null,
    val unifiedMemory: Boolean = false,
    val cuda: Boolean = false,
)

@Serializable
data class ComputerLiveTelemetry(
    val cpuUtilizationPercent: Double? = null,
    val memoryUsedGB: Double? = null,
    val memoryTotalGB: Double? = null,
    val gpuUtilizationPercent: Double? = null,
    val gpuMemoryUsedGB: Double? = null,
    val gpuMemoryTotalGB: Double? = null,
    val telemetryAvailable: Boolean = false,
)

@Serializable
data class ComputerModelAssignment(
    val instanceId: String,
    val modelId: String,
    val runtimeId: String,
    val loaded: Boolean = false,
    val state: String = "INSTALLED",
    val health: String = "healthy",
    val pinned: Boolean = false,
    val contextTokens: Int? = null,
    val estimatedMemoryBytes: Long? = null,
)

@Serializable
data class ResourceBudgetSnapshot(
    val timestamp: String = "",
    val overallMode: String = "normal",
    val emergencyStop: EmergencyStopInfo? = null,
    val policy: ResourcePolicySummary = ResourcePolicySummary(),
    val totals: ResourceTotalsSummary = ResourceTotalsSummary(),
    val localVsHosted: LocalVsHostedSummary = LocalVsHostedSummary(),
    val usageBySource: UsageBySourceSummary = UsageBySourceSummary(),
    val reservations: List<ActiveReservationItem> = emptyList(),
    val accounts: List<AccountBudgetStatusItem> = emptyList(),
    val warnings: List<ResourceWarningItem> = emptyList(),
)

@Serializable
data class EmergencyStopInfo(
    val at: Long = 0,
    val reason: String = "",
)

@Serializable
data class ResourcePolicySummary(
    val enforce: Boolean = false,
    val paidApiFallback: Boolean = false,
    val dailySpendLimitUsd: Double = 0.0,
    val monthlySpendLimitUsd: Double = 0.0,
    val maxTaskTokens: Long = 0,
)

@Serializable
data class ResourceTotalsSummary(
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cachedInputTokens: Long = 0,
    val reasoningTokens: Long = 0,
    val totalTokens: Long = 0,
    val totalCostUsd: Double = 0.0,
    val providerReportedCostUsd: Double = 0.0,
    val estimatedCostUsd: Double = 0.0,
    val activeReservations: Int = 0,
)

@Serializable
data class LocalVsHostedSummary(
    val localTokens: Long = 0,
    val hostedTokens: Long = 0,
    val localRequests: Long = 0,
    val hostedRequests: Long = 0,
)

@Serializable
data class UsageBySourceSummary(
    val providerReportedTokens: Long = 0,
    val estimatedTokens: Long = 0,
    val conservativeTokens: Long = 0,
)

@Serializable
data class ActiveReservationItem(
    val id: String,
    val requestId: String,
    val accountId: String,
    val modelId: String,
    val taskId: String? = null,
    val workload: String = "routine",
    val estimatedInputTokens: Long = 0,
    val estimatedOutputTokens: Long = 0,
    val estimatedCostUsd: Double = 0.0,
    val createdAt: String = "",
    val leaseExpiresAt: String = "",
    val local: Boolean = true,
)

@Serializable
data class AccountBudgetStatusItem(
    val id: String,
    val kind: String = "local",
    val provider: String = "local",
    val enabled: Boolean = true,
    val health: String = "ok",
    val healthUntil: String? = null,
    val healthReason: String? = null,
    val throttlingMode: String = "normal",
    val inFlight: Int = 0,
    val limits: List<AccountLimitStatusItem> = emptyList(),
)

@Serializable
data class AccountLimitStatusItem(
    val unit: String,
    val window: String,
    val limit: Double? = null,
    val source: String = "estimated",
    val used: Double = 0.0,
    val reserved: Double = 0.0,
    val remaining: Double? = null,
    val utilizationPercent: Int? = null,
    val mode: String = "normal",
    val windowEnd: String? = null,
)

@Serializable
data class ResourceWarningItem(
    val severity: String,
    val accountId: String? = null,
    val message: String,
)

@Serializable
data class MobileAutonomyState(
    val ok: Boolean = true,
    val posture: String = "request-review",
    val networkGuard: String = "normal",
    val updatedAt: String = "",
    val updatedBy: String = "operator",
)

@Serializable
data class UpdateAutonomyRequest(
    val posture: String? = null,
    val networkGuard: String? = null,
    val updatedBy: String = "mobile-operator",
)

@Serializable
data class ArtifactPlanStep(
    val id: String = "",
    val title: String = "",
    val status: String = "pending",
)

@Serializable
data class MobileDiffFileItem(
    val path: String,
    val changeType: String = "modified",
    val additions: Int = 0,
    val deletions: Int = 0,
    val status: String = "pending",
    val patch: String = "",
)

@Serializable
data class ArtifactTestCheck(
    val name: String,
    val status: String,
    val durationMs: Long = 0,
    val output: String? = null,
)

@Serializable
data class MobileVerifiableArtifact(
    val id: String,
    val executionId: String = "",
    val kind: String,
    val title: String,
    val status: String = "pending",
    val createdAt: String = "",
    val summary: String = "",
    val steps: List<ArtifactPlanStep> = emptyList(),
    val files: List<MobileDiffFileItem> = emptyList(),
    val checks: List<ArtifactTestCheck> = emptyList(),
    val previewHtml: String? = null,
)

@Serializable
data class TaskArtifactsResponse(
    val ok: Boolean = true,
    val taskId: String = "",
    val executionId: String = "",
    val artifacts: List<MobileVerifiableArtifact> = emptyList(),
)

@Serializable
data class DiffReviewRequest(
    val path: String,
    val decision: String,
)

@Serializable
data class DiffReviewDecisionItem(
    val path: String,
    val decision: String,
    val updatedAt: String = "",
)

@Serializable
data class TaskDiffReviewResponse(
    val ok: Boolean = true,
    val taskId: String = "",
    val executionId: String = "",
    val reviews: List<DiffReviewDecisionItem> = emptyList(),
    val artifacts: List<MobileVerifiableArtifact> = emptyList(),
)

@Serializable
data class MobileScheduleItem(
    val id: String,
    val name: String,
    val prompt: String,
    val cronExpression: String,
    val agentId: String = "coding-agent",
    val modelId: String = "local-default",
    val autonomyPosture: String = "request-review",
    val enabled: Boolean = true,
    val lastRunAt: String? = null,
    val lastExecutionId: String? = null,
    val nextRunDescription: String = "",
    val createdAt: String = "",
)

@Serializable
data class ScheduleListResponse(
    val schedules: List<MobileScheduleItem> = emptyList(),
    val count: Int = 0,
)

@Serializable
data class CreateScheduleRequest(
    val name: String,
    val prompt: String,
    val cronExpression: String,
    val agentId: String = "coding-agent",
    val modelId: String = "local-default",
    val autonomyPosture: String = "request-review",
    val enabled: Boolean = true,
)

@Serializable
data class ScheduleMutationResponse(
    val ok: Boolean = true,
    val schedule: MobileScheduleItem? = null,
    val executionId: String? = null,
    val deleted: Boolean = false,
)

