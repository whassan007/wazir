import Foundation
import Network

// MARK: - TCP reachability

public enum ReachabilityProbe {
    /// Races TCP connects to every (address, port) pair; first success wins. Never blocks
    /// longer than `timeout`, so sleeping hosts can't stall a refresh.
    public static func probe(addresses: [String], ports: [Int], timeout: TimeInterval) async -> Reachability {
        let pairs = addresses.flatMap { a in ports.map { (a, $0) } }
        guard !pairs.isEmpty else { return .offline(reason: "No address configured") }
        return await withTaskGroup(of: (String, Int, Double?).self) { group in
            for (a, p) in pairs {
                group.addTask { (a, p, await connect(host: a, port: p, timeout: timeout)) }
            }
            for await (addr, _, latency) in group {
                if let latency {
                    group.cancelAll()
                    return .online(latencyMS: latency, address: addr)
                }
            }
            return .offline(reason: "No response on ports \(Set(ports).sorted().map(String.init).joined(separator: ", "))")
        }
    }

    /// Returns connect latency in ms, or nil on failure/timeout.
    public static func connect(host: String, port: Int, timeout: TimeInterval) async -> Double? {
        guard let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { return nil }
        let params = NWParameters.tcp
        if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.connectionTimeout = Int(ceil(timeout))
        }
        let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: params)
        let once = Once<Double?>()
        let start = DispatchTime.now()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<Double?, Never>) in
                once.set(cont)
                conn.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        let ms = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e6
                        once.resume(ms); conn.cancel()
                    case .failed, .cancelled:
                        once.resume(nil); conn.cancel()
                    case .waiting:
                        // No route / refused: fail fast rather than waiting for the timeout.
                        once.resume(nil); conn.cancel()
                    default: break
                    }
                }
                conn.start(queue: .global(qos: .utility))
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                    once.resume(nil); conn.cancel()
                }
            }
        } onCancel: {
            once.resume(nil); conn.cancel()
        }
    }
}

/// Resumes a continuation exactly once from any thread.
final class Once<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var cont: CheckedContinuation<T, Never>?
    private var pending: T?  // value delivered before the continuation was set
    private var hasPending = false
    private var done = false

    func set(_ c: CheckedContinuation<T, Never>) {
        lock.lock()
        if hasPending, !done { done = true; let v = pending!; lock.unlock(); c.resume(returning: v); return }
        if done { lock.unlock(); return }
        cont = c
        lock.unlock()
    }

    func resume(_ value: T) {
        lock.lock()
        guard !done, !hasPending else { lock.unlock(); return }
        if let c = cont {
            done = true; cont = nil; lock.unlock()
            c.resume(returning: value)
        } else {
            pending = value; hasPending = true; lock.unlock()
        }
    }
}

// MARK: - Tailscale

public enum TailscaleStatus {
    static let candidates = [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
    ]

    public static func fetch(timeout: TimeInterval = 5) async throws(FleetError) -> [TailscalePeer] {
        let fm = FileManager.default
        var lastError = FleetError("Tailscale CLI not found")
        for path in candidates where fm.isExecutableFile(atPath: path) {
            do {
                let r = try await ProcessRunner.capture(path, ["status", "--json"], timeout: timeout)
                guard r.status == 0 else {
                    lastError = FleetError("tailscale status failed: \(r.stderr.split(separator: "\n").first ?? "exit \(r.status)")")
                    continue
                }
                return try parse(Data(r.stdout.utf8))
            } catch {
                lastError = error
            }
        }
        throw lastError
    }

    struct Status: Decodable {
        struct Node: Decodable {
            var HostName: String?
            var DNSName: String?
            var TailscaleIPs: [String]?
            var Online: Bool?
            var LastSeen: String?
            var OS: String?
        }
        var `Self`: Node?
        var Peer: [String: Node]?
    }

    public static func parse(_ data: Data) throws(FleetError) -> [TailscalePeer] {
        let s: Status
        do { s = try JSONDecoder().decode(Status.self, from: data) } catch {
            throw FleetError("Unreadable tailscale status JSON")
        }
        func peer(_ n: Status.Node, isSelf: Bool) -> TailscalePeer {
            let seen = n.LastSeen.flatMap(ISODate.parse).flatMap { $0.timeIntervalSince1970 > 0 ? $0 : nil }
            return TailscalePeer(hostName: n.HostName ?? "?", dnsName: n.DNSName, ips: n.TailscaleIPs ?? [],
                                 online: isSelf ? true : (n.Online ?? false), lastSeen: seen, os: n.OS, isSelf: isSelf)
        }
        var out = (s.Peer ?? [:]).values.map { peer($0, isSelf: false) }
        if let me = s.Self { out.append(peer(me, isSelf: true)) }
        return out.sorted { $0.hostName < $1.hostName }
    }
}

