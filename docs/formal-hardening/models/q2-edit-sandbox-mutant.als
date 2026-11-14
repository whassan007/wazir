// Alloy 6 Negative-Control Mutant: Q2 Symlink Escape & Partial Multi-Edit Corruption
// Defects modeled:
//   1. Checks lexicalInWorkspace only, allowing symlink escape outside projectRoot.
//   2. Writes hunk 1 to disk before hunk 2 fails, leaving VPartial on disk.

open util/boolean

abstract sig TargetNode {
  lexicalInWorkspace: one Bool,
  realpathInWorkspace: one Bool,
  isFrozenSpec: one Bool
}

one sig SrcFile, SymlinkToHostSecret, FrozenSpecFile extends TargetNode {}

fact NodeProperties {
  SrcFile.lexicalInWorkspace = True
  SrcFile.realpathInWorkspace = True
  SrcFile.isFrozenSpec = False

  SymlinkToHostSecret.lexicalInWorkspace = True
  SymlinkToHostSecret.realpathInWorkspace = False
  SymlinkToHostSecret.isFrozenSpec = False

  FrozenSpecFile.lexicalInWorkspace = True
  FrozenSpecFile.realpathInWorkspace = True
  FrozenSpecFile.isFrozenSpec = True
}

abstract sig ContentVersion {}
one sig V0, V1, VPartial extends ContentVersion {}

abstract sig HunkBatch {
  target: one TargetNode,
  allHunksMatch: one Bool
}

one sig PartialFailMultiEdit, SymlinkEscapeEdit extends HunkBatch {}

fact BatchCatalog {
  PartialFailMultiEdit.target = SrcFile
  PartialFailMultiEdit.allHunksMatch = False

  SymlinkEscapeEdit.target = SymlinkToHostSecret
  SymlinkEscapeEdit.allHunksMatch = True
}

one sig FS {
  var content: TargetNode -> one ContentVersion,
  var readObserved: set TargetNode
}

pred init {
  all n: TargetNode | FS.content[n] = V0
  no FS.readObserved
}

// DEFECT 1: Lexical check only (misses symlink escape) + DEFECT 2: Partial write on failed hunk batch!
pred buggyApplyMultiEdit[b: HunkBatch] {
  FS.readObserved' = FS.readObserved
  b.target.lexicalInWorkspace = True implies {
    b.allHunksMatch = True implies
      FS.content' = FS.content ++ (b.target -> V1)
    else
      FS.content' = FS.content ++ (b.target -> VPartial)
  } else {
    FS.content' = FS.content
  }
}

pred stutter {
  FS.content' = FS.content
  FS.readObserved' = FS.readObserved
}

fact Trace {
  init
  always ((some b: HunkBatch | buggyApplyMultiEdit[b]) or stutter)
}

assert RealpathContainmentOnWrite {
  always (all n: TargetNode | n.realpathInWorkspace = False implies FS.content[n] = V0)
}

assert MultiEditTransactionalAtomicity {
  always (all n: TargetNode | FS.content[n] != VPartial)
}

run WitnessMutantExecutes {
  eventually (FS.content[SrcFile] = VPartial)
} for 4 steps

check RealpathContainmentOnWrite for 4 steps
check MultiEditTransactionalAtomicity for 4 steps
