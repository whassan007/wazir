import Foundation

// MARK: - Command model

public enum ModelVerb: String, Sendable, CaseIterable, Hashable, Codable {
    case add, remove, update, reload

    public var displayName: String {
        switch self {
        case .add: "Add"
        case .remove: "Remove"
        case .update: "Update"
        case .reload: "Reload"
        }
    }

    public var isDestructive: Bool { self == .remove }
}

public enum HostTarget: Equatable, Sendable, Hashable {
    case all
    case hosts([String])
}

public enum ExecutionModeOverride: Equatable, Sendable {
    case dryRun, live
}

public struct ModelCommand: Equatable, Sendable {
    public var verb: ModelVerb
    public var models: [String]
    public var target: HostTarget
    public var runtime: RuntimeKind?
    public var mode: ExecutionModeOverride?

    public init(verb: ModelVerb, models: [String], target: HostTarget, runtime: RuntimeKind? = nil,
                mode: ExecutionModeOverride? = nil) {
        self.verb = verb
        self.models = models
        self.target = target
        self.runtime = runtime
        self.mode = mode
    }
}

public enum FleetCommand: Equatable, Sendable {
    case model(ModelCommand)
    /// Re-poll health + inventory.
    case refresh(HostTarget)
    /// Show/select hosts or their inventory.
    case list(HostTarget)
    case help
}

public enum ParseError: Error, Equatable, Sendable, LocalizedError {
    case empty
    case unknownVerb(String)
    case missingModel(ModelVerb)
    case missingHost(ModelVerb)
    case invalidModelName(String)
    case invalidHostName(String)
    case unknownRuntime(String)
    case missingValue(String)
    case conflictingRuntimes(RuntimeKind, RuntimeKind)
    case conflictingModes
    case ambiguous(String)
    case unexpected(String)

    public var errorDescription: String? {
        switch self {
        case .empty: "Type a command, e.g. `add model qwen2.5 on machine jetson`."
        case .unknownVerb(let w): "Unknown action '\(w)'. Try add, remove, update, reload, refresh or list."
        case .missingModel(let v): "\(v.displayName) needs a model name, e.g. `\(v.rawValue) qwen2.5 on jetson`."
        case .missingHost(let v): "\(v.displayName) needs a target machine, e.g. `\(v.rawValue) qwen2.5 on jetson` (or `on all`)."
        case .invalidModelName(let m): "'\(m)' is not a valid model name (letters, digits and . _ : / @ + - only)."
        case .invalidHostName(let h): "'\(h)' is not a valid host name."
        case .unknownRuntime(let r): "Unknown runtime '\(r)'. Use ollama, lmstudio, llamacpp or mlx."
        case .missingValue(let k): "'\(k)' needs a value."
        case .conflictingRuntimes(let a, let b): "Two runtimes given: \(a.displayName) and \(b.displayName)."
        case .conflictingModes: "Both --dry-run and --live given."
        case .ambiguous(let msg): msg
        case .unexpected(let t): "Didn't understand '\(t)'."
        }
    }
}

// MARK: - Parser

/// Deterministic parser for natural-language-ish and structured fleet commands.
///
/// Accepted shapes (case-insensitive keywords, model names keep their case):
/// - `add model qwen2.5 on machine jetson`
/// - `pull llama3.2:3b to dgx via ollama --live`
/// - `please remove gemma3 from studio using lmstudio`
/// - `reload qwen3 @gb10`, `update qwen2.5, llama3.2 on jetson and dgx`
/// - `add host=jetson model=qwen2.5 runtime=ollama --dry-run`
/// - `refresh`, `refresh dgx`, `refresh all`, `list studio`, `help`
public struct CommandParser: Sendable {
    /// Lowercased known host names/aliases; used to disambiguate bare tokens.
    public var knownHosts: Set<String>

    public init(knownHosts: Set<String> = []) {
        self.knownHosts = Set(knownHosts.map { $0.lowercased() })
    }

    public init(config: FleetConfig) {
        self.init(knownHosts: Set(config.hosts.flatMap(\.allNames)))
    }

    enum Action: Equatable {
        case model(ModelVerb)
        case refreshish  // "refresh": inventory refresh, or model update when a model is present
        case list
        case help
    }

    static let verbs: [String: Action] = {
        var m: [String: Action] = [:]
        for w in ["add", "pull", "download", "install", "get", "fetch", "deploy"] { m[w] = .model(.add) }
        for w in ["remove", "delete", "rm", "uninstall", "drop", "purge", "del", "erase"] { m[w] = .model(.remove) }
        for w in ["update", "upgrade", "repull", "re-pull", "redownload"] { m[w] = .model(.update) }
        for w in ["reload", "restart", "load", "warm", "warmup", "preload"] { m[w] = .model(.reload) }
        for w in ["refresh", "rescan", "sync", "poll", "scan"] { m[w] = .refreshish }
        for w in ["list", "ls", "show", "status", "inventory"] { m[w] = .list }
        for w in ["help", "?", "commands"] { m[w] = .help }
        return m
    }()

