import Foundation

/// Pure state transition function. All UI state changes flow through here, which keeps
/// behaviour deterministic and unit-testable.
public enum FleetReducer {
    public static func reduce(_ state: inout FleetState, _ event: FleetEvent) {
        switch event {
        case .configLoaded(let config):
            reconcile(&state, config)

        case .probeStarted(let id):
            mutateHost(&state, id) { $0.isProbing = true }

        case .reachability(let id, let r, let date):
            mutateHost(&state, id) { h in
                h.reachability = r
                h.lastProbe = date
                if r.isOnline {
                    h.lastSeen = max(h.lastSeen ?? date, date)
                } else {
                    // Unreachable host: keep last-known inventory but mark it stale.
                    for k in h.runtimes.keys {
                        h.runtimes[k]!.isStale = !h.runtimes[k]!.models.isEmpty
                        h.runtimes[k]!.status = .unreachable("Host unreachable")
                        h.runtimes[k]!.models = h.runtimes[k]!.models.map { var m = $0; m.isLoaded = false; return m }
                    }
                }
            }

        case .tailscale(.success(let peers), let date):
            state.tailscaleError = nil
            state.tailscaleUpdated = date
            for id in state.hostOrder {
                // Matched by the host's configured Tailscale IP or name.
                guard let peer = state.hosts[id].flatMap({ _ in matchPeer(peers, id: id, state: state) }) else { continue }
                mutateHost(&state, id) { h in
                    h.tailscale = peer
                    // Tailscale "online" doesn't mean our services answer (relay-only, firewalled),
                    // so only its last-seen time for offline peers counts; direct probes set the rest.
                    if !peer.online, let seen = peer.lastSeen {
                        h.lastSeen = max(h.lastSeen ?? seen, seen)
                    }
                }
            }

        case .tailscale(.failure(let err), _):
            state.tailscaleError = err.message

        case .inventory(let id, let kind, let result, let date):
            mutateHost(&state, id) { h in
                var rt = h.runtimes[kind] ?? RuntimeState(kind: kind)
                switch result {
                case .success(let snap):
                    rt.status = .online
                    rt.version = snap.version
                    rt.models = snap.models.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                    rt.isStale = false
                    rt.lastUpdated = date
                case .failure(let err):
                    rt.status = .unreachable(err.message)
                    rt.isStale = !rt.models.isEmpty
                }
                h.runtimes[kind] = rt
            }

        case .metrics(let id, let result, let date):
            mutateHost(&state, id) { h in
                switch result {
                case .success(let m):
                    h.metrics = m
                    h.metricsError = nil
                    h.metricsUpdated = date
                case .failure(let e):
                    h.metricsError = e.message
                }
            }

        case .probeFinished(let id, _):
            mutateHost(&state, id) { $0.isProbing = false }

        case .operationStarted(let op):
            guard state.operation(op.id) == nil else {
                state.diagnostics.append("Operation \(op.id) started twice; ignored.")
                return
            }
            state.operations.insert(op, at: 0)

        case .operation(let id, let ev, let date):
            guard let idx = state.operations.firstIndex(where: { $0.id == id }) else {
                state.diagnostics.append("Event for unknown operation \(id) ignored.")
                return
            }
            do {
                try apply(ev, to: &state.operations[idx], at: date)
            } catch {
                state.diagnostics.append("Operation \(id.uuidString.prefix(8)): \(error.message)")
            }

        case .clearFinishedOperations:
            state.operations.removeAll { $0.phase.isTerminal }

        case .cloudServicesUpdated(let snapshots, _):
            for snap in snapshots {
                state.cloudSnapshots[snap.id] = snap
            }
        }
    }

    // MARK: Operation state machine

