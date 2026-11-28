import Foundation
import Testing
@testable import FleetCore

@Suite("Wire formats & helpers")
struct ParsingTests {
    @Test func linuxMetricsWithUnifiedMemoryGPU() {
        let out = """
        os=Linux 6.11.0-1016-nvidia
        load=0.52 0.29 0.20
        cpus=20
        memTotalKB=127598636
        memAvailKB=28135472
        uptime=86400
        gpu=NVIDIA GB10, 7, [N/A], [N/A], 35
        """
        let m = MetricsProbe.parse(out)
        #expect(m.load1 == 0.52)
        #expect(m.cpuCount == 20)
        #expect(m.memTotalBytes == Int64(127598636) * 1024)
        #expect(m.gpus == [GPUMetrics(name: "NVIDIA GB10", utilizationPercent: 7, memoryUsedMB: nil, memoryTotalMB: nil, temperatureC: 35)])
        #expect(abs((m.memoryUsedFraction ?? 0) - 0.7795) < 0.001)
    }

    @Test func macMetrics() {
        let out = "os=macOS 27.0\nchip=Apple M5 Pro\nload=2.1 1.9 1.5\ncpus=14\nmemTotalBytes=25769803776\nmemAvailBytes=8589934592\nboot=1799990000"
        let m = MetricsProbe.parse(out, now: Date(timeIntervalSince1970: 1_800_000_000))
        #expect(m.chip == "Apple M5 Pro")
        #expect(m.uptimeSeconds == 10_000)
        #expect(m.loadFraction == 2.1 / 14)
    }

    @Test func windowsBareGPULine() {
        let m = MetricsProbe.parse("NVIDIA GeForce RTX 4080 Laptop GPU, 3, 1024, 12282, 51\r\n")
        #expect(m.gpus.first?.memoryTotalMB == 12282)
    }

    @Test func tailscaleStatusJSON() throws {
        let json = """
        {"Self":{"HostName":"MacBook-Pro","TailscaleIPs":["100.64.0.15"],"Online":true,"OS":"macOS"},
         "Peer":{"k1":{"HostName":"studio","DNSName":"studio.tail.ts.net.","TailscaleIPs":["100.64.0.14","fd7a::1"],
                       "Online":false,"LastSeen":"2026-11-23T10:00:00.123456Z","OS":"macOS"},
                 "k2":{"HostName":"dgx-spark","TailscaleIPs":["100.64.0.12"],"Online":true,"LastSeen":"0001-01-01T00:00:00Z"}}}
        """
        let peers = try TailscaleStatus.parse(Data(json.utf8))
        #expect(peers.count == 3)
        let studio = peers.first { $0.hostName == "studio" }!
        #expect(!studio.online)
        #expect(studio.lastSeen != nil)
        #expect(peers.first { $0.hostName == "dgx-spark" }!.lastSeen == nil)
        #expect(peers.first { $0.isSelf }!.online)
    }

    @Test func ollamaInventoryDecoding() throws {
        let tags = """
        {"models":[{"name":"qwen2.5:latest","size":4683087332,"modified_at":"2025-05-01T12:34:56.123456789-07:00",
          "details":{"family":"qwen2","parameter_size":"7.6B","quantization_level":"Q4_K_M"}},
          {"name":"nomic-embed-text:latest","size":274302450}]}
        """
        let ps = #"{"models":[{"name":"qwen2.5:latest","size_vram":5000000000,"context_length":4096}]}"#
        let s = try OllamaClient.decodeSnapshot(tags: Data(tags.utf8), ps: Data(ps.utf8), version: "0.12.0")
        #expect(s.models.count == 2)
        #expect(s.models[0].isLoaded && s.models[0].vramBytes == 5_000_000_000)
        #expect(s.models[0].parameterSize == "7.6B")
        #expect(s.models[0].modifiedAt != nil)
        #expect(!s.models[1].isLoaded)
    }

    @Test func lmStudioAndOpenAIDecoding() throws {
        let v0 = #"{"data":[{"id":"qwen3-8b","type":"llm","arch":"qwen3","quantization":"Q4_K_M","state":"loaded","max_context_length":32768},{"id":"text-embedding-nomic","type":"embeddings","state":"not-loaded"}]}"#
        let s = try LMStudioClient.decodeSnapshot(Data(v0.utf8))
        #expect(s.models.map(\.isLoaded) == [true, false])
        let oa = #"{"object":"list","data":[{"id":"Qwen3-8B-Q4_K_M.gguf","meta":{"n_params":8190735360,"size":5027783488}}]}"#
        let l = try OpenAIModelsClient(http: HTTPClient(timeout: 1), assumeLoaded: true).decodeSnapshot(Data(oa.utf8))
        #expect(l.models[0].parameterSize == "8.2B")
        #expect(l.models[0].isLoaded)
    }

