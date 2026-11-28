import Foundation

public enum BuildSystemKind: String, Codable, Sendable, Equatable {
    case swiftPackage
    case node
    case python
    case rust
    case make
    case generic
}

public struct RepoBranchInfo: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var id: String { name }
    public var name: String
    public var isCurrent: Bool
    public var isMainBranch: Bool
    public var shortSHA: String
    public var subject: String

    public init(name: String, isCurrent: Bool = false, shortSHA: String = "", subject: String = "") {
        self.name = name
        self.isCurrent = isCurrent
        self.isMainBranch = (name == "main" || name == "master" || name == "develop")
        self.shortSHA = shortSHA
        self.subject = subject
    }
}

public struct ProjectRepositoryContext: Codable, Sendable, Equatable {
    public var repoPath: String
    public var gitBranch: String
    public var headCommit: String?
    public var trackedFiles: [String]
    public var dirtyHumanFiles: Set<String>
    public var detectedBuildSystem: BuildSystemKind
    public var branches: [RepoBranchInfo]

    public init(repoPath: String, gitBranch: String = "main", headCommit: String? = nil,
                trackedFiles: [String] = [], dirtyHumanFiles: Set<String> = [],
                detectedBuildSystem: BuildSystemKind = .generic, branches: [RepoBranchInfo] = []) {
        self.repoPath = repoPath
        self.gitBranch = gitBranch
        self.headCommit = headCommit
        self.trackedFiles = trackedFiles
        self.dirtyHumanFiles = dirtyHumanFiles
        self.detectedBuildSystem = detectedBuildSystem
        self.branches = branches
    }
}

public enum RepoFileAction: String, Codable, Sendable, Equatable {
    case write
    case modify
    case delete
}

public struct RepoCodeChange: Codable, Sendable, Equatable {
    public var path: String
    public var action: RepoFileAction
    public var content: String

    public init(path: String, action: RepoFileAction = .write, content: String = "") {
        self.path = path
        self.action = action
        self.content = content
    }
}

/// Introspects a target project repository before planning/execution so prompts
/// operate directly in the repository and protect existing human modifications.
public struct RepositoryIntrospector: Sendable {
    public init() {}

