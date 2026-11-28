import Testing
@testable import FleetCore

@Suite("Command parsing")
struct CommandParserTests {
    let parser = CommandParser(config: DefaultFleet.config)

    func model(_ s: String) throws -> ModelCommand {
        guard case .model(let m) = try parser.parse(s) else {
            Issue.record("expected model command for \(s)")
            throw FleetError("not a model command")
        }
        return m
    }

    @Test func canonicalExample() throws {
        let c = try model("add model qwen2.2 on machine jetson")
        #expect(c == ModelCommand(verb: .add, models: ["qwen2.2"], target: .hosts(["jetson"])))
    }

    @Test(arguments: [
        ("pull llama3.2:3b to dgx", ModelVerb.add),
        ("download llama3.2:3b onto dgx", .add),
        ("install llama3.2:3b on dgx", .add),
        ("delete llama3.2:3b from dgx", .remove),
        ("rm llama3.2:3b from dgx", .remove),
        ("uninstall llama3.2:3b from dgx", .remove),
        ("update llama3.2:3b on dgx", .update),
        ("upgrade llama3.2:3b on dgx", .update),
        ("refresh llama3.2:3b on dgx", .update),
        ("reload llama3.2:3b on dgx", .reload),
        ("restart llama3.2:3b on dgx", .reload),
    ])
    func verbSynonyms(input: String, verb: ModelVerb) throws {
        let c = try model(input)
        #expect(c.verb == verb)
        #expect(c.models == ["llama3.2:3b"])
        #expect(c.target == .hosts(["dgx"]))
    }

    @Test func conversationalPrefixAndRuntime() throws {
        let c = try model("hey can you please remove gemma3 from studio using lm studio")
        #expect(c.verb == .remove)
        #expect(c.models == ["gemma3"])
        #expect(c.target == .hosts(["studio"]))
        #expect(c.runtime == .lmstudio)
    }

    @Test func structuredSyntax() throws {
        let c = try model("add model=qwen2.5 host=jetson runtime=ollama --live")
        #expect(c == ModelCommand(verb: .add, models: ["qwen2.5"], target: .hosts(["jetson"]), runtime: .ollama, mode: .live))
    }

    @Test func atHostAndFlags() throws {
        let c = try model("reload qwen3 @gb10 via ollama --dry-run")
        #expect(c.target == .hosts(["gb10"]))
        #expect(c.runtime == .ollama)
        #expect(c.mode == .dryRun)
    }

    @Test func multipleModelsAndHosts() throws {
        let c = try model("update qwen2.5, llama3.2 on jetson and dgx")
        #expect(c.models == ["qwen2.5", "llama3.2"])
        #expect(c.target == .hosts(["jetson", "dgx"]))
    }

    @Test func allHosts() throws {
        let c = try model("pull nomic-embed-text on all machines")
        #expect(c.target == .all)
    }

    @Test func bareKnownHostAfterModel() throws {
        let c = try model("add qwen2.5 jetson")
        #expect(c.models == ["qwen2.5"])
        #expect(c.target == .hosts(["jetson"]))
    }

    @Test func aliasesAreKeptRawForPlanner() throws {
        let c = try model("add qwen2.5 on spark")
        #expect(c.target == .hosts(["spark"]))
    }

    @Test func huggingFaceRepoKeepsCase() throws {
        let c = try model("add unsloth/Qwen3-8B-GGUF:Q4_K_M on macbook with llama.cpp")
        #expect(c.models == ["unsloth/Qwen3-8B-GGUF:Q4_K_M"])
        #expect(c.runtime == .llamacpp)
    }

    @Test func inPrepositionDisambiguates() throws {
        let c = try model("add qwen2.5 in lmstudio on dgx")
        #expect(c.runtime == .lmstudio)
        #expect(c.target == .hosts(["dgx"]))
        let d = try model("add qwen2.5 in dgx")
        #expect(d.target == .hosts(["dgx"]))
    }

    @Test func quotedAndTrailingPunctuation() throws {
        let c = try model(#"add "qwen2.5:7b" on jetson."#)
        #expect(c.models == ["qwen2.5:7b"])
        #expect(c.target == .hosts(["jetson"]))
    }

    @Test func refreshAndList() throws {
        #expect(try parser.parse("refresh") == .refresh(.all))
        #expect(try parser.parse("refresh all") == .refresh(.all))
        #expect(try parser.parse("refresh dgx") == .refresh(.hosts(["dgx"])))
        #expect(try parser.parse("rescan on studio") == .refresh(.hosts(["studio"])))
        #expect(try parser.parse("list studio") == .list(.hosts(["studio"])))
        #expect(try parser.parse("status") == .list(.all))
        #expect(try parser.parse("help") == .help)
    }

    @Test func errors() {
        #expect(throws: ParseError.empty) { try parser.parse("   ") }
        #expect(throws: ParseError.unknownVerb("frobnicate")) { try parser.parse("frobnicate qwen on jetson") }
        #expect(throws: ParseError.missingModel(.add)) { try parser.parse("add model on jetson") }
        #expect(throws: ParseError.missingHost(.remove)) { try parser.parse("remove qwen2.5") }
        #expect(throws: ParseError.unknownRuntime("tensorrt")) { try parser.parse("add qwen2.5 on jetson via tensorrt") }
        #expect(throws: ParseError.conflictingModes) { try parser.parse("add qwen2.5 on jetson --live --dry-run") }
        #expect(throws: ParseError.conflictingRuntimes(.ollama, .mlx)) { try parser.parse("add qwen2.5 on jetson via ollama runtime=mlx") }
        #expect(throws: ParseError.missingValue("--runtime")) { try parser.parse("add qwen2.5 on jetson --runtime") }
        #expect(throws: ParseError.self) { try parser.parse("refresh qwen2.5") }
    }

    @Test(arguments: ["qwen;rm -rf /", "$(reboot)", "a`b`", "../etc/passwd", "-rf", "model name", "x//y", "qwen|nc"])
    func rejectsUnsafeModelNames(name: String) {
        #expect(!CommandParser.isValidModelName(name))
    }

    @Test(arguments: ["qwen2.5", "llama3.2:3b-instruct-q4_K_M", "hf.co/bartowski/Llama-3.2-1B-GGUF:Q8_0",
                      "mlx-community/Qwen3-4B-4bit", "user/model@sha256", "gpt-oss:20b"])
    func acceptsRealModelNames(name: String) {
        #expect(CommandParser.isValidModelName(name))
    }

    @Test func injectionAttemptIsRejectedByParser() {
        #expect(throws: ParseError.self) { try parser.parse("add 'qwen; rm -rf ~' on jetson") }
    }
}
