import Foundation

/// Streams output of a subprocess line by line (splitting on \n and \r so progress bars
/// show up as updates), with cancellation and an optional overall timeout.
public enum ProcessRunner {
    public enum Output: Sendable, Equatable {
        case stdout(String)
        case stderr(String)
        case exit(Int32)
    }

    public static func stream(_ executable: String, _ arguments: [String], timeout: TimeInterval? = nil,
                              environment: [String: String]? = nil) -> AsyncThrowingStream<Output, Error> {
        AsyncThrowingStream { continuation in
            let box = ProcessBox()
            let process = box.process
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            if let environment {
                process.environment = ProcessInfo.processInfo.environment.merging(environment) { _, new in new }
            }
            process.standardInput = FileHandle.nullDevice
            let out = Pipe(), err = Pipe()
            process.standardOutput = out
            process.standardError = err
            let outBuf = LineBuffer(), errBuf = LineBuffer()

            out.fileHandleForReading.readabilityHandler = { h in
                let d = h.availableData
                if d.isEmpty { h.readabilityHandler = nil; return }
                for l in outBuf.feed(d) { continuation.yield(.stdout(l)) }
            }
            err.fileHandleForReading.readabilityHandler = { h in
                let d = h.availableData
                if d.isEmpty { h.readabilityHandler = nil; return }
                for l in errBuf.feed(d) { continuation.yield(.stderr(l)) }
            }
            process.terminationHandler = { p in
                // Drain anything left in the pipes.
                out.fileHandleForReading.readabilityHandler = nil
                err.fileHandleForReading.readabilityHandler = nil
                if let rest = try? out.fileHandleForReading.readToEnd() { for l in outBuf.feed(rest) { continuation.yield(.stdout(l)) } }
                if let rest = try? err.fileHandleForReading.readToEnd() { for l in errBuf.feed(rest) { continuation.yield(.stderr(l)) } }
                if let l = outBuf.flush() { continuation.yield(.stdout(l)) }
                if let l = errBuf.flush() { continuation.yield(.stderr(l)) }
                if box.timedOut {
                    continuation.finish(throwing: FleetError("Timed out after \(Int(timeout ?? 0))s"))
                } else {
                    continuation.yield(.exit(p.terminationStatus))
                    continuation.finish()
                }
            }
            do {
                try process.run()
            } catch {
                continuation.finish(throwing: FleetError("Could not start \(executable): \(error.localizedDescription)"))
                return
            }
            if let timeout {
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                    if process.isRunning { box.timedOut = true; process.terminate() }
                }
            }
            continuation.onTermination = { reason in
                if case .cancelled = reason, process.isRunning { process.terminate() }
            }
        }
    }

    public struct Captured: Sendable {
        public var status: Int32
        public var stdout: String
        public var stderr: String
    }

    public static func capture(_ executable: String, _ arguments: [String], timeout: TimeInterval) async throws(FleetError) -> Captured {
        var o: [String] = [], e: [String] = [], status: Int32 = -1
        do {
            for try await item in stream(executable, arguments, timeout: timeout) {
                switch item {
                case .stdout(let l): o.append(l)
                case .stderr(let l): e.append(l)
                case .exit(let s): status = s
                }
            }
        } catch let err as FleetError {
            throw err
        } catch {
            throw FleetError(error.localizedDescription)
        }
        return Captured(status: status, stdout: o.joined(separator: "\n"), stderr: e.joined(separator: "\n"))
    }
}

final class ProcessBox: @unchecked Sendable {
    let process = Process()
    private let lock = NSLock()
    private var _timedOut = false
    var timedOut: Bool {
        get { lock.withLock { _timedOut } }
        set { lock.withLock { _timedOut = newValue } }
    }
}

/// Thread-safe accumulator that splits bytes into lines on \n or \r.
final class LineBuffer: @unchecked Sendable {
    private var pending = Data()
    private let lock = NSLock()

    func feed(_ data: Data) -> [String] {
        lock.withLock {
            pending.append(data)
            var lines: [String] = []
            while let idx = pending.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
                let line = pending[pending.startIndex..<idx]
                pending.removeSubrange(pending.startIndex...idx)
                let s = String(decoding: line, as: UTF8.self)
                if !s.trimmingCharacters(in: .whitespaces).isEmpty { lines.append(s) }
            }
            return lines
        }
    }

    func flush() -> String? {
        lock.withLock {
            defer { pending.removeAll() }
            let s = String(decoding: pending, as: UTF8.self)
            return s.trimmingCharacters(in: .whitespaces).isEmpty ? nil : s
        }
    }
}

// MARK: - SSH

public struct SSHRunner: Sendable {
    public var connectTimeout: Int
    public init(connectTimeout: Int) { self.connectTimeout = connectTimeout }

    /// Arguments for a non-interactive ssh invocation. BatchMode prevents password prompts
    /// from ever blocking; `--` stops the target being parsed as an option.
    public func arguments(target: String, command: String, posix: Bool) -> [String] {
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=\(connectTimeout)", "-o", "ServerAliveInterval=15",
         "-T", "--", target, posix ? Shell.posixPathPrefix + command : command]
    }

    public func stream(target: String, command: String, posix: Bool, timeout: TimeInterval? = nil)
        -> AsyncThrowingStream<ProcessRunner.Output, Error> {
        ProcessRunner.stream("/usr/bin/ssh", arguments(target: target, command: command, posix: posix), timeout: timeout)
    }

    public func capture(target: String, command: String, posix: Bool, timeout: TimeInterval) async throws(FleetError) -> ProcessRunner.Captured {
        try await ProcessRunner.capture("/usr/bin/ssh", arguments(target: target, command: command, posix: posix), timeout: timeout)
    }
}
