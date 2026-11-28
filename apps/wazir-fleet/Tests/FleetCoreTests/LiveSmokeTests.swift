import Foundation
import Testing
@testable import FleetCore

/// Read-only checks against the real fleet (your hosts.json, else the example defaults).
/// Opt-in: `FLEET_LIVE=1 swift test --filter Live`.
@Suite("Live fleet (read-only)", .enabled(if: ProcessInfo.processInfo.environment["FLEET_LIVE"] == "1"))
struct LiveSmokeTests {
    @Test func probeInventoryAndMetricsForEveryHost() async throws {
        let cfg = (try? ConfigStore().load()) ?? DefaultFleet.config
        let http = HTTPClient(timeout: 4)
        let ssh = SSHRunner(connectTimeout: 5)
        if let peers = try? await TailscaleStatus.fetch() {
            print("tailscale peers:", peers.count)
        }
        await withTaskGroup(of: String.self) { g in
            for host in cfg.hosts {
                g.addTask {
                    var lines: [String] = []
                    let ports = (host.sshTarget != nil ? [22] : []) + host.enabledRuntimes.map(\.port)
                    let r = host.isLocal ? .online(latencyMS: 0, address: "127.0.0.1")
                        : await ReachabilityProbe.probe(addresses: host.candidateAddresses, ports: ports, timeout: 2.5)
                    lines.append("\(host.id): \(r)")
                    guard r.isOnline else { return lines.joined(separator: "\n") }
                    var hs = HostState(id: host.id, runtimes: [])
                    hs.reachability = r
                    for rt in host.enabledRuntimes {
                        let base = Endpoint.baseURL(host: host, runtime: rt, state: hs)!
                        do throws(FleetError) {
                            let snap = try await RuntimeClients.inventory(kind: rt.kind, base: base, http: http)
                            lines.append("  \(rt.kind.rawValue) v\(snap.version ?? "?"): \(snap.models.count) models, loaded: \(snap.models.filter(\.isLoaded).map(\.name))")
                        } catch {
                            lines.append("  \(rt.kind.rawValue): \(error.message)")
                        }
                    }
                    if host.isLocal || host.sshTarget != nil {
                        do throws(FleetError) {
                            let m = try await MetricsProbe.collect(host: host, ssh: ssh, timeout: 12)
                            lines.append("  metrics: mem \(m.memoryUsedFraction.map { "\(Int($0 * 100))%" } ?? "?"), load \(m.load1 ?? -1), gpus \(m.gpus.map(\.name))")
                        } catch {
                            lines.append("  metrics: \(error.message)")
                        }
                    }
                    return lines.joined(separator: "\n")
                }
            }
            for await s in g { print(s) }
        }
    }

    @Test func registryLookup() async {
        let reg = OllamaRegistry()
        #expect(await reg.lookup("qwen2.2") == .notFound)
        if case .found(let b) = await reg.lookup("qwen2.5") { #expect(b > 1_000_000_000) } else { Issue.record("qwen2.5 not found") }
    }

    /// Streams a planner reply from the first already-loaded model it finds (never loads one).
    @Test func plannerRoundTripOnALoadedModel() async throws {
        let cfg = (try? ConfigStore().load()) ?? DefaultFleet.config
        let http = HTTPClient(timeout: 4)
        for host in cfg.hosts where host.isLocal {
            var hs = HostState(id: host.id, runtimes: [])
            hs.reachability = .online(latencyMS: 0, address: "127.0.0.1")
            for rt in host.enabledRuntimes {
                guard let base = Endpoint.baseURL(host: host, runtime: rt, state: hs),
                      let snap = try? await RuntimeClients.inventory(kind: rt.kind, base: base, http: http),
                      let model = snap.models.first(where: \.isLoaded) else { continue }
                var text = "", events = 0
                let started = Date()
                for try await e in ChatClient().stream(base: base, model: model.name,
                                                       messages: AgentPrompts.planner(goal: "Compare heat pumps and gas boilers for a UK home", maxSubtasks: 4),
                                                       maxTokens: 2048) {
                    events += 1
                    if case .content(let s) = e { text += s }
                }
                let subtasks = AgentPrompts.parseSubtasks(text, limit: 4)
                print("\(model.name) @ \(host.id) [\(rt.kind.rawValue)]: \(events) events in \(String(format: "%.1f", Date().timeIntervalSince(started)))s")
                for s in subtasks { print("  - \(s.title): \(s.task)") }
                #expect(!subtasks.isEmpty, "unparsed reply: \(text.prefix(400))")
                return
            }
        }
        print("no loaded model on the local machine; skipped")
    }
}
