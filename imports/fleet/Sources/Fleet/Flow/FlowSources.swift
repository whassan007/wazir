import FleetCore
import Foundation
import Observation

// MARK: - Fleet operations → flow graph

enum FleetFlow {
    /// The command is the pump; plan steps run in order, so each step feeds the next;
    /// a final block shows the operation's outcome.
    static func graph(for op: OperationRecord) -> FlowGraph {
        func t(_ d: Date?) -> Double? { d?.timeIntervalSinceReferenceDate }
        var nodes: [FlowNode] = []
        var prev: String?
        for (i, step) in op.plan.steps.enumerated() {
            let st = op.steps[step.id] ?? .pending
            let (status, progress, detail): (FlowStatus, Double?, String) = switch st {
            case .pending: (.queued, nil, "")
            case .running(let p, let d): (.running, p, p.map { "\(Int($0 * 100))%" } ?? (d ?? ""))
            case .succeeded: (.done, 1, "")
            case .failed: (.failed, nil, "")
            case .skipped: (.skipped, nil, "")
            }
            let id = "step-\(step.id)"
            nodes.append(FlowNode(id: id, title: step.hostName,
                                  subtitle: "\(step.verb.rawValue) \(step.model)",
                                  wave: i, deps: prev.map { [$0] } ?? [], status: status, progress: progress,
                                  detail: detail, appearedAt: nil,
                                  startedAt: t(op.stepStartedAt[step.id]), finishedAt: t(op.stepFinishedAt[step.id])))
            prev = id
        }
        let resultStatus: FlowStatus = switch op.phase {
        case .running: .queued
        case .succeeded: .done
        case .failed: .failed
        case .cancelled: .skipped
        }
        nodes.append(FlowNode(id: "result", title: op.dryRun ? "Dry run" : "Result",
                              subtitle: op.phase.label.lowercased(), wave: op.plan.steps.count,
                              deps: prev.map { [$0] } ?? [], status: resultStatus, progress: nil, detail: "",
                              appearedAt: nil, startedAt: t(op.finishedAt), finishedAt: t(op.finishedAt)))
        return FlowGraph(nodes: nodes, sourceLabel: "Command",
                         sourceActiveAt: op.startedAt.timeIntervalSinceReferenceDate,
                         isActive: op.phase == .running)
    }
}

// MARK: - Simulated multi-agent run

/// Small deterministic RNG so a given prompt always produces the same plan.
struct SplitMix64: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Simulated planner → parallel workers → synthesizer → critic run. Workers are assigned to
/// models that are actually on the fleet, so the demo shows which machine would do what.
/// Nothing is sent to any host.
@MainActor
@Observable
final class AgentSimulation {
    struct Agent {
        var node: FlowNode
        var task: String
        var duration: Double
        var tokenRate: Double
        var failsOnce = false
        var attempt = 1
        var tokens = 0
        var failedAt: Double?
        var log: [String] = []
        /// Live runs only: the answer streamed so far, and the model doing the work.
        var output = ""
        var worker: FleetWorker?
    }

    var prompt = "Write a market analysis of EV charging in Europe"
    private(set) var agents: [Agent] = []
    private(set) var time: Double = 0
    private(set) var isRunning = false
    var isPaused = false
    var speed: Double = 1

    private var timer: Timer?
    private var planExpanded = false
    private var rng = SplitMix64(state: 1)
    private var workers: [(model: String, host: String)] = []

    var graph: FlowGraph {
        FlowGraph(nodes: agents.map(\.node), sourceLabel: "Prompt",
                  sourceActiveAt: agents.isEmpty ? nil : 0, isActive: isRunning && !isPaused)
    }
    var totalTokens: Int { agents.reduce(0) { $0 + $1.tokens } }
    var retries: Int { agents.reduce(0) { $0 + $1.attempt - 1 } }
    func agent(_ id: String?) -> Agent? { agents.first { $0.node.id == id } }

