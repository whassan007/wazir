// ==============================================================================
// A7: Multi-Agent Workspace Isolation & Conflict Detection
// Sound Reference Specification (Alloy 6 Temporal Logic)
// ==============================================================================
// Models 2 concurrent agents branching from a base revision, modifying
// overlapping or disjoint files, and integrating back into a shared target branch.
// In this sound model, conflict detection checks BOTH:
// 1. Candidate-candidate overlaps (competing changes in the same batch).
// 2. Candidate-target stale-base modifications (target branch advanced since
//    the agent branched, modifying files the agent also touched).
// ==============================================================================

abstract sig Agent {
  var status: one AgentStatus,
  var baseRev: lone Revision,
  var modifiedFiles: set File
}
one sig AgentA, AgentB extends Agent {}

abstract sig File {}
one sig File1, File2 extends File {}

abstract sig Revision {}
one sig R0, R1, R2, R3 extends Revision {}

abstract sig AgentStatus {}
one sig Idle, Working, Completed, Integrated, Conflicted extends AgentStatus {}

one sig Target {
  var head: one Revision,
  var fileRev: File -> one Revision
}

one sig Coordinator {
  var flaggedConflicts: set Agent
}

// ------------------------------------------------------------------------------
// Initial State
// ------------------------------------------------------------------------------
pred init {
  all a: Agent {
    a.status = Idle
    no a.baseRev
    no a.modifiedFiles
  }
  Target.head = R0
  Target.fileRev = File -> R0
  no Coordinator.flaggedConflicts
}

// ------------------------------------------------------------------------------
// State Machine Transitions & Frame Conditions
// ------------------------------------------------------------------------------

// Agent branches from current target HEAD into an isolated worktree
pred branch[a: Agent] {
  a.status = Idle
  a.status' = Working
  a.baseRev' = Target.head
  no a.modifiedFiles'

  // Frame conditions
  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
  Target.head' = Target.head
  Target.fileRev' = Target.fileRev
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts
}

// Agent modifies a file within its isolated worktree
pred modify[a: Agent, f: File] {
  a.status = Working
  f not in a.modifiedFiles
  a.status' = Working
  a.baseRev' = a.baseRev
  a.modifiedFiles' = a.modifiedFiles + f

  // Frame conditions
  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
  Target.head' = Target.head
  Target.fileRev' = Target.fileRev
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts
}

// Agent finishes work and submits candidate for integration
pred complete[a: Agent] {
  a.status = Working
  some a.modifiedFiles
  a.status' = Completed
  a.baseRev' = a.baseRev
  a.modifiedFiles' = a.modifiedFiles

  // Frame conditions
  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
  Target.head' = Target.head
  Target.fileRev' = Target.fileRev
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts
}

// Comprehensive Conflict Detection (Sound Policy)
pred hasConflict[a: Agent] {
  // Stale-base check: Target modified any file in a.modifiedFiles since a.baseRev
  (some f: a.modifiedFiles | Target.fileRev[f] != a.baseRev)
  or
  // Overlap with another completed or already-integrated candidate
  (some b: (Agent - a) | b.status in Completed + Integrated and some (a.modifiedFiles & b.modifiedFiles))
}

// Coordinator detects and flags conflict for candidate
pred flagConflict[a: Agent] {
  a.status = Completed
  hasConflict[a]
  a.status' = Conflicted
  a.baseRev' = a.baseRev
  a.modifiedFiles' = a.modifiedFiles
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts + a

  // Frame conditions
  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
  Target.head' = Target.head
  Target.fileRev' = Target.fileRev
}

// Integration into Target Branch
pred integrate[a: Agent, nextRev: Revision] {
  a.status = Completed
  not hasConflict[a]
  a not in Coordinator.flaggedConflicts
  nextRev != Target.head
  nextRev not in (Target.head + Target.fileRev[File])

  a.status' = Integrated
  a.baseRev' = a.baseRev
  a.modifiedFiles' = a.modifiedFiles
  Target.head' = nextRev
  Target.fileRev' = Target.fileRev ++ (a.modifiedFiles -> nextRev)
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts

  // Frame conditions
  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
}

// Stutter step for finite/lasso execution
pred stutter {
  all a: Agent {
    a.status' = a.status
    a.baseRev' = a.baseRev
    a.modifiedFiles' = a.modifiedFiles
  }
  Target.head' = Target.head
  Target.fileRev' = Target.fileRev
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts
}

// Closed Transition System
fact traces {
  init
  always (
    (some a: Agent | branch[a]) or
    (some a: Agent, f: File | modify[a, f]) or
    (some a: Agent | complete[a]) or
    (some a: Agent | flagConflict[a]) or
    (some a: Agent, r: Revision | integrate[a, r]) or
    stutter
  )
}

// ------------------------------------------------------------------------------
// Formal Invariants (Safety Properties)
// ------------------------------------------------------------------------------

// Invariant 1: No Stale Base Integration
// An agent can never integrate if target has modified any of the agent's files since the agent's base revision.
assert NoStaleBaseIntegration {
  always (all a: Agent |
    (a.status = Completed and a.status' = Integrated) implies
      (all f: a.modifiedFiles | Target.fileRev[f] = a.baseRev)
  )
}

// Invariant 2: No Silent Lost Updates
// An agent never integrates if any of its files have moved on target or if conflict was flagged.
assert NoSilentLostUpdate {
  always (all a: Agent |
    (a.status = Completed and a.status' = Integrated) implies
      (a not in Coordinator.flaggedConflicts and (all f: a.modifiedFiles | Target.fileRev[f] = a.baseRev))
  )
}

// Invariant 3: Conflicted Agent Never Integrates
// An agent flagged as conflicted can never transition to Integrated.
assert ConflictedAgentNeverIntegrates {
  always (all a: Agent |
    (a in Coordinator.flaggedConflicts) implies always (a.status != Integrated)
  )
}

// Invariant 4: Same-File Conflict Detected
// Two concurrent agents modifying overlapping files cannot both integrate without conflict detection.
assert SameFileConflictDetected {
  always (all disj a1, a2: Agent, f: File |
    (a1.status = Integrated and a2.status = Integrated and f in (a1.modifiedFiles & a2.modifiedFiles)) implies
      some Coordinator.flaggedConflicts
  )
}

// Invariant 5: Workspace Isolation Integrity
// While an agent is in the Working state, other agents' transitions do not alter its private modifications or base revision.
assert WorkspaceIsolation {
  always (all disj a1, a2: Agent |
    (a1.status = Working and a2.status' != a2.status) implies
      (a1.modifiedFiles' = a1.modifiedFiles and a1.baseRev' = a1.baseRev)
  )
}

// ------------------------------------------------------------------------------
// Positive Witness Runs & Verification Checks
// ------------------------------------------------------------------------------

run BothIntegratedDisjoint {
  eventually (AgentA.status = Integrated and AgentB.status = Integrated and no (AgentA.modifiedFiles & AgentB.modifiedFiles))
} for 10 steps

run ConflictDetected {
  eventually (some Coordinator.flaggedConflicts)
} for 10 steps

check NoStaleBaseIntegration for 10 steps
check NoSilentLostUpdate for 10 steps
check ConflictedAgentNeverIntegrates for 10 steps
check SameFileConflictDetected for 10 steps
check WorkspaceIsolation for 10 steps
