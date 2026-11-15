module a27_workspace_conflict_mutant

/*
 * Formal Specification: Multi-Agent Workspace Isolation & Conflict Detection (Mutant)
 * Program: Wazir 30-Agent Cost-Optimized Formal Hardening Program
 * Agent: A27 (Gemini TIER 2 — Multi-Agent Conflict & Concurrency Regression Engineer)
 * Commit: 4661c33a6caeaca0639853463e4ccbbe3ebc63d8
 *
 * Negative-Control Mutant Specification:
 *   Models the defective behavior where conflict detection only checks
 *   candidate-candidate overlaps among pending candidates, omitting stale-base
 *   candidate-target conflicts and already-integrated candidates (last-writer-wins).
 *
 * Expected Results:
 *   - Positive witnesses SAT
 *   - Check NoStaleBaseIntegration: SAT (counterexample found)
 *   - Check NoSilentLostUpdate: SAT (counterexample found)
 *   - Check SameFileConflictDetected: SAT (counterexample found)
 */

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

pred branch[a: Agent] {
  a.status = Idle
  a.status' = Working
  a.baseRev' = Target.head
  no a.modifiedFiles'

  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
  Target.head' = Target.head
  Target.fileRev' = Target.fileRev
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts
}

pred modify[a: Agent, f: File] {
  a.status = Working
  f not in a.modifiedFiles
  a.status' = Working
  a.baseRev' = a.baseRev
  a.modifiedFiles' = a.modifiedFiles + f

  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
  Target.head' = Target.head
  Target.fileRev' = Target.fileRev
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts
}

pred complete[a: Agent] {
  a.status = Working
  some a.modifiedFiles
  a.status' = Completed
  a.baseRev' = a.baseRev
  a.modifiedFiles' = a.modifiedFiles

  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
  Target.head' = Target.head
  Target.fileRev' = Target.fileRev
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts
}

// DEFECTIVE Conflict Detection (Mutant: omits candidate-target stale-base check and already-integrated agents):
pred hasConflict[a: Agent] {
  some b: (Agent - a) | b.status = Completed and some (a.modifiedFiles & b.modifiedFiles)
}

pred flagConflict[a: Agent] {
  a.status = Completed
  hasConflict[a]
  a.status' = Conflicted
  a.baseRev' = a.baseRev
  a.modifiedFiles' = a.modifiedFiles
  Coordinator.flaggedConflicts' = Coordinator.flaggedConflicts + a

  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
  Target.head' = Target.head
  Target.fileRev' = Target.fileRev
}

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

  all other: Agent - a {
    other.status' = other.status
    other.baseRev' = other.baseRev
    other.modifiedFiles' = other.modifiedFiles
  }
}

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

// Invariants to challenge against the mutant

assert NoStaleBaseIntegration {
  always (all a: Agent |
    (a.status = Completed and a.status' = Integrated) implies
      (all f: a.modifiedFiles | Target.fileRev[f] = a.baseRev)
  )
}

assert NoSilentLostUpdate {
  always (all a: Agent |
    (a.status = Completed and a.status' = Integrated) implies
      (a not in Coordinator.flaggedConflicts and (all f: a.modifiedFiles | Target.fileRev[f] = a.baseRev))
  )
}

assert ConflictedAgentNeverIntegrates {
  always (all a: Agent |
    (a in Coordinator.flaggedConflicts) implies always (a.status != Integrated)
  )
}

assert SameFileConflictDetected {
  always (all disj a1, a2: Agent, f: File |
    (a1.status = Integrated and a2.status = Integrated and f in (a1.modifiedFiles & a2.modifiedFiles)) implies
      some Coordinator.flaggedConflicts
  )
}

assert WorkspaceIsolation {
  always (all disj a1, a2: Agent |
    (a1.status = Working and a2.status' != a2.status) implies
      (a1.modifiedFiles' = a1.modifiedFiles and a1.baseRev' = a1.baseRev)
  )
}

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
