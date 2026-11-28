import FleetCore
import Foundation
import Observation

/// A chat-capable model on an online machine.
struct FleetWorker: Equatable, Sendable {
    var model: String
    var host: String
    var kind: RuntimeKind
    var base: URL
    var isLoaded: Bool
    var label: String { "\(model) @ \(host)" }
}

/// Shared surface of the simulated and live agent runs, so the Flow page can show either.
@MainActor
protocol AgentRunModel: AnyObject {
    var graph: FlowGraph { get }
    var time: Double { get }
    var isRunning: Bool { get }
    var totalTokens: Int { get }
    var retries: Int { get }
    func agent(_ id: String?) -> AgentSimulation.Agent?
    func stop()
}

extension AgentSimulation: AgentRunModel {}

/// Real planner → parallel workers → synthesizer → critic run. Every agent is a streamed
/// chat completion against a model on the fleet; a failed agent fails over once to a model
/// on a different machine.
@MainActor
@Observable
final class LiveAgentRun: AgentRunModel {
    typealias Agent = AgentSimulation.Agent

    private(set) var agents: [Agent] = []
    private(set) var isRunning = false
    private(set) var finalAnswer: String?
    private(set) var problem: String?
    private var startDate: Date?
    private var endTime: Double?
    private var runTask: Task<Void, Never>?
    private let client = ChatClient()

    var time: Double {
        guard let startDate else { return 0 }
        return endTime ?? Date().timeIntervalSince(startDate)
    }
    var graph: FlowGraph {
        FlowGraph(nodes: agents.map(\.node), sourceLabel: "Prompt",
                  sourceActiveAt: agents.isEmpty ? nil : 0, isActive: isRunning)
    }
    var totalTokens: Int { agents.reduce(0) { $0 + $1.tokens } }
    var retries: Int { agents.reduce(0) { $0 + $1.attempt - 1 } }
    func agent(_ id: String?) -> Agent? { agents.first { $0.node.id == id } }

    func start(prompt: String, workers: [FleetWorker]) {
        stop()
        agents = []
        finalAnswer = nil
        problem = nil
        endTime = nil
        startDate = Date()
        isRunning = true
        runTask = Task { [weak self] in
            await self?.run(goal: prompt, workers: workers)
            self?.finish()
        }
    }

    func stop() {
        runTask?.cancel()
        runTask = nil
        if isRunning { finish() }
    }

    private func finish() {
        guard isRunning else { return }
        isRunning = false
        endTime = startDate.map { Date().timeIntervalSince($0) }
        for i in agents.indices where agents[i].node.status == .queued || agents[i].node.status.isActive {
            agents[i].node.status = .skipped
            agents[i].log.append(stamp("stopped"))
        }
    }

    // MARK: Pipeline

    private func run(goal: String, workers: [FleetWorker]) async {
        guard let lead = workers.first else { problem = "No chat models on online machines."; return }
        let critic = workers.first { $0.host != lead.host } ?? workers[min(1, workers.count - 1)]

        addAgent(id: "planner", title: "Planner", wave: 0, deps: [], task: "Break the prompt into parallel subtasks",
                 worker: lead)
        let maxSubtasks = min(5, max(3, workers.count))
        guard let planText = await execute("planner", AgentPrompts.planner(goal: goal, maxSubtasks: maxSubtasks),
                                           budget: 2048, workers: workers) else {
            problem = "The planner failed, so the run stopped."
            return
        }
        var subtasks = AgentPrompts.parseSubtasks(planText, limit: maxSubtasks)
        if subtasks.isEmpty {
            log("planner", "reply had no usable subtasks; running the prompt as a single task")
            subtasks = [.init(title: "Answer", task: goal)]
        } else {
            log("planner", "plan created: \(subtasks.count) subtasks")
        }

        // Spread workers across machines, skipping the planner's model when there are others.
        let rotation = workers.count > 1 ? Array(workers.dropFirst()) + [lead] : workers
        var ids: [String] = []
        for (i, s) in subtasks.enumerated() {
            let id = "w\(i)"
            ids.append(id)
            addAgent(id: id, title: s.title, wave: 1, deps: ["planner"], task: s.task,
                     worker: rotation[i % rotation.count])
        }
        addAgent(id: "synth", title: "Synthesizer", wave: 2, deps: ids, task: "Merge the findings into a draft",
                 worker: lead)
        addAgent(id: "critic", title: "Critic", wave: 3, deps: ["synth"], task: "Check the draft and fix gaps and errors",
                 worker: critic)
        addAgent(id: "result", title: "Result", wave: 4, deps: ["critic"], task: "Final answer",
                 worker: nil)

        // Workers run concurrently: each awaits its own network stream off the main actor.
        let tasks = subtasks.enumerated().map { i, s in
            Task { @MainActor in
                await self.execute("w\(i)", AgentPrompts.worker(goal: goal, subtask: s), budget: 1536, workers: workers)
            }
        }
        var findings: [(AgentPrompts.Subtask, String)] = []
        await withTaskCancellationHandler {
            for (i, t) in tasks.enumerated() {
                if let text = await t.value { findings.append((subtasks[i], text)) }
            }
        } onCancel: {
            for t in tasks { t.cancel() }
        }
        guard !Task.isCancelled else { return }
        guard !findings.isEmpty else { problem = "Every worker failed, so there was nothing to synthesize."; return }

        guard let draft = await execute("synth", AgentPrompts.synthesizer(goal: goal, findings: findings),
                                        budget: 3072, workers: workers) else {
            problem = "The synthesizer failed."
            return
        }
        let answer = await execute("critic", AgentPrompts.critic(goal: goal, draft: draft),
                                   budget: 3072, workers: workers) ?? draft
        guard !Task.isCancelled else { return }
        update("result") {
            $0.node.status = .done
            $0.node.startedAt = time
            $0.node.finishedAt = time
            $0.node.progress = 1
            $0.node.detail = "\(answer.split(whereSeparator: \.isWhitespace).count) words"
            $0.output = answer
            $0.log.append(stamp("answer ready"))
        }
        finalAnswer = answer
    }

