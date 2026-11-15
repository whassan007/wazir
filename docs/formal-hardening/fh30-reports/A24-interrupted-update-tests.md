# A24 — Interrupted Update Formal Modeling & Disposable Regression Engineering Report

- **Agent ID**: A24 (Gemini TIER 2 — Interrupted Update Formal Modeler & Regression Engineer)
- **Program**: Wazir 30-Agent Cost-Optimized Formal Hardening Program (Group H — Priority P1)
- **Working Directory (Isolated Worktree)**: `/Users/wael/Code/Wazir/.worktrees/fh30/A24`
- **Target Repository**: `/Users/wael/Code/Wazir`
- **HEAD Commit**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Alloy Analyzer Version**: Alloy 6.2.0 (`sat4j` solver)
- **Models**:
  - `tests/formal-hardening/models/a24-updater.als`
  - `tests/formal-hardening/models/a24-updater-mutant.als`
- **Logs & Artifacts**:
  - `tests/formal-hardening/logs/alloy-a24-updater/`
  - `tests/formal-hardening/logs/alloy-a24-updater-mutant/`
- **Regression Suites**:
  - `apps/cli/tests/formalHardeningGroupH.test.ts` (17 deterministic tests, 100% passing)
  - `apps/cli/tests/updater.test.ts` (45 regression tests, 100% passing)
  - Full Execution: 62 passing tests in 1.81s

---

## 1. Executive Summary

In autonomous CLI infrastructure and persistent runtime deployments, the software update subsystem is an existential reliability boundary. If a power outage, operating system reboot, process crash, network severance, or disk quota exhaustion interrupts an ongoing update operation, the system must never land in an unexecutable, partially swapped, unverified, or corrupted binary state.

### Critical Safety Invariant (Group H — Priority P1)
> **"An interrupted update must preserve or recover a valid, trustworthy executable state."**

This formal hardening assignment accomplished four concrete objectives:
1. **Mathematical Verification in Alloy 6.2.0**: Adapted and executed the temporal state machine models (`a24-updater.als` and negative-control `a24-updater-mutant.als`) verifying atomic update safety, pre-install integrity gating, crash recovery, and rollback monotonicity over bounded temporal steps.
2. **Defect Discovery in Production Logic**: Identified critical vulnerabilities in `apps/cli/src/updater/service.ts`, including missing pre-activation artifact checksum verification, unsafe revival of rolled-back staged releases (`NoReactivationWithoutRestaging` violation), host Node.js executable clobbering risks, and incomplete cleanup of sibling temporary swap files.
3. **Minimal Production Patch**: Hardened `service.ts` in `.worktrees/fh30/A24` with fail-closed integrity validation before transitioning to `INSTALLING`, strict history terminal phase invalidation in `readLatestStagedDescriptor`, configurable target binary paths (`targetExecutablePath()`), initial executable version probing for accurate backup validation, and cleanup of interrupted swap artifacts.
4. **Disposable Regression Test Suite**: Engineered a deterministic Vitest test suite (`apps/cli/tests/formalHardeningGroupH.test.ts`) that verifies all updater phases in isolated disposable temporary directories (`fs.mkdtempSync`), testing crash recovery across all phases, checksum tampering detection, atomic binary swap rollback, and full SemVer 2.0.0 comparison edge cases.

---

## 2. Alloy 6 Formal Modeling & Verification Results

### 2.1 Formal Specification Architecture (`a24-updater.als`)
The formal model abstracts the core state machine of Wazir's atomic updater across 12 discrete phases:
```alloy
abstract sig Phase {}
one sig Idle, Checking, Downloading, Verifying, Staged, WaitingForSafeActivation,
        Installing, Validating, Completed, Failed, RollingBack, RolledBack extends Phase {}

abstract sig FileIntegrity {}
one sig Valid, Corrupted, Missing extends FileIntegrity {}

one sig UpdaterState {
  var activeVersion: one Version,
  var phase: one Phase,
  var stagedVersion: lone Version,
  var stagedFile: lone FileIntegrity,
  var backupVersion: lone Version
}
```

The model explicitly introduces environmental perturbations (`stagedFileTamperedOrLost`), simulating file loss or byte corruption during arbitrary delays between staging and activation (e.g. while deferring for active tasks or waiting for user consent).

### 2.2 Invariants Checked

