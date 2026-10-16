import Foundation

// MARK: - Pairing & connection profile

struct ControllerProfile: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var baseUrl: String
    var deviceId: String
    var scopes: [String] = ["read", "mutate", "execute"]
    var tlsCertFingerprint: String?
    var controllerVersion: String = "0.1.68"
    var apiVersion: String = "1.0.0"
    var pairedAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
    var lastConnectedAt: Int64?

    var canMutate: Bool { scopes.contains("mutate") }
    var canExecute: Bool { scopes.contains("execute") }
}

struct ParsedPairingUri: Equatable {
    var sessionId: String
    var pairingSecret: String
    var controllerName: String
    var controllerUrl: String?
    var tlsCertFingerprint: String?
    var apiVersion: String
}

struct PairingRequestPayload: Codable {
    var sessionId: String
    var pairingSecret: String
    var deviceId: String
    var deviceName: String
    var deviceModel: String?
    var osVersion: String?
    var publicKeyFingerprint: String?
}

struct PairingRequestResponse: Decodable {
    var ok: Bool
    var sessionId: String?
    var status: String?
    var confirmationCode: String?
    var controllerName: String?
    var expiresAt: Int64?
    var error: String?
    var code: String?

    private enum CodingKeys: String, CodingKey {
        case ok, sessionId, status, confirmationCode, controllerName, expiresAt, error, code
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok, default: false)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        confirmationCode = try c.decodeIfPresent(String.self, forKey: .confirmationCode)
        controllerName = try c.decodeIfPresent(String.self, forKey: .controllerName)
        expiresAt = try c.decodeIfPresent(Int64.self, forKey: .expiresAt)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        code = try c.decodeIfPresent(String.self, forKey: .code)
    }
}

struct PairedControllerMetadata: Decodable {
    var id: String
    var name: String
    var version: String
    var apiVersion: String

    private enum CodingKeys: String, CodingKey {
        case id, name, version, apiVersion
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: "")
        name = try c.decode(String.self, forKey: .name, default: "")
        version = try c.decode(String.self, forKey: .version, default: "0.1.68")
        apiVersion = try c.decode(String.self, forKey: .apiVersion, default: "1.0.0")
    }
}

struct PairingCompleteResponse: Decodable {
    var ok: Bool
    var status: String?
    var confirmationCode: String?
    var deviceId: String?
    var accessToken: String?
    var refreshToken: String?
    var expiresAt: Int64?
    var scopes: [String]
    var controller: PairedControllerMetadata?
    var error: String?
    var code: String?

    private enum CodingKeys: String, CodingKey {
        case ok, status, confirmationCode, deviceId, accessToken, refreshToken, expiresAt, scopes, controller, error, code
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok, default: false)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        confirmationCode = try c.decodeIfPresent(String.self, forKey: .confirmationCode)
        deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId)
        accessToken = try c.decodeIfPresent(String.self, forKey: .accessToken)
        refreshToken = try c.decodeIfPresent(String.self, forKey: .refreshToken)
        expiresAt = try c.decodeIfPresent(Int64.self, forKey: .expiresAt)
        scopes = try c.decode([String].self, forKey: .scopes, default: [])
        controller = try c.decodeIfPresent(PairedControllerMetadata.self, forKey: .controller)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        code = try c.decodeIfPresent(String.self, forKey: .code)
    }
}

struct TokenRotationResponse: Decodable {
    var ok: Bool
    var deviceId: String?
    var accessToken: String?
    var refreshToken: String?
    var expiresAt: Int64?
    var scopes: [String]
    var error: String?

    private enum CodingKeys: String, CodingKey {
        case ok, deviceId, accessToken, refreshToken, expiresAt, scopes, error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok, default: false)
        deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId)
        accessToken = try c.decodeIfPresent(String.self, forKey: .accessToken)
        refreshToken = try c.decodeIfPresent(String.self, forKey: .refreshToken)
        expiresAt = try c.decodeIfPresent(Int64.self, forKey: .expiresAt)
        scopes = try c.decode([String].self, forKey: .scopes, default: [])
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }
}

struct HandshakePrincipal: Decodable {
    var id: String
    var kind: String
    var scopes: [String]

    private enum CodingKeys: String, CodingKey {
        case id, kind, scopes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: "")
        kind = try c.decode(String.self, forKey: .kind, default: "device")
        scopes = try c.decode([String].self, forKey: .scopes, default: [])
    }
}

struct HandshakeResponse: Decodable {
    var compatible: Bool
    var apiVersion: String
    var minMobileVersion: String
    var controllerVersion: String
    var controllerId: String
    var hostname: String
    var principal: HandshakePrincipal?

    private enum CodingKeys: String, CodingKey {
        case compatible, apiVersion, minMobileVersion, controllerVersion, controllerId, hostname, principal
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        compatible = try c.decode(Bool.self, forKey: .compatible, default: true)
        apiVersion = try c.decode(String.self, forKey: .apiVersion, default: "1.0.0")
        minMobileVersion = try c.decode(String.self, forKey: .minMobileVersion, default: "1.0.0")
        controllerVersion = try c.decode(String.self, forKey: .controllerVersion, default: "0.1.68")
        controllerId = try c.decode(String.self, forKey: .controllerId, default: "local")
        hostname = try c.decode(String.self, forKey: .hostname, default: "localhost")
        principal = try c.decodeIfPresent(HandshakePrincipal.self, forKey: .principal)
    }
}

// MARK: - Dashboard

struct DashboardResourceStatus: Decodable {
    var mode: String
    var emergencyStop: Bool
    var inFlightRequests: Int
    var totalTokensConsumed: Int64
    var estimatedCostUsd: Double

