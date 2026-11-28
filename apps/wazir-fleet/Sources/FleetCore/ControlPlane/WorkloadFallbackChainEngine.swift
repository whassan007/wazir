import Foundation

public enum WorkloadActivityKind: String, Codable, Sendable, CaseIterable, Hashable, Identifiable {
    case architectureAndPlanning = "Architecture & Planning"
    case interactiveComplexSteps = "Interactive Tools & Complex Steps"
    case highFrequencyEdits = "High-Frequency Edits"
    case complexMultiFile = "Complex Multi-File Engineering"
    case standardFeatureAndTestCoding = "Standard Feature & Test Coding ($0)"
    case longContextSynthesis = "Long-Context Synthesis ($0)"
    case qaAndCodeReview = "QA & Code Review ($0)"
    case releaseAndSecurityAcceptance = "Release & Security Acceptance"
    case routingAndTriage = "Routing & Triage ($0)"

    public var id: String { rawValue }
}

public struct FallbackCandidateSlot: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var rank: Int
    public var hostOrProviderID: String
    public var modelPattern: String
    public var displayName: String
    public var isLocalZeroCost: Bool
    public var isPrivacyLockedLocal: Bool
    public var isNonPrivateCloudOnly: Bool
    public var isStandby: Bool

    public init(
        id: String = UUID().uuidString,
        rank: Int,
        hostOrProviderID: String,
        modelPattern: String,
        displayName: String,
        isLocalZeroCost: Bool = false,
        isPrivacyLockedLocal: Bool = false,
        isNonPrivateCloudOnly: Bool = false,
        isStandby: Bool = false
    ) {
        self.id = id
        self.rank = rank
        self.hostOrProviderID = hostOrProviderID
        self.modelPattern = modelPattern
        self.displayName = displayName
        self.isLocalZeroCost = isLocalZeroCost
        self.isPrivacyLockedLocal = isPrivacyLockedLocal
        self.isNonPrivateCloudOnly = isNonPrivateCloudOnly
        self.isStandby = isStandby
    }
}

public struct WorkloadFallbackChain: Codable, Sendable, Equatable, Identifiable {
    public var id: String { activity.rawValue }
    public var activity: WorkloadActivityKind
    public var preferZeroCostLocal: Bool
    public var slots: [FallbackCandidateSlot]

    public init(activity: WorkloadActivityKind, preferZeroCostLocal: Bool = false, slots: [FallbackCandidateSlot]) {
        self.activity = activity
        self.preferZeroCostLocal = preferZeroCostLocal
        self.slots = slots.sorted { $0.rank < $1.rank }
    }