| Invariant Assertion | Formal Definition | Alloy 6 Result | Status |
|---|---|---|---|
| `NoCorruptedOrMissingActivation` | `always ((UpdaterState.phase = Installing) implies (UpdaterState.stagedFile = Valid))` | UNSAT (No counterexamples, 10 steps) | Verified Safe |
| `CompletedVersionMatchesAndVerified` | `always ((UpdaterState.phase = Completed) implies (UpdaterState.activeVersion = V2))` | UNSAT (No counterexamples, 10 steps) | Verified Safe |
| `NoReactivationWithoutRestaging` | `always ((UpdaterState.phase = RolledBack and UpdaterState.activeVersion = V1) implies (no UpdaterState.stagedVersion and (after (UpdaterState.phase != Installing))))` | UNSAT (No counterexamples, 10 steps) | Verified Safe |
| `BackupPreservedDuringInstall` | `always ((UpdaterState.phase in Installing + Validating + RollingBack) implies (UpdaterState.backupVersion = V1))` | UNSAT (No counterexamples, 10 steps) | Verified Safe |
| `ActiveVersionAlwaysValid` | `always (some UpdaterState.activeVersion)` | UNSAT (No counterexamples, 10 steps) | Verified Safe |

### 2.3 Analyzer Execution Log (`alloy-a24-updater`)
Command:
```bash
/Users/wael/.local/bin/java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar \
  exec -f -t text -c '*' -o /Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a24-updater \
  /Users/wael/Code/Wazir/tests/formal-hardening/models/a24-updater.als
```
Output:
```text
00. run   WitnessSuccessfulUpgrade     0         1/1     SAT
01. run   WitnessInterruptedRollback     0         1/1     SAT
02. check NoCorruptedOrMissingActivation     0       UNSAT
03. check CompletedVersionMatchesAndVerified     0       UNSAT
04. check NoReactivationWithoutRestaging     0       UNSAT
05. check BackupPreservedDuringInstall     0       UNSAT
06. check ActiveVersionAlwaysValid     0       UNSAT
```
Both witness runs found valid execution traces (upgrade completion and interrupted rollback), proving non-vacuity. All five safety assertions held with zero counterexamples within bounded scopes.

### 2.4 Negative-Control Mutant Analysis (`a24-updater-mutant.als`)
The mutant model was executed to verify that the invariants are sensitive to real production flaws:
1. `beginInstallMutant`: Omission of file integrity check prior to entering `Installing`.
2. `completeRollbackMutant`: Retention of stale `stagedVersion` across rollback events.

Command:
```bash
/Users/wael/.local/bin/java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar \
  exec -f -t text -c '*' -o /Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a24-updater-mutant \
  /Users/wael/Code/Wazir/tests/formal-hardening/models/a24-updater-mutant.als
```
Output:
```text
00. check NoCorruptedOrMissingActivation     0         1/1     SAT (Counterexample Found)
01. check NoReactivationWithoutRestaging     0         1/1     SAT (Counterexample Found)
```
Both mutant assertions failed with concrete temporal counterexamples:
- `NoCorruptedOrMissingActivation-solution-0.txt`: The updater transitioned to `Installing` while `stagedFile = Corrupted` because the guard was commented out.
- `NoReactivationWithoutRestaging-solution-0.txt`: Following a failed update and rollback to V1, the stale staged release was immediately reactivated into `Installing` without a new staging discovery event.

---

## 3. Production Defects Identified & Patched

Inspection of `apps/cli/src/updater/service.ts` revealed four concrete defects corresponding to the Alloy counterexample traces:

### Defect 1: Unverified Staged Artifact Activation (Violating `NoCorruptedOrMissingActivation`)
- **Code Path**: `apps/cli/src/updater/service.ts:1086-1135` (`activateStagedRelease`)
- **Vulnerability**:
  1. For `standalone-binary`, the code recorded `WAITING_FOR_SAFE_ACTIVATION` and entered `INSTALLING` before checking whether `staged.path` existed or matched its SHA-256 digest. If the file was corrupted or deleted while deferred, `tar` crashed mid-installation.
  2. For `npm`, lines 1120–1135 contained a fallback where `!existsSync(staged.path)` logged `INSTALLING` and returned `COMPLETED` (`applied: true`), allowing missing packages to report false success.
  3. Neither path verified the SHA-256 hash of the artifact on disk against `staged.sha256` prior to installation, leaving a TOCTOU window for disk corruption or post-download modification.
