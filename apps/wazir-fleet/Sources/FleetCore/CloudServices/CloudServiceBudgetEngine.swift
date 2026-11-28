import Foundation

public enum CloudServiceProviderKind: String, Codable, Sendable, CaseIterable, Hashable {
    case agy
    case codex
    case claude
    case custom
}

public enum CloudAuthMethod: String, Codable, Sendable, CaseIterable, Hashable {
    case bothWebAndConfig
    case weblink
    case configFile
}

public struct CloudServicePlanConfig: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var kind: CloudServiceProviderKind
    public var displayName: String
    public var planName: String
    public var monthlyPlanBudgetUSD: Double
    public var additionalSpendLimitUSD: Double
    public var webLoginURL: String
    public var billingURL: String
    public var configPaths: [String]
    public var executablePath: String
    public var authMethod: CloudAuthMethod
    public var enabled: Bool

    public var totalBudgetCeilingUSD: Double {
        monthlyPlanBudgetUSD + additionalSpendLimitUSD
    }

    public init(
        id: String,
        kind: CloudServiceProviderKind,
        displayName: String,
        planName: String,
        monthlyPlanBudgetUSD: Double,
        additionalSpendLimitUSD: Double = 0,
        webLoginURL: String,
        billingURL: String,
        configPaths: [String],
        executablePath: String,
        authMethod: CloudAuthMethod = .bothWebAndConfig,
        enabled: Bool = true
    ) {
        self.id = id
        self.kind = kind
        self.displayName = displayName
        self.planName = planName
        self.monthlyPlanBudgetUSD = monthlyPlanBudgetUSD
        self.additionalSpendLimitUSD = additionalSpendLimitUSD
        self.webLoginURL = webLoginURL
        self.billingURL = billingURL
        self.configPaths = configPaths
        self.executablePath = executablePath
        self.authMethod = authMethod
        self.enabled = enabled
    }

    public static let defaultServices: [CloudServicePlanConfig] = [
        CloudServicePlanConfig(
            id: "agy",
            kind: .agy,
            displayName: "Gemini Antigravity",
            planName: "Antigravity Ultra Plan",
            monthlyPlanBudgetUSD: 200.0,
            additionalSpendLimitUSD: 0.0,
            webLoginURL: "https://antigravity.google",
            billingURL: "https://aistudio.google.com/apikey",
            configPaths: [
                "~/.gemini/settings.json",
                "~/.gemini/antigravity-cli/settings.json",
                "~/.gemini/config/fleet-orchestration.json",
            ],
            executablePath: "/Users/wael/.local/bin/agy"
        ),
        CloudServicePlanConfig(
            id: "codex",
            kind: .codex,
            displayName: "OpenAI Codex",
            planName: "Codex / ChatGPT Plus Plan",
            monthlyPlanBudgetUSD: 20.0,
            additionalSpendLimitUSD: 0.0,
            webLoginURL: "https://chatgpt.com/#settings/Subscription",
            billingURL: "https://platform.openai.com/usage",
            configPaths: [
                "~/.codex/config.toml",
                "~/.codex/auth.json",
                "~/.codex/models_cache.json",
            ],
            executablePath: "/Users/wael/.local/bin/codex"
        ),
        CloudServicePlanConfig(
            id: "claude",
            kind: .claude,
            displayName: "Anthropic Claude",
            planName: "Claude Pro + Extra Spend Limit",
            monthlyPlanBudgetUSD: 20.0,
            additionalSpendLimitUSD: 50.0,
            webLoginURL: "https://claude.ai/login",
            billingURL: "https://claude.ai/settings/billing",
            configPaths: [
                "~/.claude/settings.json",
                "~/.claude/.credentials.json",
                "~/.claude/stats-cache.json",
            ],
            executablePath: "/Users/wael/.local/bin/claude"
        ),
    ]
}

public struct FrontierCloudModel: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String
    public var displayName: String
    public var providerID: String
    public var providerName: String
    public var tier: String
    public var reasoningLevels: [String]
    public var inputTokensUsed: Int64
    public var outputTokensUsed: Int64
    public var cachedTokensUsed: Int64
    public var isActiveDefault: Bool

    public init(
        id: String,
        displayName: String,
        providerID: String,
        providerName: String,
        tier: String = "frontier",
        reasoningLevels: [String] = [],
        inputTokensUsed: Int64 = 0,
        outputTokensUsed: Int64 = 0,
        cachedTokensUsed: Int64 = 0,
        isActiveDefault: Bool = false
    ) {
        self.id = id
        self.displayName = displayName
        self.providerID = providerID
        self.providerName = providerName
        self.tier = tier
        self.reasoningLevels = reasoningLevels
        self.inputTokensUsed = inputTokensUsed
        self.outputTokensUsed = outputTokensUsed
        self.cachedTokensUsed = cachedTokensUsed
        self.isActiveDefault = isActiveDefault
    }
}

