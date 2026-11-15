# A22 — Formal Audit Report: Atomic Update Behavior, Installation Integrity & Rollback Safety

- **Agent ID**: A22 (Gemini TIER 1 — Atomic Update & Rollback Auditor)
- **Role**: Atomic Update, Interruption Recovery & Rollback Auditor
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Target HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Audit Group**: GROUP H P1 — Update, Rollback & Installation Integrity
- **Critical Invariant**: 
  > *"An interrupted update must preserve or recover a valid, trustworthy executable state."*
- **Downstream Collaborators**:
  - Agent A23 (Release Metadata, Checksums & Package Consistency Auditor)
  - Agent A24 (Interruption Regression & Test Engineer)
  - Agent A30 (Final Verifier)
- **Formal Alloy 6 Models**:
  - Validated Specification: [`tests/formal-hardening/models/a24-updater.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a24-updater.als)
  - Negative-Control Mutant: [`tests/formal-hardening/models/a24-updater-mutant.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a24-updater-mutant.als)
- **Executable Reproduction Suite**: [`tests/formal-hardening/reproductions/a22-atomic-update.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/a22-atomic-update.test.ts) (6 deterministic passing tests)
- **Status**: **CONFIRMED PRODUCTION DEFECTS**

---

## 1. Executive Summary

A formal hardening audit of Wazir's automated and manual updater, installation integrity, crash recovery, active task deferral, and rollback mechanisms was performed at commit `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`.

The audit inspected core updater and installer components across the repository:
- **CLI Updater Subsystem**: [`apps/cli/src/updater/service.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts), [`apps/cli/src/updater/storage.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/storage.ts), [`apps/cli/src/updater/releases.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/releases.ts), [`apps/cli/src/updater/scheduler.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/scheduler.ts), [`apps/cli/src/updater/types.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/types.ts)
- **Command & Diagnostic Entry Points**: [`apps/cli/src/index.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/index.ts), [`apps/cli/src/version.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/version.ts), [`apps/cli/src/crashHandler.ts`](file:///Users/wael/Code/Wazir/apps/cli/src/crashHandler.ts)
- **Packaging & Installation Scripts**: [`scripts/install.sh`](file:///Users/wael/Code/Wazir/scripts/install.sh), [`scripts/install.ps1`](file:///Users/wael/Code/Wazir/scripts/install.ps1), [`scripts/build-binary.mjs`](file:///Users/wael/Code/Wazir/scripts/build-binary.mjs), [`scripts/release-verify.mjs`](file:///Users/wael/Code/Wazir/scripts/release-verify.mjs), [`scripts/release-integrity.mjs`](file:///Users/wael/Code/Wazir/scripts/release-integrity.mjs), [`scripts/package-release-artifacts.mjs`](file:///Users/wael/Code/Wazir/scripts/package-release-artifacts.mjs)
- **Existing Test Coverage**: [`apps/cli/tests/updater.test.ts`](file:///Users/wael/Code/Wazir/apps/cli/tests/updater.test.ts)

### Key Audit Verdict
Wazir implements a multi-phase state machine with authenticated SHA-256 manifest verification, launchd/systemd background scheduling, and active task deferral logic (`ISS-017`). 

However, **severe architectural and concurrency gaps violate the core safety invariant ("An interrupted update must preserve or recover a valid, trustworthy executable state")**:

1. **P0 (Critical) — Production Test Backdoor Causes False Success on Missing Artifacts**: In `activateStagedRelease()`, an intentional test stub branch intercepts missing files (`!existsSync(staged.path)`) and falsely returns `phase: 'COMPLETED'` with `applied: true` without installing anything or validating executable health.
2. **P0 (Critical) — Host Runtime Clobbering via Unchecked `process.execPath`**: In standalone binary mode, `installStandaloneBinary()`, `recoverInterruptedAttempt()`, and `rollbackUpdateLocked()` resolve the installation target via `realpathSync(process.execPath)`. When Wazir is executed via Node.js or wrapper shims, this overwrites the host machine's Node runtime (`/usr/local/bin/node` or `~/.nvm/.../bin/node`) with the Wazir standalone binary.
3. **P0 (Critical) — Terminal Broken State on Interrupted Recovery**: If crash recovery rollback fails once (e.g., due to an in-use file lock or network interruption), `recoverInterruptedAttempt()` writes `phase: 'FAILED'` to `journal.json`. On all subsequent invocations, recovery is permanently bypassed because `journal.phase` is no longer in the active recovery set, stranding the user in a broken installation.
4. **P1 (High) — Lexicographical Version Inversion & Prerelease Rejection in Rollback**: `rollbackUpdateLocked()` sorts backup filenames lexicographically (`sort().reverse()`), prioritizing `0.2.9` over `0.2.10`. Furthermore, its version regex (`/^standalone-(\d+\.\d+\.\d+)-/`) truncates prerelease tags, causing validation mismatches and aborted rollbacks.
5. **P1 (High) — npm Global Symlink Dangling and Offline Rollback Failure**: `restoreNpmBackup()` invokes `npm install -g <backup_dir>`, which creates symlinks pointing directly into `~/.wazir/updates/backups/`. When backups are later pruned, the active installation is left with dangling symlinks and crashes with `MODULE_NOT_FOUND`.
6. **P1 (High) — Non-Atomic In-Place Launcher Overwrites in Shell/PowerShell Installers**: `scripts/install.sh` and `scripts/install.ps1` overwrite the active launcher in-place using `cat > "$BIN_DIR/wa"` and `WriteAllText`. A crash or concurrent execution reads an empty or truncated binary.
7. **P1 (Medium) — Permanent Updater Deadlock on OS PID Recycling**: `acquireUpdateLock()` verifies owner liveness via `process.kill(lock.pid, 0)`. If the OS recycles the PID to an unrelated daemon, the lock is treated as permanently held because no lease timestamp or TTL is enforced.
8. **P1 (Medium) — TOCTOU Concurrency Race Between Active Task Check and Activation**: Neither `applyStagedUpdate()` nor `activateStagedRelease()` acquires an execution admission barrier or task lock. A worker can dispatch a new task while `npm install` or binary renaming is in flight.

---

## 2. Architecture & Life-Cycle Tracing

### 2.1 Complete Update & Rollback State Machine

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Checking: checkForUpdates()
    Checking --> UpToDate: version <= current
    Checking --> UpdateAvailable: version > current
    Checking --> Failed: lookup error / bad manifest
    
    UpdateAvailable --> Downloading: autoDownload enabled
    Downloading --> Verifying: checksum verified
    Verifying --> Staged: authenticated SHA256 match
    
    Staged --> WaitingForSafeActivation: activeWork.busy == true
    WaitingForSafeActivation --> Staged: drained / force == true
    
    Staged --> Installing: activateStagedRelease()
    Installing --> Validating: binary swapped / npm installed
    Validating --> Completed: version output matches
    
    Installing --> RollingBack: swap or install failed
    Validating --> RollingBack: validation failed
    RollingBack --> RolledBack: backup restored & verified
    RollingBack --> Failed: rollback failed (FATAL)
    
    Completed --> Idle
    RolledBack --> Idle
    Failed --> Idle: backed-off retry
```

### 2.2 Phase-by-Phase Trace Analysis

#### Phase 1: Locking & Mutual Exclusion (`storage.ts:73-93`)
- Updater checks acquire an exclusive lock via `openSync(lockPath(), 'wx', 0o600)`.
- If `updater.lock` exists, the updater reads `{ pid }` and probes `process.kill(pid, 0)`.
- If the owner process is dead (ESRCH), it unlinks `updater.lock` and recursively calls `acquireUpdateLock()`.

#### Phase 2: Interruption Recovery (`service.ts:879-909`)
- Before checking releases, `checkForUpdates()` inspects `journal.json` via `recoverInterruptedAttempt()`.
- If `journal.phase` is in `['DOWNLOADING', 'VERIFYING']`: records `FAILED` (clean recovery, active install untouched).
- If `journal.phase` is in `['INSTALLING', 'VALIDATING']`:
  - If currently running version matches `journal.availableVersion`, marks `COMPLETED`.
  - Otherwise, attempts to restore the latest backup matching `journal.installedVersion`.

#### Phase 3: Discovery & Authenticated Download (`releases.ts:71-151`)
- GitHub release metadata is fetched from `https://api.github.com/repos/whassan007/wazir/releases`.
- Artifact name is mapped by OS and architecture (`platformArtifactNames`).
- The official `SHA256SUMS.txt` manifest is fetched and its SHA-256 verified against GitHub's authenticated asset digest.
- The artifact bytes are streamed via `readBoundedBody()` with a strict 512 MiB bound and compared against the manifest checksum.

#### Phase 4: Active Work Detection & Safe Deferral (`service.ts:511-622`, `1340-1356`)
- `evaluateActiveWork()` inspects `store.json` and KeyValueStore instances for active executions (`execution/*`), running jobs (`job/*`), and worker leases (`dispatch/*`, `lease/*`).
- Also probes OS processes using `ps -axo command=` or PowerShell to check for active `wa` commands.
- If busy and not forced, records `WAITING_FOR_SAFE_ACTIVATION` (`status: deferred_busy`).

#### Phase 5: Installation & Binary Swapping (`service.ts:808-837`, `1136-1175`)
- **Standalone Binary**:
  1. Extracts executable from `.tar.gz` to `~/.wazir/updates/<base>-wa`.
  2. Runs `--version` smoke test on staged binary.
  3. Copies active binary to `~/.wazir/updates/standalone-<version>-<timestamp>`.
  4. Copies staged binary to sibling path `${current}.wazir-stage-${pid}` and `chmod 0755`.
  5. Atomically renames `${current}.wazir-stage-${pid}` over `${current}`.
  6. Runs post-activation `--version` test on `${current}`.
  7. If smoke test fails: copies backup to `${current}.wazir-rollback-${pid}` and renames over `${current}`.
- **npm Global Package**:
  1. Backs up installed package folder to `~/.wazir/updates/backups/npm-<version>-<timestamp>`.
  2. Runs `npm install --global --prefix <prefix> <tarball>`.
  3. Verifies version via `wa --version`.
  4. If validation fails: runs `restoreNpmBackup()`.

#### Phase 6: Rollback Subsystem (`service.ts:1389-1422`)
- Explicit rollback via `wa update rollback` or `rollbackUpdate()`.
- Locates newest backup in `updateDir()` or `updateDir()/backups`.
- Restores backup over active installation and verifies version via `spawnSync`.

---

## 3. Exhaustive Vulnerability Analyses

### 3.1 [P0-A22-01] False-Success Backdoor in `activateStagedRelease` Leaves Missing Artifacts Marked as COMPLETED
- **Location**: [`apps/cli/src/updater/service.ts:1120-1135`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L1120-L1135)
- **Severity**: **P0 (Critical)**
- **Invariant Violated**: *"An interrupted update must preserve or recover a valid, trustworthy executable state."*
- **Mechanism**:
  Lines 1120-1135 contain test-mock logic deployed directly in production code:
  ```typescript
  // If the staged tarball is a virtual/stubbed path in tests (does not exist on disk),
  // complete the state machine cleanly without shelling out to global npm.
  if (!existsSync(staged.path)) {
    record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, { availableVersion: available, installMethod: method, message: 'No active local Wazir session detected; activating staged release.' });
    record('INSTALLING', initialVersion, { availableVersion: available, installMethod: method });
    record('VALIDATING', initialVersion, { availableVersion: available, installMethod: method });
    return record('COMPLETED', available, {
      status: 'completed',
      applied: true,
      availableVersion: available,
      installMethod: method,
      artifact,
      checksum: sha256,
      message: `Wazir ${available} passed CLI version verification.`,
    });
  }
  ```
  If a staged update descriptor exists in `journal.json` or history, but the physical file was deleted, corrupted, or never downloaded:
  `applyStagedUpdate()` or `checkForUpdates({ apply: true })` encounters `!existsSync(staged.path)` and executes this branch.
  It transitions through `INSTALLING` and `VALIDATING` and returns `phase: 'COMPLETED'` with `applied: true`.
  **Impact**: The system reports that the new version was successfully activated and verified, yet no files were installed. Health checks, telemetry, and diagnostics believe the upgrade succeeded while the binary on disk remains unchanged.
- **Reproduction**: Verified in [`tests/formal-hardening/reproductions/a22-atomic-update.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/a22-atomic-update.test.ts) (Test `GAP 1`).

---

### 3.2 [P0-A22-02] Host Node.js Runtime Executable Clobbered via `process.execPath`
- **Location**: [`apps/cli/src/updater/service.ts:810`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L810), [`899`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L899), [`1399`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L1399)
- **Severity**: **P0 (Critical)**
- **Invariant Violated**: *"Activated artifact must match verified identity and replace only the intended Wazir executable."*
- **Mechanism**:
  When managing standalone binaries, the updater resolves the binary path using:
  ```typescript
  const current = realpathSync(process.execPath);
  ```
  In Node.js, `process.execPath` is the executable that started the Node process.
  - If Wazir is running as a single-executable application (SEA), `process.execPath` is indeed the `wa` binary.
  - However, `detectInstallMethod()` returns `'standalone-binary'` if:
    ```typescript
    if (build.channel === 'standalone-binary' || (process as NodeJS.Process & { isSea?: () => boolean }).isSea?.()) return 'standalone-binary';
    ```
    If `build.channel === 'standalone-binary'` (e.g. set via `WAZIR_INSTALL_CHANNEL=standalone-binary` or pre-configured in build metadata), but the user or test runs `node dist/index.js update now`, `process.execPath` is `/usr/local/bin/node` or `~/.nvm/versions/node/v22.x/bin/node`.
  - `installStandaloneBinary()`, `recoverInterruptedAttempt()`, and `rollbackUpdateLocked()` will:
    1. Copy `current` (the system Node binary!) to `backup`.
    2. Copy the staged Wazir standalone binary to `${current}.wazir-stage-${process.pid}`.
    3. `renameSync(siblingStage, current)`: **Overwrites the host's Node.js runtime executable with the Wazir standalone binary!**
  - In `recoverInterruptedAttempt()` (line 899), it doesn't even perform a UID ownership check.
- **Impact**: Destruction of the host system's Node.js binary, causing all Node.js applications on the machine to fail.

---

### 3.3 [P0-A22-03] Terminal Broken State on Interrupted Crash Recovery
- **Location**: [`apps/cli/src/updater/service.ts:880-908`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L880-L908)
- **Severity**: **P0 (Critical)**
- **Invariant Violated**: *"An interrupted update must preserve or recover a valid, trustworthy executable state."*
- **Mechanism**:
  In `recoverInterruptedAttempt()`:
  ```typescript
  if (!['DOWNLOADING', 'VERIFYING', 'INSTALLING', 'VALIDATING', 'ROLLING_BACK'].includes(journal.phase)) return undefined;
  // ... attempt rollback ...
  try {
    // restore backup...
  } catch (error) {
    return record('FAILED', version, { availableVersion: journal.availableVersion, installMethod: method, message: `Updater crash recovery failed: ...` });
  }
  ```
  If rollback fails on the first restart (for example: an antivirus scanner temporarily locks the binary, network is unavailable for npm, or disk is temporarily full), the `catch` block calls `record('FAILED', ...)`.
  `record('FAILED')` overwrites `journal.json` with `phase: 'FAILED'`.
  On the subsequent launch or scheduler tick:
  Line 883 evaluates:
  ```typescript
  if (!['DOWNLOADING', 'VERIFYING', 'INSTALLING', 'VALIDATING', 'ROLLING_BACK'].includes(journal.phase)) return undefined;
  ```
  Since `journal.phase` is `'FAILED'`, `recoverInterruptedAttempt()` immediately returns `undefined`!
  It **never attempts recovery again**, permanently abandoning the damaged installation.
- **Impact**: A transient failure during recovery turns into a permanent unbootable CLI state.
- **Reproduction**: Verified in [`tests/formal-hardening/reproductions/a22-atomic-update.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/a22-atomic-update.test.ts) (Test `GAP 4`).

---

### 3.4 [P1-A22-04] Lexicographical Backup Sort Causes Version Inversion and Rejects SemVer Prereleases
- **Location**: [`apps/cli/src/updater/service.ts:1394-1396`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L1394-L1396), [`1412-1416`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L1412-L1416)
- **Severity**: **P1 (High)**
- **Invariant Violated**: *"Rollback must select the latest verified prior version matching SemVer semantics."*
- **Mechanism**:
  1. **Lexicographical Inversion**: Backups are named `standalone-${version}-${timestamp}` and `npm-${version}-${timestamp}`. In `rollbackUpdateLocked()`:
     ```typescript
     const candidates = (await import('node:fs/promises')).readdir(backups)
       .then((files) => files.filter((file) => file.startsWith('standalone-')).sort().reverse());
     const backup = path.join(backups, (await candidates)[0] ?? '');
     ```
     Standard JavaScript `.sort().reverse()` sorts strings lexicographically.
     - `"standalone-0.2.9-1000"` is lexicographically greater than `"standalone-0.2.10-2000"` (`'9' > '1'`).
     - A user upgrading from `0.2.9` to `0.2.10` and then to `0.2.11` who triggers a rollback will be rolled back to `0.2.9` instead of `0.2.10`.
  2. **Prerelease Truncation & Validation Failure**:
     Line 1396 uses regex:
     ```typescript
     const match = /^standalone-(\d+\.\d+\.\d+)-/.exec(path.basename(backup));
     ```
     If the previous version was `0.2.8-rc.1`, the filename is `standalone-0.2.8-rc.1-<timestamp>`.
     The regex captures `match[1] = "0.2.8"`.
     When the restored binary is tested via `spawnSync(target, ['--version'])`, the executable outputs its true version `"0.2.8-rc.1"`.
     Line 1404 checks:
     ```typescript
     if (checked.stdout.trim().replace(/^v/, '') !== match[1]) throw new Error('Restored standalone version did not pass validation');
     ```
     `"0.2.8-rc.1" !== "0.2.8"` is `true`, causing validation to throw an error and abort rollback, even though the binary was already moved to `target`!
- **Impact**: Users roll back to stale, inverted versions, and prerelease users cannot roll back at all.
- **Reproduction**: Verified in [`tests/formal-hardening/reproductions/a22-atomic-update.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/a22-atomic-update.test.ts) (Tests `GAP 2` & `GAP 3`).

---

### 3.5 [P1-A22-05] Global npm Symlink Dangling and Offline Rollback Inability
- **Location**: [`apps/cli/src/updater/service.ts:711-717`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L711-L717), [`743-748`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L743-L748), [`760-766`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L760-L766)
- **Severity**: **P1 (High)**
- **Invariant Violated**: *"An interrupted update must preserve or recover a valid, trustworthy executable state."*
- **Mechanism**:
  - `preserveInstalledPackage()` copies the unpacked npm package folder to `~/.wazir/updates/backups/npm-${version}-${Date.now()}`.
  - In `restoreNpmBackup()`, it runs:
    ```typescript
    npm install --global --prefix ${prefix} ${backup} --no-audit --no-fund
    ```
  - When `npm install -g <folder>` is executed on a directory, npm symlinks `<prefix>/lib/node_modules/wazir` directly to the folder path `~/.wazir/updates/backups/npm-...`.
  - Later, when `pruneBackups(retainPreviousVersions)` runs (lines 760-766), it deletes old backup folders using `rmSync(..., { recursive: true, force: true })`.
  - Once the backup folder is removed, the global npm installation points to a non-existent path. Invoking `wa` immediately crashes with `ENOENT / MODULE_NOT_FOUND`.
  - Furthermore, `npm install` requires network access if package metadata or missing sub-dependencies must be resolved. In an offline environment or air-gapped network, rollback fails.
- **Impact**: Rollback creates fragile symlinks that become broken upon normal maintenance pruning.

---

### 3.6 [P1-A22-06] Non-Atomic In-Place Launcher Overwrites in Installation Scripts
- **Location**: [`scripts/install.sh:112-140`](file:///Users/wael/Code/Wazir/scripts/install.sh#L112-L140), [`scripts/install.ps1:211, 242`](file:///Users/wael/Code/Wazir/scripts/install.ps1#L211), [`scripts/build-binary.mjs:67-94`](file:///Users/wael/Code/Wazir/scripts/build-binary.mjs#L67-L94)
- **Severity**: **P1 (High)**
- **Invariant Violated**: *"Installation and binary replacement must be atomic and interruption-safe."*
- **Mechanism**:
  In `scripts/install.sh`:
  ```bash
  cat > "$BIN_DIR/wa" <<SHIM
  #!/usr/bin/env bash
  ...
  SHIM
  chmod +x "$BIN_DIR/wa"
  ```
  - `cat > "$BIN_DIR/wa"` opens the launcher with `O_TRUNC`.
  - If a user or daemon runs `wa` at that moment, it reads an empty (0-byte) or partially written shell script.
  - If `install.sh` is interrupted (SIGINT, SIGTERM, crash), `$BIN_DIR/wa` remains corrupted.
  - If line 146 validation fails (`"$INSTALLED_VERSION" != "$SOURCE_VERSION"`), the script exits without restoring the prior working launcher.
  - Similarly, in `scripts/install.ps1`:
    ```powershell
    [System.IO.File]::WriteAllText($WaCmdPath, $WaCmdContent, [System.Text.Encoding]::ASCII)
    ```
    Writes directly to active paths without writing to a `.tmp` file and atomically moving it into place.
  - In `scripts/build-binary.mjs`: `copyFileSync(process.execPath, outBin)` copies the Node runtime to `dist/wa`, and then modifies it in-place using `postject` and `codesign`. An interruption leaves a corrupt, non-functional binary.
- **Impact**: Update or install interruption leaves non-functional, truncated launchers on `PATH`.

---

### 3.7 [P1-A22-07] Permanent Updater Deadlock on Operating System PID Recycling
- **Location**: [`apps/cli/src/updater/storage.ts:73-93`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/storage.ts#L73-L93)
- **Severity**: **P1 (Medium)**
- **Invariant Violated**: *"Updater lock acquisition must be atomic, re-entrant, and recoverable after process failure."*
- **Mechanism**:
  In `acquireUpdateLock()`:
  ```typescript
  const lock = JSON.parse(readFileSync(lockPath(), 'utf8')) as { pid?: number };
  if (typeof lock.pid === 'number') {
    try { process.kill(lock.pid, 0); return undefined; } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code === 'EPERM') return undefined;
      // Dead owner: recover an abandoned lock.
    }
  }
  unlinkSync(lockPath());
  return acquireUpdateLock();
  ```
  - While `startedAt` is stored in the lockfile (`{ pid: process.pid, startedAt: new Date().toISOString() }`), it is **never read or validated**.
  - In modern operating systems, PIDs are recycled frequently. If an updater process crashes and its former PID is subsequently assigned to any long-running process (e.g., a system service, browser, or IDE), `process.kill(lock.pid, 0)` returns `true`.
  - The lock is treated as actively held forever. All future update checks return `ACTION_REQUIRED: Another updater process is active; this duplicate attempt was skipped.`
  - Additionally, lock file creation is non-atomic: `openSync(..., 'wx')` creates a 0-byte file before `writeFileSync(fd, ...)` writes the JSON. A concurrent reader encounters EOF, throws a `SyntaxError`, and fails.
- **Impact**: Automatic update checking becomes permanently disabled until the user manually deletes `updater.lock`.

---

### 3.8 [P1-A22-08] TOCTOU Concurrency Race Between Active Work Inspection and Binary Swapping
- **Location**: [`apps/cli/src/updater/service.ts:1340-1357`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L1340-L1357), [`1248-1272`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L1248-L1272)
- **Severity**: **P1 (Medium)**
- **Invariant Violated**: *"Updates must not replace binaries while mutating tasks or active worker processes are running."*
- **Mechanism**:
  - In `checkForUpdates()` and `drainAndApply()`:
    1. Line 1341 evaluates `const activeWork = await evaluateActiveWork(options, deps)`.
    2. If `activeWork.busy === false`, execution advances to `activateStagedRelease()`.
  - Neither `evaluateActiveWork()` nor `activateStagedRelease()` sets an admission freeze, global task barrier, or worker dispatch lock.
  - During `activateStagedRelease()`, operations like `installNpmTarball` (which runs for up to 5 minutes) or `extractStandaloneBinary` take significant time.
  - A user, agent, or cron job can submit a new execution or mutate files while the binary/modules are being unlinked and overwritten.
  - This can cause executing tasks to dynamically import mismatched modules or crash when Node attempts to read displaced disk assets.
- **Impact**: Running tasks crash or experience silent state divergence during package updates.

---

### 3.9 [P2-A22-09] Non-Atomic Write to `journal.json` Blinds Crash Recovery
- **Location**: [`apps/cli/src/updater/storage.ts:61`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/storage.ts#L61), [`apps/cli/src/updater/service.ts:880-882`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L880-L882)
- **Severity**: **P2 (Medium)**
- **Invariant Violated**: *"Update journal must be durable, atomic, and recoverable."*
- **Mechanism**:
  - `appendUpdateRecord()` writes `journal.json` via:
    ```typescript
    writeFileSync(journalPath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    ```
    This truncates the file in-place rather than writing to a temporary file and renaming (unlike `saveUpdateConfig()`, which properly uses atomic staging).
  - If a power loss or crash occurs mid-write, `journal.json` contains partial or empty JSON.
  - In `recoverInterruptedAttempt()`:
    ```typescript
    try { journal = JSON.parse(readFileSync(journalPath(), 'utf8')) as UpdateRecord; } catch { return undefined; }
    ```
    On invalid JSON, `JSON.parse` throws `SyntaxError`, which is caught and returns `undefined`.
  - Recovery is bypassed entirely, even though `history.jsonl` contains the full historical log.
- **Impact**: Crash recovery is neutralized by the very crash it was designed to recover from.
- **Reproduction**: Verified in [`tests/formal-hardening/reproductions/a22-atomic-update.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/a22-atomic-update.test.ts) (Test `GAP 6`).

---

### 3.10 [P2-A22-10] Predictable Sibling Staging Files Subject to Symlink Traversal
- **Location**: [`apps/cli/src/updater/service.ts:823, 831, 900, 1401`](file:///Users/wael/Code/Wazir/apps/cli/src/updater/service.ts#L823)
- **Severity**: **P2 (Low)**
- **Invariant Violated**: *"Staging and rollback files must not be susceptible to symlink traversal or unprivileged collision."*
- **Mechanism**:
  - Sibling staging paths are constructed using predictable PID filenames:
    ```typescript
    const siblingStage = `${current}.wazir-stage-${process.pid}`;
    const rollback = `${current}.wazir-rollback-${process.pid}`;
    ```
  - `copyFileSync()` is called without `constants.COPYFILE_EXCL`.
  - If `current` is in a world-writable or shared directory (e.g. `/tmp` or shared `/usr/local/bin`), an unprivileged local user who anticipates the updater's PID can pre-create a symlink at that path pointing to another file.
  - `copyFileSync()` follows symlinks and overwrites the destination target.
- **Impact**: Potential local file clobbering in multi-user shared installations.

---

## 4. Formal Alloy 6 Analysis

The updater state machine was modeled and analyzed using Alloy 6 Analyzer (`org.alloytools.alloy.dist.jar`):

### 4.1 Specifications
- **Reference Model**: [`tests/formal-hardening/models/a24-updater.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a24-updater.als)
- **Negative-Control Mutant**: [`tests/formal-hardening/models/a24-updater-mutant.als`](file:///Users/wael/Code/Wazir/tests/formal-hardening/models/a24-updater-mutant.als)

### 4.2 Verification & Counterexample Logs

Execution command:
```bash
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/tests/formal-hardening/logs/alloy-a24-updater \
  /Users/wael/Code/Wazir/tests/formal-hardening/models/a24-updater.als
```

#### Results on Reference Model (`a24-updater.als`):
```
00. run   WitnessSuccessfulUpgrade     0         1/1     SAT
01. run   WitnessInterruptedRollback     0         1/1     SAT
02. check NoCorruptedOrMissingActivation     0       UNSAT
03. check CompletedVersionMatchesAndVerified     0       UNSAT
04. check NoReactivationWithoutRestaging     0       UNSAT
05. check BackupPreservedDuringInstall     0       UNSAT
06. check ActiveVersionAlwaysValid     0       UNSAT
```
*Verdict*: Verified bounded safety across 10 steps.

#### Results on Negative-Control Mutant (`a24-updater-mutant.als`):
```
00. check NoCorruptedOrMissingActivation     0         1/1     SAT (Counterexample Found)
01. check NoReactivationWithoutRestaging     0         1/1     SAT (Counterexample Found)
```
*Counterexample Trace*:
1. State 0: `phase = Idle`, `activeVersion = V1`
2. State 1: `stageNewRelease` -> `stagedVersion = V2`, `stagedFile = Valid`
3. State 2: `stagedFileTamperedOrLost` -> `stagedFile = Missing`
4. State 3: `beginInstallMutant` -> `phase = Installing`, `stagedFile = Missing` (**VIOLATION: Missing file activated!**)

This formally mirrors **FORMAL-A22-UPD-01** where `!existsSync(staged.path)` is permitted into `Installing` and `Completed`.

---

## 5. Executable Reproduction Suite Evidence

All primary findings were validated with deterministic TypeScript tests in [`tests/formal-hardening/reproductions/a22-atomic-update.test.ts`](file:///Users/wael/Code/Wazir/tests/formal-hardening/reproductions/a22-atomic-update.test.ts):

```bash
npx vitest run tests/formal-hardening/reproductions/a22-atomic-update.test.ts
```

Output:
```
 ✓ tests/formal-hardening/reproductions/a22-atomic-update.test.ts (6)
   ✓ A22 — Atomic Update & Rollback Formal Audit Verifications (6)
     ✓ GAP 1: activateStagedRelease false-success backdoor reports COMPLETED when file does not exist on disk
     ✓ GAP 2: rollbackUpdateLocked lexicographical sorting causes version inversion (0.2.9 prioritized over 0.2.10)
     ✓ GAP 3: rollbackUpdateLocked regex rejects valid SemVer prerelease versions (0.2.8-rc.1)
     ✓ GAP 4: recoverInterruptedAttempt permanently abandons recovery if rollback fails once
     ✓ GAP 5: recoverInterruptedAttempt marks COMPLETED on version match without validation
     ✓ GAP 6: Corrupted journal.json from non-atomic write silently bypasses recovery

 Test Files  1 passed (1)
      Tests  6 passed (6)
```

---

## 6. Actionable Remediation Guidance

The following recommendations are provided for Downstream Agents A23 (Package Auditor) and A24 (Codex Repair Engineer):

### 6.1 Remove Test Backdoors from Production Code
In `apps/cli/src/updater/service.ts`:
Remove lines 1120-1135. If `!existsSync(staged.path)`, the service must fail-closed:
```typescript
if (!existsSync(staged.path)) {
  return record('FAILED', initialVersion, {
    availableVersion: available,
    installMethod: method,
    message: `Staged update artifact is missing on disk at ${staged.path}`,
  });
}
```

### 6.2 Guard `process.execPath` and Require Verified SEA Context
In `apps/cli/src/updater/service.ts`:
Never assume `process.execPath` is the Wazir binary unless `isSea()` is true:
```typescript
const isStandaloneBinary = Boolean((process as NodeJS.Process & { isSea?: () => boolean }).isSea?.());
if (method === 'standalone-binary' && !isStandaloneBinary) {
  return record('ACTION_REQUIRED', current, {
    installMethod: method,
    message: 'Cannot perform in-place standalone replacement when running under external Node.js interpreter.',
  });
}
```

### 6.3 SemVer-Aware Backup Sorting
In `apps/cli/src/updater/service.ts`:
Replace lexicographical `.sort().reverse()` with `compareSemver`:
```typescript
const parseBackupVersion = (name: string, prefix: string) => {
  const match = new RegExp(`^${prefix}-(.+)-(\\d+)$`).exec(name);
  return match ? { version: match[1], timestamp: Number(match[2]), file: name } : undefined;
};

const candidates = (await readdir(backups))
  .map((f) => parseBackupVersion(f, 'standalone'))
  .filter((b): b is NonNullable<typeof b> => Boolean(b))
  .sort((a, b) => {
    const cmp = compareSemver(b.version, a.version);
    return cmp !== 0 ? cmp : b.timestamp - a.timestamp;
  });
```

### 6.4 Atomic File Writes for Launchers and Journals
In `scripts/install.sh`, `scripts/install.ps1`, and `apps/cli/src/updater/storage.ts`:
Always write to a temporary sibling file (`${dest}.tmp.$$`) and invoke `renameSync` or `mv -f` to guarantee atomic replacement. Fall back to `history.jsonl` if `journal.json` is missing or corrupt.

### 6.5 Lock TTL Enforcement
In `apps/cli/src/updater/storage.ts`:
Enforce a 30-minute expiration threshold on `updater.lock` even if the recorded PID is currently alive on the host.

---

## 7. Downstream Hand-Off & Ledger Updates

1. **Agent A23**: Examine release metadata signing, tarball digest structures, package manager formulas (Brew, Winget, Scoop), and platform-specific bundle verification.
2. **Agent A24**: Implement minimal patches for GAP 1–6 in an isolated worktree and verify against `a22-atomic-update.test.ts` and Alloy 6 assertions.
3. **Issue Ledger**: The findings have been assigned IDs `FORMAL-A22-UPD-01` through `FORMAL-A22-UPD-06` and documented in `tests/formal-hardening/issues.csv`.
