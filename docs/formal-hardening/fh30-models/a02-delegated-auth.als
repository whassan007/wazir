module a02_delegated_auth

/*
 * ============================================================================
 * Agent A02 — Alloy 6 Specification: Authorization & Delegation Chains
 * ============================================================================
 * Target System: Wazir PolicyEngine (packages/core/src/services/policyEngine.ts)
 * Invariant: "A delegated agent must never execute an operation unless that
 *            operation is authorized under the effective permissions of the
 *            complete delegation chain."
 *
 * This behavioral model formalizes:
 *  1. Dynamic agent hierarchies: RootAgent delegating to child and grandchild agents.
 *  2. Capability & tool boundaries: File operations (Workspace, Protected, HostEscape),
 *     Shell operations (Safe, Dangerous).
 *  3. Least privilege & policy narrowing: Delegation grants can only assign a subset
 *     of delegating ancestor permissions and cannot grant security-escalating capabilities.
 *  4. Dynamic policy revocation: Permissions can be revoked at any point from any agent.
 *  5. Execution-time complete chain intersection: At execution time, an operation is
 *     permitted if and only if EVERY ancestor in the delegation chain (a.*parent)
 *     currently holds that permission, and no path/shell escalation occurs.
 */

// ----------------------------------------------------------------------------
// Core Types: Tools, Resources, and Risks (aligned with PolicyEngine)
// ----------------------------------------------------------------------------
abstract sig Tool {}
one sig ToolFileRead, ToolFileWrite, ToolShell extends Tool {}

abstract sig ResourcePath {}
one sig WorkspacePath, ProtectedPath, HostPath extends ResourcePath {}

abstract sig ShellRisk {}
one sig SafeCmd, DangerousCmd extends ShellRisk {}

abstract sig Operation {
  tool: one Tool,
  path: lone ResourcePath,
  risk: lone ShellRisk
}

// Concrete domain operations representing Wazir's policy rules:
one sig ReadWorkspace extends Operation {} {
  tool = ToolFileRead
  path = WorkspacePath
  no risk
}

one sig WriteWorkspace extends Operation {} {
  tool = ToolFileWrite
  path = WorkspacePath
  no risk
}

one sig WriteProtected extends Operation {} {
  tool = ToolFileWrite
  path = ProtectedPath
  no risk
}

one sig WriteHostEscape extends Operation {} {
  tool = ToolFileWrite
  path = HostPath
  no risk
}

one sig ExecSafeShell extends Operation {} {
  tool = ToolShell
  no path
  risk = SafeCmd
}

one sig ExecDangerousShell extends Operation {} {
  tool = ToolShell
  no path
  risk = DangerousCmd
}

// Escalation predicate: Protected path writes, host escapes, and dangerous shell commands
pred isEscalation[op: Operation] {
  (some op.path and op.path in (ProtectedPath + HostPath)) or
  (some op.risk and op.risk in DangerousCmd)
}

// ----------------------------------------------------------------------------
// Agents and Dynamic Delegation State
// ----------------------------------------------------------------------------
sig Agent {
  var parent: lone Agent,
  var agentPerms: set Operation
}

one sig RootAgent extends Agent {}

var sig activeAgents in Agent {}
var sig lastExecutingAgent in Agent {}
var sig lastExecutedOp in Operation {}

// ----------------------------------------------------------------------------
// Initial State
// ----------------------------------------------------------------------------
pred init {
  // Only RootAgent is active initially
  activeAgents = RootAgent
  no parent
  // RootAgent begins with legitimate standard permissions
  RootAgent.agentPerms = ReadWorkspace + WriteWorkspace + ExecSafeShell
  all a: Agent - RootAgent | no a.agentPerms
  no lastExecutingAgent
  no lastExecutedOp
}

// ----------------------------------------------------------------------------
// State Transitions
// ----------------------------------------------------------------------------

// Delegation: Parent 'p' spawns child 'c' and delegates a subset of non-escalating permissions
pred delegate[p: Agent, c: Agent] {
  p in activeAgents
  c not in activeAgents
  // Policy narrowing: Child permissions must be a subset of parent's current permissions,
  // excluding any escalation operations
  c.agentPerms' in (p.agentPerms - WriteProtected - WriteHostEscape - ExecDangerousShell)
  some c.agentPerms'
  activeAgents' = activeAgents + c
  parent' = parent + (c -> p)
  all other: Agent - c | other.agentPerms' = other.agentPerms
  no lastExecutingAgent'
  no lastExecutedOp'
}

// Policy Revocation: Operator or policy tightening revokes an operation from an active agent
pred revoke[a: Agent, op: Operation] {
  a in activeAgents
  op in a.agentPerms
  a.agentPerms' = a.agentPerms - op
  all other: Agent - a | other.agentPerms' = other.agentPerms
  activeAgents' = activeAgents
  parent' = parent
  no lastExecutingAgent'
  no lastExecutedOp'
}

// Execution: Agent 'a' executes operation 'op'
// Enforces complete delegation chain intersection at execution time
pred execute[a: Agent, op: Operation] {
  a in activeAgents
  // CRITICAL ENFORCEMENT: Every ancestor in the delegation chain (including 'a')
  // must currently hold 'op' in their effective permissions at execution time!
  all anc: a.*parent | op in anc.agentPerms
  // Containment & escalation prevention
  not isEscalation[op]

  lastExecutingAgent' = a
  lastExecutedOp' = op
  activeAgents' = activeAgents
  parent' = parent
  agentPerms' = agentPerms
}

// Stutter: Environment non-progress frame
pred stutter {
  activeAgents' = activeAgents
  parent' = parent
  agentPerms' = agentPerms
  lastExecutingAgent' = lastExecutingAgent
  lastExecutedOp' = lastExecutedOp
}

// ----------------------------------------------------------------------------
// Transition System
// ----------------------------------------------------------------------------
fact traces {
  init
  always (
    (some p, c: Agent | delegate[p, c]) or
    (some a: Agent, op: Operation | revoke[a, op]) or
    (some a: Agent, op: Operation | execute[a, op]) or
    stutter
  )
}

// ----------------------------------------------------------------------------
// Safety Assertions & Verification
// ----------------------------------------------------------------------------

// Core Safety Invariant:
// "A delegated agent must never execute an operation unless that operation is
//  authorized under the effective permissions of the complete delegation chain."
assert EffectiveDelegationAuth {
  always (all a: Agent, op: Operation |
    (lastExecutingAgent = a and lastExecutedOp = op) implies (
      (all anc: a.*parent | op in anc.agentPerms) and
      not isEscalation[op]
    )
  )
}

// ----------------------------------------------------------------------------
// Satisfiability Witnesses & Checks
// ----------------------------------------------------------------------------

// Witness: Valid parent delegation and subsequent delegated child execution
run WitnessDelegationAndExecution {
  eventually (some c: Agent - RootAgent, op: Operation |
    c.parent = RootAgent and lastExecutingAgent = c and lastExecutedOp = op)
} for 3 Agent, 6 steps

// Witness: Multi-level delegation chain (Root -> Child -> Grandchild)
run WitnessMultiLevelDelegation {
  eventually (some c: Agent, g: Agent, op: Operation |
    c.parent = RootAgent and g.parent = c and
    lastExecutingAgent = g and lastExecutedOp = op)
} for 3 Agent, 8 steps

// Bounded Verification Check: Expects NO COUNTEREXAMPLE (UNSAT)
check EffectiveDelegationAuth for 3 Agent, 8 steps
