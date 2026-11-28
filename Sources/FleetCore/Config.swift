import Foundation

// MARK: - Runtime kinds

public enum RuntimeKind: String, Codable, Sendable, CaseIterable, Hashable, Identifiable {
    case ollama
    case lmstudio
    case llamacpp
    case mlx

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .ollama: "Ollama"
        case .lmstudio: "LM Studio"
        case .llamacpp: "llama.cpp"
        case .mlx: "MLX"
        }
    }

    public var defaultPort: Int {
        switch self {
        case .ollama: 11434
        case .lmstudio: 1234
        case .llamacpp: 8080
        case .mlx: 8081
        }
    }

    /// Words a user may type to refer to this runtime.
    public var keywords: [String] {
        switch self {
        case .ollama: ["ollama"]
        case .lmstudio: ["lmstudio", "lm-studio", "lm_studio", "lms"]
        case .llamacpp: ["llamacpp", "llama.cpp", "llama-cpp", "llama-server", "llamaserver", "gguf"]
        case .mlx: ["mlx", "mlx-lm", "mlx_lm", "mlxlm"]
        }
    }

    public static func fromKeyword(_ word: String) -> RuntimeKind? {
        let w = word.lowercased()
        return allCases.first { $0.keywords.contains(w) || $0.rawValue == w }
    }
}

public enum HostOS: String, Codable, Sendable, CaseIterable, Hashable {
    case linux, macos, windows

    public var displayName: String {
        switch self {
        case .linux: "Linux"
        case .macos: "macOS"
        case .windows: "Windows"
        }
    }

    /// Whether SSH command templates (POSIX sh) can be expected to work.
    public var isPOSIX: Bool { self != .windows }
}

// MARK: - Command templates

/// Remote shell command templates used for runtimes that are managed over SSH.
/// Placeholders: `{model}` (shell-quoted model id), `{repo}`, `{repoSlug}`,
/// `{include}` (shell-quoted glob), `{modelsDir}`, `{hfCacheDir}`.
public struct CommandTemplates: Codable, Sendable, Hashable {
    public var add: String?
    public var remove: String?
    public var update: String?
    public var reload: String?

    public init(add: String? = nil, remove: String? = nil, update: String? = nil, reload: String? = nil) {
        self.add = add
        self.remove = remove
        self.update = update
        self.reload = reload
    }

    public func template(for verb: ModelVerb) -> String? {
        switch verb {
        case .add: add
        case .remove: remove
        case .update: update
        case .reload: reload
        }
    }

    /// Overlay non-nil values of `other` on top of `self`.
    public func merged(with other: CommandTemplates?) -> CommandTemplates {
        guard let other else { return self }
        return CommandTemplates(
            add: other.add ?? add,
            remove: other.remove ?? remove,
            update: other.update ?? update,
            reload: other.reload ?? reload
        )
    }

    public static func defaults(for kind: RuntimeKind) -> CommandTemplates {
        switch kind {
        case .ollama:
            // Ollama is driven through its HTTP API; templates unused by default.
            return CommandTemplates()
        case .lmstudio:
            return CommandTemplates(
                add: "lms get {model} --yes",
                remove: nil,
                update: "lms get {model} --yes",
                reload: "lms unload {model} ; lms load {model} --yes"
            )
        case .llamacpp:
            return CommandTemplates(
                add: "mkdir -p {modelsDir}/{repoSlug} && hf download {repo} --include {include} --local-dir {modelsDir}/{repoSlug}",
                remove: "rm -rf -- {modelsDir}/{repoSlug}",
                update: "hf download {repo} --include {include} --local-dir {modelsDir}/{repoSlug}",
                reload: nil
            )
        case .mlx:
            return CommandTemplates(
                add: "hf download {repo}",
                remove: "rm -rf -- {hfCacheDir}/models--{hfCacheName}",
                update: "hf download {repo}",
                reload: nil
            )
        }
    }
}

// MARK: - Runtime config

public struct RuntimeConfig: Codable, Sendable, Hashable, Identifiable {
    public var kind: RuntimeKind
    public var port: Int
    /// Optional full base URL override (e.g. an SSH tunnel `http://127.0.0.1:11435`).
    public var baseURL: String?
    /// Directory holding model files (llama.cpp GGUFs).
    public var modelsDir: String?
    /// Per-host overrides of the default command templates.
    public var commands: CommandTemplates?
    public var enabled: Bool