// MARK: - Host metrics

public enum MetricsProbe {
    static let gpuQuery = "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits"

    public static func script(for os: HostOS) -> String {
        switch os {
        case .linux:
            return [
                #"echo "os=$(uname -sr)""#,
                #"echo "load=$(cut -d' ' -f1-3 /proc/loadavg)""#,
                #"echo "cpus=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)""#,
                #"awk '/^MemTotal:/{print "memTotalKB="$2} /^MemAvailable:/{print "memAvailKB="$2}' /proc/meminfo"#,
                #"echo "uptime=$(cut -d. -f1 /proc/uptime)""#,
                "\(gpuQuery) 2>/dev/null | sed 's/^/gpu=/'",
                "true",
            ].joined(separator: "; ")
        case .macos:
            return [
                #"echo "os=macOS $(sw_vers -productVersion)""#,
                #"echo "chip=$(sysctl -n machdep.cpu.brand_string)""#,
                #"echo "load=$(sysctl -n vm.loadavg | tr -d '{}' | awk '{print $1, $2, $3}')""#,
                #"echo "cpus=$(sysctl -n hw.ncpu)""#,
                #"echo "memTotalBytes=$(sysctl -n hw.memsize)""#,
                #"vm_stat | awk -v ps=$(sysctl -n hw.pagesize) '/Pages free/{f=$3} /Pages inactive/{i=$3} /Pages speculative/{s=$3} END{print "memAvailBytes=" (f+i+s)*ps}'"#,
                #"echo "boot=$(sysctl -n kern.boottime | sed -E 's/.*sec = ([0-9]+).*/\1/')""#,
                "true",
            ].joined(separator: "; ")
        case .windows:
            return gpuQuery
        }
    }

    /// Parses `key=value` lines; bare 5-field CSV lines (Windows) are treated as GPU rows.
    public static func parse(_ output: String, now: Date = Date()) -> HostMetrics {
        var m = HostMetrics()
        func num(_ s: Substring) -> Double? {
            let t = s.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("[") ? nil : Double(t)  // "[N/A]" on unified-memory GPUs
        }
        for raw in output.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            var key = "", value = Substring(line)
            if let eq = line.firstIndex(of: "=") {
                key = String(line[..<eq]); value = line[line.index(after: eq)...]
            } else if line.split(separator: ",").count == 5 {
                key = "gpu"
            }
            switch key {
            case "os": m.osVersion = String(value)
            case "chip": m.chip = String(value)
            case "load":
                let parts = value.split(separator: " ").compactMap { num($0) }
                if parts.count >= 3 { (m.load1, m.load5, m.load15) = (parts[0], parts[1], parts[2]) }
            case "cpus": m.cpuCount = Int(value.trimmingCharacters(in: .whitespaces))
            case "memTotalKB": m.memTotalBytes = num(value).map { Int64($0 * 1024) }
            case "memAvailKB": m.memAvailableBytes = num(value).map { Int64($0 * 1024) }
            case "memTotalBytes": m.memTotalBytes = num(value).map { Int64($0) }
            case "memAvailBytes": m.memAvailableBytes = num(value).map { Int64($0) }
            case "uptime": m.uptimeSeconds = Int(value.trimmingCharacters(in: .whitespaces))
            case "boot":
                if let b = Double(value.trimmingCharacters(in: .whitespaces)) { m.uptimeSeconds = Int(now.timeIntervalSince1970 - b) }
            case "gpu":
                let f = value.split(separator: ",", omittingEmptySubsequences: false)
                guard f.count >= 5 else { continue }
                m.gpus.append(GPUMetrics(name: f[0].trimmingCharacters(in: .whitespaces), utilizationPercent: num(f[1]),
                                         memoryUsedMB: num(f[2]), memoryTotalMB: num(f[3]), temperatureC: num(f[4])))
            default: break
            }
        }
        return m
    }

    public static func collect(host: HostConfig, ssh: SSHRunner, timeout: TimeInterval) async throws(FleetError) -> HostMetrics {
        let script = script(for: host.os)
        let result: ProcessRunner.Captured
        if host.isLocal {
            result = try await ProcessRunner.capture("/bin/sh", ["-c", script], timeout: timeout)
        } else if let target = host.sshTarget {
            result = try await ssh.capture(target: target, command: script, posix: host.os.isPOSIX, timeout: timeout)
        } else {
            throw FleetError("No SSH target configured")
        }
        if result.status == 255 {
            throw FleetError("SSH failed: " + (result.stderr.split(separator: "\n").last.map(String.init) ?? "exit 255"))
        }
        let m = parse(result.stdout)
        if m == HostMetrics() { throw FleetError("No metrics returned (exit \(result.status))") }
        return m
    }
}