    @Test func pullAggregation() throws {
        var agg = OllamaClient.PullAggregator()
        _ = try agg.consume(#"{"status":"pulling manifest"}"#)
        _ = try agg.consume(#"{"status":"pulling a","digest":"a","total":100,"completed":50}"#)
        let u = try agg.consume(#"{"status":"pulling b","digest":"b","total":300,"completed":0}"#)
        #expect(u?.progress == 0.125)
        #expect(try agg.consume(#"{"status":"success"}"#)?.progress == 1)
        #expect(try agg.consume("") == nil)
        #expect(throws: FleetError("pull model manifest: file does not exist")) {
            try agg.consume(#"{"error":"pull model manifest: file does not exist"}"#)
        }
    }

    @Test func isoDates() {
        #expect(ISODate.parse("2025-05-01T12:34:56.123456789-07:00") != nil)
        #expect(ISODate.parse("2025-05-01T12:34:56Z") != nil)
        #expect(ISODate.parse("garbage") == nil)
    }

    @Test func shellQuoting() {
        #expect(Shell.quote("qwen2.5:7b") == "qwen2.5:7b")
        #expect(Shell.quote("it's") == #"'it'\''s'"#)
        #expect(Shell.quote("$(x)") == "'$(x)'")
        #expect(Shell.quote("") == "''")
    }

    @Test func templateRendering() throws {
        let rt = RuntimeConfig(kind: .mlx)
        let r = try TemplateRenderer.render("rm -rf -- {hfCacheDir}/models--{hfCacheName}", model: "mlx-community/Qwen3-4B-4bit", runtime: rt)
        #expect(r.command == #"rm -rf -- "$HOME/.cache/huggingface/hub"/models--mlx-community--Qwen3-4B-4bit"#)
        #expect(throws: TemplateError.requiresRepo("qwen")) { try TemplateRenderer.render("hf download {repo}", model: "qwen", runtime: rt) }
        #expect(throws: TemplateError.unresolvedPlaceholder("oops")) { try TemplateRenderer.render("x {oops}", model: "a/b", runtime: rt) }
    }

    @Test func progressPercentExtraction() {
        #expect(ProgressThrottle.percent(in: "model.gguf:  45%|████▌     | 2.1G/4.6G") == 0.45)
        #expect(ProgressThrottle.percent(in: "done 99.5%") == 0.995)
        #expect(ProgressThrottle.percent(in: "no progress here") == nil)
    }

    @Test func sshArgumentsAreNonInteractive() {
        let a = SSHRunner(connectTimeout: 5).arguments(target: "dgx", command: "echo hi", posix: true)
        #expect(a.contains("BatchMode=yes"))
        #expect(a[a.firstIndex(of: "--")! + 1] == "dgx")
        #expect(a.last!.hasSuffix("echo hi"))
    }

    @Test func configRoundTripAndLenientDecoding() throws {
        let data = try JSONEncoder().encode(DefaultFleet.config)
        #expect(try JSONDecoder().decode(FleetConfig.self, from: data) == DefaultFleet.config)
        let minimal = #"{"hosts":[{"id":"box","tailscaleIP":"100.1.2.3","runtimes":[{"kind":"ollama"}]}]}"#
        let c = try JSONDecoder().decode(FleetConfig.self, from: Data(minimal.utf8))
        #expect(c.hosts[0].name == "box")
        #expect(c.hosts[0].runtimes[0].port == 11434)
        #expect(c.dryRunByDefault)
        #expect(c.validate().isEmpty)
        #expect(DefaultFleet.config.validate().isEmpty)
    }

    @Test func configValidationCatchesDuplicateAliases() {
        var c = DefaultFleet.config
        c.hosts[0].aliases.append("dgx")
        #expect(c.validate().contains { $0.contains("'dgx'") })
    }

    @Test func endpointPrefersAnsweringAddress() {
        let h = HostConfig(id: "x", name: "x", os: .linux, tailscaleIP: "100.1.1.1", lanIP: "192.168.1.5",
                           runtimes: [RuntimeConfig(kind: .ollama)])
        var hs = HostState(id: "x", runtimes: [.ollama])
        #expect(Endpoint.baseURL(host: h, runtime: h.runtimes[0], state: hs)?.absoluteString == "http://100.1.1.1:11434")
        hs.reachability = .online(latencyMS: 1, address: "192.168.1.5")
        #expect(Endpoint.baseURL(host: h, runtime: h.runtimes[0], state: hs)?.absoluteString == "http://192.168.1.5:11434")
        let tunneled = RuntimeConfig(kind: .ollama, baseURL: "http://127.0.0.1:11435")
        #expect(Endpoint.baseURL(host: h, runtime: tunneled, state: hs)?.absoluteString == "http://127.0.0.1:11435")
    }
}
