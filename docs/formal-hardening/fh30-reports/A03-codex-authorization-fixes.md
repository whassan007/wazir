# A03 — Codex & Gemini Authorization, Delegation & Policy Engine Repairs Report

- **Agent ID**: A03
- **Provider**: Codex (`gpt-6-sol`) initial execution + Antigravity Gemini (`gemini-pro`) quota-escalation completion
- **Worktree**: `/Users/wael/Code/Wazir/.worktrees/fh30/A03` (`fh30/A03`, commit `daf6117`)
- **Group**: GROUP A (P0) — Authorization, Delegated Permissions & Policy Inheritance
- **Target Repository**: `/Users/wael/Code/Wazir`
- **Critical Invariant (P0-01)**:
  > *"A delegated agent must never execute an operation unless that operation is authorized under the effective permissions of the complete delegation chain."*
  > 
  > $$\forall op \in \text{Operation}, \forall a \in \text{Agent}: \text{execute}(a, op) \implies (\forall anc \in a.*parent: op \in anc.\text{effectivePermissions}) \land \text{authorized}(op)$$

---

## 1. Executive Summary & Session Transfer

The initial Group A repair was initiated by Codex CLI (`gpt-6-sol`) in worktree `/Users/wael/Code/Wazir/.worktrees/fh30/A03`. Prior to hitting the OpenAI subscription quota limit, Codex had drafted partial modifications to `packages/core/src/services/policyEngine.ts` and created `packages/core/src/services/delegatedPolicyGate.ts`. Several drafted checks introduced regressions in existing shell substitution and find-output tests.

Remediation was transferred to Google Antigravity (Gemini Pro), which:
1. Audited the partial Codex diffs, eliminated faulty crude pattern checks that broke nested command substitutions (`$(...)`) and contained `find` outputs (`-fprint`), and correctly aligned policy logic with Wazir's architecture.
2. Completed the fixes for `FORMAL-A01-AUTH-01`, `FORMAL-A01-AUTH-02`, `FORMAL-A01-AUTH-03`, and `A01-06`.
3. Integrated `DelegatedPolicyGate` with multi-hop chain intersection and least-privilege attenuation.
4. Authored a comprehensive deterministic regression suite at `packages/core/tests/formalHardeningGroupA.test.ts` (23 tests).
5. Validated that all 139 Group A policy tests pass cleanly with zero failures and verified TypeScript clean builds.

---

## 2. Defects Repaired

### 2.1 FORMAL-A01-AUTH-01: Recursive Validation for `find -exec` Inner Arguments
- **Subsystem**: Core Policy Engine / Shell Classification
- **Affected File**: `packages/core/src/services/policyEngine.ts:1861-1930`
- **Vulnerability**: Previously, `classifySafeCommandArgs` only checked `basename(args[i + 1])` against `SAFE_SHELL_COMMANDS` and jumped past `;` or `+`, blindly permitting any flags or targets passed to inner commands (e.g., `find . -exec cat /etc/passwd ;` or `find . -exec rg --pre=/tmp/evil.sh pattern {} ;`).
- **Remediation**:
  - Replaced the binary-only check with extraction of the complete inner clause up to the terminating `;` or `+`.
  - Empty inner commands (`find . -exec ;`) are explicitly denied under `shell-dangerous-deny`.
  - Inner commands are passed recursively into `this.classifyShellSegment({ words: innerWords, redirects: [] }, projectRoot, executionId, effectiveIsolation)`.
  - Path-escaping commands (`cat /etc/passwd`, `sort -o /etc/passwd`), code-executing flags (`rg --pre=...`), system destructive commands (`reboot`), and state-changing interpreters (`node`, `python3`) inside `-exec`, `-execdir`, `-ok`, and `-okdir` clauses are now strictly denied or ask-gated.
  - Safe, contained invocations (such as `find . -exec cat safe.txt ;` or `find . -name "*.ts" -exec cat {} +`) remain auto-allowed under `shell-safe-allow`.