    /// `pool` is (model, host) pairs from the fleet's inventory; loaded models first.
    func start(pool: [(model: String, host: String)]) {
        timer?.invalidate()
        rng = SplitMix64(state: UInt64(truncatingIfNeeded: prompt.utf8.reduce(5381) { ($0 &* 33) &+ Int($1) }))
        workers = pool.isEmpty ? [("sonnet", "cloud"), ("haiku", "cloud")] : pool
        time = 0
        planExpanded = false
        agents = [makeAgent(id: "planner", title: "Planner", wave: 0, deps: [],
                            task: "Break the prompt into parallel subtasks", duration: 2.6, rate: 900,
                            worker: workers[0])]
        isRunning = true
        isPaused = false
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, !self.isPaused else { return }
                self.tick(1.0 / 60.0 * self.speed)
            }
        }
    }

    func stop() { timer?.invalidate(); timer = nil; isRunning = false }

    private func makeAgent(id: String, title: String, wave: Int, deps: [String], task: String,
                           duration: Double, rate: Double, worker: (model: String, host: String),
                           failsOnce: Bool = false) -> Agent {
        Agent(node: FlowNode(id: id, title: title, subtitle: "\(worker.model) @ \(worker.host)", wave: wave,
                             deps: deps, status: .queued, progress: 0, detail: "0%", appearedAt: time),
              task: task, duration: duration, tokenRate: rate, failsOnce: failsOnce)
    }

    private func tick(_ dt: Double) {
        time += dt
        for i in agents.indices {
            var a = agents[i]
            switch a.node.status {
            case .queued:
                if a.node.deps.allSatisfy({ d in agents.first { $0.node.id == d }?.node.status == .done }) {
                    a.node.status = .running
                    a.node.startedAt = a.node.startedAt ?? time
                    a.log.append(stamp("started on \(a.node.subtitle)"))
                }
            case .running, .retrying:
                let p = min(1, (a.node.progress ?? 0) + dt / a.duration)
                a.node.progress = p
                a.tokens += Int(a.tokenRate * dt * Double.random(in: 0.6...1.4, using: &rng))
                a.node.detail = "\(Int(p * 100))%"
                if a.failsOnce && a.attempt == 1 && p >= 0.55 {
                    a.node.status = .failed
                    a.failedAt = time
                    a.log.append(stamp("failed: tool call timed out"))
                } else if p >= 1 {
                    a.node.status = .done
                    a.node.finishedAt = time
                    a.node.detail = String(format: "%.1fk tok", Double(a.tokens) / 1000)
                    a.log.append(stamp("finished, \(a.tokens.formatted()) tokens"))
                }
            case .failed:
                if time - (a.failedAt ?? time) > 1.2 {
                    a.node.status = .retrying
                    a.attempt += 1
                    a.node.progress = 0
                    a.log.append(stamp("retrying (attempt \(a.attempt))"))
                }
            case .done, .skipped:
                break
            }
            agents[i] = a
        }
        if !planExpanded, agents.first?.node.status == .done { expandPlan() }
        if planExpanded, agents.allSatisfy({ $0.node.status == .done }) { stop() }
    }

    private func stamp(_ s: String) -> String { String(format: "%5.1fs  ", time) + s }

    private func expandPlan() {
        planExpanded = true
        let pool = ["Market sizing", "Competitor scan", "Regulation", "Tech trends",
                    "Customer sentiment", "Pricing models", "Supply chain", "Risk review"]
        let count = Int.random(in: 4...6, using: &rng)
        let failIndex = Int.random(in: 0..<count, using: &rng)
        var research: [String] = []
        for (i, topic) in pool.shuffled(using: &rng).prefix(count).enumerated() {
            let id = "r\(i)"
            research.append(id)
            agents.append(makeAgent(id: id, title: topic, wave: 1, deps: ["planner"], task: "\(topic) for: \(prompt)",
                                    duration: Double.random(in: 3...8, using: &rng),
                                    rate: Double.random(in: 500...1400, using: &rng),
                                    worker: workers[(i + 1) % workers.count], failsOnce: i == failIndex))
        }
        agents.append(makeAgent(id: "synth", title: "Synthesizer", wave: 2, deps: research,
                                task: "Merge research into a draft", duration: 5, rate: 1500, worker: workers[0]))
        agents.append(makeAgent(id: "critic", title: "Critic", wave: 3, deps: ["synth"],
                                task: "Check the draft for gaps and errors", duration: 3, rate: 800,
                                worker: workers[min(1, workers.count - 1)]))
        agents.append(makeAgent(id: "result", title: "Result", wave: 4, deps: ["critic"],
                                task: "Final answer", duration: 0.8, rate: 0, worker: ("output", "fleet")))
        agents[0].log.append(stamp("plan created: \(count + 3) agents"))
    }
}
