import Foundation

// MARK: - Plan types

public enum StepAction: Equatable, Sendable, Hashable {
    case ollamaPull(model: String)
    case ollamaDelete(model: String)
    case ollamaUnload(model: String)
    case ollamaLoad(model: String)
    /// POSIX remote command run over SSH (PATH prefix added on execution).
    case ssh(target: String, command: String, posix: Bool)
    /// Command run on this Mac via /bin/sh.
    case local(command: String)
}

public struct PlanStep: Equatable, Sendable, Identifiable, Hashable {
    public var id: Int
    public var hostID: String
    public var hostName: String
    public var runtime: RuntimeKind
    public var model: String
    public var verb: ModelVerb
    public var title: String
    /// Exact request/command shown in the preview.
    public var detail: String
    public var action: StepAction
    public var baseURL: URL?
}

public struct ExecutionPlan: Equatable, Sendable, Identifiable {
    public var id: UUID
    public var input: String
    public var command: ModelCommand
    public var dryRun: Bool
    public var steps: [PlanStep]
    public var warnings: [String]
    /// Total bytes expected to download (from registry manifests), if known.
    public var estimatedBytes: Int64?
    /// Models whose Ollama registry manifest should be checked before execution.
    public var registryLookups: [String]
    /// Problems that block live execution (dry-run still allowed), e.g. model not in registry.
    public var blockers: [String] = []

    public var isDestructive: Bool { command.verb.isDestructive }
    public var touchedHosts: [String] {
        var seen: [String] = []
        for s in steps where !seen.contains(s.hostID) { seen.append(s.hostID) }
        return seen
    }

    public var summary: String {
        let models = command.models.joined(separator: ", ")
        let hosts = Set(steps.map(\.hostName)).sorted().joined(separator: ", ")
        let runtimes = Set(steps.map(\.runtime.displayName)).sorted().joined(separator: "/")
        let verb: String = switch command.verb {
        case .add: "Pull"
        case .remove: "Delete"
        case .update: "Re-pull"
        case .reload: "Reload"
        }
        return "\(verb) \(models) \(command.verb == .remove ? "from" : "on") \(hosts) via \(runtimes)"
    }
}

public struct PlanError: Error, Equatable, Sendable, LocalizedError {
    public var problems: [String]
    public init(_ problems: [String]) { self.problems = problems }
    public var errorDescription: String? { problems.joined(separator: "\n") }
}

// MARK: - Registry enrichment

public enum PlanEnricher {
    /// Folds registry lookups into a plan: size estimate, not-found blockers with suggestions,
    /// large-download and memory-fit warnings. Pure and deterministic.
    public static func apply(_ results: [String: OllamaRegistry.Lookup], to plan: ExecutionPlan,
                             config: FleetConfig, inventory: [String]) -> ExecutionPlan {
        var p = plan
        var total: Int64 = 0
        var known = false
        for model in plan.registryLookups {
            guard let r = results[model] else { continue }
            let pulls = plan.steps.filter { $0.model == model && $0.action == .ollamaPull(model: model) }
            switch r {
            case .found(let bytes):
                known = true
                total += bytes * Int64(pulls.count)
                for step in pulls {
                    if let gb = config.host(id: step.hostID)?.memoryGB, Double(bytes) > Double(gb) * 0.85 * 1_073_741_824 {
                        p.warnings.append("\(model) (\(Format.bytes(bytes))) may not fit in \(step.hostName)'s \(gb) GB memory.")
                    }
                }
            case .notFound:
                let hint = ModelCatalog.suggest(model, inventory: inventory).map { " Did you mean '\($0)'?" } ?? ""
                p.blockers.append("'\(model)' was not found in the Ollama registry.\(hint)")
            case .unavailable(let why):
                p.warnings.append("Could not check '\(model)' in the Ollama registry (\(why)).")
            }
        }
        if known {
            p.estimatedBytes = total
            if Double(total) > config.largeDownloadWarningGB * 1_073_741_824 {
                p.warnings.append("Large download: about \(Format.bytes(total)) in total.")
            }
        }
        return p
    }
}

// MARK: - Endpoint resolution

public enum Endpoint {
    /// Best address for a host: the one that answered the last probe, else the first configured.
    public static func address(for host: HostConfig, state: HostState?) -> String? {
        if case .online(_, let addr)? = state?.reachability { return addr }
        return host.candidateAddresses.first
    }