    public var id: RuntimeKind { kind }

    public init(kind: RuntimeKind, port: Int? = nil, baseURL: String? = nil, modelsDir: String? = nil,
                commands: CommandTemplates? = nil, enabled: Bool = true) {
        self.kind = kind
        self.port = port ?? kind.defaultPort
        self.baseURL = baseURL
        self.modelsDir = modelsDir
        self.commands = commands
        self.enabled = enabled
    }

    public var effectiveTemplates: CommandTemplates {
        CommandTemplates.defaults(for: kind).merged(with: commands)
    }

    enum CodingKeys: String, CodingKey { case kind, port, baseURL, modelsDir, commands, enabled }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let kind = try c.decode(RuntimeKind.self, forKey: .kind)
        self.init(
            kind: kind,
            port: try c.decodeIfPresent(Int.self, forKey: .port),
            baseURL: try c.decodeIfPresent(String.self, forKey: .baseURL),
            modelsDir: try c.decodeIfPresent(String.self, forKey: .modelsDir),
            commands: try c.decodeIfPresent(CommandTemplates.self, forKey: .commands),
            enabled: try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        )
    }
}

// MARK: - Host config

public struct HostConfig: Codable, Sendable, Hashable, Identifiable {
    /// Stable primary alias, e.g. `jetson`.
    public var id: String
    public var name: String
    public var aliases: [String]
    public var role: String?
    public var hardware: String?
    public var memoryGB: Int?
    public var os: HostOS
    public var tailscaleIP: String?
    public var tailscaleName: String?
    public var lanIP: String?
    /// `ssh` destination: a Host from ~/.ssh/config or `user@host`. nil disables SSH.
    public var sshTarget: String?
    /// True for the Mac running this app: probes use 127.0.0.1 and run metrics locally.
    public var isLocal: Bool
    public var collectMetrics: Bool
    public var runtimes: [RuntimeConfig]

    public init(id: String, name: String, aliases: [String] = [], role: String? = nil, hardware: String? = nil,
                memoryGB: Int? = nil, os: HostOS, tailscaleIP: String? = nil, tailscaleName: String? = nil,
                lanIP: String? = nil, sshTarget: String? = nil, isLocal: Bool = false,
                collectMetrics: Bool = true, runtimes: [RuntimeConfig] = []) {
        self.id = id
        self.name = name
        self.aliases = aliases
        self.role = role
        self.hardware = hardware
        self.memoryGB = memoryGB
        self.os = os
        self.tailscaleIP = tailscaleIP
        self.tailscaleName = tailscaleName
        self.lanIP = lanIP
        self.sshTarget = sshTarget
        self.isLocal = isLocal
        self.collectMetrics = collectMetrics
        self.runtimes = runtimes
    }

    enum CodingKeys: String, CodingKey {
        case id, name, aliases, role, hardware, memoryGB, os, tailscaleIP, tailscaleName, lanIP, sshTarget,
             isLocal, collectMetrics, runtimes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let id = try c.decode(String.self, forKey: .id)
        self.init(
            id: id,
            name: try c.decodeIfPresent(String.self, forKey: .name) ?? id,
            aliases: try c.decodeIfPresent([String].self, forKey: .aliases) ?? [],
            role: try c.decodeIfPresent(String.self, forKey: .role),
            hardware: try c.decodeIfPresent(String.self, forKey: .hardware),
            memoryGB: try c.decodeIfPresent(Int.self, forKey: .memoryGB),
            os: try c.decodeIfPresent(HostOS.self, forKey: .os) ?? .linux,
            tailscaleIP: try c.decodeIfPresent(String.self, forKey: .tailscaleIP),
            tailscaleName: try c.decodeIfPresent(String.self, forKey: .tailscaleName),
            lanIP: try c.decodeIfPresent(String.self, forKey: .lanIP),
            sshTarget: try c.decodeIfPresent(String.self, forKey: .sshTarget),
            isLocal: try c.decodeIfPresent(Bool.self, forKey: .isLocal) ?? false,
            collectMetrics: try c.decodeIfPresent(Bool.self, forKey: .collectMetrics) ?? true,
            runtimes: try c.decodeIfPresent([RuntimeConfig].self, forKey: .runtimes) ?? []
        )
    }