    public static let defaultChains: [WorkloadFallbackChain] = [
        WorkloadFallbackChain(activity: .architectureAndPlanning, slots: [
            FallbackCandidateSlot(rank: 1, hostOrProviderID: "agy", modelPattern: "gemini-4-argon-high", displayName: "agy gemini-4-argon-high"),
            FallbackCandidateSlot(rank: 2, hostOrProviderID: "claude", modelPattern: "claude-opus-5-5-high", displayName: "claude-opus-5-5-high"),
            FallbackCandidateSlot(rank: 3, hostOrProviderID: "agy", modelPattern: "gemini-4-neon-high", displayName: "agy gemini-4-neon-high"),
            FallbackCandidateSlot(rank: 4, hostOrProviderID: "jetson", modelPattern: "gpt-oss-120b", displayName: "🔒 jetson gpt-oss-120b", isLocalZeroCost: true, isPrivacyLockedLocal: true),
        ]),
        WorkloadFallbackChain(activity: .interactiveComplexSteps, slots: [
            FallbackCandidateSlot(rank: 1, hostOrProviderID: "agy", modelPattern: "gemini-4-hydrogen-medium", displayName: "agy gemini-4-hydrogen-medium"),
            FallbackCandidateSlot(rank: 2, hostOrProviderID: "codex", modelPattern: "gpt-6-astra", displayName: "codex gpt-6-astra"),
            FallbackCandidateSlot(rank: 3, hostOrProviderID: "claude", modelPattern: "claude-sonnet-5-5-high", displayName: "claude-sonnet-5-5-high"),
        ]),
        WorkloadFallbackChain(activity: .highFrequencyEdits, slots: [
            FallbackCandidateSlot(rank: 1, hostOrProviderID: "rtx", modelPattern: "qwen3-coder:30b", displayName: "rtx qwen3-coder:30b", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 2, hostOrProviderID: "dgx", modelPattern: "qwen3-coder-next", displayName: "dgx qwen3-coder-next", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 3, hostOrProviderID: "jetson", modelPattern: "qwen3-coder:30b", displayName: "jetson qwen3-coder:30b (standby)", isLocalZeroCost: true, isStandby: true),
            FallbackCandidateSlot(rank: 4, hostOrProviderID: "agy", modelPattern: "gemini-4-hydrogen-low", displayName: "agy gemini-4-hydrogen-low"),
        ]),
        WorkloadFallbackChain(activity: .complexMultiFile, slots: [
            FallbackCandidateSlot(rank: 1, hostOrProviderID: "codex", modelPattern: "gpt-6-astra", displayName: "codex gpt-6-astra"),
            FallbackCandidateSlot(rank: 2, hostOrProviderID: "agy", modelPattern: "gemini-4-hydrogen-high", displayName: "agy gemini-4-hydrogen-high"),
            FallbackCandidateSlot(rank: 3, hostOrProviderID: "dgx", modelPattern: "qwen3-coder-next", displayName: "🔒 dgx qwen3-coder-next", isLocalZeroCost: true, isPrivacyLockedLocal: true),
            FallbackCandidateSlot(rank: 4, hostOrProviderID: "rtx", modelPattern: "qwen3-coder:30b", displayName: "🔒 rtx qwen3-coder:30b", isLocalZeroCost: true, isPrivacyLockedLocal: true),
        ]),
        WorkloadFallbackChain(activity: .standardFeatureAndTestCoding, preferZeroCostLocal: true, slots: [
            FallbackCandidateSlot(rank: 1, hostOrProviderID: "dgx", modelPattern: "qwen3-coder-next", displayName: "dgx qwen3-coder-next", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 2, hostOrProviderID: "rtx", modelPattern: "qwen3-coder:30b", displayName: "rtx qwen3-coder:30b", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 3, hostOrProviderID: "studio", modelPattern: "mlx", displayName: "studio MLX coder (standby)", isLocalZeroCost: true, isStandby: true),
            FallbackCandidateSlot(rank: 4, hostOrProviderID: "claude", modelPattern: "claude-sonnet-5-5-high", displayName: "claude-sonnet-5-5-high (non-private only)", isNonPrivateCloudOnly: true),
        ]),
        WorkloadFallbackChain(activity: .longContextSynthesis, preferZeroCostLocal: true, slots: [
            FallbackCandidateSlot(rank: 1, hostOrProviderID: "studio", modelPattern: "mlx", displayName: "studio MLX long-context model", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 2, hostOrProviderID: "dgx", modelPattern: "nemotron", displayName: "dgx Nemotron (NIM, once verified)", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 3, hostOrProviderID: "jetson", modelPattern: "gpt-oss-120b", displayName: "jetson gpt-oss-120b", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 4, hostOrProviderID: "claude", modelPattern: "claude-sonnet-5-5-high", displayName: "claude-sonnet-5-5-high (non-private only)", isNonPrivateCloudOnly: true),
        ]),
        WorkloadFallbackChain(activity: .qaAndCodeReview, preferZeroCostLocal: true, slots: [
            FallbackCandidateSlot(rank: 1, hostOrProviderID: "jetson", modelPattern: "gpt-oss-120b", displayName: "jetson gpt-oss-120b", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 2, hostOrProviderID: "dgx", modelPattern: "gpt-oss-120b", displayName: "dgx gpt-oss-120b (standby)", isLocalZeroCost: true, isStandby: true),
            FallbackCandidateSlot(rank: 3, hostOrProviderID: "studio", modelPattern: "gpt-oss-120b", displayName: "studio gpt-oss-120b (MLX, standby)", isLocalZeroCost: true, isStandby: true),
            FallbackCandidateSlot(rank: 4, hostOrProviderID: "claude", modelPattern: "claude-sonnet-5-5-high", displayName: "claude-sonnet-5-5-high (non-private only)", isNonPrivateCloudOnly: true),
        ]),
        WorkloadFallbackChain(activity: .releaseAndSecurityAcceptance, slots: [
            FallbackCandidateSlot(rank: 1, hostOrProviderID: "jetson", modelPattern: "gpt-oss-120b", displayName: "gate: tests + jetson gpt-oss-120b pre-pass", isLocalZeroCost: true, isPrivacyLockedLocal: true),
            FallbackCandidateSlot(rank: 2, hostOrProviderID: "claude", modelPattern: "claude-opus-5-5-high", displayName: "claude-opus-5-5-high"),
            FallbackCandidateSlot(rank: 3, hostOrProviderID: "agy", modelPattern: "gemini-4-neon-high", displayName: "agy gemini-4-neon-high"),
            FallbackCandidateSlot(rank: 4, hostOrProviderID: "codex", modelPattern: "gpt-6-astra", displayName: "codex gpt-6-astra"),
        ]),
        WorkloadFallbackChain(activity: .routingAndTriage, preferZeroCostLocal: true, slots: [
            FallbackCandidateSlot(rank: 1, hostOrProviderID: "rule", modelPattern: "keyword-filter", displayName: "rule, keyword or embedding filter", isLocalZeroCost: true, isPrivacyLockedLocal: true),
            FallbackCandidateSlot(rank: 2, hostOrProviderID: "legion", modelPattern: "qwen", displayName: "legion small model", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 3, hostOrProviderID: "jetson", modelPattern: "qwen", displayName: "jetson small model", isLocalZeroCost: true),
            FallbackCandidateSlot(rank: 4, hostOrProviderID: "macbook", modelPattern: "qwen", displayName: "macbook tiny model", isLocalZeroCost: true),
        ]),
    ]
}