    public static func baseURL(host: HostConfig, runtime: RuntimeConfig, state: HostState?) -> URL? {
        if let override = runtime.baseURL, !override.isEmpty { return URL(string: override) }
        guard let addr = address(for: host, state: state) else { return nil }
        let h = addr.contains(":") ? "[\(addr)]" : addr  // IPv6 literal
        return URL(string: "http://\(h):\(runtime.port)")
    }
}

// MARK: - Planner

/// Turns a parsed `ModelCommand` into a concrete, previewable plan. Pure: depends only on
/// configuration and the current state snapshot.
public struct Planner: Sendable {
    public var config: FleetConfig

    public init(config: FleetConfig) { self.config = config }

    public func resolveHosts(_ target: HostTarget) throws(PlanError) -> [HostConfig] {
        switch target {
        case .all:
            return config.hosts
        case .hosts(let names):
            var out: [HostConfig] = []
            var problems: [String] = []
            for n in names {
                if let h = resolveHost(n) {
                    if !out.contains(where: { $0.id == h.id }) { out.append(h) }
                } else {
                    let all = config.hosts.flatMap(\.allNames)
                    let hint = Fuzzy.suggest(n, among: all).map { " Did you mean '\($0)'?" } ?? ""
                    problems.append("Unknown machine '\(n)'.\(hint) Known: \(config.hosts.map(\.id).joined(separator: ", ")).")
                }
            }
            if !problems.isEmpty { throw PlanError(problems) }
            return out
        }
    }

    public func resolveHost(_ name: String) -> HostConfig? {
        let l = name.lowercased()
        return config.hosts.first { $0.allNames.contains(l) }
            ?? config.hosts.first { $0.name.lowercased() == l }
    }

    public func plan(_ command: ModelCommand, input: String, state: FleetState, id: UUID = UUID()) throws(PlanError) -> ExecutionPlan {
        let hosts = try resolveHosts(command.target)
        var steps: [PlanStep] = []
        var warnings: [String] = []
        var problems: [String] = []
        var lookups: [String] = []

        for host in hosts {
            let hs = state.hosts[host.id]
            switch hs?.reachability {
            case .offline(let reason)?: warnings.append("\(host.name) is currently unreachable (\(reason)); its steps will likely fail.")
            case .unknown?, nil: warnings.append("\(host.name) has not been probed yet.")
            case .online?: break
            }
            for model in command.models {
                do {
                    let (rt, notes) = try chooseRuntime(command, model: model, host: host, state: hs)
                    warnings.append(contentsOf: notes)
                    let built = try buildSteps(command.verb, model: model, host: host, runtime: rt, state: hs,
                                               firstID: steps.count)
                    warnings.append(contentsOf: built.notes)
                    steps.append(contentsOf: built.steps)
                    if rt.kind == .ollama, command.verb == .add || command.verb == .update,
                       !model.lowercased().hasPrefix("hf.co/"), !lookups.contains(model) {
                        lookups.append(model)
                    }
                } catch {
                    if case .hosts = command.target { problems.append(error.message) } else { warnings.append("Skipping: " + error.message) }
                }
            }
        }
        if !problems.isEmpty { throw PlanError(problems) }
        if steps.isEmpty { throw PlanError(["Nothing to do: no host/runtime can perform this operation."] + warnings) }

        let dryRun = command.mode.map { $0 == .dryRun } ?? config.dryRunByDefault
        return ExecutionPlan(id: id, input: input, command: command, dryRun: dryRun, steps: steps,
                             warnings: dedupe(warnings), estimatedBytes: nil, registryLookups: lookups)
    }

    // MARK: Runtime choice