    private enum CodingKeys: String, CodingKey {
        case mode, emergencyStop, inFlightRequests, totalTokensConsumed, estimatedCostUsd
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = try c.decode(String.self, forKey: .mode, default: "normal")
        emergencyStop = try c.decode(Bool.self, forKey: .emergencyStop, default: false)
        inFlightRequests = try c.decode(Int.self, forKey: .inFlightRequests, default: 0)
        totalTokensConsumed = try c.decode(Int64.self, forKey: .totalTokensConsumed, default: 0)
        estimatedCostUsd = try c.decode(Double.self, forKey: .estimatedCostUsd, default: 0)
    }

    init(mode: String, emergencyStop: Bool, inFlightRequests: Int, totalTokensConsumed: Int64, estimatedCostUsd: Double) {
        self.mode = mode
        self.emergencyStop = emergencyStop
        self.inFlightRequests = inFlightRequests
        self.totalTokensConsumed = totalTokensConsumed
        self.estimatedCostUsd = estimatedCostUsd
    }
}

struct DashboardCards: Decodable {
    var runningTasks: Int
    var queuedTasks: Int
    var completedTasks: Int
    var failedTasks: Int
    var tasksRequiringApproval: Int
    var connectedWorkers: Int
    var totalComputers: Int
    var activeModels: Int
    var availableModels: Int
    var resourceStatus: DashboardResourceStatus

    private enum CodingKeys: String, CodingKey {
        case runningTasks, queuedTasks, completedTasks, failedTasks, tasksRequiringApproval,
             connectedWorkers, totalComputers, activeModels, availableModels, resourceStatus
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runningTasks = try c.decode(Int.self, forKey: .runningTasks, default: 0)
        queuedTasks = try c.decode(Int.self, forKey: .queuedTasks, default: 0)
        completedTasks = try c.decode(Int.self, forKey: .completedTasks, default: 0)
        failedTasks = try c.decode(Int.self, forKey: .failedTasks, default: 0)
        tasksRequiringApproval = try c.decode(Int.self, forKey: .tasksRequiringApproval, default: 0)
        connectedWorkers = try c.decode(Int.self, forKey: .connectedWorkers, default: 0)
        totalComputers = try c.decode(Int.self, forKey: .totalComputers, default: 0)
        activeModels = try c.decode(Int.self, forKey: .activeModels, default: 0)
        availableModels = try c.decode(Int.self, forKey: .availableModels, default: 0)
        resourceStatus = try c.decodeIfPresent(DashboardResourceStatus.self, forKey: .resourceStatus)
            ?? DashboardResourceStatus(mode: "normal", emergencyStop: false, inFlightRequests: 0, totalTokensConsumed: 0, estimatedCostUsd: 0)
    }
}

struct DashboardControllerInfo: Decodable {
    var id: String
    var hostname: String
    var version: String
    var apiVersion: String
    var timestamp: String

    private enum CodingKeys: String, CodingKey {
        case id, hostname, version, apiVersion, timestamp
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: "local")
        hostname = try c.decode(String.self, forKey: .hostname, default: "localhost")
        version = try c.decode(String.self, forKey: .version, default: "0.1.68")
        apiVersion = try c.decode(String.self, forKey: .apiVersion, default: "1.0.0")
        timestamp = try c.decode(String.self, forKey: .timestamp, default: "")
    }
}

struct MobileStreamEvent: Decodable, Identifiable {
    var sequence: Int64
    var eventId: String
    var timestamp: String
    var type: String
    var taskId: String?
    var executionId: String?
    var computerId: String?
    var approvalId: String?
    var agentId: String?
    var modelId: String?
    var status: String?
    var summary: String

    var id: String { eventId }

    private enum CodingKeys: String, CodingKey {
        case sequence, eventId, timestamp, type, taskId, executionId, computerId, approvalId, agentId, modelId, status, summary
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sequence = try c.decode(Int64.self, forKey: .sequence, default: 0)
        eventId = try c.decode(String.self, forKey: .eventId, default: UUID().uuidString)
        timestamp = try c.decode(String.self, forKey: .timestamp, default: "")
        type = try c.decode(String.self, forKey: .type, default: "")
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        executionId = try c.decodeIfPresent(String.self, forKey: .executionId)
        computerId = try c.decodeIfPresent(String.self, forKey: .computerId)
        approvalId = try c.decodeIfPresent(String.self, forKey: .approvalId)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        modelId = try c.decodeIfPresent(String.self, forKey: .modelId)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        summary = try c.decode(String.self, forKey: .summary, default: "")
    }
}

struct DashboardSnapshot: Decodable {
    var controller: DashboardControllerInfo
    var cards: DashboardCards
    var recentActivity: [MobileStreamEvent]

    private enum CodingKeys: String, CodingKey {
        case controller, cards, recentActivity
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        controller = try c.decode(DashboardControllerInfo.self, forKey: .controller)
        cards = try c.decode(DashboardCards.self, forKey: .cards)
        recentActivity = try c.decode([MobileStreamEvent].self, forKey: .recentActivity, default: [])
    }
}

// MARK: - Tasks

struct MobileTaskSummary: Decodable, Identifiable, Equatable {
    var taskId: String
    var executionId: String?
    var jobId: String?
    var title: String
    var input: String
    var agentId: String
    var modelId: String
    var runtimeId: String
    var computerId: String
    var priority: String
    var state: String
    var phase: String
    var currentOperation: String?
    var createdAt: String
    var startedAt: String?
    var completedAt: String?
    var lastActivityAt: String
    var elapsedMs: Int64
    var verificationStatus: String
    var pendingApprovalIds: [String]
    var supportedActions: [String]

    var id: String { taskId }

