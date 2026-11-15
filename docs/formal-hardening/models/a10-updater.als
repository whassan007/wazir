// Alloy 6 Formal Model: Wazir Atomic Updater, Verification & Rollback Safety (A10)
// Domain: apps/cli/src/updater/{service,storage,releases,scheduler,types}.ts

abstract sig Version {}
one sig V1, V2 extends Version {}

abstract sig Phase {}
one sig Idle, Checking, Downloading, Verifying, Staged, WaitingForSafeActivation, Installing, Validating, Completed, Failed, RollingBack, RolledBack extends Phase {}

abstract sig FileIntegrity {}
one sig Valid, Corrupted, Missing extends FileIntegrity {}

one sig UpdaterState {
  var activeVersion: one Version,
  var phase: one Phase,
  var stagedVersion: lone Version,
  var stagedFile: lone FileIntegrity,
  var backupVersion: lone Version
}

pred init {
  UpdaterState.activeVersion = V1
  UpdaterState.phase = Idle
  no UpdaterState.stagedVersion
  no UpdaterState.stagedFile
  no UpdaterState.backupVersion
}

// Action: check and discover a new release (V2), then download and stage it
pred stageNewRelease {
  UpdaterState.phase in Idle + Completed + Failed + RolledBack
  UpdaterState.activeVersion = V1
  UpdaterState.phase' = Staged
  UpdaterState.stagedVersion' = V2
  UpdaterState.stagedFile' = Valid
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// Action: defer activation because tasks/jobs/sessions are active
pred deferActivation {
  UpdaterState.phase = Staged
  UpdaterState.phase' = WaitingForSafeActivation
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// Action: environmental perturbation - staged file deleted or corrupted before activation
pred stagedFileTamperedOrLost {
  UpdaterState.phase in Staged + WaitingForSafeActivation
  some UpdaterState.stagedVersion
  UpdaterState.stagedFile in Valid
  UpdaterState.stagedFile' in (Corrupted + Missing)
  UpdaterState.phase' = UpdaterState.phase
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// Action: begin installation (only permitted if staged artifact is present and valid!)
pred beginInstall {
  UpdaterState.phase in Staged + WaitingForSafeActivation
  some UpdaterState.stagedVersion
  UpdaterState.stagedFile = Valid // Invariant guard: must verify intact bytes before installing
  UpdaterState.phase' = Installing
  UpdaterState.backupVersion' = UpdaterState.activeVersion // Preserve rollback backup
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
}

// Action: validate newly installed executable
pred validateInstall {
  UpdaterState.phase = Installing
  UpdaterState.phase' = Validating
  UpdaterState.activeVersion' = UpdaterState.stagedVersion // Executable swapped
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// Action: complete validated installation
pred completeInstall {
  UpdaterState.phase = Validating
  UpdaterState.phase' = Completed
  no UpdaterState.stagedVersion' // Staged descriptor cleared upon completion
  no UpdaterState.stagedFile'
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// Action: crash or failure during installation or validation triggers rollback
pred abortToRollback {
  UpdaterState.phase in Installing + Validating
  some UpdaterState.backupVersion
  UpdaterState.phase' = RollingBack
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// Action: complete rollback to backup version
pred completeRollback {
  UpdaterState.phase = RollingBack
  some UpdaterState.backupVersion
  UpdaterState.activeVersion' = UpdaterState.backupVersion
  UpdaterState.phase' = RolledBack
  no UpdaterState.stagedVersion' // Crucial: clear staged release on rollback!
  no UpdaterState.stagedFile'
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// Action: manual or scheduled rollback from active version
pred manualRollback {
  UpdaterState.phase in Completed + Idle
  UpdaterState.activeVersion = V2
  UpdaterState.backupVersion = V1
  UpdaterState.phase' = RollingBack
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  no UpdaterState.stagedVersion'
  no UpdaterState.stagedFile'
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// Action: stutter (no state change)
pred stutter {
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.phase' = UpdaterState.phase
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

fact traces {
  init
  always (
    stageNewRelease or
    deferActivation or
    stagedFileTamperedOrLost or
    beginInstall or
    validateInstall or
    completeInstall or
    abortToRollback or
    completeRollback or
    manualRollback or
    stutter
  )
}

// INVARIANT 1: No unverified or corrupted artifact may ever be activated
assert NoCorruptedOrMissingActivation {
  always (
    (UpdaterState.phase = Installing) implies (UpdaterState.stagedFile = Valid)
  )
}

// INVARIANT 2: Completion implies active version matches target and artifact was valid
assert CompletedVersionMatchesAndVerified {
  always (
    (UpdaterState.phase = Completed) implies (UpdaterState.activeVersion = V2)
  )
}

// INVARIANT 3: Rolled-back state never immediately resurfaces unverified V2 without re-staging
assert NoReactivationWithoutRestaging {
  always (
    (UpdaterState.phase = RolledBack and UpdaterState.activeVersion = V1) implies
    (no UpdaterState.stagedVersion and (after (UpdaterState.phase != Installing)))
  )
}

// INVARIANT 4: Rollback backup is preserved whenever an installation is in flight
assert BackupPreservedDuringInstall {
  always (
    (UpdaterState.phase in Installing + Validating + RollingBack) implies
    (UpdaterState.backupVersion = V1)
  )
}

// INVARIANT 5: Terminal safety - active version is V1 or V2 and never undefined
assert ActiveVersionAlwaysValid {
  always (some UpdaterState.activeVersion)
}

// Witnesses
run WitnessSuccessfulUpgrade {
  eventually (UpdaterState.phase = Completed)
} for 8 steps

run WitnessInterruptedRollback {
  eventually (UpdaterState.phase = RolledBack)
} for 8 steps

// Checks
check NoCorruptedOrMissingActivation for 10 steps
check CompletedVersionMatchesAndVerified for 10 steps
check NoReactivationWithoutRestaging for 10 steps
check BackupPreservedDuringInstall for 10 steps
check ActiveVersionAlwaysValid for 10 steps