public struct SkippedFallbackSlot: Codable, Sendable, Equatable {
    public var slot: FallbackCandidateSlot
    public var reason: String
}

public struct ResolvedChainAssignment: Codable, Sendable, Equatable {
    public var activity: WorkloadActivityKind
    public var selectedSlot: FallbackCandidateSlot?
    public var fallbackQueue: [FallbackCandidateSlot]
    public var skippedSlots: [SkippedFallbackSlot]
}

public struct MachineActivityRole: Sendable, Equatable, Identifiable {
    public var id: String { "\(activity.rawValue)-\(rank)" }
    public var activity: WorkloadActivityKind
    public var rank: Int
    public var modelPattern: String
    public var isStandby: Bool
}

public struct WorkloadFallbackChainEngine: Sendable {
    public init() {}

    public func classifyActivity(title: String, prompt: String, stageRole: String) -> WorkloadActivityKind {
        let combined = "\(title) \(prompt) \(stageRole)".lowercased()
        if combined.contains("plan") || combined.contains("architect") { return .architectureAndPlanning }
        if combined.contains("critic") || combined.contains("review") || combined.contains("qa") || combined.contains("audit") { return .qaAndCodeReview }
        if combined.contains("synth") || combined.contains("merge") || combined.contains("summar") { return .longContextSynthesis }
        if combined.contains("release") || combined.contains("security") || combined.contains("gate") { return .releaseAndSecurityAcceptance }
        if combined.contains("multi-file") || combined.contains("refactor") { return .complexMultiFile }
        if combined.contains("edit") || combined.contains("fix") || combined.contains("patch") { return .highFrequencyEdits }
        if combined.contains("triage") || combined.contains("route") { return .routingAndTriage }
        return .standardFeatureAndTestCoding
    }

    public func resolve(
        activity: WorkloadActivityKind,
        chains: [WorkloadFallbackChain] = WorkloadFallbackChain.defaultChains,
        onlineHostIDs: Set<String>,
        authenticatedCloudIDs: Set<String>,
        exhaustedCloudIDs: Set<String> = [],
        requirePrivateLocal: Bool = false
    ) -> ResolvedChainAssignment {
        guard let chain = chains.first(where: { $0.activity == activity }) else {
            return ResolvedChainAssignment(activity: activity, selectedSlot: nil, fallbackQueue: [], skippedSlots: [])
        }

        let cloudProviders: Set<String> = ["agy", "claude", "codex"]
        var eligible: [FallbackCandidateSlot] = []
        var skipped: [SkippedFallbackSlot] = []

        for slot in chain.slots {
            if requirePrivateLocal && (slot.isNonPrivateCloudOnly || cloudProviders.contains(slot.hostOrProviderID)) {
                skipped.append(SkippedFallbackSlot(slot: slot, reason: "Skipped non-private cloud slot under privacy constraint"))
                continue
            }
            if slot.hostOrProviderID == "rule" {
                eligible.append(slot)
                continue
            }
            if cloudProviders.contains(slot.hostOrProviderID) {
                if !authenticatedCloudIDs.contains(slot.hostOrProviderID) {
                    skipped.append(SkippedFallbackSlot(slot: slot, reason: "Cloud provider '\(slot.hostOrProviderID)' not authenticated"))
                    continue
                }
                if exhaustedCloudIDs.contains(slot.hostOrProviderID) {
                    skipped.append(SkippedFallbackSlot(slot: slot, reason: "Cloud budget exhausted for '\(slot.hostOrProviderID)'"))
                    continue
                }
                eligible.append(slot)
            } else {
                if !onlineHostIDs.contains(slot.hostOrProviderID) {
                    skipped.append(SkippedFallbackSlot(slot: slot, reason: "Machine '\(slot.hostOrProviderID)' offline/unreachable"))
                    continue
                }
                eligible.append(slot)
            }
        }

        return ResolvedChainAssignment(
            activity: activity,
            selectedSlot: eligible.first,
            fallbackQueue: Array(eligible.dropFirst()),
            skippedSlots: skipped
        )
    }

    public func groupByMachine(
        chains: [WorkloadFallbackChain] = WorkloadFallbackChain.defaultChains
    ) -> [(hostOrProviderID: String, roles: [MachineActivityRole])] {
        var map: [String: [MachineActivityRole]] = [:]
        for chain in chains {
            for slot in chain.slots {
                map[slot.hostOrProviderID, default: []].append(
                    MachineActivityRole(activity: chain.activity, rank: slot.rank, modelPattern: slot.modelPattern, isStandby: slot.isStandby)
                )
            }
        }
        return map.keys.sorted().map { key in
            (key, (map[key] ?? []).sorted { $0.rank < $1.rank })
        }
    }
}