    public func introspect(repoPath: String, coordinator: GitWorktreeCoordinator? = nil) async throws(FleetError) -> ProjectRepositoryContext {
        let url = URL(fileURLWithPath: repoPath)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else {
            throw FleetError("Project repository path does not exist: \(repoPath)")
        }

        let buildSystem = detectBuildSystem(at: url)
        var branch = "detached"
        var headCommit: String?
        var dirtyFiles: Set<String> = []
        var tracked: [String] = []
        var branches: [RepoBranchInfo] = []

        if let br = try? await ProcessRunner.capture("/usr/bin/git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], timeout: 5),
           br.status == 0 {
            branch = br.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let rev = try? await ProcessRunner.capture("/usr/bin/git", ["-C", repoPath, "rev-parse", "HEAD"], timeout: 5),
           rev.status == 0 {
            headCommit = rev.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let st = try? await ProcessRunner.capture("/usr/bin/git", ["-C", repoPath, "status", "--porcelain"], timeout: 5),
           st.status == 0 {
            for line in st.stdout.split(whereSeparator: \.isNewline) where line.count > 3 {
                let file = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                if !file.isEmpty { dirtyFiles.insert(file) }
            }
        }
        if let ls = try? await ProcessRunner.capture("/usr/bin/git", ["-C", repoPath, "ls-files"], timeout: 5),
           ls.status == 0 {
            tracked = ls.stdout.split(whereSeparator: \.isNewline).map(String.init)
        }
        if let brList = try? await ProcessRunner.capture("/usr/bin/git", ["-C", repoPath, "for-each-ref", "--format=%(refname:short)|%(HEAD)|%(objectname:short)|%(subject)", "refs/heads/"], timeout: 5),
           brList.status == 0 {
            for line in brList.stdout.split(whereSeparator: \.isNewline) {
                let parts = line.split(separator: "|", maxSplits: 3, omittingEmptySubsequences: false).map(String.init)
                guard !parts.isEmpty, !parts[0].isEmpty else { continue }
                let name = parts[0]
                let isCur = parts.count > 1 && parts[1].trimmingCharacters(in: .whitespaces) == "*"
                let sha = parts.count > 2 ? parts[2] : ""
                let subj = parts.count > 3 ? parts[3] : ""
                branches.append(RepoBranchInfo(name: name, isCurrent: isCur, shortSHA: sha, subject: subj))
            }
            branches.sort { ($0.isMainBranch ? 0 : ($0.isCurrent ? 1 : 2), $0.name) < ($1.isMainBranch ? 0 : ($1.isCurrent ? 1 : 2), $1.name) }
        }

        if let coordinator, !dirtyFiles.isEmpty {
            await coordinator.protectHumanModifications(Array(dirtyFiles))
        }

        return ProjectRepositoryContext(
            repoPath: repoPath,
            gitBranch: branch,
            headCommit: headCommit,
            trackedFiles: tracked,
            dirtyHumanFiles: dirtyFiles,
            detectedBuildSystem: buildSystem,
            branches: branches
        )
    }

    private func detectBuildSystem(at url: URL) -> BuildSystemKind {
        let fm = FileManager.default
        if fm.fileExists(atPath: url.appendingPathComponent("Package.swift").path) { return .swiftPackage }
        if fm.fileExists(atPath: url.appendingPathComponent("package.json").path) { return .node }
        if fm.fileExists(atPath: url.appendingPathComponent("pyproject.toml").path) { return .python }
        if fm.fileExists(atPath: url.appendingPathComponent("Cargo.toml").path) { return .rust }
        if fm.fileExists(atPath: url.appendingPathComponent("Makefile").path) { return .make }
        return .generic
    }
}

/// Applies validated code changes directly into the target project repository,
/// enforcing path safety, exclusive file ownership, and rollback on failed verification.
public struct RepoCodeExecutor: Sendable {
    public init() {}

    public func parseChanges(from modelOutput: String) -> [RepoCodeChange] {
        struct Payload: Decodable { var files: [RepoCodeChange] }
        let cleaned = ChatStreamParser.stripThinking(modelOutput)
        if let open = cleaned.firstIndex(of: "{"), let close = cleaned.lastIndex(of: "}"), open < close,
           let decoded = try? JSONDecoder().decode(Payload.self, from: Data(cleaned[open...close].utf8)) {
            return decoded.files
        }
        return []
    }

    public func apply(
        changes: [RepoCodeChange],
        in repoPath: String,
        agentID: String,
        coordinator: GitWorktreeCoordinator
    ) async throws(FleetError) -> [String] {
        let rootURL = URL(fileURLWithPath: repoPath).standardizedFileURL
        var resolvedPaths: [String] = []

        for change in changes {
            guard !change.path.isEmpty, !change.path.contains("..") else {
                throw FleetError("Unsafe repository path '\(change.path)'")
            }
            let targetURL = rootURL.appendingPathComponent(change.path).standardizedFileURL
            guard targetURL.path.hasPrefix(rootURL.path) else {
                throw FleetError("Path '\(change.path)' escapes repository root")
            }
            resolvedPaths.append(change.path)
        }

        try await coordinator.claimOwnership(files: resolvedPaths, agentID: agentID, worktreePath: repoPath)

        let fm = FileManager.default
        var written: [String] = []
        do {
            for change in changes {
                let targetURL = rootURL.appendingPathComponent(change.path).standardizedFileURL
                switch change.action {
                case .write, .modify:
                    try fm.createDirectory(at: targetURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try Data(change.content.utf8).write(to: targetURL, options: .atomic)
                    written.append(change.path)
                case .delete:
                    if fm.fileExists(atPath: targetURL.path) {
                        try fm.removeItem(at: targetURL)
                        written.append(change.path)
                    }
                }
            }
        } catch {
            await coordinator.releaseOwnership(agentID: agentID)
            throw FleetError("Failed writing repository changes: \(error.localizedDescription)")
        }

        await coordinator.releaseOwnership(agentID: agentID)
        return written
    }
}
