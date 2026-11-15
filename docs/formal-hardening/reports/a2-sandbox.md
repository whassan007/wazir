# Formal Hardening Report: Subagent A2 (Shell & Path Sandbox Isolation)

## Executive Summary

- **Subagent ID**: Subagent A2 (Shell & Path Sandbox Isolation)
- **Campaign**: Wazir 12-Agent Formal Hardening Campaign
- **Working Tree**: `/Users/wael/Code/Wazir/.worktrees/fh-a2-sandbox`
- **Git HEAD SHA**: `4661c33a6caeaca0639853463e4ccbbe3ebc63d8`
- **Alloy 6 Analyzer JAR**: `/Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar` (Alloy 6.2 CLI, SAT4J solver)
- **Status**: **CONFIRMED DEFECTS IDENTIFIED, FORMALLY MODELLED, REPRODUCED, AND FIXED**
- **Test Results**: Pre-fix: 3 failed / 18 passed in security suite. Post-fix: 21 passed in security suite, 107 passed | 10 skipped across 19 files in `@wazir/tools`. Zero TypeScript compiler errors.

---

## 1. Subsystem Scope & Codebase Mapping

Subagent A2 conducted a deep formal verification and security audit across the filesystem path validation, OS sandbox generation, command wrapping, and interactive terminal boundaries in Wazir:

1. **`packages/tools/src/paths.ts`**:
   - `canonicalize`: Ancestor walking and symlink resolution for existing and not-yet-existing target paths.
   - `assertInsideProject` & `resolveInsideProject`: Lexical and physical symlink containment gates.
   - `readProjectFile` & `readProjectBytes`: `O_NOFOLLOW` descriptor binding and `assertSameInode` TOCTOU validation.
   - `writeProjectFile`: Atomic exclusive temp file creation, fsync, and atomic rename.

2. **`packages/tools/src/sandbox.ts`**:
   - `bwrapArgs`: Linux Bubblewrap namespace isolation, read-only root, masked host directories (`/home`, `/Users`, `/root`, `/mnt`, `/srv`), toolchain re-exposure, and private tempfs.
   - `seatbeltProfile`: macOS `sandbox-exec` Scheme profile generation, home denial, cache allowance, and network restriction.
   - `seccompFilter`: Pure BPF filter assembly denying dangerous syscalls (`mount`, `pivot_root`, `ptrace`, `setns`, `bpf`, `clone3`).
   - `wrapInSandbox`: Mode selection (`bwrap`, `sandbox-exec`, `none`, `required`) and fail-closed enforcement.

3. **`packages/tools/src/process.ts`**:
   - `runProcess`, `runShell`, `runFile`: Process spawning, resource limit wrapping (`rlimit`), output streaming, and killing process groups via `detached: true` / negative PID signaling.
   - `childEnvironment`: Strict credential redaction allowlist (`CHILD_ENV_ALLOW`).

4. **`packages/tools/src/filesystem.ts` & `process-tools.ts`**:
   - `readTool`, `writeTool`, `editTool`: File tool operations and mutation result accounting.
   - `shellTool`, `gitTool`, `testTool`, `lintTool`, `buildTool`, `typecheckTool`: Check tools and scoped workspace execution.

5. **`packages/tools/src/terminalSession.ts`**:
   - Interactive PTY shell sessions backed by `node-pty` and `@xterm/headless`, `PROMPT_COMMAND` marker synchronization, and graceful group disposal.

---

## 2. Formal Invariants & Alloy 6 Models

We formalized the core path isolation, dangling symlink resolution, and sandbox containment state machine in Alloy 6:
- Model: `docs/formal-hardening/models/a2-sandbox.als`
- Negative Control Mutant: `docs/formal-hardening/models/a2-sandbox-mutant.als`
- Results: `docs/formal-hardening/results/a2-sandbox/` and `docs/formal-hardening/results/a2-sandbox-mutant/`

### Formal Invariants

1. **`Inv1_DanglingSymlinkSafety`**:
   $$\forall \text{step}, (\text{validationPassed} = \text{True} \land \exists n = \text{lastValidated}) \implies \text{canonicalTarget}[n].\text{isProject} = \text{True}$$
   Any path that passes containment validation (`assertInsideProject` / `resolveInsideProject`) must have its true physical canonical destination located within the project boundary, even if the destination or intermediate directories do not exist yet on disk.

2. **`Inv2_NoDanglingSymlinkEscape`**:
   $$\forall n \in \text{Node}, (n.\text{isSymlink} = \text{True} \land n.\text{symlinkTarget}.\text{isProject} = \text{False}) \implies \neg \text{validateInsideProject}[n]$$
   A symlink pointing outside the project root must never be approved, regardless of whether its target exists.

