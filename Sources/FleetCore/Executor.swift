import Foundation

/// Executes a plan step by step, emitting `OperationEvent`s. In dry-run mode nothing is
/// sent to any host: each step only reports what it would do.
public struct PlanExecutor: Sendable {
    public let http: HTTPClient
    public let ssh: SSHRunner

    public init(http: HTTPClient, ssh: SSHRunner) {
        self.http = http
        self.ssh = ssh
    }

    public func run(_ plan: ExecutionPlan, dryRun: Bool) -> AsyncStream<OperationEvent> {
        AsyncStream { continuation in
            let task = Task {
                for step in plan.steps {
                    if Task.isCancelled { break }
                    continuation.yield(.stepStarted(step.id))
                    continuation.yield(.stepLog(step.id, .info, step.detail))
                    if dryRun {
                        continuation.yield(.stepSucceeded(step.id, "Dry run: nothing was changed"))
                        continue
                    }
                    do {
                        let msg = try await execute(step) { continuation.yield($0) }
                        continuation.yield(.stepSucceeded(step.id, msg))
                    } catch {
                        if Task.isCancelled { break }
                        continuation.yield(.stepFailed(step.id, (error as? FleetError)?.message ?? error.localizedDescription))
                    }
                }
                if !Task.isCancelled { continuation.yield(.finished) }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func execute(_ step: PlanStep, emit: @Sendable (OperationEvent) -> Void) async throws(FleetError) -> String? {
        let ollama = OllamaClient(http: http)
        func base() throws(FleetError) -> URL {
            guard let b = step.baseURL else { throw FleetError("No address for \(step.hostName)") }
            return b
        }
        switch step.action {
        case .ollamaPull(let model):
            var lastStatus = ""
            var lastProgressEmit = Date.distantPast
            do {
                for try await u in ollama.pull(base: try base(), model: model) {
                    if u.status != lastStatus {
                        emit(.stepLog(step.id, .output, u.status))
                    }
                    lastStatus = u.status
                    let now = Date()
                    if now.timeIntervalSince(lastProgressEmit) > 0.25 || u.progress == 1 {
                        lastProgressEmit = now
                        let detail = u.totalBytes > 0
                            ? "\(Format.bytes(u.completedBytes)) / \(Format.bytes(u.totalBytes))" : u.status
                        emit(.stepProgress(step.id, u.progress, detail))
                    }
                }
            } catch let e as FleetError {
                throw e
            } catch {
                throw FleetError(error.localizedDescription)
            }
            return "Pulled \(model)"

        case .ollamaDelete(let model):
            try await ollama.delete(base: try base(), model: model)
            return "Deleted \(model)"

        case .ollamaUnload(let model):
            try await ollama.generate(base: try base(), model: model, keepAlive: 0)
            return "Unloaded \(model)"

        case .ollamaLoad(let model):
            emit(.stepProgress(step.id, nil, "Loading weights into memory…"))
            try await ollama.generate(base: try base(), model: model, keepAlive: nil)
            return "Loaded \(model)"

        case .ssh(let target, let command, let posix):
            return try await runProcess(step, emit: emit, stream: ssh.stream(target: target, command: command, posix: posix))

        case .local(let command):
            return try await runProcess(step, emit: emit,
                                        stream: ProcessRunner.stream("/bin/sh", ["-c", Shell.posixPathPrefix + command]))
        }
    }

    func runProcess(_ step: PlanStep, emit: @Sendable (OperationEvent) -> Void,
                    stream: AsyncThrowingStream<ProcessRunner.Output, Error>) async throws(FleetError) -> String? {
        var lastErr = ""
        var throttle = ProgressThrottle()
        do {
            for try await item in stream {
                switch item {
                case .stdout(let l), .stderr(let l):
                    if case .stderr = item { lastErr = l }
                    if let p = ProgressThrottle.percent(in: l) {
                        if throttle.shouldEmit(p) { emit(.stepProgress(step.id, p, String(l.suffix(120)))) }
                        if !throttle.shouldLog() { continue }
                    }
                    let level: LogLine.Level = { if case .stderr = item { return .warning } else { return .output } }()
                    emit(.stepLog(step.id, level, l))
                case .exit(let code):
                    if code == 0 { return "Exit 0" }
                    let hint = code == 255 ? " (SSH connection failed)" : (code == 127 ? " (command not found on host)" : "")
                    throw FleetError("Exit \(code)\(hint)" + (lastErr.isEmpty ? "" : ": \(lastErr)"))
                }
            }
        } catch let e as FleetError {
            throw e
        } catch {
            throw FleetError(error.localizedDescription)
        }
        throw FleetError("Process ended without an exit status")
    }
}

/// Limits progress-bar spam from tools like `hf download` that redraw with \r.
struct ProgressThrottle {
    var lastEmit = Date.distantPast
    var lastLog = Date.distantPast
    var lastValue: Double = -1

    mutating func shouldEmit(_ p: Double) -> Bool {
        let now = Date()
        guard now.timeIntervalSince(lastEmit) > 0.2 || p >= 1 || abs(p - lastValue) > 0.05 else { return false }
        lastEmit = now; lastValue = p
        return true
    }

    mutating func shouldLog() -> Bool {
        let now = Date()
        guard now.timeIntervalSince(lastLog) > 3 else { return false }
        lastLog = now
        return true
    }

    /// Extracts the last `NN%` / `NN.N%` occurrence as 0...1.
    static func percent(in line: String) -> Double? {
        guard let r = line.range(of: #"(\d{1,3}(?:\.\d+)?)%"#, options: [.regularExpression, .backwards]) else { return nil }
        guard let v = Double(line[r].dropLast()), v <= 100 else { return nil }
        return v / 100
    }
}