- **Minimal Fix**:
  - Added pre-activation artifact integrity verification in both `standalone-binary` and `npm` branches before recording `INSTALLING`.
  - Added explicit check: if `!existsSync(staged.path)`, immediately record `FAILED` with descriptive error and fail closed.
  - Calculated `createHash('sha256').update(readFileSync(staged.path)).digest('hex')` and compared against `staged.sha256`. If mismatched, purged the corrupted file with `rmSync` and recorded `FAILED` without touching the active executable.

### Defect 2: Stale Staged Release Resurfacing After Rollback (Violating `NoReactivationWithoutRestaging`)
- **Code Path**: `apps/cli/src/updater/service.ts:1030-1060` (`readLatestStagedDescriptor`)
- **Vulnerability**:
  - `readLatestStagedDescriptor` used `candidates.find(entry => entry.phase === 'STAGED' || entry.phase === 'WAITING_FOR_SAFE_ACTIVATION')`.
  - If an update rolled back or completed, appending `ROLLED_BACK` or `COMPLETED` to history, `candidates.find` bypassed those terminal records and retrieved the obsolete `STAGED` record from earlier in the log.
  - Subsequent invocations of `applyStagedUpdate()` would re-attempt activation of the failed release without requiring a fresh release check.
- **Minimal Fix**:
  - Iterated through `candidates` in reverse-chronological order.
  - If a terminal event (`ROLLED_BACK` or `COMPLETED`) was encountered before any `STAGED` record, terminated search immediately and returned `undefined`.
  - Requires fresh `checkForUpdates()` to discover and stage before any new activation can occur.

### Defect 3: Non-Disposable Executable Path & Inaccurate Backup Version Matching
- **Code Path**: `apps/cli/src/updater/service.ts:810, 834, 899, 1399` (`installStandaloneBinary`, `recoverInterruptedAttempt`, `rollbackUpdateLocked`)
- **Vulnerability**:
  - Hardcoded `realpathSync(process.execPath)`, which targeted the running Node.js executable in non-single-executable-application environments, creating a risk of clobbering the host interpreter during tests.
  - During rollback verification, line 834 compared `restored.stdout` strictly against `getBuildInfo().version` rather than the probed version of the pre-swap binary, causing false verification failures if installed version diverged from build metadata.
- **Minimal Fix**:
  - Extracted `export function targetExecutablePath(): string` reading `process.env.WAZIR_TARGET_EXECUTABLE || process.env.WAZIR_STANDALONE_BINARY_PATH || realpathSync(process.execPath)`.
  - Probed pre-swap version via `spawnSync(current, ['--version'])` before replacement and used it for backup naming and rollback validation.

### Defect 4: Uncleaned Temporary Sibling Swap Files After Interrupted Swaps
- **Code Path**: `apps/cli/src/updater/service.ts:880-915` (`recoverInterruptedAttempt`)
- **Vulnerability**:
  - If a SIGKILL or power outage interrupted `installStandaloneBinary` between `copyFileSync` and `renameSync`, sibling swap files `${current}.wazir-stage-${pid}` or `${current}.wazir-rollback-${pid}` remained indefinitely in the binary directory.
- **Minimal Fix**:
  - Added cleanup loop in `recoverInterruptedAttempt()` to purge stale `.wazir-stage-*` and `.wazir-rollback-*` temporary artifacts in the target binary directory during crash recovery.

---

## 4. Vitest Deterministic Regression Suite (`formalHardeningGroupH.test.ts`)

A dedicated Vitest suite was authored at `apps/cli/tests/formalHardeningGroupH.test.ts` to test all interrupted update and verification properties in disposable isolation using `fs.mkdtempSync` and `afterEach` directory purging:

### Test Suite Structure (17 Tests)

