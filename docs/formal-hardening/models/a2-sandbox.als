// Alloy 6 Formal Hardening Model: A2 Shell & Path Sandbox Isolation
// Subsystem: packages/tools/src/paths.ts, sandbox.ts, filesystem.ts
// Models path containment validation, dangling symlink resolution,
// TOCTOU verification, and filesystem mutation safety.

open util/boolean

abstract sig Node {
  isProject: one Bool,
  isTemp: one Bool,
  parent: lone Node,
  var exists: one Bool,
  var isSymlink: one Bool,
  var symlinkTarget: lone Node
}

one sig RootFS extends Node {}
one sig ProjectRoot extends Node {}
one sig TempDir extends Node {}
one sig OutsideDir extends Node {}
one sig InsideDir extends Node {}
one sig OutsideVictimFile extends Node {}
one sig ProjectFile extends Node {}
one sig LinkNode extends Node {}

one sig ExecutionState {
  var lastValidated: lone Node,
  var lastWritten: lone Node,
  var validationPassed: one Bool
}

fact StaticTopology {
  // Tree hierarchy
  no RootFS.parent
  ProjectRoot.parent = RootFS
  TempDir.parent = RootFS
  OutsideDir.parent = RootFS
  InsideDir.parent = ProjectRoot
  OutsideVictimFile.parent = OutsideDir
  ProjectFile.parent = InsideDir
  LinkNode.parent = ProjectRoot

  // Project containment flags
  RootFS.isProject = False
  OutsideDir.isProject = False
  OutsideVictimFile.isProject = False
  TempDir.isProject = False
  ProjectRoot.isProject = True
  InsideDir.isProject = True
  ProjectFile.isProject = True
  LinkNode.isProject = True

  // Temp flags
  RootFS.isTemp = False
  OutsideDir.isTemp = False
  OutsideVictimFile.isTemp = False
  ProjectRoot.isTemp = False
  InsideDir.isTemp = False
  ProjectFile.isTemp = False
  LinkNode.isTemp = False
  TempDir.isTemp = True
}

// In the sound model, resolving a node traverses symlinks even if the target is currently non-existent.
fun canonicalTarget[n: Node]: lone Node {
  (n.isSymlink = True) => n.symlinkTarget else n
}

pred soundValidateInsideProject[n: Node] {
  // Lexical containment
  n.isProject = True
  // Canonical containment: target (even if dangling) must be inside project
  let target = canonicalTarget[n] |
    some target and target.isProject = True
}

pred init {
  RootFS.exists = True
  ProjectRoot.exists = True
  TempDir.exists = True
  InsideDir.exists = True
  OutsideDir.exists = True
  ProjectFile.exists = True
  OutsideVictimFile.exists = False
  LinkNode.exists = False

  all n: Node | n.isSymlink = False and no n.symlinkTarget

  no ExecutionState.lastValidated
  no ExecutionState.lastWritten
  ExecutionState.validationPassed = False
}

pred createDanglingSymlink[l: Node, target: Node] {
  l = LinkNode
  l.exists = False
  l.exists' = True
  l.isSymlink' = True
  l.symlinkTarget' = target

  // frame conditions for other nodes
  all n: Node - l {
    n.exists' = n.exists
    n.isSymlink' = n.isSymlink
    n.symlinkTarget' = n.symlinkTarget
  }
  // Symlink mutation invalidates prior validation certificate (anti-TOCTOU)
  ExecutionState.lastValidated' = ExecutionState.lastValidated
  ExecutionState.lastWritten' = ExecutionState.lastWritten
  ExecutionState.validationPassed' = False
}

pred createOutsideTarget[target: Node] {
  target = OutsideVictimFile
  target.exists = False
  target.exists' = True
  target.isSymlink' = False
  no target.symlinkTarget'

  all n: Node - target {
    n.exists' = n.exists
    n.isSymlink' = n.isSymlink
    n.symlinkTarget' = n.symlinkTarget
  }
  ExecutionState.lastValidated' = ExecutionState.lastValidated
  ExecutionState.lastWritten' = ExecutionState.lastWritten
  ExecutionState.validationPassed' = ExecutionState.validationPassed
}

