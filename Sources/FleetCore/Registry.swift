import Foundation

/// Ollama registry lookups used during plan preview: validates that a model exists and
/// estimates its download size from manifest layer sizes. Only the model name is sent.
public struct OllamaRegistry: Sendable {
    public enum Lookup: Equatable, Sendable {
        case found(bytes: Int64)
        case notFound
        case unavailable(String)
    }

    let http: HTTPClient
    public init(timeout: TimeInterval = 6) { http = HTTPClient(timeout: timeout) }

    /// `qwen2.5` → library/qwen2.5 + latest; `user/model:tag` → user/model + tag.
    public static func manifestURL(for model: String) -> URL? {
        var name = model.lowercased()
        var tag = "latest"
        if let colon = name.lastIndex(of: ":") {
            tag = String(name[name.index(after: colon)...])
            name = String(name[..<colon])
        }
        if !name.contains("/") { name = "library/" + name }
        guard CommandParser.isValidModelName(name), !tag.isEmpty else { return nil }
        return URL(string: "https://registry.ollama.ai/v2/\(name)/manifests/\(tag)")
    }

    struct Manifest: Decodable {
        struct Layer: Decodable { var size: Int64 }
        var layers: [Layer]
    }

    public func lookup(_ model: String) async -> Lookup {
        guard let url = Self.manifestURL(for: model) else { return .unavailable("Unrecognized model name") }
        var req = URLRequest(url: url)
        req.setValue("application/vnd.docker.distribution.manifest.v2+json", forHTTPHeaderField: "Accept")
        do {
            let (data, resp) = try await http.session.data(for: req)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 404 { return .notFound }
            guard (200..<300).contains(code) else { return .unavailable("Registry HTTP \(code)") }
            let m = try JSONDecoder().decode(Manifest.self, from: data)
            return .found(bytes: m.layers.reduce(0) { $0 + $1.size })
        } catch {
            return .unavailable(HTTPClient.describe(error, url: url).message)
        }
    }
}

public enum ModelCatalog {
    /// Well-known Ollama library names used for "did you mean" suggestions.
    public static let popular: [String] = [
        "llama3.3", "llama3.2", "llama3.1", "llama4", "qwen3", "qwen3-coder", "qwen2.5", "qwen2.5-coder", "qwen2.5vl",
        "qwq", "gemma3", "gemma3n", "gemma2", "mistral", "mistral-small", "mistral-nemo", "mixtral", "devstral",
        "magistral", "phi4", "phi4-mini", "phi3", "deepseek-r1", "deepseek-v3", "gpt-oss", "granite3.3", "smollm2",
        "command-r", "codellama", "starcoder2", "llava", "nomic-embed-text", "mxbai-embed-large", "bge-m3",
    ]

    /// Suggests a likely intended model name (tag-insensitive) from fleet inventory + catalog.
    public static func suggest(_ model: String, inventory: [String]) -> String? {
        let base = model.split(separator: ":").first.map(String.init) ?? model
        let tag = model.contains(":") ? String(model[model.index(after: model.lastIndex(of: ":")!)...]) : nil
        let bases = Array(Set(inventory.map { $0.split(separator: ":").first.map(String.init) ?? $0 } + popular)).sorted()
        guard let s = Fuzzy.suggest(base, among: bases, maxDistance: 2) else { return nil }
        return tag.map { "\(s):\($0)" } ?? s
    }
}