    /// All names this host answers to (lowercased, deduplicated, id first).
    public var allNames: [String] {
        var seen = Set<String>()
        var out: [String] = []
        for n in [id] + aliases + [tailscaleName].compactMap({ $0 }) {
            let l = n.lowercased()
            if !l.isEmpty, seen.insert(l).inserted { out.append(l) }
        }
        return out
    }

    /// Candidate addresses in preference order.
    public var candidateAddresses: [String] {
        if isLocal { return ["127.0.0.1"] }
        var out: [String] = []
        for a in [tailscaleIP, lanIP] {
            if let a, !a.isEmpty, !out.contains(a) { out.append(a) }
        }
        return out
    }

    public func runtime(_ kind: RuntimeKind) -> RuntimeConfig? {
        runtimes.first { $0.kind == kind && $0.enabled }
    }

    public var enabledRuntimes: [RuntimeConfig] { runtimes.filter(\.enabled) }
}

// MARK: - Fleet config

public struct FleetConfig: Codable, Sendable, Hashable {
    public var hosts: [HostConfig]
    public var pollIntervalSeconds: Double
    /// When true, plans default to dry-run; live execution must be chosen explicitly.
    public var dryRunByDefault: Bool
    public var sshConnectTimeoutSeconds: Int
    public var httpTimeoutSeconds: Double
    /// Look up Ollama registry manifests to validate names and estimate download size.
    public var registryLookup: Bool
    /// Pulls above this size get a "large download" warning.
    public var largeDownloadWarningGB: Double

    public init(hosts: [HostConfig], pollIntervalSeconds: Double = 30, dryRunByDefault: Bool = true,
                sshConnectTimeoutSeconds: Int = 5, httpTimeoutSeconds: Double = 4, registryLookup: Bool = true,
                largeDownloadWarningGB: Double = 10) {
        self.hosts = hosts
        self.pollIntervalSeconds = pollIntervalSeconds
        self.dryRunByDefault = dryRunByDefault
        self.sshConnectTimeoutSeconds = sshConnectTimeoutSeconds
        self.httpTimeoutSeconds = httpTimeoutSeconds
        self.registryLookup = registryLookup
        self.largeDownloadWarningGB = largeDownloadWarningGB
    }

    enum CodingKeys: String, CodingKey {
        case hosts, pollIntervalSeconds, dryRunByDefault, sshConnectTimeoutSeconds, httpTimeoutSeconds,
             registryLookup, largeDownloadWarningGB
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            hosts: try c.decodeIfPresent([HostConfig].self, forKey: .hosts) ?? [],
            pollIntervalSeconds: try c.decodeIfPresent(Double.self, forKey: .pollIntervalSeconds) ?? 30,
            dryRunByDefault: try c.decodeIfPresent(Bool.self, forKey: .dryRunByDefault) ?? true,
            sshConnectTimeoutSeconds: try c.decodeIfPresent(Int.self, forKey: .sshConnectTimeoutSeconds) ?? 5,
            httpTimeoutSeconds: try c.decodeIfPresent(Double.self, forKey: .httpTimeoutSeconds) ?? 4,
            registryLookup: try c.decodeIfPresent(Bool.self, forKey: .registryLookup) ?? true,
            largeDownloadWarningGB: try c.decodeIfPresent(Double.self, forKey: .largeDownloadWarningGB) ?? 10
        )
    }

    public func host(id: String) -> HostConfig? { hosts.first { $0.id == id } }

    /// Validates config invariants; returns human-readable problems.
    public func validate() -> [String] {
        var problems: [String] = []
        var owners: [String: String] = [:]
        for h in hosts {
            if h.id.trimmingCharacters(in: .whitespaces).isEmpty { problems.append("A host has an empty id.") }
            for n in h.allNames {
                if let other = owners[n], other != h.id {
                    problems.append("Alias '\(n)' is used by both '\(other)' and '\(h.id)'.")
                } else {
                    owners[n] = h.id
                }
            }
            let kinds = h.runtimes.map(\.kind)
            if Set(kinds).count != kinds.count { problems.append("Host '\(h.id)' lists the same runtime twice.") }
            if h.candidateAddresses.isEmpty && h.runtimes.allSatisfy({ $0.baseURL == nil }) {
                problems.append("Host '\(h.id)' has no IP address.")
            }
        }
        if pollIntervalSeconds < 5 { problems.append("Poll interval must be at least 5 seconds.") }
        return problems
    }
}