public struct CloudServiceSnapshot: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var displayName: String
    public var planName: String
    public var isAuthenticated: Bool
    public var authSourceDescription: String
    public var detectedConfigFiles: [String]
    public var discoveredModels: [FrontierCloudModel]
    public var totalInputTokens: Int64
    public var totalOutputTokens: Int64
    public var totalCachedTokens: Int64
    public var totalSessions: Int
    public var totalMessages: Int
    public var monthlyPlanBudgetUSD: Double
    public var additionalSpendLimitUSD: Double
    public var totalBudgetCeilingUSD: Double
    public var estimatedPlanSpendUSD: Double
    public var estimatedExtraSpendUSD: Double
    public var remainingBudgetUSD: Double
    public var budgetUtilizationFraction: Double
    public var lastUpdated: Date

    public init(
        id: String,
        displayName: String,
        planName: String,
        isAuthenticated: Bool,
        authSourceDescription: String,
        detectedConfigFiles: [String],
        discoveredModels: [FrontierCloudModel],
        totalInputTokens: Int64,
        totalOutputTokens: Int64,
        totalCachedTokens: Int64,
        totalSessions: Int,
        totalMessages: Int,
        monthlyPlanBudgetUSD: Double,
        additionalSpendLimitUSD: Double,
        estimatedPlanSpendUSD: Double,
        estimatedExtraSpendUSD: Double,
        lastUpdated: Date = Date()
    ) {
        self.id = id
        self.displayName = displayName
        self.planName = planName
        self.isAuthenticated = isAuthenticated
        self.authSourceDescription = authSourceDescription
        self.detectedConfigFiles = detectedConfigFiles
        self.discoveredModels = discoveredModels
        self.totalInputTokens = totalInputTokens
        self.totalOutputTokens = totalOutputTokens
        self.totalCachedTokens = totalCachedTokens
        self.totalSessions = totalSessions
        self.totalMessages = totalMessages
        self.monthlyPlanBudgetUSD = monthlyPlanBudgetUSD
        self.additionalSpendLimitUSD = additionalSpendLimitUSD
        let ceiling = monthlyPlanBudgetUSD + additionalSpendLimitUSD
        self.totalBudgetCeilingUSD = ceiling
        self.estimatedPlanSpendUSD = estimatedPlanSpendUSD
        self.estimatedExtraSpendUSD = estimatedExtraSpendUSD
        let totalUsed = estimatedPlanSpendUSD + estimatedExtraSpendUSD
        self.remainingBudgetUSD = max(0, ceiling - totalUsed)
        self.budgetUtilizationFraction = ceiling > 0 ? min(1.0, totalUsed / ceiling) : 0
        self.lastUpdated = lastUpdated
    }
}

/// Discovers available frontier cloud models, authentication status, and token spend / budget
/// across Gemini Antigravity (`agy`), OpenAI Codex (`codex`), and Anthropic Claude (`claude`).
public struct CloudServiceBudgetEngine: Sendable {
    public let homeDirectory: String

    public init(homeDirectory: String = NSHomeDirectory()) {
        self.homeDirectory = homeDirectory
    }

    public func expand(_ path: String) -> String {
        if path.hasPrefix("~/") {
            return homeDirectory + "/" + path.dropFirst(2)
        }
        return path
    }

    public func discoverAll(configs: [CloudServicePlanConfig]) -> [CloudServiceSnapshot] {
        configs.filter(\.enabled).map { discover(config: $0) }
    }

    public func discover(config: CloudServicePlanConfig) -> CloudServiceSnapshot {
        let fm = FileManager.default
        let existingConfigs = config.configPaths.map(expand).filter { fm.fileExists(atPath: $0) }
        let hasCLI = fm.isExecutableFile(atPath: expand(config.executablePath))

        switch config.kind {
        case .claude:
            return discoverClaude(config: config, existingConfigs: existingConfigs, hasCLI: hasCLI)
        case .codex:
            return discoverCodex(config: config, existingConfigs: existingConfigs, hasCLI: hasCLI)
        case .agy:
            return discoverAGY(config: config, existingConfigs: existingConfigs, hasCLI: hasCLI)
        case .custom:
            return CloudServiceSnapshot(
                id: config.id,
                displayName: config.displayName,
                planName: config.planName,
                isAuthenticated: !existingConfigs.isEmpty || hasCLI,
                authSourceDescription: hasCLI ? "CLI + Config" : (existingConfigs.isEmpty ? "Needs Login" : "Config File"),
                detectedConfigFiles: existingConfigs,
                discoveredModels: [],
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCachedTokens: 0,
                totalSessions: 0,
                totalMessages: 0,
                monthlyPlanBudgetUSD: config.monthlyPlanBudgetUSD,
                additionalSpendLimitUSD: config.additionalSpendLimitUSD,
                estimatedPlanSpendUSD: 0,
                estimatedExtraSpendUSD: 0
            )
        }
    }

