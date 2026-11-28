import Foundation

// MARK: - HTTP plumbing

public struct HTTPClient: Sendable {
    public let session: URLSession
    public let timeout: TimeInterval

    public init(timeout: TimeInterval) {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = timeout
        cfg.timeoutIntervalForResource = max(timeout, 30)
        cfg.waitsForConnectivity = false
        cfg.httpMaximumConnectionsPerHost = 4
        self.session = URLSession(configuration: cfg)
        self.timeout = timeout
    }

    /// Long-running requests (pulls, loads): generous idle timeout, no resource cap.
    public static let longRunning: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 600
        cfg.timeoutIntervalForResource = 60 * 60 * 24
        return URLSession(configuration: cfg)
    }()

    public func get<T: Decodable>(_ url: URL, as: T.Type) async throws(FleetError) -> T {
        var req = URLRequest(url: url)
        req.timeoutInterval = timeout
        let data = try await send(req, session: session)
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            throw FleetError("Unexpected response from \(url.path): \(ConfigStore.describe(error))")
        }
    }

    public func send(_ req: URLRequest, session: URLSession? = nil) async throws(FleetError) -> Data {
        let data: Data, resp: URLResponse
        do {
            (data, resp) = try await (session ?? self.session).data(for: req)
        } catch {
            throw HTTPClient.describe(error, url: req.url)
        }
        try HTTPClient.check(resp, data: data)
        return data
    }

    static func check(_ resp: URLResponse, data: Data) throws(FleetError) {
        guard let http = resp as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            let body = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error
                ?? String(data: data.prefix(300), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw FleetError("HTTP \(http.statusCode)" + (body.map { $0.isEmpty ? "" : ": \($0)" } ?? ""))
        }
    }

    static func describe(_ error: Error, url: URL?) -> FleetError {
        let where_ = url.map { "\($0.host ?? "?"):\($0.port.map(String.init) ?? "")" } ?? ""
        if let e = error as? URLError {
            switch e.code {
            case .timedOut: return FleetError("Timed out contacting \(where_)")
            case .cannotConnectToHost: return FleetError("Connection refused by \(where_) (runtime not running or bound to localhost?)")
            case .notConnectedToInternet, .networkConnectionLost: return FleetError("Network unavailable for \(where_)")
            case .cancelled: return FleetError("Cancelled")
            case .appTransportSecurityRequiresSecureConnection: return FleetError("Blocked by App Transport Security (run the bundled Fleet.app)")
            default: return FleetError("\(where_): \(e.localizedDescription)")
            }
        }
        return FleetError(error.localizedDescription)
    }

    struct ErrorBody: Decodable { var error: String? }
}

// MARK: - Inventory

public protocol InventoryClient: Sendable {
    func inventory(base: URL) async throws(FleetError) -> RuntimeSnapshot
}

public enum RuntimeClients {
    public static func inventory(kind: RuntimeKind, base: URL, http: HTTPClient) async throws(FleetError) -> RuntimeSnapshot {
        switch kind {
        case .ollama: try await OllamaClient(http: http).inventory(base: base)
        case .lmstudio: try await LMStudioClient(http: http).inventory(base: base)
        case .llamacpp: try await OpenAIModelsClient(http: http, assumeLoaded: true).inventory(base: base)
        case .mlx: try await OpenAIModelsClient(http: http, assumeLoaded: false).inventory(base: base)
        }
    }
}

// MARK: Ollama

public struct OllamaClient: InventoryClient {
    public let http: HTTPClient
    public init(http: HTTPClient) { self.http = http }

    struct Tags: Decodable {
        struct Model: Decodable {
            struct Details: Decodable {
                var family: String?
                var parameter_size: String?
                var quantization_level: String?
            }
            var name: String
            var size: Int64?
            var modified_at: String?
            var details: Details?
        }
        var models: [Model]?
    }
    struct PS: Decodable {
        struct Model: Decodable { var name: String; var size_vram: Int64?; var context_length: Int? }
        var models: [Model]?
    }
    struct Version: Decodable { var version: String? }