    func chooseRuntime(_ cmd: ModelCommand, model: String, host: HostConfig, state: HostState?)
        throws(FleetError) -> (RuntimeConfig, [String])
    {
        let enabled = host.enabledRuntimes
        guard !enabled.isEmpty else { throw FleetError("\(host.name) has no runtimes configured.") }

        if let kind = cmd.runtime {
            guard let rt = host.runtime(kind) else {
                throw FleetError("\(host.name) has no \(kind.displayName) runtime (has: \(enabled.map(\.kind.displayName).joined(separator: ", "))).")
            }
            guard supports(rt, cmd.verb, host: host) else { throw unsupported(rt, cmd.verb, host) }
            return (rt, [])
        }

        // Remove/reload/update: prefer the runtime that actually has the model.
        if cmd.verb != .add, let hs = state {
            let holders = enabled.filter { rt in hs.runtimes[rt.kind]?.models.contains { $0.matches(model) } ?? false }
                .filter { supports($0, cmd.verb, host: host) }
            if holders.count == 1 { return (holders[0], []) }
            if holders.count > 1 {
                let pick = holders.first { $0.kind == .ollama } ?? holders[0]
                return (pick, ["'\(model)' exists in several runtimes on \(host.name); using \(pick.kind.displayName). Add `via <runtime>` to choose."])
            }
        }

        let isRepo = HFModelRef(model).isRepo && !model.lowercased().hasPrefix("hf.co/")
        let lower = model.lowercased()
        var order: [RuntimeKind]
        if isRepo {
            if lower.contains("gguf") || HFModelRef(model).quant != nil { order = [.llamacpp, .lmstudio, .ollama] }
            else if lower.contains("mlx") { order = [.mlx, .lmstudio] }
            else { order = [.lmstudio, .mlx, .llamacpp] }
        } else {
            order = [.ollama, .lmstudio]
        }
        for k in order {
            if let rt = host.runtime(k), supports(rt, cmd.verb, host: host) {
                var notes: [String] = []
                if cmd.verb == .add || cmd.verb == .update, enabled.count > 1 {
                    notes.append("Using \(k.displayName) on \(host.name) (add `via <runtime>` to override).")
                }
                if k == .ollama, isRepo { notes.append("Ollama expects hf.co/<repo> for Hugging Face models.") }
                return (rt, notes)
            }
        }
        throw FleetError("No runtime on \(host.name) can \(cmd.verb.rawValue) '\(model)'.")
    }

    func supports(_ rt: RuntimeConfig, _ verb: ModelVerb, host: HostConfig) -> Bool {
        if rt.kind == .ollama && rt.commands?.template(for: verb) == nil { return true }
        guard rt.effectiveTemplates.template(for: verb) != nil else { return false }
        guard host.isLocal || host.sshTarget != nil else { return false }
        // Default templates are POSIX; on Windows only explicit custom commands are allowed.
        if !host.os.isPOSIX && rt.commands?.template(for: verb) == nil { return false }
        return true
    }

    func unsupported(_ rt: RuntimeConfig, _ verb: ModelVerb, _ host: HostConfig) -> FleetError {
        if rt.effectiveTemplates.template(for: verb) == nil {
            return FleetError("\(rt.kind.displayName) has no '\(verb.rawValue)' command; set runtimes[].commands.\(verb.rawValue) for \(host.id) in hosts.json.")
        }
        if !host.isLocal && host.sshTarget == nil {
            return FleetError("\(host.name) has no sshTarget; \(rt.kind.displayName) \(verb.rawValue) runs over SSH.")
        }
        return FleetError("\(host.name) runs \(host.os.displayName); default \(rt.kind.displayName) commands assume a POSIX shell. Configure custom commands.")
    }

    // MARK: Step construction