    public func canAllocateWithinBudget(snapshot: CloudServiceSnapshot, estimatedCostUSD: Double) -> Bool {
        snapshot.remainingBudgetUSD >= estimatedCostUSD
    }

    // MARK: - Claude

    private struct ClaudeStatsCache: Decodable {
        struct ModelUsage: Decodable {
            var inputTokens: Int64?
            var outputTokens: Int64?
            var cacheReadInputTokens: Int64?
            var cacheCreationInputTokens: Int64?
            var costUSD: Double?
        }
        var modelUsage: [String: ModelUsage]?
        var totalSessions: Int?
        var totalMessages: Int?
    }

    private func discoverClaude(config: CloudServicePlanConfig, existingConfigs: [String], hasCLI: Bool) -> CloudServiceSnapshot {
        let statsPath = expand("~/.claude/stats-cache.json")
        let settingsPath = expand("~/.claude/settings.json")
        let activeModel: String? = (try? Data(contentsOf: URL(fileURLWithPath: settingsPath)))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["model"] as? String

        var models: [FrontierCloudModel] = []
        var totalIn: Int64 = 0
        var totalOut: Int64 = 0
        var totalCache: Int64 = 0
        var sessions = 0
        var messages = 0

        if let data = try? Data(contentsOf: URL(fileURLWithPath: statsPath)),
           let stats = try? JSONDecoder().decode(ClaudeStatsCache.self, from: data) {
            sessions = stats.totalSessions ?? 0
            messages = stats.totalMessages ?? 0
            for (slug, u) in (stats.modelUsage ?? [:]).sorted(by: { $0.key < $1.key }) {
                let inp = u.inputTokens ?? 0
                let out = u.outputTokens ?? 0
                let cache = (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
                totalIn += inp
                totalOut += out
                totalCache += cache
                models.append(FrontierCloudModel(
                    id: slug,
                    displayName: slug,
                    providerID: config.id,
                    providerName: config.displayName,
                    tier: slug.contains("opus") ? "frontier-opus" : "frontier-sonnet",
                    inputTokensUsed: inp,
                    outputTokensUsed: out,
                    cachedTokensUsed: cache,
                    isActiveDefault: activeModel.map { slug.contains($0) } ?? false
                ))
            }
        }

        if models.isEmpty {
            models = [
                FrontierCloudModel(id: "claude-opus-5-5-high", displayName: "Claude Opus 5.5 High", providerID: config.id, providerName: config.displayName, tier: "frontier-opus", isActiveDefault: activeModel == "opus"),
                FrontierCloudModel(id: "claude-sonnet-5-5-high", displayName: "Claude Sonnet 5.5 High", providerID: config.id, providerName: config.displayName, tier: "frontier-sonnet"),
            ]
        }

        // Estimate API-equivalent spend ($15/1M out, $3/1M in, $0.30/1M cache) capped to plan + extra
        let rawSpend = (Double(totalIn) * 3.0 + Double(totalOut) * 15.0 + Double(totalCache) * 0.30) / 1_000_000.0
        let planSpend = min(config.monthlyPlanBudgetUSD, rawSpend)
        let extraSpend = min(config.additionalSpendLimitUSD, max(0, rawSpend - config.monthlyPlanBudgetUSD))

        return CloudServiceSnapshot(
            id: config.id,
            displayName: config.displayName,
            planName: config.planName,
            isAuthenticated: hasCLI || !existingConfigs.isEmpty,
            authSourceDescription: hasCLI ? "Claude CLI + Credentials" : "Config File",
            detectedConfigFiles: existingConfigs,
            discoveredModels: models,
            totalInputTokens: totalIn,
            totalOutputTokens: totalOut,
            totalCachedTokens: totalCache,
            totalSessions: sessions,
            totalMessages: messages,
            monthlyPlanBudgetUSD: config.monthlyPlanBudgetUSD,
            additionalSpendLimitUSD: config.additionalSpendLimitUSD,
            estimatedPlanSpendUSD: planSpend,
            estimatedExtraSpendUSD: extraSpend
        )
    }

    // MARK: - Codex

    private struct CodexModelsCache: Decodable {
        struct Model: Decodable {
            struct Level: Decodable { var effort: String }
            var slug: String
            var display_name: String?
            var supported_reasoning_levels: [Level]?
        }
        var models: [Model]?
    }

    private func discoverCodex(config: CloudServicePlanConfig, existingConfigs: [String], hasCLI: Bool) -> CloudServiceSnapshot {
        let cachePath = expand("~/.codex/models_cache.json")
        let tomlPath = expand("~/.codex/config.toml")
        var activeSlug = "gpt-6-astra"
        if let toml = try? String(contentsOfFile: tomlPath, encoding: .utf8) {
            for line in toml.split(whereSeparator: \.isNewline) {
                let t = line.trimmingCharacters(in: .whitespaces)
                if t.hasPrefix("model ="), let q1 = t.firstIndex(of: "\""), let q2 = t.lastIndex(of: "\""), q1 < q2 {
                    activeSlug = String(t[t.index(after: q1)..<q2])
                    break
                }
            }
        }

        var models: [FrontierCloudModel] = []
        if let data = try? Data(contentsOf: URL(fileURLWithPath: cachePath)),
           let cache = try? JSONDecoder().decode(CodexModelsCache.self, from: data) {
            for m in (cache.models ?? []).prefix(12) {
                models.append(FrontierCloudModel(
                    id: m.slug,
                    displayName: m.display_name ?? m.slug,
                    providerID: config.id,
                    providerName: config.displayName,
                    tier: "frontier-codex",
                    reasoningLevels: (m.supported_reasoning_levels ?? []).map(\.effort),
                    isActiveDefault: m.slug == activeSlug
                ))
            }
        }
        if models.isEmpty {
            models = [
                FrontierCloudModel(id: "gpt-6-astra", displayName: "GPT-6 Astra", providerID: config.id, providerName: config.displayName, tier: "frontier-codex", isActiveDefault: true),
                FrontierCloudModel(id: "gpt-6.2-sol", displayName: "GPT-6.2 Sol", providerID: config.id, providerName: config.displayName, tier: "frontier-codex"),
            ]
        }

        return CloudServiceSnapshot(
            id: config.id,
            displayName: config.displayName,
            planName: config.planName,
            isAuthenticated: hasCLI || !existingConfigs.isEmpty,
            authSourceDescription: hasCLI ? "Codex CLI + Auth" : "Config File",
            detectedConfigFiles: existingConfigs,
            discoveredModels: models,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCachedTokens: 0,
            totalSessions: 0,
            totalMessages: 0,
            monthlyPlanBudgetUSD: config.monthlyPlanBudgetUSD,
            additionalSpendLimitUSD: config.additionalSpendLimitUSD,
            estimatedPlanSpendUSD: 0,
            estimatedExtraSpendUSD: 0
        )
    }

    // MARK: - AGY / Gemini

    private func discoverAGY(config: CloudServicePlanConfig, existingConfigs: [String], hasCLI: Bool) -> CloudServiceSnapshot {
        let manifestPath = expand("~/.gemini/config/fleet-orchestration.json")
        var modelIDs: [String] = []
        if let data = try? Data(contentsOf: URL(fileURLWithPath: manifestPath)),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let agents = obj["codingAgents"] as? [String: Any],
           let agy = agents["antigravity"] as? [String: Any],
           let avail = agy["availableModels"] as? [String] {
            modelIDs = avail
        }
        if modelIDs.isEmpty {
            modelIDs = [
                "gemini-4-argon-high", "gemini-4-neon-high", "gemini-4-hydrogen-low",
                "gemini-4-hydrogen-high", "claude-opus-5-5-high", "claude-sonnet-5-5-high",
            ]
        }

        let models = modelIDs.map { id in
            FrontierCloudModel(
                id: id,
                displayName: id,
                providerID: config.id,
                providerName: config.displayName,
                tier: id.contains("neon") || id.contains("opus") ? "frontier-heavy" : "frontier-orchestrator",
                isActiveDefault: id == "gemini-4-argon-high"
            )
        }

        return CloudServiceSnapshot(
            id: config.id,
            displayName: config.displayName,
            planName: config.planName,
            isAuthenticated: hasCLI || !existingConfigs.isEmpty,
            authSourceDescription: hasCLI ? "AGY CLI + Config" : "Config File",
            detectedConfigFiles: existingConfigs,
            discoveredModels: models,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCachedTokens: 0,
            totalSessions: 0,
            totalMessages: 0,
            monthlyPlanBudgetUSD: config.monthlyPlanBudgetUSD,
            additionalSpendLimitUSD: config.additionalSpendLimitUSD,
            estimatedPlanSpendUSD: 0,
            estimatedExtraSpendUSD: 0
        )
    }
}