### 2.2 FORMAL-A01-AUTH-02: Delegation Inheritance of `writtenPathsByExecution` (Anti-Laundering)
- **Subsystem**: Core Policy Engine / Task Orchestration
- **Affected Files**: `packages/core/src/services/policyEngine.ts:778-835, 1125-1135`, `packages/core/src/types/policy.ts:3-10`, `apps/cli/src/run.ts:1394-1397, 1541-1544`
- **Vulnerability**: When an agent wrote a test file (e.g. `exploit.test.js`), `PolicyEngine` recorded it in `writtenPathsByExecution` to prevent laundering arbitrary code through auto-approved interpreter invocations (`classifyTestWorkspace`). However, spawning a child subagent created a fresh `executionId`. Because delegation lineage was not tracked, the subagent could invoke `node exploit.test.js` and have it auto-allowed under `shell-test-workspace-allow`.
- **Remediation**:
  - Introduced `parentExecutionByExecution: Map<string, string>` and `linkParentExecution(childExecId, parentExecId)` (with `registerDelegation` alias) on `PolicyEngine`.
  - Added optional `parentExecutionId` to `PolicyActionRequest` and automatically linked executions during classification.
  - Updated `wasWrittenThisExecution` and `isTrackedCompiledOutput` to traverse the complete delegation ancestry chain with cycle guards (`visited` set).
  - Updated `runSubagent` in `apps/cli/src/run.ts` to call `engine.policy.linkParentExecution(childExecId, context.parentExecutionId)` upon spawning and propagate `parentExecutionId` to `engine.policy.authorize()`.
  - Subagents can no longer launder files authored by parent or ancestor agents.

### 2.3 FORMAL-A01-AUTH-03: Subshell Wrapper `executionId` Preservation
- **Subsystem**: Core Policy Engine / Shell Recursion
- **Affected File**: `packages/core/src/services/policyEngine.ts:1435-1510`
- **Vulnerability**: When unpacking subshell commands (`sh -c <cmd>`, `bash -c <cmd>`, `dash -c <cmd>`), `classifyShellSegment` recursively invoked `this.classifyShell` without passing `executionId`. As a result, `executionId` became `undefined`, bypassing `wasWrittenThisExecution` checks and allowing an agent to execute model-authored scripts without approval simply by prepending `bash -c`.
- **Remediation**:
  - Passed `executionId`, `effectiveIsolation`, and `isSubshell: true` into the recursive `this.classifyShell` call.
  - Gated `isTrackedCompiledOutput` with `!isSubshell` so that wrapper commands cannot launder compiled paths without operator review, preserving the security fence while maintaining the anti-laundering gate for test interpreters.

### 2.4 A01-06: `ExternalHarnessAdapter` Interface Mismatch Resolution
- **Subsystem**: Agent Adapters / External Harness Protocol
- **Affected File**: `packages/agents/src/externalHarnessAdapter.ts:159-185, 428-456, 598-622`
- **Vulnerability**: `ExternalHarnessAdapter` attempted to invoke `this.options.policyEngine?.evaluate()`. The production `PolicyEngine` in `@wazir/core` implements `authorize()` and `evaluateTask()`, but lacked `evaluate()`. Consequently, policy enforcement was silently dropped for external ACP/CLI agents.
- **Remediation**:
  - Expanded `PolicyEngineLike` in `externalHarnessAdapter.ts` to support `authorize`, `evaluate`, `classify`, and `evaluateTask`.
  - In `ExternalHarnessAdapter.execute()`, evaluated `this.options.policyEngine?.evaluateTask()` against `request.objective` and `policyContext` prior to harness launch, terminating immediately with `POLICY_DENIED` if forbidden.
  - In tool permission handling, resolved `pe.authorize ?? pe.evaluate ?? pe.classify` dynamically to ensure `PolicyEngine` authorization is never skipped.
  - Added `evaluate()` as a standard alias to `authorize()` on `PolicyEngine` in `packages/core/src/services/policyEngine.ts` for dual-sided backwards compatibility.