    static func == (lhs: MobileTaskSummary, rhs: MobileTaskSummary) -> Bool { lhs.taskId == rhs.taskId && lhs.state == rhs.state && lhs.lastActivityAt == rhs.lastActivityAt }

    private enum CodingKeys: String, CodingKey {
        case taskId, executionId, jobId, title, input, agentId, modelId, runtimeId, computerId, priority,
             state, phase, currentOperation, createdAt, startedAt, completedAt, lastActivityAt, elapsedMs,
             verificationStatus, pendingApprovalIds, supportedActions
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId, default: "")
        executionId = try c.decodeIfPresent(String.self, forKey: .executionId)
        jobId = try c.decodeIfPresent(String.self, forKey: .jobId)
        title = try c.decode(String.self, forKey: .title, default: "")
        input = try c.decode(String.self, forKey: .input, default: "")
        agentId = try c.decode(String.self, forKey: .agentId, default: "coding-agent")
        modelId = try c.decode(String.self, forKey: .modelId, default: "local-default")
        runtimeId = try c.decode(String.self, forKey: .runtimeId, default: "ollama")
        computerId = try c.decode(String.self, forKey: .computerId, default: "local")
        priority = try c.decode(String.self, forKey: .priority, default: "normal")
        state = try c.decode(String.self, forKey: .state, default: "queued")
        phase = try c.decode(String.self, forKey: .phase, default: "Queued")
        currentOperation = try c.decodeIfPresent(String.self, forKey: .currentOperation)
        createdAt = try c.decode(String.self, forKey: .createdAt, default: "")
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
        completedAt = try c.decodeIfPresent(String.self, forKey: .completedAt)
        lastActivityAt = try c.decode(String.self, forKey: .lastActivityAt, default: "")
        elapsedMs = try c.decode(Int64.self, forKey: .elapsedMs, default: 0)
        verificationStatus = try c.decode(String.self, forKey: .verificationStatus, default: "PENDING")
        pendingApprovalIds = try c.decode([String].self, forKey: .pendingApprovalIds, default: [])
        supportedActions = try c.decode([String].self, forKey: .supportedActions, default: [])
    }
}

struct TaskListResponse: Decodable {
    var tasks: [MobileTaskSummary]
    var timestamp: String

    private enum CodingKeys: String, CodingKey {
        case tasks, timestamp
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tasks = try c.decode([MobileTaskSummary].self, forKey: .tasks, default: [])
        timestamp = try c.decode(String.self, forKey: .timestamp, default: "")
    }
}

struct TimelineStep: Decodable, Identifiable {
    var id: String
    var phase: String
    var title: String
    var status: String
    var timestamp: String
    var durationMs: Int64?
    var detail: String?

    private enum CodingKeys: String, CodingKey {
        case id, phase, title, status, timestamp, durationMs, detail
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: UUID().uuidString)
        phase = try c.decode(String.self, forKey: .phase, default: "")
        title = try c.decode(String.self, forKey: .title, default: "")
        status = try c.decode(String.self, forKey: .status, default: "")
        timestamp = try c.decode(String.self, forKey: .timestamp, default: "")
        durationMs = try c.decodeIfPresent(Int64.self, forKey: .durationMs)
        detail = try c.decodeIfPresent(String.self, forKey: .detail)
    }
}

struct ToolCallRecord: Decodable, Identifiable {
    var callId: String
    var tool: String
    var status: String
    var output: String?
    var error: String?
    var durationMs: Int64
    var timestamp: String

    var id: String { callId }

    private enum CodingKeys: String, CodingKey {
        case callId, tool, status, output, error, durationMs, timestamp
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        callId = try c.decode(String.self, forKey: .callId, default: UUID().uuidString)
        tool = try c.decode(String.self, forKey: .tool, default: "")
        status = try c.decode(String.self, forKey: .status, default: "")
        output = try c.decodeIfPresent(String.self, forKey: .output)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        durationMs = try c.decode(Int64.self, forKey: .durationMs, default: 0)
        timestamp = try c.decode(String.self, forKey: .timestamp, default: "")
    }
}

struct VerificationCheckItem: Decodable, Identifiable {
    var name: String
    var status: String
    var durationMs: Int64
    var output: String?
    var error: String?

    var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name, status, durationMs, output, error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name, default: "")
        status = try c.decode(String.self, forKey: .status, default: "")
        durationMs = try c.decode(Int64.self, forKey: .durationMs, default: 0)
        output = try c.decodeIfPresent(String.self, forKey: .output)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }
}

struct VerificationReport: Decodable {
    var status: String
    var checks: [VerificationCheckItem]
    var reasons: [String]
    var workspaceRevision: String?
    var completedAt: String?

    private enum CodingKeys: String, CodingKey {
        case status, checks, reasons, workspaceRevision, completedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decode(String.self, forKey: .status, default: "")
        checks = try c.decode([VerificationCheckItem].self, forKey: .checks, default: [])
        reasons = try c.decode([String].self, forKey: .reasons, default: [])
        workspaceRevision = try c.decodeIfPresent(String.self, forKey: .workspaceRevision)
        completedAt = try c.decodeIfPresent(String.self, forKey: .completedAt)
    }
}

struct TaskResourceConsumption: Decodable {
    var inputTokens: Int64
    var outputTokens: Int64
    var totalTokens: Int64
    var estimatedCostUsd: Double
    var durationMs: Int64
    var source: String