pred validateToolPath[n: Node] {
  ExecutionState.lastValidated' = n
  soundValidateInsideProject[n] => {
    ExecutionState.validationPassed' = True
  } else {
    ExecutionState.validationPassed' = False
  }
  ExecutionState.lastWritten' = ExecutionState.lastWritten

  all node: Node {
    node.exists' = node.exists
    node.isSymlink' = node.isSymlink
    node.symlinkTarget' = node.symlinkTarget
  }
}

pred writeProjectFile[n: Node] {
  // Can only write if validation passed on this node AND still holds at commit time
  ExecutionState.lastValidated = n
  ExecutionState.validationPassed = True
  soundValidateInsideProject[n]

  let target = canonicalTarget[n] {
    some target
    target.exists' = True
    ExecutionState.lastWritten' = target

    all other: Node - target {
      other.exists' = other.exists
    }
  }

  all node: Node {
    node.isSymlink' = node.isSymlink
    node.symlinkTarget' = node.symlinkTarget
  }
  ExecutionState.lastValidated' = ExecutionState.lastValidated
  ExecutionState.validationPassed' = ExecutionState.validationPassed
}

pred stutter {
  all n: Node {
    n.exists' = n.exists
    n.isSymlink' = n.isSymlink
    n.symlinkTarget' = n.symlinkTarget
  }
  ExecutionState.lastValidated' = ExecutionState.lastValidated
  ExecutionState.lastWritten' = ExecutionState.lastWritten
  ExecutionState.validationPassed' = ExecutionState.validationPassed
}

fact traces {
  init
  always (
    (some target: Node | createDanglingSymlink[LinkNode, target]) or
    createOutsideTarget[OutsideVictimFile] or
    (some n: Node | validateToolPath[n]) or
    (some n: Node | writeProjectFile[n]) or
    stutter
  )
}

// ---------------------------------------------------------------------------
// Assertions & Invariants
// ---------------------------------------------------------------------------

// Invariant 1: Any path validated as safe must have its canonical target inside the project.
assert Inv1_DanglingSymlinkSafety {
  always (
    (ExecutionState.validationPassed = True and some ExecutionState.lastValidated) =>
      canonicalTarget[ExecutionState.lastValidated].isProject = True
  )
}

// Invariant 2: A symlink pointing outside the project must never pass validation, even if dangling.
assert Inv2_NoDanglingSymlinkEscape {
  always (
    all n: Node |
      (n.isSymlink = True and n.symlinkTarget.isProject = False) =>
        not soundValidateInsideProject[n]
  )
}

// Invariant 3: Any committed write must land strictly on a project node, never an outside node.
assert Inv3_NoOutsideWrite {
  always (
    some ExecutionState.lastWritten =>
      ExecutionState.lastWritten.isProject = True
  )
}

// Invariant 4: No tool write can occur on OutsideVictimFile.
assert Inv4_VictimFileNeverWritten {
  always (
    ExecutionState.lastWritten != OutsideVictimFile
  )
}

// ---------------------------------------------------------------------------
// Run Witnesses
// ---------------------------------------------------------------------------

run WitnessProjectWrite {
  eventually (ExecutionState.lastWritten = ProjectFile)
} for 4 steps

run WitnessDanglingSymlinkCreated {
  eventually (LinkNode.isSymlink = True and LinkNode.symlinkTarget = OutsideVictimFile)
} for 4 steps

check Inv1_DanglingSymlinkSafety for 6 steps
check Inv2_NoDanglingSymlinkEscape for 6 steps
check Inv3_NoOutsideWrite for 6 steps
check Inv4_VictimFileNeverWritten for 6 steps
