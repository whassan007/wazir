import Foundation

public enum Shell {
    /// POSIX single-quote escaping: `it's` → `'it'\''s'`.
    public static func quote(_ s: String) -> String {
        if !s.isEmpty, s.unicodeScalars.allSatisfy({ safe.contains($0) }) { return s }
        return "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    private static let safe = CharacterSet(charactersIn:
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/@+-=,")

    /// PATH prefix so non-interactive SSH sessions find user-installed tools (hf, lms, ollama).
    public static let posixPathPrefix =
        #"export PATH="$HOME/.local/bin:$HOME/.lmstudio/bin:$HOME/.cache/lm-studio/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; "#
}

/// A Hugging Face style model reference, optionally with a llama.cpp quant suffix:
/// `unsloth/Qwen3-8B-GGUF:Q4_K_M`.
public struct HFModelRef: Equatable, Sendable {
    public var repo: String
    public var quant: String?

    public init(_ raw: String) {
        if let colon = raw.lastIndex(of: ":"), raw.contains("/") {
            repo = String(raw[..<colon])
            let q = String(raw[raw.index(after: colon)...])
            quant = q.isEmpty ? nil : q
        } else {
            repo = raw
            quant = nil
        }
    }

    /// Filesystem-safe directory name, e.g. `unsloth__Qwen3-8B-GGUF`.
    public var slug: String { repo.replacingOccurrences(of: "/", with: "__") }
    /// HF cache directory name component, e.g. `mlx-community--Qwen3-4B-4bit`.
    public var hfCacheName: String { repo.replacingOccurrences(of: "/", with: "--") }
    public var isRepo: Bool { repo.contains("/") }
}

public enum TemplateError: Error, Equatable, Sendable, LocalizedError {
    case missingModelsDir
    case requiresRepo(String)
    case unresolvedPlaceholder(String)

    public var errorDescription: String? {
        switch self {
        case .missingModelsDir: "This runtime needs `modelsDir` in its host configuration."
        case .requiresRepo(let m): "'\(m)' must be a Hugging Face repo id like org/name."
        case .unresolvedPlaceholder(let p): "Command template has an unknown placeholder {\(p)}."
        }
    }
}

public enum TemplateRenderer {
    /// Renders a command template with shell-quoted substitutions. Every substituted value is
    /// quoted, so model names can never inject shell syntax.
    public static func render(_ template: String, model: String, runtime: RuntimeConfig, defaultQuant: String = "Q4_K_M")
        throws(TemplateError) -> (command: String, notes: [String])
    {
        let ref = HFModelRef(model)
        var notes: [String] = []
        let needsRepo = ["{repo}", "{repoSlug}", "{include}", "{hfCacheName}"].contains { template.contains($0) }
        if needsRepo && !ref.isRepo { throw .requiresRepo(model) }

        var values: [String: String] = [
            "model": Shell.quote(model),
            "repo": Shell.quote(ref.repo),
            "repoSlug": Shell.quote(ref.slug),
            "hfCacheName": Shell.quote(ref.hfCacheName),
            "hfCacheDir": "\"$HOME/.cache/huggingface/hub\"",
        ]
        if template.contains("{include}") {
            let q = ref.quant ?? defaultQuant
            if ref.quant == nil { notes.append("No quantization given; defaulting to \(defaultQuant) (use repo:QUANT).") }
            values["include"] = Shell.quote("*\(q)*.gguf")
        }
        if template.contains("{modelsDir}") {
            guard let dir = runtime.modelsDir, !dir.isEmpty else { throw .missingModelsDir }
            // Allow ~ expansion while quoting the rest.
            if dir.hasPrefix("~/") {
                values["modelsDir"] = "\"$HOME\"/" + Shell.quote(String(dir.dropFirst(2)))
            } else {
                values["modelsDir"] = Shell.quote(dir)
            }
        }

        var out = ""
        var rest = Substring(template)
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            guard let close = rest[open...].firstIndex(of: "}") else { out += rest[open...]; rest = ""; break }
            let key = String(rest[rest.index(after: open)..<close])
            guard let v = values[key] else { throw .unresolvedPlaceholder(key) }
            out += v
            rest = rest[rest.index(after: close)...]
        }
        out += rest
        return (out, notes)
    }
}