    private enum CodingKeys: String, CodingKey {
        case inputTokens, outputTokens, totalTokens, estimatedCostUsd, durationMs, source
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = try c.decode(Int64.self, forKey: .inputTokens, default: 0)
        outputTokens = try c.decode(Int64.self, forKey: .outputTokens, default: 0)
        totalTokens = try c.decode(Int64.self, forKey: .totalTokens, default: 0)
        estimatedCostUsd = try c.decode(Double.self, forKey: .estimatedCostUsd, default: 0)
        durationMs = try c.decode(Int64.self, forKey: .durationMs, default: 0)
        source = try c.decode(String.self, forKey: .source, default: "estimated")
    }
}

struct TaskLogEntry: Decodable, Identifiable {
    var sequence: Int
    var timestamp: String
    var level: String
    var phase: String
    var message: String

    var id: Int { sequence }

    private enum CodingKeys: String, CodingKey {
        case sequence, timestamp, level, phase, message
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sequence = try c.decode(Int.self, forKey: .sequence, default: 0)
        timestamp = try c.decode(String.self, forKey: .timestamp, default: "")
        level = try c.decode(String.self, forKey: .level, default: "info")
        phase = try c.decode(String.self, forKey: .phase, default: "")
        message = try c.decode(String.self, forKey: .message, default: "")
    }
}

struct MobileTaskDetail: Decodable, Identifiable {
    var taskId: String
    var executionId: String?
    var jobId: String?
    var title: String
    var input: String
    var repository: String?
    var agentId: String
    var modelId: String
    var runtimeId: String
    var computerId: String
    var priority: String
    var state: String
    var phase: String
    var currentOperation: String?
    var createdAt: String
    var startedAt: String?
    var completedAt: String?
    var lastActivityAt: String
    var elapsedMs: Int64
    var verificationStatus: String
    var pendingApprovalIds: [String]
    var supportedActions: [String]
    var timeline: [TimelineStep]
    var reasoningSummaries: [String]
    var toolCalls: [ToolCallRecord]
    var filesChanged: [String]
    var verificationReport: VerificationReport?
    var errors: [String]
    var resourceConsumption: TaskResourceConsumption
    var finalOutput: String?
    var logs: [TaskLogEntry]

    var id: String { taskId }

    private enum CodingKeys: String, CodingKey {
        case taskId, executionId, jobId, title, input, repository, agentId, modelId, runtimeId, computerId,
             priority, state, phase, currentOperation, createdAt, startedAt, completedAt, lastActivityAt,
             elapsedMs, verificationStatus, pendingApprovalIds, supportedActions, timeline, reasoningSummaries,
             toolCalls, filesChanged, verificationReport, errors, resourceConsumption, finalOutput, logs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decode(String.self, forKey: .taskId, default: "")
        executionId = try c.decodeIfPresent(String.self, forKey: .executionId)
        jobId = try c.decodeIfPresent(String.self, forKey: .jobId)
        title = try c.decode(String.self, forKey: .title, default: "")
        input = try c.decode(String.self, forKey: .input, default: "")
        repository = try c.decodeIfPresent(String.self, forKey: .repository)
        agentId = try c.decode(String.self, forKey: .agentId, default: "coding-agent")
        modelId = try c.decode(String.self, forKey: .modelId, default: "local-default")
        runtimeId = try c.decode(String.self, forKey: .runtimeId, default: "ollama")
        computerId = try c.decode(String.self, forKey: .computerId, default: "local")
        priority = try c.decode(String.self, forKey: .priority, default: "normal")
        state = try c.decode(String.self, forKey: .state, default: "queued")
        phase = try c.decode(String.self, forKey: .phase, default: "Queued")
        currentOperation = try c.decodeIfPresent(String.self, forKey: .currentOperation)
        createdAt = try c.decode(String.self, forKey: .createdAt, default: "")
        startedAt = try c.decodeIfPresent(String.self, forKey: .startedAt)
        completedAt = try c.decodeIfPresent(String.self, forKey: .completedAt)
        lastActivityAt = try c.decode(String.self, forKey: .lastActivityAt, default: "")
        elapsedMs = try c.decode(Int64.self, forKey: .elapsedMs, default: 0)
        verificationStatus = try c.decode(String.self, forKey: .verificationStatus, default: "PENDING")
        pendingApprovalIds = try c.decode([String].self, forKey: .pendingApprovalIds, default: [])
        supportedActions = try c.decode([String].self, forKey: .supportedActions, default: [])
        timeline = try c.decode([TimelineStep].self, forKey: .timeline, default: [])
        reasoningSummaries = try c.decode([String].self, forKey: .reasoningSummaries, default: [])
        toolCalls = try c.decode([ToolCallRecord].self, forKey: .toolCalls, default: [])
        filesChanged = try c.decode([String].self, forKey: .filesChanged, default: [])
        verificationReport = try c.decodeIfPresent(VerificationReport.self, forKey: .verificationReport)
        errors = try c.decode([String].self, forKey: .errors, default: [])
        resourceConsumption = try c.decodeIfPresent(TaskResourceConsumption.self, forKey: .resourceConsumption)
            ?? (try JSONDecoder().decode(TaskResourceConsumption.self, from: Data("{}".utf8)))
        finalOutput = try c.decodeIfPresent(String.self, forKey: .finalOutput)
        logs = try c.decode([TaskLogEntry].self, forKey: .logs, default: [])
    }
}

struct TaskDetailEnvelope: Decodable {
    var task: MobileTaskDetail
}

// MARK: - Create task

struct TaskResourceBudgetRequest: Codable {
    var maxTokens: Int64?
    var maxCostUsd: Double?
    var maxExecutionTimeSeconds: Int?
}

struct TaskPolicyRequest: Codable {
    var localOnly: Bool = true
    var networkAccess: Bool = false
    var toolAccess: Bool = true
    var dataClassification: String = "internal"
}

