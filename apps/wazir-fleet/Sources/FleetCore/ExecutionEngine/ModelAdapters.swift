import Foundation

// MARK: - Model & Agent Capabilities

public enum ModelCapability: String, Codable, Sendable, CaseIterable, Hashable {
    case generalChat
    case coding
    case reasoning
    case toolCalling
    case structuredOutput
    case vision
    case embedding
}

public struct AdapterAvailability: Equatable, Sendable, Codable {
    public var adapterID: String
    public var isOnline: Bool
    public var isAuthenticated: Bool
    public var discoveredModels: [String]
    public var capabilities: Set<ModelCapability>
    public var errorReason: String?
    public var checkedAt: Date

    public init(adapterID: String, isOnline: Bool, isAuthenticated: Bool, discoveredModels: [String] = [],
                capabilities: Set<ModelCapability> = [], errorReason: String? = nil, checkedAt: Date = Date()) {
        self.adapterID = adapterID
        self.isOnline = isOnline
        self.isAuthenticated = isAuthenticated
        self.discoveredModels = discoveredModels
        self.capabilities = capabilities
        self.errorReason = errorReason
        self.checkedAt = checkedAt
    }
}

public struct ExecutionRequest: Sendable, Equatable, Codable {
    public var id: UUID
    public var model: String
    public var messages: [ChatMessage]
    public var maxTokens: Int
    public var temperature: Double
    public var requiredCapabilities: Set<ModelCapability>

    public init(id: UUID = UUID(), model: String, messages: [ChatMessage], maxTokens: Int = 2048,
                temperature: Double = 0.2, requiredCapabilities: Set<ModelCapability> = [.generalChat]) {
        self.id = id
        self.model = model
        self.messages = messages
        self.maxTokens = maxTokens
        self.temperature = temperature
        self.requiredCapabilities = requiredCapabilities
    }
}

public enum ExecutionChunk: Sendable, Equatable {
    case content(String)
    case reasoning(String)
    case usage(prompt: Int, completion: Int)
}

public struct AdapterLifecycleCapabilities: Codable, Sendable, Equatable {
    public var modelDiscovery: Bool
    public var modelLoading: Bool
    public var modelUnloading: Bool
    public var instanceCreation: Bool
    public var instanceTermination: Bool
    public var concurrencyAdjustment: Bool
    public var requestCancellation: Bool
    public var batching: Bool
    public var memoryTelemetry: Bool
    public var healthMonitoring: Bool

    public init(
        modelDiscovery: Bool = true, modelLoading: Bool = false, modelUnloading: Bool = false,
        instanceCreation: Bool = false, instanceTermination: Bool = false, concurrencyAdjustment: Bool = false,
        requestCancellation: Bool = true, batching: Bool = false, memoryTelemetry: Bool = false,
        healthMonitoring: Bool = true
    ) {
        self.modelDiscovery = modelDiscovery
        self.modelLoading = modelLoading
        self.modelUnloading = modelUnloading
        self.instanceCreation = instanceCreation
        self.instanceTermination = instanceTermination
        self.concurrencyAdjustment = concurrencyAdjustment
        self.requestCancellation = requestCancellation
        self.batching = batching
        self.memoryTelemetry = memoryTelemetry
        self.healthMonitoring = healthMonitoring
    }
}

public protocol InferenceAdapter: Sendable {
    var adapterID: String { get }
    var hostID: String { get }
    var runtimeKind: RuntimeKind? { get }
    var lifecycleCapabilities: AdapterLifecycleCapabilities { get }
    func discoverAvailability() async -> AdapterAvailability
    func stream(_ request: ExecutionRequest) -> AsyncThrowingStream<ExecutionChunk, Error>
}

// MARK: - OpenAI-Compatible / Local HTTP Adapter

public struct OpenAIHTTPAdapter: InferenceAdapter {
    public let adapterID: String
    public let hostID: String
    public let runtimeKind: RuntimeKind?
    public let baseURL: URL
    public let http: HTTPClient
    public let lifecycleCapabilities: AdapterLifecycleCapabilities
    private let chat = ChatClient()

