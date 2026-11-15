// Alloy 6 Formal Hardening Model: A1 Policy & Delegated Tool Authorization
// Subsystem: packages/core/src/services/policyEngine.ts & permissionBroker.ts
// Models multi-step execution, subshell wrappers, find -exec delegation, and parent-child delegation.

open util/boolean

abstract sig Principal {
  parent: lone Principal
}
one sig RootAgent extends Principal {}
one sig SubAgent extends Principal {}

fact AgentHierarchy {
  SubAgent.parent = RootAgent
  no RootAgent.parent
}

abstract sig ResourcePath {
  insideWorkspace: one Bool,
  isProtected: one Bool
}
one sig WorkspaceNormalFile extends ResourcePath {}
one sig WorkspaceProtectedFile extends ResourcePath {}
one sig OutsideHostFile extends ResourcePath {}
one sig ModelAuthoredTestFile extends ResourcePath {}

fact PathAttributes {
  WorkspaceNormalFile.insideWorkspace = True
  WorkspaceNormalFile.isProtected = False

  WorkspaceProtectedFile.insideWorkspace = True
  WorkspaceProtectedFile.isProtected = True

  OutsideHostFile.insideWorkspace = False
  OutsideHostFile.isProtected = False

  ModelAuthoredTestFile.insideWorkspace = True
  ModelAuthoredTestFile.isProtected = False
}

abstract sig ToolCommand {
  readsResource: lone ResourcePath,
  writesResource: lone ResourcePath,
  isExecWrapper: one Bool,
  subCommand: lone ToolCommand
}

// Concrete command classes
one sig SafeInspectCmd extends ToolCommand {}
one sig HostEscapeCmd extends ToolCommand {}
one sig WriteTargetCmd extends ToolCommand {}
one sig SubshellWrapperCmd extends ToolCommand {}
one sig FindExecCmd extends ToolCommand {}
one sig InterpreterTestRunCmd extends ToolCommand {}

fact CommandProperties {
  SafeInspectCmd.isExecWrapper = False
  SafeInspectCmd.readsResource = WorkspaceNormalFile
  no SafeInspectCmd.writesResource
  no SafeInspectCmd.subCommand

  HostEscapeCmd.isExecWrapper = False
  HostEscapeCmd.readsResource = OutsideHostFile
  no HostEscapeCmd.writesResource
  no HostEscapeCmd.subCommand

  WriteTargetCmd.isExecWrapper = False
  WriteTargetCmd.writesResource = OutsideHostFile
  no WriteTargetCmd.readsResource
  no WriteTargetCmd.subCommand

  // Subshell wrapper wraps an interpreter test run
  SubshellWrapperCmd.isExecWrapper = True
  SubshellWrapperCmd.subCommand = InterpreterTestRunCmd
  no SubshellWrapperCmd.readsResource
  no SubshellWrapperCmd.writesResource

  // FindExec wraps host escape (e.g. cat /etc/passwd or sort -o /etc/passwd)
  FindExecCmd.isExecWrapper = True
  FindExecCmd.subCommand = HostEscapeCmd
  FindExecCmd.readsResource = WorkspaceNormalFile
  no FindExecCmd.writesResource

  InterpreterTestRunCmd.isExecWrapper = False
  InterpreterTestRunCmd.readsResource = ModelAuthoredTestFile
  no InterpreterTestRunCmd.writesResource
  no InterpreterTestRunCmd.subCommand
}

one sig State {
  var written: Principal -> ResourcePath,
  var justExecuted: Principal -> lone ToolCommand
}

pred isTargetInsideWorkspace[r: ResourcePath] {
  r.insideWorkspace = True and r.isProtected = False
}

fun effectiveTargetRead[cmd: ToolCommand]: set ResourcePath {
  (cmd.*subCommand - isExecWrapper.True).readsResource
}

fun effectiveTargetWrite[cmd: ToolCommand]: set ResourcePath {
  (cmd.*subCommand - isExecWrapper.True).writesResource
}

// Hardened policy engine gate:
// 1. Path containment applies recursively to all effective reads and writes (closing find -exec bypass).
// 2. Anti-laundering gate checks session-wide written files across all principals and subshell wrappers.
pred policyAllows[p: Principal, cmd: ToolCommand] {
  // 1. Path containment: any effective read or write must stay inside workspace and not protected
  (all r: effectiveTargetRead[cmd] | isTargetInsideWorkspace[r])
  and
  (all w: effectiveTargetWrite[cmd] | isTargetInsideWorkspace[w])
  and
  // 2. Anti-laundering gate: interpreter test run cannot execute files authored during session by any principal
  ((cmd = InterpreterTestRunCmd or (cmd.isExecWrapper = True and cmd.subCommand = InterpreterTestRunCmd)) implies
    no (Principal.(State.written) & ModelAuthoredTestFile))
}

// Transitions
pred init {
  no State.written
  no State.justExecuted
}

pred agentWritesFile[p: Principal, r: ResourcePath] {
  r.insideWorkspace = True
  State.written' = State.written + p->r
  no State.justExecuted'
}

pred dispatchToolDirect[p: Principal, cmd: ToolCommand] {
  policyAllows[p, cmd]
  State.written' = State.written
  State.justExecuted' = p->cmd
}

pred stutter {
  State.written' = State.written
  no State.justExecuted'
}

fact SystemTrace {
  init
  always (
    (some p: Principal, r: ResourcePath | agentWritesFile[p, r])
    or
    (some p: Principal, cmd: ToolCommand | dispatchToolDirect[p, cmd])
    or
    stutter
  )
}

// Safety Invariants
assert SafeExecutionInsideWorkspace {
  always (all cmd: Principal.(State.justExecuted) | {
    (all r: effectiveTargetRead[cmd] | r.insideWorkspace = True)
    and
    (all w: effectiveTargetWrite[cmd] | w.insideWorkspace = True)
  })
}

assert NoModelAuthoredCodeLaundering {
  always (
    some (Principal.(State.written) & ModelAuthoredTestFile) implies
      no (Principal.(State.justExecuted) & (InterpreterTestRunCmd + SubshellWrapperCmd))
  )
}

assert SubagentBoundedPrivilege {
  always (all cmd: SubAgent.(State.justExecuted) | {
    (all r: effectiveTargetRead[cmd] | r.insideWorkspace = True)
    and
    (all w: effectiveTargetWrite[cmd] | w.insideWorkspace = True)
    and
    (some (Principal.(State.written) & ModelAuthoredTestFile) implies
      cmd not in (InterpreterTestRunCmd + SubshellWrapperCmd))
  })
}

// Positive witnesses
run WitnessNormalInspection {
  eventually (SafeInspectCmd in RootAgent.(State.justExecuted))
} for 5 steps

run WitnessDelegatedSubagentExecution {
  eventually (SafeInspectCmd in SubAgent.(State.justExecuted))
} for 5 steps

check SafeExecutionInsideWorkspace for 5 steps
check NoModelAuthoredCodeLaundering for 5 steps
check SubagentBoundedPrivilege for 5 steps