    static let fillers: Set<String> = [
        "model", "models", "the", "a", "an", "please", "machine", "machines", "host", "hosts", "node", "nodes",
        "server", "box", "runtime", "engine", "and", "now", "my", "named", "called", "computer",
    ]
    static let hostPrepositions: Set<String> = ["on", "to", "from", "at", "onto", "for", "off"]
    static let runtimePrepositions: Set<String> = ["via", "using", "with", "through", "thru"]
    static let allWords: Set<String> = ["all", "everywhere", "fleet", "*", "every", "everything"]

    public func parse(_ input: String) throws(ParseError) -> FleetCommand {
        var tokens = Self.tokenize(input)
        guard !tokens.isEmpty else { throw .empty }

        // Find the verb: skip leading conversational noise ("can you", "hey fleet").
        guard let verbIndex = tokens.firstIndex(where: { Self.verbs[$0.lowercased()] != nil }) else {
            throw .unknownVerb(tokens[0])
        }
        let action = Self.verbs[tokens[verbIndex].lowercased()]!
        tokens = Array(tokens[(verbIndex + 1)...])

        var models: [String] = []
        var hosts: [String] = []
        var all = false
        var runtime: RuntimeKind?
        var mode: ExecutionModeOverride?
        var bareTokens: [String] = []  // before any host preposition: candidates for models

        func setRuntime(_ word: String) throws(ParseError) {
            guard let k = RuntimeKind.fromKeyword(word) else { throw .unknownRuntime(word) }
            if let runtime, runtime != k { throw .conflictingRuntimes(runtime, k) }
            runtime = k
        }
        func setMode(_ m: ExecutionModeOverride) throws(ParseError) {
            if let mode, mode != m { throw .conflictingModes }
            mode = m
        }
        func addHost(_ word: String) throws(ParseError) {
            let l = word.lowercased()
            if Self.allWords.contains(l) { all = true; return }
            guard Self.isValidHostName(word) else { throw .invalidHostName(word) }
            if !hosts.contains(l) { hosts.append(l) }
        }

        // Context: where bare tokens go.
        enum Slot { case model, host, runtime }
        var slot: Slot = .model
        var i = 0
        while i < tokens.count {
            let raw = tokens[i]
            let low = raw.lowercased()
            i += 1

            // Flags.
            switch low {
            case "--dry-run", "--dryrun", "-n", "dry-run", "dryrun", "--plan", "--preview":
                try setMode(.dryRun); continue
            case "--live", "--execute", "--exec", "--for-real", "live", "--apply":
                try setMode(.live); continue
            case "--yes", "-y":
                continue  // confirmation is always explicit in the UI; accepted for compatibility
            case "--runtime", "-r", "--host", "--on", "-h", "--model", "-m":
                guard i < tokens.count else { throw .missingValue(raw) }
                let value = tokens[i]; i += 1
                switch low {
                case "--runtime", "-r": try setRuntime(value)
                case "--host", "--on", "-h": try addHost(value)
                default: models.append(value)
                }
                continue
            default: break
            }

            // key=value structured syntax.
            if let eq = raw.firstIndex(of: "="), eq != raw.startIndex {
                let key = raw[..<eq].lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "-"))
                let value = String(raw[raw.index(after: eq)...])
                guard !value.isEmpty else { throw .missingValue(key) }
                switch key {
                case "runtime", "rt", "engine": try setRuntime(value)
                case "host", "machine", "on", "node", "target": for v in Self.splitList(value) { try addHost(v) }
                case "model", "models": models.append(contentsOf: Self.splitList(value))
                case "mode": try setMode(value.lowercased() == "live" ? .live : .dryRun)
                default: throw .unexpected(raw)
                }
                continue
            }

            if raw.hasPrefix("@") && raw.count > 1 {
                try addHost(String(raw.dropFirst())); slot = .host; continue
            }
            if Self.hostPrepositions.contains(low) { slot = .host; continue }
            if Self.runtimePrepositions.contains(low) { slot = .runtime; continue }
            if low == "in" {
                // "in lmstudio" → runtime; "in jetson" → host.
                if i < tokens.count, RuntimeKind.fromKeyword(tokens[i]) != nil { slot = .runtime } else { slot = .host }
                continue
            }
            if low == "lm", i < tokens.count, tokens[i].lowercased() == "studio" {
                i += 1; try setRuntime("lmstudio"); continue
            }
            if Self.fillers.contains(low) { continue }

