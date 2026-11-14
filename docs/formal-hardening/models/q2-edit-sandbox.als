// Alloy 6 Formal Hardening Model: Q2 Smart Edit, Multi-Edit Atomicity & Sandbox Realpath Containment
// Subsystem: packages/tools/src/{editMatcher,multiEdit,readManyFiles,fencing}.ts
// Verifies:
//   1. FH-A2-01 Realpath Containment: symlink inside workspace pointing to host file outside projectRoot
//      is NEVER read by read_many_files or written by edit / multi_edit.
//   2. SPEC_WRITE_FENCE: frozen formal specification files under specs/ are NEVER mutated.
//   3. Transactional Multi-Edit Atomicity: if a multi_edit operation has >=1 failing hunk,
//      zero hunks are committed to disk (file content remains identical to pre-call state).

open util/boolean

abstract sig TargetNode {
  lexicalInWorkspace: one Bool,
  realpathInWorkspace: one Bool,
  isFrozenSpec: one Bool
}

one sig SrcFile, SymlinkToHostSecret, FrozenSpecFile, HostOutsideFile extends TargetNode {}

fact NodeProperties {
  SrcFile.lexicalInWorkspace = True
  SrcFile.realpathInWorkspace = True
  SrcFile.isFrozenSpec = False

  // Symlink lives lexically inside workspace, but realpath resolves outside!
  SymlinkToHostSecret.lexicalInWorkspace = True
  SymlinkToHostSecret.realpathInWorkspace = False
  SymlinkToHostSecret.isFrozenSpec = False

  FrozenSpecFile.lexicalInWorkspace = True
  FrozenSpecFile.realpathInWorkspace = True
  FrozenSpecFile.isFrozenSpec = True

  HostOutsideFile.lexicalInWorkspace = False
  HostOutsideFile.realpathInWorkspace = False
  HostOutsideFile.isFrozenSpec = False
}

abstract sig ContentVersion {}
one sig V0, V1, VPartial extends ContentVersion {}

abstract sig HunkBatch {
  target: one TargetNode,
  allHunksMatch: one Bool
}

one sig ValidMultiEdit, PartialFailMultiEdit, SymlinkEscapeEdit, SpecTamperEdit extends HunkBatch {}

fact BatchCatalog {
  ValidMultiEdit.target = SrcFile
  ValidMultiEdit.allHunksMatch = True

  PartialFailMultiEdit.target = SrcFile
  PartialFailMultiEdit.allHunksMatch = False

  SymlinkEscapeEdit.target = SymlinkToHostSecret
  SymlinkEscapeEdit.allHunksMatch = True

  SpecTamperEdit.target = FrozenSpecFile
  SpecTamperEdit.allHunksMatch = True
}

one sig FS {
  var content: TargetNode -> one ContentVersion,
  var readObserved: set TargetNode,
  var lastAttemptedBatch: lone HunkBatch
}

pred canRead[n: TargetNode] {
  n.lexicalInWorkspace = True
  n.realpathInWorkspace = True
}

pred canWrite[n: TargetNode] {
  n.lexicalInWorkspace = True
  n.realpathInWorkspace = True
  n.isFrozenSpec = False
}

pred init {
  all n: TargetNode | FS.content[n] = V0
  no FS.readObserved
  no FS.lastAttemptedBatch
}

// read_many_files filters every resolved path through realpath containment
pred readManyFiles[requested: set TargetNode] {
  some requested
  let allowed = { n: requested | canRead[n] } | {
    FS.readObserved' = FS.readObserved + allowed
    FS.content' = FS.content
    no FS.lastAttemptedBatch'
  }
}

// Atomic multi_edit computes all hunks in memory and writes via temp+rename ONLY if canWrite and allHunksMatch
pred applyMultiEdit[b: HunkBatch] {
  FS.lastAttemptedBatch' = b
  FS.readObserved' = FS.readObserved
  (canWrite[b.target] and b.allHunksMatch = True) implies {
    FS.content' = FS.content ++ (b.target -> V1)
  } else {
    FS.content' = FS.content
  }
}

pred stutter {
  FS.content' = FS.content
  FS.readObserved' = FS.readObserved
  no FS.lastAttemptedBatch'
}

fact Trace {
  init
  always (
    (some r1, r2: TargetNode | readManyFiles[r1 + r2]) or
    (some b: HunkBatch | applyMultiEdit[b]) or
    stutter
  )
}

assert RealpathContainmentOnReadAndWrite {
  always (
    (all n: FS.readObserved | n.realpathInWorkspace = True) and
    (all n: TargetNode | n.realpathInWorkspace = False implies FS.content[n] = V0)
  )
}

assert FrozenSpecsImmutable {
  always (all n: TargetNode | n.isFrozenSpec = True implies FS.content[n] = V0)
}

assert MultiEditTransactionalAtomicity {
  always (
    (all n: TargetNode | FS.content[n] != VPartial) and
    (all b: HunkBatch |
      (FS.lastAttemptedBatch' = b and b.allHunksMatch = False) implies
        FS.content'[b.target] = FS.content[b.target])
  )
}

run WitnessValidEditAndRead {
  eventually (SrcFile in FS.readObserved and FS.content[SrcFile] = V1)
} for 5 steps

run WitnessFailedBatchRolledBack {
  eventually (FS.lastAttemptedBatch = PartialFailMultiEdit and FS.content[SrcFile] = V0)
} for 5 steps

check RealpathContainmentOnReadAndWrite for 6 steps
check FrozenSpecsImmutable for 6 steps
check MultiEditTransactionalAtomicity for 6 steps
