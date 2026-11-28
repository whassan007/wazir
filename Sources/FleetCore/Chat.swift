import Foundation

// MARK: - OpenAI-compatible chat (Ollama, LM Studio, llama.cpp server, mlx_lm.server)

public struct ChatMessage: Codable, Sendable, Equatable {
    public var role: String
    public var content: String
    public init(role: String, content: String) {
        self.role = role
        self.content = content
    }
    public static func system(_ s: String) -> ChatMessage { ChatMessage(role: "system", content: s) }
    public static func user(_ s: String) -> ChatMessage { ChatMessage(role: "user", content: s) }
}

public enum ChatEvent: Sendable, Equatable {
    /// Visible answer text.
    case content(String)
    /// Reasoning text from thinking models (`reasoning_content` / `reasoning`), not part of the answer.
    case reasoning(String)
    /// Final token counts, when the server reports them.
    case usage(prompt: Int, completion: Int)
}

public enum ChatStreamParser {
    struct Chunk: Decodable {
        struct Choice: Decodable {
            struct Delta: Decodable {
                var content: String?
                var reasoning_content: String?
                var reasoning: String?
            }
            var delta: Delta?
        }
        struct Usage: Decodable { var prompt_tokens: Int?; var completion_tokens: Int? }
        struct Err: Decodable { var message: String? }
        var choices: [Choice]?
        var usage: Usage?
        var error: ErrorField?
    }