    /// Applies an operation event, enforcing legal transitions:
    /// step: pending → running → succeeded|failed|skipped (pending → skipped also allowed);
    /// operation: running → succeeded|failed|cancelled; terminal phases accept nothing but logs.
    public static func apply(_ event: OperationEvent, to op: inout OperationRecord, at date: Date) throws(FleetError) {
        if op.phase.isTerminal {
            if case .stepLog(let step, let level, let text) = event {
                op.appendLog(level, text, step: step, at: date)
                return
            }
            throw FleetError("Ignored \(event) after operation \(op.phase.label.lowercased()).")
        }
        func status(_ step: Int) throws(FleetError) -> StepStatus {
            guard let s = op.steps[step] else { throw FleetError("Unknown step \(step).") }
            return s
        }
        switch event {
        case .stepStarted(let s):
            guard case .pending = try status(s) else { throw FleetError("Step \(s) started twice.") }
            op.steps[s] = .running(progress: nil, detail: nil)
            op.stepStartedAt[s] = date
            if let step = op.plan.steps.first(where: { $0.id == s }) {
                op.appendLog(.info, "▶ \(step.title)", step: s, at: date)
            }
        case .stepProgress(let s, let p, let detail):
            guard case .running = try status(s) else { throw FleetError("Progress for step \(s) which is not running.") }
            op.steps[s] = .running(progress: p.map { min(1, max(0, $0)) }, detail: detail)
        case .stepLog(let s, let level, let text):
            op.appendLog(level, text, step: s, at: date)
        case .stepSucceeded(let s, let msg):
            guard case .running = try status(s) else { throw FleetError("Step \(s) finished without starting.") }
            op.steps[s] = .succeeded(msg)
            op.stepFinishedAt[s] = date
            op.appendLog(.info, "✓ " + (msg ?? "Done"), step: s, at: date)
        case .stepFailed(let s, let msg):
            let st = try status(s)
            guard !st.isTerminal else { throw FleetError("Step \(s) already finished.") }
            op.steps[s] = .failed(msg)
            op.stepFinishedAt[s] = date
            op.appendLog(.error, "✗ " + msg, step: s, at: date)
        case .stepSkipped(let s, let why):
            let st = try status(s)
            guard !st.isTerminal else { throw FleetError("Step \(s) already finished.") }
            op.steps[s] = .skipped(why)
            op.stepFinishedAt[s] = date
            op.appendLog(.warning, "↷ Skipped: " + why, step: s, at: date)
        case .finished:
            let failures = op.plan.steps.compactMap { step -> String? in
                if case .failed(let m) = op.steps[step.id] { return "\(step.title): \(m)" }
                return nil
            }
            // Any step not finished is marked skipped so the record is self-consistent.
            for step in op.plan.steps where !(op.steps[step.id]?.isTerminal ?? true) {
                op.steps[step.id] = .skipped("Not run")
                op.stepFinishedAt[step.id] = date
            }
            op.phase = failures.isEmpty ? .succeeded : .failed(failures.joined(separator: "; "))
            op.finishedAt = date
        case .cancelled:
            for step in op.plan.steps where !(op.steps[step.id]?.isTerminal ?? true) {
                op.steps[step.id] = .skipped("Cancelled")
                op.stepFinishedAt[step.id] = date
            }
            op.phase = .cancelled
            op.finishedAt = date
            op.appendLog(.warning, "Operation cancelled.", step: nil, at: date)
        }
    }

    // MARK: Helpers

    static func reconcile(_ state: inout FleetState, _ config: FleetConfig) {
        var next: [String: HostState] = [:]
        for h in config.hosts {
            var hs = state.hosts[h.id] ?? HostState(id: h.id, runtimes: [])
            let kinds = Set(h.enabledRuntimes.map(\.kind))
            for k in kinds where hs.runtimes[k] == nil { hs.runtimes[k] = RuntimeState(kind: k) }
            for k in hs.runtimes.keys where !kinds.contains(k) { hs.runtimes[k] = nil }
            next[h.id] = hs
        }
        state.hosts = next
        state.hostOrder = config.hosts.map(\.id)
        state.tailscaleConfig = Dictionary(uniqueKeysWithValues: config.hosts.map {
            ($0.id, TailscaleMatchKey(ip: $0.tailscaleIP, name: $0.tailscaleName))
        })
    }

    static func matchPeer(_ peers: [TailscalePeer], id: String, state: FleetState) -> TailscalePeer? {
        guard let key = state.tailscaleConfig[id] else { return nil }
        if let ip = key.ip, let p = peers.first(where: { $0.ips.contains(ip) }) { return p }
        if let name = key.name?.lowercased(),
           let p = peers.first(where: { $0.hostName.lowercased() == name || ($0.dnsName?.lowercased().hasPrefix(name + ".") ?? false) }) {
            return p
        }
        return nil
    }

    static func mutateHost(_ state: inout FleetState, _ id: String, _ body: (inout HostState) -> Void) {
        guard state.hosts[id] != nil else {
            state.diagnostics.append("Event for unknown host '\(id)' ignored.")
            return
        }
        body(&state.hosts[id]!)
    }
}

public struct TailscaleMatchKey: Equatable, Sendable {
    public var ip: String?
    public var name: String?
}