    /// Runs one agent with a single failover to a model on another machine. Returns the
    /// answer text, or nil if both attempts failed or the run was cancelled.
    private func execute(_ id: String, _ messages: [ChatMessage], budget: Int,
                         workers: [FleetWorker]) async -> String? {
        guard var worker = agent(id)?.worker else { return nil }
        for attempt in 1...2 {
            if Task.isCancelled { return nil }
            update(id) {
                $0.attempt = attempt
                $0.worker = worker
                $0.node.subtitle = worker.label
                $0.node.status = attempt == 1 ? .running : .retrying
                $0.node.startedAt = $0.node.startedAt ?? time
                $0.node.progress = 0
                $0.tokens = 0
                $0.output = ""
                $0.log.append(stamp(attempt == 1 ? "started on \(worker.label)" : "retrying on \(worker.label)"))
            }
            let began = Date()
            do {
                var content = "", sawUsage = false, chunks = 0, lastPaint = Date.distantPast
                for try await event in client.stream(base: worker.base, model: worker.model, messages: messages,
                                                     maxTokens: budget) {
                    switch event {
                    case .content(let s): content += s; chunks += 1
                    case .reasoning: chunks += 1
                    case .usage(_, let completion): sawUsage = true; chunks = completion
                    }
                    // Repaint at most ~15×/s; token streams can be much faster.
                    if Date().timeIntervalSince(lastPaint) > 0.066 || sawUsage {
                        lastPaint = Date()
                        let n = chunks, text = content
                        update(id) {
                            $0.tokens = n
                            $0.output = text
                            $0.node.progress = min(0.95, Double(n) / Double(budget))
                            $0.node.detail = "\(n) tok"
                        }
                    }
                }
                let answer = ChatStreamParser.stripThinking(content)
                if answer.isEmpty { throw FleetError("Model returned no answer text (token budget used up by reasoning?)") }
                let secs = max(0.1, Date().timeIntervalSince(began))
                let n = chunks
                update(id) {
                    $0.tokens = n
                    $0.output = answer
                    $0.node.status = .done
                    $0.node.progress = 1
                    $0.node.finishedAt = time
                    $0.node.detail = String(format: "%.1fk tok · %.0f t/s", Double(n) / 1000, Double(n) / secs)
                    $0.log.append(stamp(String(format: "finished, %d tokens in %.1fs", n, secs)))
                }
                return answer
            } catch {
                if Task.isCancelled { return nil }
                let message = (error as? FleetError)?.message ?? error.localizedDescription
                update(id) {
                    $0.node.status = .failed
                    $0.node.detail = "failed"
                    $0.failedAt = time
                    $0.log.append(stamp("failed: \(message)"))
                }
                guard attempt == 1, let next = failover(from: worker, in: workers) else { break }
                try? await Task.sleep(for: .seconds(1.2))
                worker = next
            }
        }
        update(id) { $0.node.finishedAt = time }
        return nil
    }

    /// Prefers a model on a different machine, then a different model on the same one.
    private func failover(from w: FleetWorker, in workers: [FleetWorker]) -> FleetWorker? {
        workers.first { $0.host != w.host } ?? workers.first { $0 != w }
    }

    // MARK: State helpers

    private func addAgent(id: String, title: String, wave: Int, deps: [String], task: String, worker: FleetWorker?) {
        var a = Agent(node: FlowNode(id: id, title: title, subtitle: worker?.label ?? "fleet", wave: wave, deps: deps,
                                     status: .queued, progress: 0, detail: "", appearedAt: time),
                      task: task, duration: 0, tokenRate: 0)
        a.worker = worker
        agents.append(a)
    }

    private func update(_ id: String, _ body: (inout Agent) -> Void) {
        guard let i = agents.firstIndex(where: { $0.node.id == id }) else { return }
        body(&agents[i])
    }

    private func log(_ id: String, _ text: String) { update(id) { $0.log.append(stamp(text)) } }
    private func stamp(_ s: String) -> String { String(format: "%5.1fs  ", time) + s }
}