    public func inventory(base: URL) async throws(FleetError) -> RuntimeSnapshot {
        let tags = try await http.get(base.appending(path: "api/tags"), as: Tags.self)
        // ps/version are best-effort enrichments.
        let ps = try? await http.get(base.appending(path: "api/ps"), as: PS.self)
        let version = try? await http.get(base.appending(path: "api/version"), as: Version.self)
        return Self.snapshot(tags: tags, ps: ps, version: version?.version)
    }

    static func snapshot(tags: Tags, ps: PS?, version: String?) -> RuntimeSnapshot {
        let loaded = Dictionary((ps?.models ?? []).map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        let models = (tags.models ?? []).map { m in
            ModelInfo(name: m.name, sizeBytes: m.size, parameterSize: m.details?.parameter_size,
                      quantization: m.details?.quantization_level, family: m.details?.family,
                      isLoaded: loaded[m.name] != nil, vramBytes: loaded[m.name]?.size_vram,
                      modifiedAt: m.modified_at.flatMap(ISODate.parse), contextLength: loaded[m.name]?.context_length)
        }
        return RuntimeSnapshot(version: version, models: models)
    }

    public static func decodeSnapshot(tags: Data, ps: Data?, version: String? = nil) throws -> RuntimeSnapshot {
        let t = try JSONDecoder().decode(Tags.self, from: tags)
        let p = try ps.map { try JSONDecoder().decode(PS.self, from: $0) }
        return snapshot(tags: t, ps: p, version: version)
    }

    // MARK: Mutations

    public struct PullUpdate: Sendable, Equatable {
        public var status: String
        public var progress: Double?
        public var completedBytes: Int64
        public var totalBytes: Int64
    }

    struct PullLine: Decodable {
        var status: String?
        var digest: String?
        var total: Int64?
        var completed: Int64?
        var error: String?
    }

    /// Aggregates per-layer progress lines of a streaming pull.
    public struct PullAggregator: Sendable {
        var layers: [String: (total: Int64, done: Int64)] = [:]
        var lastStatus = ""
        public init() {}

        /// Returns an update, or throws if the line reports an error.
        public mutating func consume(_ line: String) throws(FleetError) -> PullUpdate? {
            guard let data = line.data(using: .utf8), !line.trimmingCharacters(in: .whitespaces).isEmpty,
                  let l = try? JSONDecoder().decode(PullLine.self, from: data) else { return nil }
            if let e = l.error { throw FleetError(e) }
            if let d = l.digest, let t = l.total, t > 0 {
                layers[d] = (t, max(layers[d]?.done ?? 0, l.completed ?? 0))
            }
            let total = layers.values.reduce(Int64(0)) { $0 + $1.total }
            let done = layers.values.reduce(Int64(0)) { $0 + $1.done }
            let status = l.status ?? lastStatus
            lastStatus = status
            let progress: Double? = status == "success" ? 1 : (total > 0 ? Double(done) / Double(total) : nil)
            return PullUpdate(status: status, progress: progress, completedBytes: done, totalBytes: total)
        }
    }

    public func pull(base: URL, model: String) -> AsyncThrowingStream<PullUpdate, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = URLRequest(url: base.appending(path: "api/pull"))
                    req.httpMethod = "POST"
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.httpBody = try JSONSerialization.data(withJSONObject: ["model": model, "stream": true])
                    let (bytes, resp) = try await HTTPClient.longRunning.bytes(for: req)
                    if let http = resp as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var body = Data()
                        for try await b in bytes { body.append(b); if body.count > 2000 { break } }
                        try HTTPClient.check(resp, data: body)
                    }
                    var agg = PullAggregator()
                    var sawSuccess = false
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        if let u = try agg.consume(line) {
                            if u.status == "success" { sawSuccess = true }
                            continuation.yield(u)
                        }
                    }
                    if !sawSuccess { throw FleetError("Pull stream ended before success.") }
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

    public func delete(base: URL, model: String) async throws(FleetError) {
        var req = URLRequest(url: base.appending(path: "api/delete"))
        req.httpMethod = "DELETE"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(#"{"model":\#(Self.jsonString(model))}"#.utf8)
        _ = try await http.send(req)
    }

    /// keepAlive 0 unloads; nil loads with the server default keep-alive.
    public func generate(base: URL, model: String, keepAlive: Int?) async throws(FleetError) {
        var req = URLRequest(url: base.appending(path: "api/generate"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body = #"{"model":\#(Self.jsonString(model)),"stream":false"#
        if let keepAlive { body += #","keep_alive":\#(keepAlive)"# }
        req.httpBody = Data((body + "}").utf8)
        req.timeoutInterval = 600
        _ = try await http.send(req, session: HTTPClient.longRunning)
    }

    static func jsonString(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed])) ?? Data("[\"\"]".utf8)
        let arr = String(decoding: data, as: UTF8.self)
        return String(arr.dropFirst().dropLast())
    }
}

