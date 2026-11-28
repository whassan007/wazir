import Foundation
import Testing
@testable import FleetCore

@Suite("Chat & agent prompts")
struct ChatTests {
    @Test func parsesContentReasoningUsageAndDone() throws {
        #expect(try ChatStreamParser.parse(#"data: {"choices":[{"delta":{"content":"Hi"}}]}"#)
                == .events([.content("Hi")]))
        #expect(try ChatStreamParser.parse(#"data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}"#)
                == .events([.reasoning("hmm")]))
        #expect(try ChatStreamParser.parse(#"data: {"choices":[{"delta":{"reasoning":"ok","content":""}}]}"#)
                == .events([.reasoning("ok")]))
        #expect(try ChatStreamParser.parse(#"data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}"#)
                == .events([.usage(prompt: 12, completion: 34)]))
        #expect(try ChatStreamParser.parse("data: [DONE]") == .done)
        #expect(try ChatStreamParser.parse(": keep-alive") == .ignore)
        #expect(try ChatStreamParser.parse("") == .ignore)
    }

    @Test func streamErrorsThrow() {
        #expect(throws: FleetError.self) { try ChatStreamParser.parse(#"data: {"error":"model not found"}"#) }
        #expect(throws: FleetError.self) { try ChatStreamParser.parse(#"data: {"error":{"message":"oom"}}"#) }
    }

    @Test func stripsThinking() {
        #expect(ChatStreamParser.stripThinking("<think>plan it</think>\n\nAnswer") == "Answer")
        #expect(ChatStreamParser.stripThinking("Answer<think>unterminated") == "Answer")
    }

    @Test func requestBodyIsStreamingOpenAIShape() throws {
        let data = try ChatClient.requestBody(model: "qwen3:8b", messages: [.user("hi")], maxTokens: 50, temperature: 0.2)
        let obj = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(obj["model"] as? String == "qwen3:8b")
        #expect(obj["stream"] as? Bool == true)
        #expect(obj["max_tokens"] as? Int == 50)
        #expect((obj["messages"] as? [[String: String]])?.first?["content"] == "hi")
    }

    @Test func parsesFencedJSONPlan() {
        let reply = """
        <think>let me think</think>
        Sure! Here is the plan:
        ```json
        {"subtasks":[{"title":"Market sizing","task":"Estimate the market."},
                     {"title":"Regulation","task":"Summarize EU rules."},
                     {"task":"Scan competitors and their pricing strategy."}]}
        ```
        """
        let s = AgentPrompts.parseSubtasks(reply, limit: 6)
        #expect(s.count == 3)
        #expect(s[0] == .init(title: "Market sizing", task: "Estimate the market."))
        #expect(s[2].title == "Scan competitors and their…")
    }

    @Test func parsesBareArrayAndLimits() {
        let reply = #"[{"title":"A","task":"a"},{"title":"B","task":"b"},{"title":"C","task":"c"}]"#
        #expect(AgentPrompts.parseSubtasks(reply, limit: 2).map(\.title) == ["A", "B"])
    }

    @Test func fallsBackToList() {
        let reply = """
        Plan:
        1. **Market sizing**: estimate total demand
        2) Competitor scan
        - Regulation: EU AFIR rules
        """
        let s = AgentPrompts.parseSubtasks(reply, limit: 6)
        #expect(s.map(\.title) == ["Market sizing", "Competitor scan", "Regulation"])
        #expect(s[0].task == "estimate total demand")
    }

    @Test func unparseableReplyGivesNoSubtasks() {
        #expect(AgentPrompts.parseSubtasks("I can't help with that.", limit: 5).isEmpty)
    }
}
