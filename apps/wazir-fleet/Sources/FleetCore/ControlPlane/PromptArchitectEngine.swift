import Foundation

public enum PromptTemplateStyle: String, Codable, Sendable, CaseIterable, Hashable, Identifiable {
    case engineeringGoal = "Full Engineering Goal (/goal)"
    case featureImplementation = "Feature Implementation"
    case bugFixAndAudit = "Bug Fix & Root-Cause Audit"
    case optimizationLoop = "Optimization & Improvement Loop"
    case conciseTask = "Concise Direct Task"

    public var id: String { rawValue }
}

public enum PromptGeneratorSource: Codable, Sendable, Equatable, Hashable, Identifiable {
    case localModel(hostID: String, hostName: String, model: String, runtime: RuntimeKind, baseURL: URL, isLoaded: Bool)
    case cloudModel(providerID: String, providerName: String, modelID: String, executablePath: String)

    public var id: String {
        switch self {
        case .localModel(let hostID, _, let model, let rt, _, _): "local-\(hostID)-\(rt.rawValue)-\(model)"
        case .cloudModel(let pid, _, let modelID, _): "cloud-\(pid)-\(modelID)"
        }
    }

    public var displayName: String {
        switch self {
        case .localModel(let hostID, _, let model, let rt, _, let loaded):
            "\(model) @ \(hostID) (\(rt.displayName))\(loaded ? " ●" : "")"
        case .cloudModel(_, let providerName, let modelID, _):
            "\(modelID) (\(providerName))"
        }
    }
}

public struct PromptArchitectEngine: Sendable {
    public init() {}

    public func buildMessages(
        roughIdea: String,
        style: PromptTemplateStyle,
        repoContext: ProjectRepositoryContext?
    ) -> [ChatMessage] {
        var repoSection = ""
        if let ctx = repoContext {
            let sampleFiles = ctx.trackedFiles.prefix(25).joined(separator: ", ")
            repoSection = """
            Target Project Repository:
            - Path: \(ctx.repoPath)
            - Branch: \(ctx.gitBranch)
            - Build System: \(ctx.detectedBuildSystem.rawValue)
            - Tracked Files (\(ctx.trackedFiles.count) total): \(sampleFiles)
            - Protected Dirty Files: \(ctx.dirtyHumanFiles.isEmpty ? "none" : ctx.dirtyHumanFiles.joined(separator: ", "))
            """
        }

        let system = """
        You are an expert AI Prompt Architect. Transform the user's rough idea into a clear, actionable, \
        well-structured prompt in the '\(style.rawValue)' style. Ground the prompt in the target project \
        repository if provided, specify concrete acceptance criteria and verification commands, and output \
        ONLY the final ready-to-run prompt text.
        """
        let user = """
        Rough Idea:
        \(roughIdea)

        \(repoSection)
        """
        return [.system(system), .user(user)]
    }

    public func generatePrompt(
        roughIdea: String,
        style: PromptTemplateStyle,
        source: PromptGeneratorSource,
        repoContext: ProjectRepositoryContext?
    ) -> AsyncThrowingStream<String, Error> {
        let messages = buildMessages(roughIdea: roughIdea, style: style, repoContext: repoContext)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    switch source {
                    case .localModel(_, _, let model, _, let baseURL, _):
                        var raw = ""
                        for try await ev in ChatClient().stream(base: baseURL, model: model, messages: messages, maxTokens: 2048, temperature: 0.3) {
                            if case .content(let chunk) = ev {
                                raw += chunk
                                continuation.yield(ChatStreamParser.stripThinking(raw))
                            }
                        }
                        if raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            continuation.yield(synthesizeStructuredFallbackPrompt(roughIdea: roughIdea, style: style, repoContext: repoContext))
                        }
                        continuation.finish()

                    case .cloudModel(let providerID, _, let modelID, let executablePath):
                        let combinedPrompt = messages.map(\.content).joined(separator: "\n\n")
                        let args: [String] = switch providerID {
                        case "claude": ["-p", combinedPrompt, "--model", modelID]
                        case "codex": ["exec", combinedPrompt]
                        default: ["-p", combinedPrompt]
                        }
                        var out = ""
                        if FileManager.default.isExecutableFile(atPath: executablePath) {
                            for try await item in ProcessRunner.stream(executablePath, args, timeout: 120) {
                                if case .stdout(let line) = item {
                                    out += line + "\n"
                                    continuation.yield(out)
                                }
                            }
                        }
                        if out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            continuation.yield(synthesizeStructuredFallbackPrompt(roughIdea: roughIdea, style: style, repoContext: repoContext))
                        }
                        continuation.finish()
                    }
                } catch {
                    continuation.yield(synthesizeStructuredFallbackPrompt(roughIdea: roughIdea, style: style, repoContext: repoContext))
                    continuation.finish()
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func synthesizeStructuredFallbackPrompt(
        roughIdea: String,
        style: PromptTemplateStyle,
        repoContext: ProjectRepositoryContext?
    ) -> String {
        let repoName = repoContext.map { URL(fileURLWithPath: $0.repoPath).lastPathComponent } ?? "the active project"
        let branch = repoContext?.gitBranch ?? "main"
        let build = repoContext?.detectedBuildSystem.rawValue ?? "project"
        return """
        # \(style.rawValue): \(roughIdea)

        ## Target Repository
        - Project: \(repoName) (branch: `\(branch)`, build system: `\(build)`)

        ## Objective
        \(roughIdea)

        ## Acceptance & Verification
        - Implement clean, minimal, reversible changes in `\(repoName)`.
        - Preserve existing human modifications and run automated tests before accepting.
        """
    }
}
