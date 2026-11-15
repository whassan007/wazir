// Alloy 6 Formal Hardening Negative Control Mutant Model
// Models the observed Wazir bugs:
// Bug 1: find -exec skips argument checks and only checks command name
// Bug 2: bash -c wrapper drops execution context / anti-laundering check
// Bug 3: subagent delegation does not track parent-authored test files

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

  SubshellWrapperCmd.isExecWrapper = True
  SubshellWrapperCmd.subCommand = InterpreterTestRunCmd
  no SubshellWrapperCmd.readsResource
  no SubshellWrapperCmd.writesResource

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

fun effectiveTargetRead[cmd: ToolCommand]: set ResourcePath {
  (cmd.*subCommand - isExecWrapper.True).readsResource
}

fun effectiveTargetWrite[cmd: ToolCommand]: set ResourcePath {
  (cmd.*subCommand - isExecWrapper.True).writesResource
}

// MUTATED / DEFECTIVE Policy Gate:
// 1. For find -exec: only checks that find itself is safe, ignoring subCommand arguments!
// 2. For subshell wrapper: executionId is dropped, so written-file check is skipped!
// 3. For subagent: only checks if THIS actor wrote it, ignoring parent!
pred flawedPolicyAllows[p: Principal, cmd: ToolCommand] {
  // Flaw 1: Find -exec bypass (only checks find itself, ignores subCommand's escaped read/write)
  (cmd = FindExecCmd implies {
    cmd.readsResource.insideWorkspace = True
  } else {
    (all r: effectiveTargetRead[cmd] | r.insideWorkspace = True and r.isProtected = False)
    and
    (all w: effectiveTargetWrite[cmd] | w.insideWorkspace = True and w.isProtected = False)
  })
  and
  // Flaw 2 & 3: Anti-laundering check is bypassed if wrapped in subshell or run by subagent
  (cmd = SubshellWrapperCmd implies {
    // Context dropped in bash -c: always allowed!
    True = True
  } else (cmd = InterpreterTestRunCmd implies {
    // Flaw 3: only checks if current actor p wrote it, ignoring parent actor
    ModelAuthoredTestFile not in p.(State.written)
  } else True = True))
}

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
  flawedPolicyAllows[p, cmd]
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

// Invariants to challenge against the mutant model
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

// Check assertions: EXPECT COUNTEREXAMPLES on mutant!
check SafeExecutionInsideWorkspace for 5 steps
check NoModelAuthoredCodeLaundering for 5 steps