struct CreateTaskRequest: Codable {
    var input: String
    var title: String?
    var repository: String?
    var modelId: String?
    var agentId: String?
    var computerId: String?
    var priority: String = "normal"
    var resourceBudget: TaskResourceBudgetRequest?
    var policy: TaskPolicyRequest?
}

struct SubmitTaskResponse: Decodable {
    var taskId: String?
    var duplicate: Bool
    var task: MobileTaskDetail?
    var error: String?
    var code: String?

    private enum CodingKeys: String, CodingKey {
        case taskId, duplicate, task, error, code
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        duplicate = try c.decode(Bool.self, forKey: .duplicate, default: false)
        task = try c.decodeIfPresent(MobileTaskDetail.self, forKey: .task)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        code = try c.decodeIfPresent(String.self, forKey: .code)
    }
}

// MARK: - Approvals

struct MobileApprovalRecord: Decodable, Identifiable {
    var id: String
    var taskId: String?
    var taskTitle: String?
    var executionId: String?
    var agentId: String?
    var tool: String
    var operation: String
    var argumentsHash: String
    var redactedArgumentsDescription: String
    var relevantResources: [String]
    var riskClassification: String
    var requiresBiometric: Bool
    var rule: String
    var reasons: [String]
    var expectedSideEffects: String
    var createdAt: String
    var expiresAt: Int64
    var status: String
    var resolvedAt: String?
    var resolvedBy: String?
    var resolutionNote: String?

    private enum CodingKeys: String, CodingKey {
        case id, taskId, taskTitle, executionId, agentId, tool, operation, redactedArguments, argumentsHash,
             relevantResources, riskClassification, requiresBiometric, rule, reasons, expectedSideEffects,
             createdAt, expiresAt, status, resolvedAt, resolvedBy, resolutionNote
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: "")
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        taskTitle = try c.decodeIfPresent(String.self, forKey: .taskTitle)
        executionId = try c.decodeIfPresent(String.self, forKey: .executionId)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        tool = try c.decode(String.self, forKey: .tool, default: "")
        operation = try c.decode(String.self, forKey: .operation, default: "")
        argumentsHash = try c.decode(String.self, forKey: .argumentsHash, default: "")
        if let raw = try c.decodeIfPresent(JSONValue.self, forKey: .redactedArguments) {
            redactedArgumentsDescription = raw.prettyDescription
        } else {
            redactedArgumentsDescription = "{}"
        }
        relevantResources = try c.decode([String].self, forKey: .relevantResources, default: [])
        riskClassification = try c.decode(String.self, forKey: .riskClassification, default: "medium")
        requiresBiometric = try c.decode(Bool.self, forKey: .requiresBiometric, default: false)
        rule = try c.decode(String.self, forKey: .rule, default: "")
        reasons = try c.decode([String].self, forKey: .reasons, default: [])
        expectedSideEffects = try c.decode(String.self, forKey: .expectedSideEffects, default: "")
        createdAt = try c.decode(String.self, forKey: .createdAt, default: "")
        expiresAt = try c.decode(Int64.self, forKey: .expiresAt, default: 0)
        status = try c.decode(String.self, forKey: .status, default: "pending")
        resolvedAt = try c.decodeIfPresent(String.self, forKey: .resolvedAt)
        resolvedBy = try c.decodeIfPresent(String.self, forKey: .resolvedBy)
        resolutionNote = try c.decodeIfPresent(String.self, forKey: .resolutionNote)
    }
}

struct ApprovalListResponse: Decodable {
    var approvals: [MobileApprovalRecord]
    var pendingCount: Int
    var timestamp: String

    private enum CodingKeys: String, CodingKey {
        case approvals, pendingCount, timestamp
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approvals = try c.decode([MobileApprovalRecord].self, forKey: .approvals, default: [])
        pendingCount = try c.decode(Int.self, forKey: .pendingCount, default: 0)
        timestamp = try c.decode(String.self, forKey: .timestamp, default: "")
    }
}

struct ResolveApprovalRequest: Codable {
    var decision: String
    var argumentsHash: String
    var taskId: String?
    var biometricVerified: Bool = false
    var note: String?
}

struct ResolveApprovalResponse: Decodable {
    var ok: Bool
    var approval: MobileApprovalRecord?
    var error: String?
    var code: String?

    private enum CodingKeys: String, CodingKey {
        case ok, approval, error, code
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decode(Bool.self, forKey: .ok, default: false)
        approval = try c.decodeIfPresent(MobileApprovalRecord.self, forKey: .approval)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        code = try c.decodeIfPresent(String.self, forKey: .code)
    }
}

// MARK: - Models, runtimes, agents (read-only on mobile — see WazirControllerApi)

struct ModelCatalogItem: Decodable, Identifiable {
    var id: String
    var name: String
    var provider: String
    var family: String
    var parameters: String?
    var quantization: String?
    var contextMax: Int
    var configuredContext: Int?
    var toolCalling: Bool
    var reasoning: Bool
    var vision: Bool
    var local: Bool

    private enum CodingKeys: String, CodingKey {
        case id, name, provider, family, parameters, quantization, contextMax, configuredContext,
             toolCalling, reasoning, vision, local
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: "")
        name = try c.decode(String.self, forKey: .name, default: "")
        provider = try c.decode(String.self, forKey: .provider, default: "ollama")
        family = try c.decode(String.self, forKey: .family, default: "other")
        parameters = try c.decodeIfPresent(String.self, forKey: .parameters)
        quantization = try c.decodeIfPresent(String.self, forKey: .quantization)
        contextMax = try c.decode(Int.self, forKey: .contextMax, default: 32768)
        configuredContext = try c.decodeIfPresent(Int.self, forKey: .configuredContext)
        toolCalling = try c.decode(Bool.self, forKey: .toolCalling, default: false)
        reasoning = try c.decode(Bool.self, forKey: .reasoning, default: false)
        vision = try c.decode(Bool.self, forKey: .vision, default: false)
        local = try c.decode(Bool.self, forKey: .local, default: true)
    }
}