    func buildSteps(_ verb: ModelVerb, model: String, host: HostConfig, runtime rt: RuntimeConfig, state: HostState?,
                    firstID: Int) throws(FleetError) -> (steps: [PlanStep], notes: [String])
    {
        var notes: [String] = []
        let base = Endpoint.baseURL(host: host, runtime: rt, state: state)
        let existing = state?.runtimes[rt.kind]?.models.first { $0.matches(model) }
        var id = firstID
        func step(_ title: String, _ detail: String, _ action: StepAction) -> PlanStep {
            defer { id += 1 }
            return PlanStep(id: id, hostID: host.id, hostName: host.name, runtime: rt.kind, model: model, verb: verb,
                            title: title, detail: detail, action: action, baseURL: base)
        }

        switch verb {
        case .add where existing != nil:
            notes.append("'\(existing!.name)' is already on \(host.name) (\(rt.kind.displayName)); pulling again only fetches changed layers.")
        case .remove where existing == nil, .reload where existing == nil:
            let known = state?.runtimes[rt.kind]?.lastUpdated != nil
            notes.append(known
                ? "'\(model)' is not in \(host.name)'s \(rt.kind.displayName) inventory; the request will likely fail."
                : "\(host.name)'s \(rt.kind.displayName) inventory is unknown; cannot confirm '\(model)' exists.")
        case .remove:
            if let size = existing?.sizeBytes { notes.append("Deleting frees about \(Format.bytes(size)) on \(host.name).") }
            if existing?.isLoaded == true { notes.append("'\(model)' is currently loaded on \(host.name) and will be evicted.") }
        default: break
        }

        // Ollama over HTTP unless a custom template overrides it.
        if rt.kind == .ollama, rt.commands?.template(for: verb) == nil {
            guard let base else { throw FleetError("\(host.name) has no address for Ollama.") }
            let url = base.absoluteString
            let name = existing?.name ?? model
            switch verb {
            case .add, .update:
                return ([step("\(verb == .add ? "Pull" : "Re-pull") \(model) on \(host.name)",
                              "POST \(url)/api/pull {\"model\":\"\(model)\",\"stream\":true}", .ollamaPull(model: model))], notes)
            case .remove:
                return ([step("Delete \(name) from \(host.name)",
                              "DELETE \(url)/api/delete {\"model\":\"\(name)\"}", .ollamaDelete(model: name))], notes)
            case .reload:
                return ([
                    step("Unload \(name) on \(host.name)", "POST \(url)/api/generate {\"model\":\"\(name)\",\"keep_alive\":0}", .ollamaUnload(model: name)),
                    step("Load \(name) on \(host.name)", "POST \(url)/api/generate {\"model\":\"\(name)\"}", .ollamaLoad(model: name)),
                ], notes)
            }
        }

        guard let template = rt.effectiveTemplates.template(for: verb) else { throw unsupported(rt, verb, host) }
        let rendered: (command: String, notes: [String])
        do {
            rendered = try TemplateRenderer.render(template, model: model, runtime: rt)
        } catch {
            throw FleetError("\(host.name)/\(rt.kind.displayName): \(error.errorDescription ?? "\(error)")")
        }
        notes.append(contentsOf: rendered.notes)
        let title = "\(verb.displayName) \(model) on \(host.name) (\(rt.kind.displayName))"
        if host.isLocal {
            return ([step(title, "$ \(rendered.command)", .local(command: rendered.command))], notes)
        }
        guard let target = host.sshTarget else { throw unsupported(rt, verb, host) }
        return ([step(title, "ssh \(target) -- \(rendered.command)",
                      .ssh(target: target, command: rendered.command, posix: host.os.isPOSIX))], notes)
    }

    private func dedupe(_ xs: [String]) -> [String] {
        var seen = Set<String>()
        return xs.filter { seen.insert($0).inserted }
    }
}

// MARK: - Fuzzy matching

public enum Fuzzy {
    public static func distance(_ a: String, _ b: String) -> Int {
        let a = Array(a.lowercased()), b = Array(b.lowercased())
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }
        var prev = Array(0...b.count)
        var cur = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            cur[0] = i
            for j in 1...b.count {
                cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1))
            }
            swap(&prev, &cur)
        }
        return prev[b.count]
    }

    /// Closest candidate within a small edit distance (scaled to length), if any.
    public static func suggest(_ query: String, among candidates: [String], maxDistance: Int? = nil) -> String? {
        let limit = maxDistance ?? max(1, min(3, query.count / 3))
        let scored = candidates.map { ($0, distance(query, $0)) }.filter { $0.1 <= limit && $0.0.lowercased() != query.lowercased() }
        return scored.min { $0.1 != $1.1 ? $0.1 < $1.1 : $0.0 < $1.0 }?.0
    }
}

public enum Format {
    public static func bytes(_ b: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: b, countStyle: .binary)
    }

    public static func relative(_ date: Date, now: Date = Date()) -> String {
        let s = Int(now.timeIntervalSince(date))
        if s < 5 { return "just now" }
        if s < 60 { return "\(s)s ago" }
        if s < 3600 { return "\(s / 60)m ago" }
        if s < 86400 { return "\(s / 3600)h ago" }
        return "\(s / 86400)d ago"
    }
}