// MARK: LM Studio

public struct LMStudioClient: InventoryClient {
    public let http: HTTPClient
    public init(http: HTTPClient) { self.http = http }

    struct V0: Decodable {
        struct M: Decodable {
            var id: String
            var type: String?
            var arch: String?
            var quantization: String?
            var state: String?
            var max_context_length: Int?
        }
        var data: [M]
    }

    public func inventory(base: URL) async throws(FleetError) -> RuntimeSnapshot {
        do {
            let v0 = try await http.get(base.appending(path: "api/v0/models"), as: V0.self)
            return Self.snapshot(v0)
        } catch {
            // Older LM Studio builds: OpenAI-compatible listing only.
            return try await OpenAIModelsClient(http: http, assumeLoaded: false).inventory(base: base)
        }
    }

    static func snapshot(_ v0: V0) -> RuntimeSnapshot {
        RuntimeSnapshot(models: v0.data.map {
            ModelInfo(name: $0.id, quantization: $0.quantization, family: $0.arch, isLoaded: $0.state == "loaded",
                      contextLength: $0.max_context_length)
        })
    }

    public static func decodeSnapshot(_ data: Data) throws -> RuntimeSnapshot {
        snapshot(try JSONDecoder().decode(V0.self, from: data))
    }
}

// MARK: OpenAI-compatible (llama.cpp server, mlx_lm.server)

public struct OpenAIModelsClient: InventoryClient {
    public let http: HTTPClient
    public let assumeLoaded: Bool
    public init(http: HTTPClient, assumeLoaded: Bool) {
        self.http = http
        self.assumeLoaded = assumeLoaded
    }

    struct List: Decodable {
        struct M: Decodable {
            struct Meta: Decodable { var size: Int64?; var n_params: Int64?; var n_ctx_train: Int? }
            struct Status: Decodable { var value: String? }
            var id: String
            var meta: Meta?
            var status: Status?
        }
        var data: [M]
    }

    public func inventory(base: URL) async throws(FleetError) -> RuntimeSnapshot {
        let list = try await http.get(base.appending(path: "v1/models"), as: List.self)
        return snapshot(list)
    }

    func snapshot(_ list: List) -> RuntimeSnapshot {
        RuntimeSnapshot(models: list.data.map { m in
            let loaded = m.status?.value.map { $0 == "loaded" } ?? assumeLoaded
            let params = m.meta?.n_params.map { String(format: "%.1fB", Double($0) / 1e9) }
            return ModelInfo(name: m.id, sizeBytes: m.meta?.size, parameterSize: params, isLoaded: loaded,
                             contextLength: m.meta?.n_ctx_train)
        })
    }

    public func decodeSnapshot(_ data: Data) throws -> RuntimeSnapshot {
        snapshot(try JSONDecoder().decode(List.self, from: data))
    }
}

// MARK: - Dates

public enum ISODate {
    /// Parses RFC3339 timestamps with any number of fractional digits (Ollama emits nanoseconds).
    public static func parse(_ s: String) -> Date? {
        var str = s
        if let dot = str.firstIndex(of: ".") {
            var end = str.index(after: dot)
            while end < str.endIndex, str[end].isNumber { end = str.index(after: end) }
            let frac = str[str.index(after: dot)..<end].prefix(3)
            str = String(str[..<dot]) + "." + frac.padding(toLength: 3, withPad: "0", startingAt: 0) + String(str[end...])
        }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: str) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