struct ModelInstanceItem: Decodable, Identifiable {
    var id: String
    var modelId: String
    var computerId: String?
    var runtimeId: String
    var loaded: Bool
    var state: String?
    var health: String
    var pinned: Bool?

    private enum CodingKeys: String, CodingKey {
        case id, modelId, computerId, runtimeId, loaded, state, health, pinned
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: "")
        modelId = try c.decode(String.self, forKey: .modelId, default: "")
        computerId = try c.decodeIfPresent(String.self, forKey: .computerId)
        runtimeId = try c.decode(String.self, forKey: .runtimeId, default: "")
        loaded = try c.decode(Bool.self, forKey: .loaded, default: false)
        state = try c.decodeIfPresent(String.self, forKey: .state)
        health = try c.decode(String.self, forKey: .health, default: "healthy")
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned)
    }
}

struct ModelsApiResponse: Decodable {
    var models: [ModelCatalogItem]
    var instances: [ModelInstanceItem]

    private enum CodingKeys: String, CodingKey {
        case models, instances
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        models = try c.decode([ModelCatalogItem].self, forKey: .models, default: [])
        instances = try c.decode([ModelInstanceItem].self, forKey: .instances, default: [])
    }
}

struct RuntimeItem: Decodable, Identifiable {
    var id: String
    var name: String
    var type: String
    var version: String?
    var computerId: String
    var health: String
    var healthMessage: String?

    private enum CodingKeys: String, CodingKey {
        case id, name, type, version, computerId, health, healthMessage
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: "")
        name = try c.decode(String.self, forKey: .name, default: "")
        type = try c.decode(String.self, forKey: .type, default: "ollama")
        version = try c.decodeIfPresent(String.self, forKey: .version)
        computerId = try c.decode(String.self, forKey: .computerId, default: "local")
        health = try c.decode(String.self, forKey: .health, default: "unavailable")
        healthMessage = try c.decodeIfPresent(String.self, forKey: .healthMessage)
    }
}

struct RuntimesApiResponse: Decodable {
    var runtimes: [RuntimeItem]

    private enum CodingKeys: String, CodingKey {
        case runtimes
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runtimes = try c.decode([RuntimeItem].self, forKey: .runtimes, default: [])
    }
}

struct AgentDescriptorItem: Decodable, Identifiable {
    var name: String
    var description: String
    var source: String
    var id: String { name }

    private enum CodingKeys: String, CodingKey {
        case name, description, source
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name, default: "")
        description = try c.decode(String.self, forKey: .description, default: "")
        source = try c.decode(String.self, forKey: .source, default: "native")
    }
}

struct AgentsApiResponse: Decodable {
    var agents: [AgentDescriptorItem]

    private enum CodingKeys: String, CodingKey {
        case agents
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = try c.decode([AgentDescriptorItem].self, forKey: .agents, default: [])
    }
}

// MARK: - Compute & workers

struct ComputerOsInfo: Decodable {
    var platform: String
    var architecture: String
    var version: String

    private enum CodingKeys: String, CodingKey {
        case platform, architecture, version
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        platform = try c.decode(String.self, forKey: .platform, default: "")
        architecture = try c.decode(String.self, forKey: .architecture, default: "")
        version = try c.decode(String.self, forKey: .version, default: "")
    }
}

struct ComputerGpuSummary: Decodable, Identifiable {
    var vendor: String
    var model: String
    var vramGB: Double?
    var id: String { "\(vendor)-\(model)" }

    private enum CodingKeys: String, CodingKey {
        case vendor, model, vramGB
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        vendor = try c.decode(String.self, forKey: .vendor, default: "unknown")
        model = try c.decode(String.self, forKey: .model, default: "")
        vramGB = try c.decodeIfPresent(Double.self, forKey: .vramGB)
    }
}

struct ComputerHardwareSummary: Decodable {
    var cpuModel: String?
    var cpuCores: Int?
    var gpus: [ComputerGpuSummary]

    private enum CodingKeys: String, CodingKey {
        case cpuModel, cpuCores, gpus
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cpuModel = try c.decodeIfPresent(String.self, forKey: .cpuModel)
        cpuCores = try c.decodeIfPresent(Int.self, forKey: .cpuCores)
        gpus = try c.decode([ComputerGpuSummary].self, forKey: .gpus, default: [])
    }

    init() {
        cpuModel = nil
        cpuCores = nil
        gpus = []
    }
}

struct ComputerLiveTelemetry: Decodable {
    var cpuUtilizationPercent: Double?
    var memoryUsedGB: Double?
    var memoryTotalGB: Double?
    var gpuUtilizationPercent: Double?
    var gpuMemoryUsedGB: Double?
    var gpuMemoryTotalGB: Double?
    var telemetryAvailable: Bool

    private enum CodingKeys: String, CodingKey {
        case cpuUtilizationPercent, memoryUsedGB, memoryTotalGB, gpuUtilizationPercent,
             gpuMemoryUsedGB, gpuMemoryTotalGB, telemetryAvailable
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cpuUtilizationPercent = try c.decodeIfPresent(Double.self, forKey: .cpuUtilizationPercent)
        memoryUsedGB = try c.decodeIfPresent(Double.self, forKey: .memoryUsedGB)
        memoryTotalGB = try c.decodeIfPresent(Double.self, forKey: .memoryTotalGB)
        gpuUtilizationPercent = try c.decodeIfPresent(Double.self, forKey: .gpuUtilizationPercent)
        gpuMemoryUsedGB = try c.decodeIfPresent(Double.self, forKey: .gpuMemoryUsedGB)
        gpuMemoryTotalGB = try c.decodeIfPresent(Double.self, forKey: .gpuMemoryTotalGB)
        telemetryAvailable = try c.decode(Bool.self, forKey: .telemetryAvailable, default: false)
    }