### 2.5 Core Service: `DelegatedPolicyGate` Multi-Hop Chain Intersection
- **Subsystem**: Core Services / Delegated Permissions
- **Affected Files**: `packages/core/src/services/delegatedPolicyGate.ts`, `packages/core/src/services/index.ts:307`
- **Architecture**:
  - Implemented `DelegatedPolicyGate` providing runtime evaluation of multi-hop delegation chains ($A_0 \to A_1 \to \dots \to A_k$).
  - Enforced least-privilege attenuation: tool sets, capability sets, and path scopes are strictly intersected across all ancestors.
  - Enforced `canDelegate: boolean` and `maxDepth: number` limits along the chain.
  - Propagated revocation immediately: revoking any ancestor grant revokes all descendant permissions in $O(\text{chain depth})$.
  - Supported single-use `DelegatedApproval` tokens with consumption anti-replay protection.
  - Exported from `@wazir/core` service registry.

---

## 3. Verification & Regression Testing

### 3.1 Group A Regression Test Suite (`packages/core/tests/formalHardeningGroupA.test.ts`)
Created 23 deterministic Vitest unit tests verifying:
- **`FORMAL-A01-AUTH-01`**:
  - Host-escaping reads denied (`cat /etc/passwd`, `head -n 5 ../../../etc/shadow`).
  - Host-escaping writes denied (`sort -o /etc/passwd`).
  - Code-executing flags denied (`rg --pre=/tmp/evil.sh`, `sort --compress-program=sh`).
  - Destructive commands denied (`reboot`, `shutdown`).
  - Interpreters and mutations ask-gated (`rm`, `node`, `python3`, `find -delete`).
  - Missing inner commands denied (`find . -exec ;`).
  - Safe, contained find commands allowed (`find . -exec cat {} \;`, `find . -name "*.ts" -exec cat {} +`).
  - `-execdir` and `-ok` clauses recursively checked.
- **`FORMAL-A01-AUTH-02`**:
  - Direct parent test execution asks.
  - Child subagent test execution asks when linked via `linkParentExecution`.
  - Multi-hop delegation chains ($root \to mid \to leaf$) prevent laundering at leaf level.
  - Automatic linking via `request.parentExecutionId`.
  - Pre-existing project tests (not written by model) remain allowed.
- **`FORMAL-A01-AUTH-03`**:
  - `bash -c "node evil.test.js"` asks.
  - `sh -c` and `dash -c` ask.
  - Combined delegation + subshell unwrapping asks.
  - Safe subshell commands (`bash -c "cat safe.txt"`) allowed.
  - Dangerous subshell commands (`bash -c "reboot"`) denied.
- **`DelegatedPolicyGate`**:
  - 3-hop delegation chain intersection (tools, capabilities, path scopes).
  - Scope escalation prevention on grant registration.
  - Immediate cascade of ancestor revocation.
  - `maxDepth` edge boundary enforcement.
  - `canDelegate: false` propagation.
  - One-time approval replay prevention.

### 3.2 Vitest Test Execution Results

```
 RUN  v2.1.9 /Users/wael/Code/Wazir/.worktrees/fh30/A03

 ✓ packages/core/tests/formalHardeningGroupA.test.ts (23 tests)
 ✓ packages/core/tests/policyEngineHardening.test.ts (91 tests)
 ✓ packages/core/tests/policyEngineShell.test.ts (25 tests)

 Test Files  3 passed (3)
      Tests  139 passed (139)
   Duration  1.72s
```

### 3.3 External Harness Adapter Suite (`packages/agents/tests/externalHarnessAdapter.test.ts`)
- 15/15 tests passing (including new test `8b. enforces PolicyEngine authorization and evaluateTask (A01-06 fix)`).

### 3.4 Build & Typecheck Verification
- `packages/core`: `tsc --noEmit` exited `0` with 0 errors.
- `packages/agents`: `tsc --noEmit` exited `0` with 0 errors.

---

## 4. Worktree Commit Status

- **Worktree**: `/Users/wael/Code/Wazir/.worktrees/fh30/A03`
- **Branch**: `fh30/A03`
- **Commit SHA**: `daf61176bfc3abdb5217972947add8200a7121bd`
- **Diffstat**: 8 files changed, 1006 insertions(+), 31 deletions(-)