    /// `error` is a string on some servers and an object on others.
    enum ErrorField: Decodable {
        case text(String)
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self) { self = .text(s); return }
            let o = try c.decode(Chunk.Err.self)
            self = .text(o.message ?? "error")
        }
    }

    public enum Line: Equatable {
        case events([ChatEvent])
        case done
        case ignore
    }

    /// Parses one Server-Sent Events line of a streamed chat completion.
    public static func parse(_ raw: String) throws(FleetError) -> Line {
        let line = raw.trimmingCharacters(in: .whitespaces)
        guard line.hasPrefix("data:") else { return .ignore }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        if payload == "[DONE]" { return .done }
        guard let chunk = try? JSONDecoder().decode(Chunk.self, from: Data(payload.utf8)) else { return .ignore }
        if case .text(let e)? = chunk.error { throw FleetError(e) }
        var out: [ChatEvent] = []
        for c in chunk.choices ?? [] {
            if let r = c.delta?.reasoning_content ?? c.delta?.reasoning, !r.isEmpty { out.append(.reasoning(r)) }
            if let s = c.delta?.content, !s.isEmpty { out.append(.content(s)) }
        }
        if let u = chunk.usage, let comp = u.completion_tokens {
            out.append(.usage(prompt: u.prompt_tokens ?? 0, completion: comp))
        }
        return out.isEmpty ? .ignore : .events(out)
    }

    /// Removes `<think>…</think>` blocks that some models emit inline in the content.
    public static func stripThinking(_ s: String) -> String {
        var out = s
        while let open = out.range(of: "<think>") {
            if let close = out.range(of: "</think>", range: open.upperBound..<out.endIndex) {
                out.removeSubrange(open.lowerBound..<close.upperBound)
            } else {
                out.removeSubrange(open.lowerBound..<out.endIndex)
            }
        }
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public struct ChatClient: Sendable {
    public init() {}

    public static func requestBody(model: String, messages: [ChatMessage], maxTokens: Int,
                                   temperature: Double) throws -> Data {
        struct Body: Encodable {
            struct StreamOptions: Encodable { var include_usage = true }
            var model: String
            var messages: [ChatMessage]
            var stream = true
            var max_tokens: Int
            var temperature: Double
            var stream_options = StreamOptions()
        }
        return try JSONEncoder().encode(Body(model: model, messages: messages, max_tokens: maxTokens,
                                             temperature: temperature))
    }

    /// Streams a chat completion from `{base}/v1/chat/completions`. Cancelling the consuming
    /// task cancels the request.
    public func stream(base: URL, model: String, messages: [ChatMessage], maxTokens: Int = 1024,
                       temperature: Double = 0.4) -> AsyncThrowingStream<ChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: base.appending(path: "v1/chat/completions"))
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    req.httpBody = try Self.requestBody(model: model, messages: messages, maxTokens: maxTokens,
                                                        temperature: temperature)
                    // Model loads can take minutes before the first token.
                    req.timeoutInterval = 600
                    let (bytes, resp) = try await HTTPClient.longRunning.bytes(for: req)
                    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await b in bytes { body.append(b); if body.count > 2000 { break } }
                        try HTTPClient.check(resp, data: body)
                    }
                    var sawAny = false
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        switch try ChatStreamParser.parse(line) {
                        case .events(let evs):
                            sawAny = true
                            for e in evs { continuation.yield(e) }
                        case .done:
                            continuation.finish()
                            return
                        case .ignore:
                            continue
                        }
                    }
                    if !sawAny { throw FleetError("Empty response from \(model)") }
                    continuation.finish()
                } catch let e as FleetError {
                    continuation.finish(throwing: e)
                } catch is CancellationError {
                    continuation.finish(throwing: FleetError("Cancelled"))
                } catch {
                    continuation.finish(throwing: HTTPClient.describe(error, url: base))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - Multi-agent prompts

/// Prompts and parsing for the planner → workers → synthesizer → critic pipeline. Pure.
public enum AgentPrompts {
    public struct Subtask: Equatable, Sendable {
        public var title: String
        public var task: String
        public init(title: String, task: String) {
            self.title = title
            self.task = task
        }
    }

    public static func planner(goal: String, maxSubtasks: Int) -> [ChatMessage] {
        [.system("""
        You are the planner in a team of AI agents. Split the user's request into 2 to \(maxSubtasks) \
        independent subtasks that different agents can work on in parallel. Reply with JSON only, no prose:
        {"subtasks":[{"title":"2-4 word title","task":"one or two sentence instruction"}]}
        """),
         .user(goal)]
    }

    public static func worker(goal: String, subtask: Subtask) -> [ChatMessage] {
        [.system("You are a focused specialist on a team of AI agents. Do only your subtask. Be concrete and concise: at most about 200 words."),
         .user("Overall goal: \(goal)\n\nYour subtask (\(subtask.title)): \(subtask.task)")]
    }

    public static func synthesizer(goal: String, findings: [(Subtask, String)]) -> [ChatMessage] {
        let body = findings.map { "## \($0.0.title)\n\($0.1)" }.joined(separator: "\n\n")
        return [.system("You are the synthesizer. Merge the team's findings into one coherent, well-structured answer to the goal. Remove repetition; keep specifics."),
                .user("Goal: \(goal)\n\nFindings:\n\n\(body)")]
    }

    public static func critic(goal: String, draft: String) -> [ChatMessage] {
        [.system("You are the critic. Check the draft for gaps, errors and unsupported claims, fix them, and reply with only the improved final answer."),
         .user("Goal: \(goal)\n\nDraft:\n\n\(draft)")]
    }

    /// Extracts subtasks from the planner's reply: JSON (possibly fenced or surrounded by
    /// prose), else a numbered or bulleted list. Returns at most `limit`.
    public static func parseSubtasks(_ reply: String, limit: Int) -> [Subtask] {
        let text = ChatStreamParser.stripThinking(reply)
        struct Plan: Decodable { var subtasks: [Item] }
        struct Item: Decodable { var title: String?; var task: String? }
        func clean(_ items: [Item]) -> [Subtask] {
            items.compactMap { i in
                let task = (i.task ?? i.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                guard !task.isEmpty else { return nil }
                let title = (i.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                return Subtask(title: title.isEmpty ? shortTitle(task) : shortTitle(title), task: task)
            }
        }
        if let open = text.firstIndex(of: "{"), let close = text.lastIndex(of: "}"), open < close,
           let plan = try? JSONDecoder().decode(Plan.self, from: Data(text[open...close].utf8)) {
            let s = clean(plan.subtasks)
            if !s.isEmpty { return Array(s.prefix(limit)) }
        }
        if let open = text.firstIndex(of: "["), let close = text.lastIndex(of: "]"), open < close,
           let items = try? JSONDecoder().decode([Item].self, from: Data(text[open...close].utf8)) {
            let s = clean(items)
            if !s.isEmpty { return Array(s.prefix(limit)) }
        }
        // List fallback: "1. ...", "2) ...", "- ...", "* ..."
        var out: [Subtask] = []
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if let m = line.firstMatch(of: /^(\d+[.)]|[-*•])\s+/) { line.removeSubrange(m.range) } else { continue }
            line = line.replacingOccurrences(of: "**", with: "")
            guard !line.isEmpty else { continue }
            let parts = line.split(separator: ":", maxSplits: 1)
            if parts.count == 2, parts[0].count <= 40 {
                out.append(Subtask(title: shortTitle(String(parts[0])),
                                   task: parts[1].trimmingCharacters(in: .whitespaces)))
            } else {
                out.append(Subtask(title: shortTitle(line), task: line))
            }
        }
        return Array(out.prefix(limit))
    }

    static func shortTitle(_ s: String) -> String {
        let words = s.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters)).split(separator: " ")
        let t = words.prefix(4).joined(separator: " ")
        return words.count > 4 ? t + "…" : t
    }
}