    init() {
        cpuUtilizationPercent = nil
        memoryUsedGB = nil
        memoryTotalGB = nil
        gpuUtilizationPercent = nil
        gpuMemoryUsedGB = nil
        gpuMemoryTotalGB = nil
        telemetryAvailable = false
    }
}

struct ComputerModelAssignment: Decodable, Identifiable {
    var instanceId: String
    var modelId: String
    var loaded: Bool
    var state: String
    var id: String { instanceId }

    private enum CodingKeys: String, CodingKey {
        case instanceId, modelId, loaded, state
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        instanceId = try c.decode(String.self, forKey: .instanceId, default: UUID().uuidString)
        modelId = try c.decode(String.self, forKey: .modelId, default: "")
        loaded = try c.decode(Bool.self, forKey: .loaded, default: false)
        state = try c.decode(String.self, forKey: .state, default: "INSTALLED")
    }
}

struct ComputerTelemetryItem: Decodable, Identifiable {
    var id: String
    var name: String
    var type: String
    var local: Bool
    var status: String
    var lastHeartbeat: String?
    var os: ComputerOsInfo?
    var hardware: ComputerHardwareSummary
    var telemetry: ComputerLiveTelemetry
    var runningTasks: [MobileTaskSummary]
    var modelAssignments: [ComputerModelAssignment]

    private enum CodingKeys: String, CodingKey {
        case id, name, type, local, status, lastHeartbeat, os, hardware, telemetry, runningTasks, modelAssignments
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: "")
        name = try c.decode(String.self, forKey: .name, default: "")
        type = try c.decode(String.self, forKey: .type, default: "workstation")
        local = try c.decode(Bool.self, forKey: .local, default: false)
        status = try c.decode(String.self, forKey: .status, default: "online")
        lastHeartbeat = try c.decodeIfPresent(String.self, forKey: .lastHeartbeat)
        os = try c.decodeIfPresent(ComputerOsInfo.self, forKey: .os)
        hardware = try c.decodeIfPresent(ComputerHardwareSummary.self, forKey: .hardware) ?? ComputerHardwareSummary()
        telemetry = try c.decodeIfPresent(ComputerLiveTelemetry.self, forKey: .telemetry) ?? ComputerLiveTelemetry()
        runningTasks = try c.decode([MobileTaskSummary].self, forKey: .runningTasks, default: [])
        modelAssignments = try c.decode([ComputerModelAssignment].self, forKey: .modelAssignments, default: [])
    }
}

struct ComputersApiResponse: Decodable {
    var computers: [ComputerTelemetryItem]
    var timestamp: String

    private enum CodingKeys: String, CodingKey {
        case computers, timestamp
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        computers = try c.decode([ComputerTelemetryItem].self, forKey: .computers, default: [])
        timestamp = try c.decode(String.self, forKey: .timestamp, default: "")
    }
}

// MARK: - Resources & budgets

struct EmergencyStopInfo: Decodable {
    var at: Int64
    var reason: String

    private enum CodingKeys: String, CodingKey {
        case at, reason
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = try c.decode(Int64.self, forKey: .at, default: 0)
        reason = try c.decode(String.self, forKey: .reason, default: "")
    }
}

struct ResourceTotalsSummary: Decodable {
    var inputTokens: Int64
    var outputTokens: Int64
    var totalTokens: Int64
    var totalCostUsd: Double
    var providerReportedCostUsd: Double
    var estimatedCostUsd: Double
    var activeReservations: Int

    private enum CodingKeys: String, CodingKey {
        case inputTokens, outputTokens, totalTokens, totalCostUsd, providerReportedCostUsd, estimatedCostUsd, activeReservations
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = try c.decode(Int64.self, forKey: .inputTokens, default: 0)
        outputTokens = try c.decode(Int64.self, forKey: .outputTokens, default: 0)
        totalTokens = try c.decode(Int64.self, forKey: .totalTokens, default: 0)
        totalCostUsd = try c.decode(Double.self, forKey: .totalCostUsd, default: 0)
        providerReportedCostUsd = try c.decode(Double.self, forKey: .providerReportedCostUsd, default: 0)
        estimatedCostUsd = try c.decode(Double.self, forKey: .estimatedCostUsd, default: 0)
        activeReservations = try c.decode(Int.self, forKey: .activeReservations, default: 0)
    }

    init() {
        inputTokens = 0; outputTokens = 0; totalTokens = 0
        totalCostUsd = 0; providerReportedCostUsd = 0; estimatedCostUsd = 0
        activeReservations = 0
    }
}

struct LocalVsHostedSummary: Decodable {
    var localTokens: Int64
    var hostedTokens: Int64
    var localRequests: Int64
    var hostedRequests: Int64

    private enum CodingKeys: String, CodingKey {
        case localTokens, hostedTokens, localRequests, hostedRequests
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        localTokens = try c.decode(Int64.self, forKey: .localTokens, default: 0)
        hostedTokens = try c.decode(Int64.self, forKey: .hostedTokens, default: 0)
        localRequests = try c.decode(Int64.self, forKey: .localRequests, default: 0)
        hostedRequests = try c.decode(Int64.self, forKey: .hostedRequests, default: 0)
    }

    init() {
        localTokens = 0; hostedTokens = 0; localRequests = 0; hostedRequests = 0
    }
}