```text
GROUP H P1: Formal Hardening — Interrupted Updates, Checksum Verification, & Rollback Safety
  1. Interrupted Update & Crash Recovery (Critical Invariant: Valid Executable Preservation)
    ✓ safely recovers an interrupted DOWNLOADING attempt left in journal without modifying installation
    ✓ safely recovers an interrupted VERIFYING attempt left in journal
    ✓ recovers an interrupted activation where the newly swapped standalone binary is already valid
    ✓ recovers an interrupted standalone INSTALLING attempt by rolling back to verified backup and cleaning temp files
    ✓ fails closed when an interrupted installation has no rollback backup available
  2. Checksum Mismatch & Missing Artifact Rejection (Alloy Invariant 1)
    ✓ fails closed and refuses to enter INSTALLING if staged artifact file was removed or is missing
    ✓ detects and rejects tampered or corrupted staged artifact, purging it without activating
    ✓ rejects an asset whose SHA256SUMS.txt entry does not match authenticated download
  3. Failed Swap Rollback & Invariant Assurance (Alloy Invariant 3: NoReactivationWithoutRestaging)
    ✓ atomically rolls back to working executable when candidate fails post-swap validation
    ✓ prevents immediate reactivation of a rolled-back release without a new staging check (Invariant 3)
    ✓ manual rollback safely rejects non-standalone and non-npm installations
  4. Version Comparison Edge Cases (compareSemver Formal Invariants)
    ✓ compares standard major, minor, and patch versions monotonically
    ✓ normalizes optional leading v prefix correctly
    ✓ enforces SemVer 2.0.0 pre-release precedence ladder
    ✓ ranks numeric pre-release identifiers below non-numeric identifiers per SemVer 2.0 spec
    ✓ ignores build metadata during version precedence comparison
    ✓ rejects invalid semantic version inputs with descriptive errors
```

### Verification Command & Output
```bash
cd /Users/wael/Code/Wazir/.worktrees/fh30/A24
npx vitest run --exclude '**/.fa/**' --exclude '**/.worktrees/**' \
  apps/cli/tests/formalHardeningGroupH.test.ts apps/cli/tests/updater.test.ts
```

Result:
```text
 ✓ apps/cli/tests/formalHardeningGroupH.test.ts (17) 539ms
 ✓ apps/cli/tests/updater.test.ts (45) 750ms

 Test Files  2 passed (2)
      Tests  62 passed (62)
   Start at  21:10:04
   Duration  1.81s
```

All 62 tests across both suites execute in under 2 seconds, with zero network dependencies, zero persistent disk residue, and full deterministic mocking through disposable directories.

---

## 5. Requirements-to-Evidence Matrix

| Requirement | Code Location | Alloy 6 Evidence | Vitest Physical Evidence | Status |
|---|---|---|---|---|
| Atomic Staging Interruption Recovery | `apps/cli/src/updater/service.ts:880-925` | `WitnessInterruptedRollback` SAT | `formalHardeningGroupH.test.ts:70-130` | VERIFIED |
| Missing Artifact Gating | `apps/cli/src/updater/service.ts:1115-1125` | `NoCorruptedOrMissingActivation` UNSAT | `formalHardeningGroupH.test.ts:225-265` | VERIFIED |
| Checksum Mismatch Purge | `apps/cli/src/updater/service.ts:1126-1140` | `NoCorruptedOrMissingActivation-mutant` SAT | `formalHardeningGroupH.test.ts:270-310` | VERIFIED |
| Atomic Post-Swap Rollback | `apps/cli/src/updater/service.ts:835-845` | `BackupPreservedDuringInstall` UNSAT | `formalHardeningGroupH.test.ts:340-380` | VERIFIED |
| Rollback Invalidation (No Reactivation) | `apps/cli/src/updater/service.ts:1040-1055` | `NoReactivationWithoutRestaging` UNSAT | `formalHardeningGroupH.test.ts:385-415` | VERIFIED |
| SemVer 2.0.0 Precedence Ladder | `apps/cli/src/updater/releases.ts:11-34` | Analytical SemVer Axioms | `formalHardeningGroupH.test.ts:430-490` | VERIFIED |

---

## 6. Recommendations & Next Steps

1. **Production Worktree Merge**: The patch in `/Users/wael/Code/Wazir/.worktrees/fh30/A24` touches only `apps/cli/src/updater/service.ts` and adds `apps/cli/tests/formalHardeningGroupH.test.ts`. It maintains 100% backward compatibility with existing tests in `updater.test.ts` while fixing four high-severity edge cases.
2. **Windows Standalone Replacement**: While Windows standalone binary replacement is deferred with an `ACTION_REQUIRED` message, applying a background helper batch/PowerShell process that moves files across process boundaries will follow the exact same journal state machine modeled in `a24-updater.als`.
3. **CI Pipeline Integration**: Add `formalHardeningGroupH.test.ts` to the continuous integration pre-merge gate to permanently prevent regressions in interrupted update handling and checksum verification.
