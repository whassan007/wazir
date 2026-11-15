module a02_delegated_auth_mutant

/*
 * ============================================================================
 * Agent A02 — Alloy 6 Negative-Control Mutant: Authorization & Delegation Chains
 * ============================================================================
 * Target System: Wazir PolicyEngine (packages/core/src/services/policyEngine.ts)
 * Invariant: "A delegated agent must never execute an operation unless that
 *            operation is authorized under the effective permissions of the
 *            complete delegation chain."
 *
 * Vulnerability modeled (Negative Control):
 *  - Dispatch-only check / Child-only policy check:
 *    When a child agent executes an operation, authorization is checked ONLY
 *    against the child's local cached permissions (`op in a.agentPerms`),
 *    WITHOUT re-validating the full ancestor chain (`a.^parent.agentPerms`).
 *  - Resulting attack vector (TOCTOU delegation bypass):
 *    1. RootAgent delegates permission P (e.g. WriteWorkspace or ExecSafeShell) to Child.
 *    2. Operator or policy engine revokes permission P from RootAgent.
 *    3. Child executes permission P.
 *    4. Because execution-time complete chain intersection is omitted, Child executes
 *       an operation that its delegating ancestor no longer permits!
 *
 * Expected Outcome:
 *  - SAT counterexample for `check EffectiveDelegationAuth`.
 */

// ----------------------------------------------------------------------------
// Core Types: Tools, Resources, and Risks
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
  activeAgents = RootAgent
  no parent
  RootAgent.agentPerms = ReadWorkspace + WriteWorkspace + ExecSafeShell
  all a: Agent - RootAgent | no a.agentPerms
  no lastExecutingAgent
  no lastExecutedOp
}

// ----------------------------------------------------------------------------
// State Transitions
// ----------------------------------------------------------------------------

pred delegate[p: Agent, c: Agent] {
  p in activeAgents
  c not in activeAgents
  c.agentPerms' in (p.agentPerms - WriteProtected - WriteHostEscape - ExecDangerousShell)
  some c.agentPerms'
  activeAgents' = activeAgents + c
  parent' = parent + (c -> p)
  all other: Agent - c | other.agentPerms' = other.agentPerms
  no lastExecutingAgent'
  no lastExecutedOp'
}

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

// FLAWED EXECUTION (MUTANT):
// Fails to intersect with complete delegation chain at execution time!
// Only checks if the executing agent has the permission locally.
pred executeMutant[a: Agent, op: Operation] {
  a in activeAgents
  // FLAW: Omission of `all anc: a.*parent | op in anc.agentPerms`
  // An execution check only verifies local/dispatch-time child permissions!
  op in a.agentPerms
  not isEscalation[op]

  lastExecutingAgent' = a
  lastExecutedOp' = op
  activeAgents' = activeAgents
  parent' = parent
  agentPerms' = agentPerms
}

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
    (some a: Agent, op: Operation | executeMutant[a, op]) or
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

// Witness: Valid delegation and execution scenario exists
run WitnessDelegationAndExecution {
  eventually (some c: Agent - RootAgent, op: Operation |
    c.parent = RootAgent and lastExecutingAgent = c and lastExecutedOp = op)
} for 3 Agent, 6 steps

// Bounded Verification Check: EXPECTS COUNTEREXAMPLE (SAT)
check EffectiveDelegationAuth for 3 Agent, 6 steps