struct UsageBySourceSummary: Decodable {
    var providerReportedTokens: Int64
    var estimatedTokens: Int64
    var conservativeTokens: Int64

    private enum CodingKeys: String, CodingKey {
        case providerReportedTokens, estimatedTokens, conservativeTokens
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        providerReportedTokens = try c.decode(Int64.self, forKey: .providerReportedTokens, default: 0)
        estimatedTokens = try c.decode(Int64.self, forKey: .estimatedTokens, default: 0)
        conservativeTokens = try c.decode(Int64.self, forKey: .conservativeTokens, default: 0)
    }

    init() {
        providerReportedTokens = 0; estimatedTokens = 0; conservativeTokens = 0
    }
}

struct ActiveReservationItem: Decodable, Identifiable {
    var id: String
    var modelId: String
    var workload: String
    var estimatedInputTokens: Int64
    var estimatedOutputTokens: Int64

    private enum CodingKeys: String, CodingKey {
        case id, modelId, workload, estimatedInputTokens, estimatedOutputTokens
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: UUID().uuidString)
        modelId = try c.decode(String.self, forKey: .modelId, default: "")
        workload = try c.decode(String.self, forKey: .workload, default: "routine")
        estimatedInputTokens = try c.decode(Int64.self, forKey: .estimatedInputTokens, default: 0)
        estimatedOutputTokens = try c.decode(Int64.self, forKey: .estimatedOutputTokens, default: 0)
    }
}

struct AccountLimitStatusItem: Decodable, Identifiable {
    var unit: String
    var window: String
    var limit: Double?
    var source: String
    var used: Double
    var utilizationPercent: Int?
    var id: String { "\(unit)-\(window)" }

    private enum CodingKeys: String, CodingKey {
        case unit, window, limit, source, used, utilizationPercent
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        unit = try c.decode(String.self, forKey: .unit, default: "")
        window = try c.decode(String.self, forKey: .window, default: "")
        limit = try c.decodeIfPresent(Double.self, forKey: .limit)
        source = try c.decode(String.self, forKey: .source, default: "estimated")
        used = try c.decode(Double.self, forKey: .used, default: 0)
        utilizationPercent = try c.decodeIfPresent(Int.self, forKey: .utilizationPercent)
    }
}

struct AccountBudgetStatusItem: Decodable, Identifiable {
    var id: String
    var provider: String
    var kind: String
    var throttlingMode: String
    var limits: [AccountLimitStatusItem]

    private enum CodingKeys: String, CodingKey {
        case id, provider, kind, throttlingMode, limits
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id, default: UUID().uuidString)
        provider = try c.decode(String.self, forKey: .provider, default: "local")
        kind = try c.decode(String.self, forKey: .kind, default: "local")
        throttlingMode = try c.decode(String.self, forKey: .throttlingMode, default: "normal")
        limits = try c.decode([AccountLimitStatusItem].self, forKey: .limits, default: [])
    }
}

struct ResourceWarningItem: Decodable, Identifiable {
    var severity: String
    var accountId: String?
    var message: String
    var id: String { "\(accountId ?? "")-\(message)" }

    private enum CodingKeys: String, CodingKey {
        case severity, accountId, message
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        severity = try c.decode(String.self, forKey: .severity, default: "info")
        accountId = try c.decodeIfPresent(String.self, forKey: .accountId)
        message = try c.decode(String.self, forKey: .message, default: "")
    }
}

struct ResourceBudgetSnapshot: Decodable {
    var overallMode: String
    var emergencyStop: EmergencyStopInfo?
    var totals: ResourceTotalsSummary
    var localVsHosted: LocalVsHostedSummary
    var usageBySource: UsageBySourceSummary
    var reservations: [ActiveReservationItem]
    var accounts: [AccountBudgetStatusItem]
    var warnings: [ResourceWarningItem]

    private enum CodingKeys: String, CodingKey {
        case overallMode, emergencyStop, totals, localVsHosted, usageBySource, reservations, accounts, warnings
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        overallMode = try c.decode(String.self, forKey: .overallMode, default: "normal")
        emergencyStop = try c.decodeIfPresent(EmergencyStopInfo.self, forKey: .emergencyStop)
        totals = try c.decodeIfPresent(ResourceTotalsSummary.self, forKey: .totals) ?? ResourceTotalsSummary()
        localVsHosted = try c.decodeIfPresent(LocalVsHostedSummary.self, forKey: .localVsHosted) ?? LocalVsHostedSummary()
        usageBySource = try c.decodeIfPresent(UsageBySourceSummary.self, forKey: .usageBySource) ?? UsageBySourceSummary()
        reservations = try c.decode([ActiveReservationItem].self, forKey: .reservations, default: [])
        accounts = try c.decode([AccountBudgetStatusItem].self, forKey: .accounts, default: [])
        warnings = try c.decode([ResourceWarningItem].self, forKey: .warnings, default: [])
    }
}

// MARK: - Loose JSON passthrough (used only for the redacted-arguments display blob)

indirect enum JSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let v = try? c.decode(Bool.self) { self = .bool(v); return }
        if let v = try? c.decode(Double.self) { self = .number(v); return }
        if let v = try? c.decode(String.self) { self = .string(v); return }
        if let v = try? c.decode([String: JSONValue].self) { self = .object(v); return }
        if let v = try? c.decode([JSONValue].self) { self = .array(v); return }
        self = .null
    }

    var prettyDescription: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return String(b)
        case .null: return "null"
        case .array(let a): return "[" + a.map(\.prettyDescription).joined(separator: ", ") + "]"
        case .object(let o):
            return "{" + o.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value.prettyDescription)" }.joined(separator: ", ") + "}"
        }
    }
}