3. **`Inv3_NoOutsideWrite`**:
   $$\forall \text{step}, \exists w = \text{lastWritten} \implies w.\text{isProject} = \text{True}$$
   Any committed write operation must land exclusively on a project node, never escaping to external host files.

4. **`Inv4_VictimFileNeverWritten`**:
   $$\forall \text{step}, \text{lastWritten} \neq \text{OutsideVictimFile}$$
   External victim files must be strictly unmodifiable by sandboxed tool executions.

### Alloy 6 Execution Evidence

Command executed:
```bash
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/docs/formal-hardening/results/a2-sandbox \
  /Users/wael/Code/Wazir/docs/formal-hardening/models/a2-sandbox.als
```

Observed Analyzer Verdict (Sound Model `a2-sandbox.als`):
```text
00. run   WitnessProjectWrite              0  1/1  SAT
01. run   WitnessDanglingSymlinkCreated     0  1/1  SAT
02. check Inv1_DanglingSymlinkSafety         0       UNSAT
03. check Inv2_NoDanglingSymlinkEscape       0       UNSAT
04. check Inv3_NoOutsideWrite                0       UNSAT
05. check Inv4_VictimFileNeverWritten        0       UNSAT
```
All assertions verified (UNSAT = no counterexample in scope 4 nodes, 6 steps). Positive witnesses verified (SAT).

Observed Analyzer Verdict (Negative Control Mutant `a2-sandbox-mutant.als`):
```bash
java -jar /Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar exec -f -t text -c '*' \
  -o /Users/wael/Code/Wazir/docs/formal-hardening/results/a2-sandbox-mutant \
  /Users/wael/Code/Wazir/docs/formal-hardening/models/a2-sandbox-mutant.als
```
```text
00. check Inv1_DanglingSymlinkSafety         0  1/1  SAT
01. check Inv2_NoDanglingSymlinkEscape       0  1/1  SAT
02. check Inv3_NoOutsideWrite                0  1/1  SAT
03. check Inv4_VictimFileNeverWritten        0  1/1  SAT
```
All four mutant assertions failed with concrete counterexamples (SAT = counterexample generated), formally demonstrating the defect mechanism.

---

## 3. Discovered Vulnerabilities & Confirmed Fixes

### FH-A2-01 (P0): Non-Existent Parent / Dangling Symlink Escape in `paths.ts`

- **Severity**: P0 (High Severity Path Traversal / Sandbox Escape)
- **Subsystem**: `packages/tools/src/paths.ts` (lines 26–34)
- **Vulnerability**:
  In `canonicalize(target)`:
  ```typescript
  try {
    const real = await fs.realpath(current);
    return missing.length > 0 ? path.join(real, ...missing) : real;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    const parent = path.dirname(current);
    if (parent === current) throw error;
    missing.unshift(path.basename(current));
    current = parent;
  }
  ```
  When `current` is a dangling symlink (the symlink exists on disk, but its target does not exist yet), `fs.realpath(current)` throws `ENOENT`. `canonicalize` assumed that `ENOENT` meant `current` was a non-existent regular file under its parent directory. It unshifted `path.basename(current)` into `missing` and walked up to `path.dirname(current)` (which is inside the project root). As a result, `canonicalize` returned `path.join(projectRoot, missing)` and `isInside` declared the path inside the project root!
  Consequently, `assertInsideProject` and `resolveInsideProject` approved dangling symlinks pointing to external locations (e.g. `/tmp/victim`, `/etc/cron.d`). As soon as an external target was created or referenced in subsequent writes/edits/searches, operations escaped outside the project root.

- **Reproduction**:
  Deterministic tests in `packages/tools/tests/security.test.ts`:
  - `rejects a dangling symlink whose target is outside the project`
  - `rejects path traversal through a dangling symlink directory pointing outside the project`
  Pre-fix result:
  `AssertionError: promise resolved "'.../project/dangling_link.txt'" instead of rejecting`

- **Fix Applied**:
  When `fs.realpath` throws `ENOENT` or `ENOTDIR`, check `fs.lstat(current)`. If `lstat.isSymbolicLink()` is true, read the link target via `fs.readlink(current)` and resolve `current` to the link target path, preserving the missing tail and guarding against loops with max 40 hops (`ELOOP`).

---

### FH-A2-02 (P1): Seatbelt Profile Quoting Corruption & Escape via Backslash