    public init(adapterID: String, hostID: String, runtimeKind: RuntimeKind?, baseURL: URL, timeout: TimeInterval = 5,
                lifecycleCapabilities: AdapterLifecycleCapabilities = AdapterLifecycleCapabilities()) {
        self.adapterID = adapterID
        self.hostID = hostID
        self.runtimeKind = runtimeKind
        self.baseURL = baseURL
        self.http = HTTPClient(timeout: timeout)
        self.lifecycleCapabilities = lifecycleCapabilities
    }

    public func discoverAvailability() async -> AdapterAvailability {
        do {
            let kind = runtimeKind ?? .openaiCompatible
            let snap = try await RuntimeClients.inventory(kind: kind, base: baseURL, http: http)
            return AdapterAvailability(
                adapterID: adapterID,
                isOnline: true,
                isAuthenticated: true,
                discoveredModels: snap.models.map(\.name),
                capabilities: [.generalChat, .coding, .structuredOutput]
            )
        } catch {
            return AdapterAvailability(
                adapterID: adapterID,
                isOnline: false,
                isAuthenticated: false,
                errorReason: error.localizedDescription
            )
        }
    }

    public func stream(_ request: ExecutionRequest) -> AsyncThrowingStream<ExecutionChunk, Error> {
        let stream = chat.stream(base: baseURL, model: request.model, messages: request.messages,
                                 maxTokens: request.maxTokens, temperature: request.temperature)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await ev in stream {
                        switch ev {
                        case .content(let s): continuation.yield(.content(s))
                        case .reasoning(let s): continuation.yield(.reasoning(s))
                        case .usage(let p, let c): continuation.yield(.usage(prompt: p, completion: c))
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - External Coding Agent CLI Adapter (Codex, Claude Code, Gemini AGY)

public struct CLIAgentAdapter: InferenceAdapter {
    public let adapterID: String
    public let hostID: String
    public let runtimeKind: RuntimeKind? = nil
    public let lifecycleCapabilities = AdapterLifecycleCapabilities(modelDiscovery: true, modelLoading: false, modelUnloading: false)
    public let executablePath: String
    public let defaultModel: String
    public let argumentsBuilder: @Sendable (ExecutionRequest) -> [String]

    public init(adapterID: String, hostID: String = "macbook_pro", executablePath: String, defaultModel: String,
                argumentsBuilder: @escaping @Sendable (ExecutionRequest) -> [String]) {
        self.adapterID = adapterID
        self.hostID = hostID
        self.executablePath = executablePath
        self.defaultModel = defaultModel
        self.argumentsBuilder = argumentsBuilder
    }

    public func discoverAvailability() async -> AdapterAvailability {
        let exists = FileManager.default.isExecutableFile(atPath: executablePath)
        return AdapterAvailability(
            adapterID: adapterID,
            isOnline: exists,
            isAuthenticated: exists,
            discoveredModels: exists ? [defaultModel] : [],
            capabilities: exists ? [.generalChat, .coding, .reasoning, .toolCalling] : [],
            errorReason: exists ? nil : "Executable not found at \(executablePath)"
        )
    }

    public func stream(_ request: ExecutionRequest) -> AsyncThrowingStream<ExecutionChunk, Error> {
        let args = argumentsBuilder(request)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var stderrLines: [String] = []
                    for try await item in ProcessRunner.stream(executablePath, args, timeout: 300) {
                        switch item {
                        case .stdout(let line): continuation.yield(.content(line + "\n"))
                        case .stderr(let err): stderrLines.append(err)
                        case .exit(let code):
                            if code != 0 {
                                let detail = stderrLines.suffix(6).joined(separator: " | ")
                                throw FleetError("\(adapterID) exited with code \(code)\(detail.isEmpty ? "" : ": \(detail)")")
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