            switch slot {
            case .runtime:
                try setRuntime(raw); slot = .model
            case .host:
                if RuntimeKind.fromKeyword(low) != nil { try setRuntime(low) } else { try addHost(raw) }
            case .model:
                if RuntimeKind.fromKeyword(low) != nil {
                    try setRuntime(low)
                } else if Self.allWords.contains(low) {
                    all = true
                } else {
                    bareTokens.append(raw)
                }
            }
        }

        // Bare tokens: models, except known host names once there is a model (e.g. `add qwen2.5 jetson`).
        for t in bareTokens {
            if knownHosts.contains(t.lowercased()) && (!models.isEmpty || !hosts.isEmpty || action == .refreshish || action == .list) {
                try addHost(t)
            } else {
                models.append(t)
            }
        }
        // "add qwen2.5 jetson" with no prior model: first bare = model, rest known hosts handled above.
        // If a model token is actually a known host and no host was given, move the last one.
        if hosts.isEmpty, !all, models.count >= 2, let last = models.last, knownHosts.contains(last.lowercased()) {
            models.removeLast()
            try addHost(last)
        }

        let target: HostTarget = all ? .all : .hosts(hosts)
        let hasTarget = all || !hosts.isEmpty

        switch action {
        case .help:
            return .help
        case .list:
            if !models.isEmpty { throw .ambiguous("Unknown host '\(models[0])'. `list` takes a host name or nothing.") }
            return .list(hasTarget ? target : .all)
        case .refreshish:
            if models.isEmpty { return .refresh(hasTarget ? target : .all) }
            guard hasTarget else {
                throw .ambiguous("'\(models.joined(separator: " "))' is not a known host. Use `refresh <host>` to re-poll, or `update <model> on <host>` to re-pull a model.")
            }
            return .model(try finish(.update, models, target, runtime, mode))
        case .model(let verb):
            guard !models.isEmpty else { throw .missingModel(verb) }
            guard hasTarget else { throw .missingHost(verb) }
            return .model(try finish(verb, models, target, runtime, mode))
        }
    }

    private func finish(_ verb: ModelVerb, _ models: [String], _ target: HostTarget, _ runtime: RuntimeKind?,
                        _ mode: ExecutionModeOverride?) throws(ParseError) -> ModelCommand {
        var unique: [String] = []
        for m in models.flatMap(Self.splitList) where !unique.contains(m) {
            guard Self.isValidModelName(m) else { throw .invalidModelName(m) }
            unique.append(m)
        }
        guard !unique.isEmpty else { throw .missingModel(verb) }
        return ModelCommand(verb: verb, models: unique, target: target, runtime: runtime, mode: mode)
    }

    // MARK: Helpers

    static func splitList(_ s: String) -> [String] {
        s.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Whitespace tokenizer honoring single/double quotes; splits commas into separate list items
    /// and trims trailing sentence punctuation.
    public static func tokenize(_ input: String) -> [String] {
        var tokens: [String] = []
        var current = ""
        var quote: Character?
        var wasQuoted = false
        func flush() {
            if wasQuoted {
                tokens.append(current)
            } else {
                var t = current
                while let last = t.last, "?!;".contains(last) { t.removeLast() }
                for piece in t.split(separator: ",", omittingEmptySubsequences: true) {
                    tokens.append(String(piece))
                }
            }
            current = ""; wasQuoted = false
        }
        for ch in input {
            if let q = quote {
                if ch == q { quote = nil } else { current.append(ch) }
            } else if ch == "\"" || ch == "'" || ch == "“" || ch == "”" {
                quote = (ch == "“") ? "”" : ch
                wasQuoted = true
            } else if ch.isWhitespace {
                if !current.isEmpty || wasQuoted { flush() }
            } else {
                current.append(ch)
            }
        }
        if !current.isEmpty || wasQuoted { flush() }
        // Trailing period on the final token ("... on jetson.")
        if var last = tokens.last, last.hasSuffix("."), last.count > 1 {
            last.removeLast(); tokens[tokens.count - 1] = last
        }
        return tokens.filter { !$0.isEmpty }
    }

    public static func isValidModelName(_ name: String) -> Bool {
        guard (1...200).contains(name.count), !name.contains(".."), !name.hasPrefix("-") else { return false }
        guard let first = name.unicodeScalars.first, CharacterSet.alphanumerics.contains(first), first.isASCII else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/@+-")
        return name.unicodeScalars.allSatisfy { allowed.contains($0) }
            && !name.hasSuffix("/") && !name.contains("//")
    }

    public static func isValidHostName(_ name: String) -> Bool {
        guard (1...64).contains(name.count) else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
        return name.unicodeScalars.allSatisfy { allowed.contains($0) } && !name.hasPrefix("-")
    }

    public static let helpText = """
    Model operations (target: host name/alias, several hosts, or `all`):
      add model qwen2.5 on machine jetson
      pull llama3.2:3b to dgx via ollama
      remove gemma3 from studio
      update qwen2.5, llama3.2 on jetson and dgx
      reload qwen3 @gb10 using ollama
      add unsloth/Qwen3-8B-GGUF:Q4_K_M on macbook with llamacpp
    Structured: add model=qwen2.5 host=jetson runtime=ollama --live
    Modes: --dry-run (plan only) · --live (execute after confirmation)
    Inventory: refresh · refresh dgx · list studio · help
    """
}
