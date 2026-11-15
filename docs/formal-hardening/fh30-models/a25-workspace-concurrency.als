module a25_workspace_concurrency

sig Agent {}
sig File {}
sig Content {}

// Physical disk state of the shared workspace
one sig Workspace {
  var file: File -> lone Content
}

// In-memory view of each agent
one sig AgentState {
  var readVersion: Agent -> File -> lone Content,
  var confirmedEdit: Agent -> File -> lone Content,
  var inFlightDirty: Agent -> set File
}

var sig LostUpdateObserved in Agent {}
var sig ContaminatedCommitObserved in Agent {}

pred init {
  // Initial state: some file content exists
  all f: File | one c: Content | Workspace.file[f] = c
  no AgentState.readVersion
  no AgentState.confirmedEdit
  no AgentState.inFlightDirty
  no LostUpdateObserved
  no ContaminatedCommitObserved
}

// Agent reads file into context
pred agentRead[a: Agent, f: File] {
  some Workspace.file[f]
  AgentState.readVersion' = AgentState.readVersion ++ (a -> f -> Workspace.file[f])
  Workspace.file' = Workspace.file
  AgentState.confirmedEdit' = AgentState.confirmedEdit
  AgentState.inFlightDirty' = AgentState.inFlightDirty
  LostUpdateObserved' = LostUpdateObserved
  ContaminatedCommitObserved' = ContaminatedCommitObserved
}

// Vulnerable Write: Agent writes new content without verifying base revision/hash (Wazir writeTool / editTool)
pred vulnerableWrite[a: Agent, f: File, newC: Content] {
  some AgentState.readVersion[a][f]
  let oldDisk = Workspace.file[f] | {
    let overwrittenAgents = { other: Agent - a |
      some AgentState.confirmedEdit[other][f] and
      AgentState.confirmedEdit[other][f] = oldDisk and
      oldDisk != AgentState.readVersion[a][f]
    } | {
      LostUpdateObserved' = LostUpdateObserved + overwrittenAgents
    }
  }

  Workspace.file' = Workspace.file ++ (f -> newC)
  AgentState.readVersion' = AgentState.readVersion
  AgentState.confirmedEdit' = AgentState.confirmedEdit
  AgentState.inFlightDirty' = AgentState.inFlightDirty + (a -> f)
  ContaminatedCommitObserved' = ContaminatedCommitObserved
}

// Agent completes verification tests on its dirty files
pred confirmWork[a: Agent, f: File] {
  f in AgentState.inFlightDirty[a]
  AgentState.confirmedEdit' = AgentState.confirmedEdit ++ (a -> f -> Workspace.file[f])
  AgentState.inFlightDirty' = AgentState.inFlightDirty - (a -> f)
  Workspace.file' = Workspace.file
  AgentState.readVersion' = AgentState.readVersion
  LostUpdateObserved' = LostUpdateObserved
  ContaminatedCommitObserved' = ContaminatedCommitObserved
}

// Vulnerable Commit: Agent commits shared worktree using `git add -A` (Wazir fleetRunner.ts:643 + worktreeManager.ts:385)
pred vulnerableSharedCommit[a: Agent] {
  // If there are in-flight unverified files written by OTHER agents in the worktree:
  (some other: Agent - a | some AgentState.inFlightDirty[other]) => {
    ContaminatedCommitObserved' = ContaminatedCommitObserved + a
  } else {
    ContaminatedCommitObserved' = ContaminatedCommitObserved
  }

  Workspace.file' = Workspace.file
  AgentState.readVersion' = AgentState.readVersion
  AgentState.confirmedEdit' = AgentState.confirmedEdit
  AgentState.inFlightDirty' = AgentState.inFlightDirty
  LostUpdateObserved' = LostUpdateObserved
}

pred stutter {
  Workspace.file' = Workspace.file
  AgentState.readVersion' = AgentState.readVersion
  AgentState.confirmedEdit' = AgentState.confirmedEdit
  AgentState.inFlightDirty' = AgentState.inFlightDirty
  LostUpdateObserved' = LostUpdateObserved
  ContaminatedCommitObserved' = ContaminatedCommitObserved
}

fact traces {
  init
  always (
    (some a: Agent, f: File | agentRead[a, f]) or
    (some a: Agent, f: File, c: Content | vulnerableWrite[a, f, c]) or
    (some a: Agent, f: File | confirmWork[a, f]) or
    (some a: Agent | vulnerableSharedCommit[a]) or
    stutter
  )
}

// Witness 1: Valid multi-agent execution
run WitnessMultiAgentExecution {
  eventually (some a: Agent, f: File | some AgentState.confirmedEdit[a][f])
} for 3 but 2 Agent, 2 File, 3 Content, 6 steps

// Invariant 1: One agent must not silently overwrite another agent's confirmed work
assert NoSilentLostUpdate {
  always (no LostUpdateObserved)
}

// Invariant 2: An agent must not commit unverified dirty files from another agent
assert NoContaminatedCommit {
  always (no ContaminatedCommitObserved)
}

// Check Invariant 1: Counterexample found (SAT)
check NoSilentLostUpdate for 3 but 2 Agent, 2 File, 3 Content, 6 steps

// Check Invariant 2: Counterexample found (SAT)
check NoContaminatedCommit for 3 but 2 Agent, 2 File, 3 Content, 6 steps
