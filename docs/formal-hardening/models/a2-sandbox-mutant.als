// Alloy 6 Formal Hardening Negative Control Mutant Model: A2 Sandbox
// Subsystem: packages/tools/src/paths.ts (Unpatched / Flawed Canonicalize)
// Models the observed defect: when a path component is a dangling symlink,
// realpath throws ENOENT, causing canonicalize to treat the symlink as a
// non-existent regular file under its parent directory. As a result,
// assertInsideProject erroneously approves an escaping symlink.

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

// In the FLAWED implementation, if a node is a symlink whose target does not exist,
// realpath throws ENOENT, and canonicalize falls back to treating it as non-existent child of its parent!
fun flawedCanonicalTarget[n: Node]: lone Node {
  (n.isSymlink = True and n.symlinkTarget.exists = True) => n.symlinkTarget else n
}

// True physical destination if followed
fun physicalTarget[n: Node]: lone Node {
  (n.isSymlink = True) => n.symlinkTarget else n
}

pred flawedValidateInsideProject[n: Node] {
  // Lexical containment
  n.isProject = True
  // Flawed canonical containment check:
  // If target does not exist, flawedCanonicalTarget returns `n` itself, which has isProject = True!
  let target = flawedCanonicalTarget[n] |
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

  all n: Node - l {
    n.exists' = n.exists
    n.isSymlink' = n.isSymlink
    n.symlinkTarget' = n.symlinkTarget
  }
  ExecutionState.lastValidated' = ExecutionState.lastValidated
  ExecutionState.lastWritten' = ExecutionState.lastWritten
  ExecutionState.validationPassed' = ExecutionState.validationPassed
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
  flawedValidateInsideProject[n] => {
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
  ExecutionState.lastValidated = n
  ExecutionState.validationPassed = True

  // Physical write operates on the actual physical destination (following symlink if resolved)
  let target = physicalTarget[n] {
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

// Invariant 1: Any path validated as safe must have its real physical target inside the project.
assert Inv1_DanglingSymlinkSafety {
  always (
    (ExecutionState.validationPassed = True and some ExecutionState.lastValidated) =>
      physicalTarget[ExecutionState.lastValidated].isProject = True
  )
}

// Invariant 2: A symlink pointing outside the project must never pass validation, even if dangling.
assert Inv2_NoDanglingSymlinkEscape {
  always (
    all n: Node |
      (n.isSymlink = True and n.symlinkTarget.isProject = False) =>
        not flawedValidateInsideProject[n]
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

check Inv1_DanglingSymlinkSafety for 6 steps
check Inv2_NoDanglingSymlinkEscape for 6 steps
check Inv3_NoOutsideWrite for 6 steps
check Inv4_VictimFileNeverWritten for 6 steps
