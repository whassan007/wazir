// Alloy 6 Negative-Control Mutant: Wazir Atomic Updater (A24)
// Intentionally models Wazir's potential updater vulnerabilities:
// 1. Activating unverified/corrupted or missing artifact without pre-install check
// 2. Failing to clear/invalidate staged version on rollback, enabling instant reactivation
// Invariant violated: "An interrupted update must preserve or recover a valid, trustworthy executable state."

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

pred stageNewRelease {
  UpdaterState.phase in Idle + Completed + Failed + RolledBack
  UpdaterState.activeVersion = V1
  UpdaterState.phase' = Staged
  UpdaterState.stagedVersion' = V2
  UpdaterState.stagedFile' = Valid
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

pred deferActivation {
  UpdaterState.phase = Staged
  UpdaterState.phase' = WaitingForSafeActivation
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

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

// MUTANT 1: beginInstall omits file integrity check (mirrors unverified activation bug)
pred beginInstallMutant {
  UpdaterState.phase in Staged + WaitingForSafeActivation
  some UpdaterState.stagedVersion
  // MISSING GUARD: UpdaterState.stagedFile = Valid is commented out!
  UpdaterState.phase' = Installing
  UpdaterState.backupVersion' = UpdaterState.activeVersion
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
}

pred validateInstall {
  UpdaterState.phase = Installing
  UpdaterState.phase' = Validating
  UpdaterState.activeVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

pred completeInstall {
  UpdaterState.phase = Validating
  UpdaterState.phase' = Completed
  no UpdaterState.stagedVersion'
  no UpdaterState.stagedFile'
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

pred abortToRollback {
  UpdaterState.phase in Installing + Validating
  some UpdaterState.backupVersion
  UpdaterState.phase' = RollingBack
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// MUTANT 2: completeRollback fails to clear stagedVersion (mirrors rollbackUpdateLocked bug)
pred completeRollbackMutant {
  UpdaterState.phase = RollingBack
  some UpdaterState.backupVersion
  UpdaterState.activeVersion' = UpdaterState.backupVersion
  UpdaterState.phase' = RolledBack
  // BUG: stagedVersion is NOT cleared! Remains V2 from old staged history!
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

pred manualRollbackMutant {
  UpdaterState.phase in Completed + Idle
  UpdaterState.activeVersion = V2
  UpdaterState.backupVersion = V1
  UpdaterState.phase' = RollingBack
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  // BUG: stale staged descriptor remains
  UpdaterState.stagedVersion' = V2
  UpdaterState.stagedFile' = Valid
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

// Action: immediate reactivation because stale stagedVersion was retained after rollback
pred reactivateStagedAfterRollbackMutant {
  UpdaterState.phase = RolledBack
  some UpdaterState.stagedVersion
  UpdaterState.phase' = Installing
  UpdaterState.activeVersion' = UpdaterState.activeVersion
  UpdaterState.stagedVersion' = UpdaterState.stagedVersion
  UpdaterState.stagedFile' = UpdaterState.stagedFile
  UpdaterState.backupVersion' = UpdaterState.backupVersion
}

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
    beginInstallMutant or
    validateInstall or
    completeInstall or
    abortToRollback or
    completeRollbackMutant or
    manualRollbackMutant or
    reactivateStagedAfterRollbackMutant or
    stutter
  )
}

assert NoCorruptedOrMissingActivation {
  always (
    (UpdaterState.phase = Installing) implies (UpdaterState.stagedFile = Valid)
  )
}

assert NoReactivationWithoutRestaging {
  always (
    (UpdaterState.phase = RolledBack and UpdaterState.activeVersion = V1) implies
    (no UpdaterState.stagedVersion and (after (UpdaterState.phase != Installing)))
  )
}

// Expected COUNTEREXAMPLE for both checks in this mutant model
check NoCorruptedOrMissingActivation for 10 steps
check NoReactivationWithoutRestaging for 10 steps
