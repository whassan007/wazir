import Foundation

public enum PolicyScope: String, Codable, Sendable {
    case platformMandatory
    case project
    case workflow
}

public enum PolicyCategory: String, Codable, Sendable {
    case security
    case dataHandling
    case architecture
    case evaluation
    case approval
    case workflowRestriction
}

public struct PolicyRule: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var version: String
    public var scope: PolicyScope
    public var category: PolicyCategory
    public var title: String
    public var mandatory: Bool
    public var requiresHumanApproval: Bool

    public init(id: String, version: String = "1.0.0", scope: PolicyScope, category: PolicyCategory,
                title: String, mandatory: Bool = true, requiresHumanApproval: Bool = false) {
        self.id = id
        self.version = version
        self.scope = scope
        self.category = category
        self.title = title
        self.mandatory = mandatory
        self.requiresHumanApproval = requiresHumanApproval
    }
}

public struct PolicyEvaluationResult: Codable, Sendable, Equatable {
    public var allowed: Bool
    public var blockedBy: [String]
    public var approvalRequiredBy: [String]

    public init(allowed: Bool, blockedBy: [String] = [], approvalRequiredBy: [String] = []) {
        self.allowed = allowed
        self.blockedBy = blockedBy
        self.approvalRequiredBy = approvalRequiredBy
    }
}

/// Machine-readable, versioned framework and policy registry.
/// Platform-mandatory security policies cannot be overridden by project configs or extensions.
public actor FrameworkPolicyRegistry {
    private var rules: [String: PolicyRule] = [:]

    public init() {
        let defaultSecurity = PolicyRule(
            id: "platform.security.default",
            scope: .platformMandatory,
            category: .security,
            title: "Untrusted project content cannot override platform security policies",
            mandatory: true
        )
        rules[defaultSecurity.id] = defaultSecurity
    }

    public func register(_ rule: PolicyRule) throws(FleetError) {
        if let existing = rules[rule.id], existing.scope == .platformMandatory, rule.scope != .platformMandatory {
            throw FleetError("Security violation: cannot override platform-mandatory policy '\(rule.id)' from scope '\(rule.scope.rawValue)'")
        }
        if let existing = rules[rule.id], existing.scope == .platformMandatory, !rule.mandatory {
            throw FleetError("Security violation: cannot weaken platform-mandatory policy '\(rule.id)'")
        }
        rules[rule.id] = rule
    }

    public func evaluate(policyIDs: [String], approvedExceptionIDs: Set<String> = []) -> PolicyEvaluationResult {
        var blocked: [String] = []
        var approvals: [String] = []
        let activeRules = rules.values.filter { $0.scope == .platformMandatory || policyIDs.contains($0.id) }
        for r in activeRules {
            if r.requiresHumanApproval && !approvedExceptionIDs.contains(r.id) {
                approvals.append(r.id)
            }
            if r.mandatory && r.scope == .platformMandatory && approvedExceptionIDs.contains("disable:\(r.id)") {
                blocked.append(r.id)
            }
        }
        return PolicyEvaluationResult(allowed: blocked.isEmpty, blockedBy: blocked, approvalRequiredBy: approvals)
    }

    public func allRules() -> [PolicyRule] {
        rules.values.sorted { $0.id < $1.id }
    }
}
