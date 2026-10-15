# Wazir Defect Register & Remediation Log

**Audit Date:** 2026-10-14  
**Git Commit SHA:** `59b7aac8f7883f6181873723a0be1ddfc51969a6`  

---

## Defect Summary Table

| Defect ID | Severity | Component | Summary | Status |
|---|---|---|---|---|
| **DEF-01** | **P2** | `apps/cli` (`commands.ts`) | `wa policy inspect` crashes with `TypeError: Cannot read properties of undefined (reading 'padEnd')` | Identified & Verified Fix |
| **DEF-02** | **P2** | `apps/cli` (`task.ts`) | `wa task status <unknown-id>` reports `Task <id>: queued` with exit code 0 | Identified & Verified Fix |
| **DEF-03** | **P1** | `packages/tools` (`sandbox.ts`) | `bwrap` fails on Ubuntu 24.04+ due to restricted unprivileged user namespaces, falling back to unconfined host execution | Identified |
| **DEF-04** | **P2** | `packages/runtimes/lmstudio` | Default baseURL is `http://localhost:1235/v1` instead of standard LM Studio port `1234` | Identified & Verified Fix |
| **DEF-05** | **P3** | `apps/cli` (`commands.ts`) | Negative inspection subcommands (`computers inspect`, `runtimes inspect`, `executions inspect`, `artifacts inspect`) exit code 0 when entity not found | Identified & Verified Fix |

---

## Detailed Defect Entries

### DEF-01: Crash in `wa policy inspect` due to undefined rule properties (P2)
- **Component:** `apps/cli/src/commands.ts:515` (`inspectPolicy`)
- **Reproduction:**
  ```bash
  wa policy inspect
  ```
- **Error Trace:**
  ```
  wa: fatal unhandledRejection: TypeError: Cannot read properties of undefined (reading 'padEnd')
      at inspectPolicy (bin/wa.js:387554:32)
  ```
- **Root Cause:** In `PolicyEngine.buildRules()`, rules are constructed with `{ id, description, effect }`. The properties `scope` and `pattern` are optional (`scope?: string; pattern?: string;`) and remain undefined. `inspectPolicy` directly calls `rule.scope.padEnd(12)` without nullish coalescing or checking.
- **User Impact:** Operators cannot inspect active policy rules via CLI.
- **Recommended Fix:**
  ```typescript
  const scope = (rule.scope ?? rule.id).padEnd(28);
  const pattern = (rule.pattern ?? '').padEnd(10);
  lines.push(`  ${scope} ${pattern} → ${rule.effect.padEnd(6)} ${color.gray(rule.description)}`);
  ```
- **Regression Test:** Add unit test in `apps/cli/tests/policyCli.test.ts` asserting `inspectPolicy(engine)` returns a non-empty string without throwing.

---

### DEF-02: Unknown task ID reported as `queued` with exit code 0 (P2)
- **Component:** `apps/cli/src/commands/task.ts`
- **Reproduction:**
  ```bash
  wa task status bogus-nonexistent-task-id-12345
  ```
- **Actual Output:**
  ```
  Task bogus-nonexistent-task-id-12345: queued
  Exit Code: 0
  ```
- **Root Cause:** When querying task status, an undefined or missing task record falls back to an initial or default `'queued'` string rather than throwing `TASK_NOT_FOUND` or reporting an error.
- **User Impact:** Scripts or operators querying invalid task IDs receive false-positive confirmation that the task exists and is waiting in queue.
- **Recommended Fix:** Check `taskStore.get(taskId)`. If null/undefined, output `Task '${taskId}' not found` and exit with code 1.
- **Regression Test:** Add CLI test asserting `wa task status non-existent` exits with code 1.

---

### DEF-03: Tool sandbox fallback to unconfined host execution (P1)
- **Component:** `packages/tools/src/sandbox.ts`
- **Reproduction:**
  Execute any task invoking shell or tools on an Ubuntu 24.04+ machine without custom AppArmor bwrap profile:
  ```bash
  wa task run "echo test" --model nvidia/nemotron-3-nano-omni
  ```
- **Observed Log:**
  ```
  [wazir] tool sandbox unavailable — running tool processes directly on the host
  (bwrap cannot start: bwrap: setting up uid map: Permission denied)
  ```
- **Root Cause:** Ubuntu 24.04 LTS restricts unprivileged user namespaces via AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`). Bubblewrap requires unprivileged user namespaces to create container mounts.
- **User Impact:** Sandboxing degrades to unconfined host execution. Tool execution relies solely on CLI string filtering without Linux namespace containment.
- **Recommended Fix:**
  1. Add an AppArmor profile in `scripts/apparmor/bwrap` during `install.sh`.
  2. Implement `WAZIR_STRICT_SANDBOX=1` mode to prevent silent degradation.

---

### DEF-04: LMStudioAdapter default URL port mismatch (P2)
- **Component:** `packages/runtimes/lmstudio/src/index.ts:92`
- **Reproduction:**
  ```typescript
  const adapter = new LMStudioAdapter();
  await adapter.healthCheck();
  ```
- **Error:** `ECONNREFUSED 127.0.0.1:1235`
- **Root Cause:** Default constructor argument is set to `http://localhost:1235/v1` instead of the official LM Studio default port `1234` (`http://localhost:1234/v1`).
- **User Impact:** Using the adapter programmatically without explicit configuration connects to the wrong port.
- **Recommended Fix:** Change default parameter from `1235` to `1234` (or read `process.env.WAZIR_LMSTUDIO_URL ?? 'http://localhost:1234/v1'`).

---

### DEF-05: Missing nonzero exit code for entity inspection misses (P3)
- **Component:** `apps/cli/src/commands.ts`
- **Reproduction:**
  ```bash
  wa computers inspect invalid-id
  wa executions inspect invalid-id
  wa artifacts inspect invalid-id
  ```
- **Actual Behavior:** Prints `not found` message but exits with code 0.
- **User Impact:** Automated bash scripts testing `$? -eq 0` incorrectly treat missing resources as successful queries.
- **Recommended Fix:** Set `process.exitCode = 1` whenever the inspected entity is not found.