- **Severity**: P1 (Integrity & Isolation Boundary Bypass)
- **Subsystem**: `packages/tools/src/sandbox.ts` (line 330)
- **Vulnerability**:
  In `seatbeltProfile`:
  ```typescript
  const q = (p: string) => `"${path.resolve(p).replace(/"/g, '\\"')}"`;
  ```
  `q()` only escaped double quotes `"` and omitted escaping backslashes `\`. In Apple Seatbelt Scheme syntax, a trailing backslash before a quote (`\"`) escapes the quote, leaving the string literal unclosed.
  When a workspace or directory name contains a backslash (valid on POSIX filesystems), `sandbox-exec` fails to compile the profile (`sandbox-exec: unbound variable`, exit code 65).
  Crucially, when `WAZIR_SANDBOX=auto` (the default mode), this compilation failure triggers `sandboxDegraded()`, causing Wazir to fall back to **completely unconfined host execution** directly on the operator's machine.

- **Reproduction**:
  Deterministic test in `packages/tools/tests/security.test.ts`:
  - `escapes backslashes in paths so seatbelt profile syntax remains valid`
  Pre-fix result:
  `AssertionError: expected '(version 1)...' to contain 'has\\\\backslash'`

- **Fix Applied**:
  Update `q(p)` to escape backslashes first, then quotes, newlines, and carriage returns:
  ```typescript
  const q = (p: string) => `"${path.resolve(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  ```

---

### FH-A2-03 (P1): Process Execution CWD Fallback Escape in `process.ts`

- **Severity**: P1 (Working Directory Escape)
- **Subsystem**: `packages/tools/src/process.ts` (lines 230–235)
- **Vulnerability**:
  In `bwrapArgs`, a `cwd` outside the project root falls back to `projectRoot`. However, in `runProcess`:
  ```typescript
  const spawnCwd = wrapped.mode === 'bwrap' ? undefined : options.cwd;
  ```
  For macOS `sandbox-exec` and unconfined host execution (`none`), `options.cwd` was passed directly to `spawn()` without containment validation, allowing subprocesses to execute with a working directory outside the project.

- **Fix Applied**:
  In `runProcess`, validate and normalize `options.cwd` against `projectRoot` and platform `tmpdir` using `isInside`, setting `spawnCwd` to `projectRoot` if `options.cwd` escapes:
  ```typescript
  const project = path.resolve(options.projectRoot ?? options.cwd);
  const rawCwd = path.resolve(options.cwd);
  const platformTmp = path.resolve(os.tmpdir());
  const effectiveCwd = isInside(project, rawCwd) || isInside(platformTmp, rawCwd) ? rawCwd : project;
  const spawnCwd = wrapped.mode === 'bwrap' ? undefined : effectiveCwd;
  ```

---

## 4. Verification & Regression Evidence

```bash
cd /Users/wael/Code/Wazir/.worktrees/fh-a2-sandbox/packages/tools
npm run typecheck
./node_modules/.bin/vitest run --reporter=basic packages/tools/tests/security.test.ts
./node_modules/.bin/vitest run --reporter=basic packages/tools/tests/sandbox.test.ts
./node_modules/.bin/vitest run --reporter=basic packages/tools/tests/
```

Test Results:
- `packages/tools/tests/security.test.ts`: 21 passed (21 total)
- `packages/tools/tests/sandbox.test.ts`: 10 passed | 10 skipped (20 total)
- `packages/tools/tests/`: 107 passed | 10 skipped (117 total across 19 test files)
- TypeScript Typecheck (`tsc --noEmit`): Clean (0 errors)

---

## 5. Artifact Ledger

| Artifact | Path | Purpose |
|---|---|---|
| Alloy Sound Model | `docs/formal-hardening/models/a2-sandbox.als` | Formal specification of path containment & dangling symlinks |
| Alloy Mutant Model | `docs/formal-hardening/models/a2-sandbox-mutant.als` | Negative control demonstrating unpatched escape counterexamples |
| Alloy Results Receipt | `docs/formal-hardening/results/a2-sandbox/receipt.json` | Analyzer solver execution log and SAT/UNSAT receipts |
| Alloy Mutant Receipt | `docs/formal-hardening/results/a2-sandbox-mutant/receipt.json` | Counterexample state traces |
| Vitest Regressions | `packages/tools/tests/security.test.ts` | Deterministic Vitest test suite reproducing and verifying fixes |
| Production Patches | `packages/tools/src/paths.ts`, `sandbox.ts`, `process.ts` | Minimal hardened source code |
| Issue Ledger | `docs/formal-hardening/reports/a2-ledger.csv` | Campaign issue tracking record |
| Hardening Report | `docs/formal-hardening/reports/a2-sandbox.md` | Complete formal verification and audit findings |
