# Agent 10 Report — Security, Policy, and Governance (`feat/parallel-security-governance`)

## 1. Identity & Scope

| Field | Value |
|---|---|
| **Agent ID** | Agent 10 (`feat/parallel-security-governance`) |
| **Role** | Security, Policy, and Governance Engineer |
| **Worktree** | `/Users/wael/Code/Wazir-gs/agent-10` |
| **Branch** | `feat/parallel-security-governance` |
| **Starting Commit SHA** | `e20355e30855f17cedeeeefb1ab7630f3e423ff6` |
| **Contract Version** | `GOAL_STUDIO_CONTRACT_VERSION = 1` (`packages/goals/src/contracts.ts`) |

---

## 2. Files Owned & Touched

All edits were strictly confined to Workstream 10 ownership per `reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md`:

- [`packages/goals/src/governance/index.ts`](file:///Users/wael/Code/Wazir-gs/agent-10/packages/goals/src/governance/index.ts) — Implemented `createGoalGovernance`, `GoalGovernanceService`, `isModelOrAgentPrincipal`, `formatApprovalScope`, `sanitizeAuditValue`, `DEFAULT_GOAL_CONSTITUTION`, and tamper-evident SHA-256 hash-chained audit persistence under `GOAL_STORE_KEYS.audit(seq)`.
- [`packages/goals/tests/governance/governance.test.ts`](file:///Users/wael/Code/Wazir-gs/agent-10/packages/goals/tests/governance/governance.test.ts) — Comprehensive unit & adversarial security test suite (25 tests).
- [`apps/api/src/goalStudio/governanceRoutes.ts`](file:///Users/wael/Code/Wazir-gs/agent-10/apps/api/src/goalStudio/governanceRoutes.ts) — Implemented `registerGovernanceRoutes` mounting `/api/v1/goal-studio/governance/{audit,policy,preflight,spend-check}` with RBAC (`auth.requireViewerOrOperator` and `auth.requireOperator`) and 503 degradation when `ctx.services.governance` is not wired.
- [`apps/api/tests/governance.goalStudioRoutes.test.ts`](file:///Users/wael/Code/Wazir-gs/agent-10/apps/api/tests/governance.goalStudioRoutes.test.ts) — HTTP route authentication, RBAC, 503 fallback, spend-gate, approval-scope, and audit-chain tests (3 test suites / 12 HTTP assertions).
- [`packages/core/src/services/policyEngine.ts`](file:///Users/wael/Code/Wazir-gs/agent-10/packages/core/src/services/policyEngine.ts) — Governance hardening (`G-1` through `G-8`: recursive `find -exec` classification, dangerous environment variable injection guard, physical symlink containment, compiler plugin/linker execution deny, `ps -E`/`eww` credential leak guard, wrapper command unwrapping, network pipe-to-interpreter RCE deny).
- [`reports/goal-studio-12-agents/agent-10.md`](file:///Users/wael/Code/Wazir-gs/agent-10/reports/goal-studio-12-agents/agent-10.md) — This report.

*(Verified `packages/goals/src/contracts.ts` was NOT modified.)*

---

## 3. Factory Signature & Composition Contract (for Coordinator Wiring in `apps/api/src/goalStudio/services.ts`)

```ts
import { createGoalGovernance, type CreateGoalGovernanceDeps, type GoalGovernanceService } from '@wazir/goals';

// Factory signature:
export function createGoalGovernance(deps: CreateGoalGovernanceDeps): GoalGovernanceService;

// Where CreateGoalGovernanceDeps extends GoalStudioDeps:
export interface CreateGoalGovernanceDeps extends GoalStudioDeps {
  graphs?: GoalGraphStore;
  ledger?: GoalLedgerStore;
  defaultConstitution?: GoalConstitution;
  policyOptions?: PolicyEngineOptions;
}
```

### Wiring in `apps/api/src/goalStudio/services.ts`:
```ts
const governance = createGoalGovernance({
  store: deps.store,
  clock: deps.clock,
  workspaceRoot: deps.workspaceRoot,
  graphs,
  ledger,
});
```

---

## 4. Security & Governance Controls Implemented

1. **Non-Principal Model Boundary (`isModelOrAgentPrincipal` & `assertHumanOrSystemPrincipal`)**:
   - Rejects any principal matching `model:*`, `agent:*`, `executor:*`, `llm:*`, `assistant:*`, `subagent:*`, `autonomous:*`, `tool:*`, `worker-model:*`, `bot:*`, or empty principal with `effect: 'deny'` (`MODEL_PRINCIPAL_FORBIDDEN` / `PRINCIPAL_REQUIRED`).
   - Also inspects `input.context.principal` and action strings for self-approval, constitution mutation, policy bypass, or budget raising (`CONSTITUTION_INVARIANT_VIOLATION`).

2. **Constitution Invariants (`preflight`)**:
   - Enforces `objective_owner: human`, `no_fabrication`, `no_unverified_completion`, `no_wet_lab_or_hazardous_protocols`, `no_unapproved_external_submission`, `no_unbounded_retry_loops`, and `preserve_reproducibility_artifacts`.
   - Enforces `resourceLimits`: `maxTasksPerRun`, `maxRunMinutes`, `deadlineAt`, `maxRepairsPerTask`, and `hostedSpendUsd`.

3. **Scoped Approvals (`requiresApproval` & `needsApproval`)**:
   - Returns `effect: 'ask'` with deterministic `approvalScope = "${run.runId}:${target.id}:${attempt}:${action}"`.
   - Approvals are bound strictly to `(runId, targetId, attempt, action)` and cannot be replayed across different targets, attempts, or runs.

4. **Hard Spending Gate (`authorizeSpend`)**:
   - Rejects negative, `NaN`, or non-finite `amountUsd` (`effect: 'deny'`).
   - Allows `$0` local/free inference (`effect: 'allow'`).
   - When `hostedSpendUsd === 0` (the default in `nobel_goal_graph.yaml`), denies any positive spend (e.g., `$0.0001` denied with explicit `BUDGET_DENIED` reason).
   - When a positive ceiling is configured by a human operator, denies whenever `run.resource.hostedSpendUsd + amountUsd > ceiling` (`BUDGET_EXCEEDED`).

5. **Tamper-Evident Redacted Audit Log (`audit`, `queryAudit`, `verifyAuditChain`)**:
   - Persists sequential records under `GOAL_STORE_KEYS.audit(seq)` (`goals/audit/0000000001`, ...).
   - Scrubs all strings and sensitive keys (`apiKey`, `client_secret`, `token`, `password`, bearer tokens, URLs with embedded credentials, PEM keys, and ANSI terminal escapes) using `@wazir/shared` `sanitizeUntrustedOutput` and key-name redaction before persistence.
   - Chains records via SHA-256 `prevDigest` → `digest` (`GENESIS` for sequence 1) and exposes `verifyAuditChain()` to detect any post-hoc tampering.

6. **HTTP Routes (`apps/api/src/goalStudio/governanceRoutes.ts`)**:
   - `GET /api/v1/goal-studio/governance/audit` (`auth.requireViewerOrOperator`)
   - `GET /api/v1/goal-studio/governance/policy` (`auth.requireViewerOrOperator`)
   - `POST /api/v1/goal-studio/governance/preflight` (`auth.requireOperator`)
   - `POST /api/v1/goal-studio/governance/spend-check` (`auth.requireOperator`)

---

## 5. Verification Evidence

### Build Verification
Command: `npx tsc --build`
Exit code: `0` (zero errors)

### Test Execution
Command: `npx vitest run packages/core/tests/policyEngine.test.ts packages/goals/tests/governance apps/api/tests/governance.goalStudioRoutes.test.ts`
Result:
- `packages/goals/tests/governance/governance.test.ts`: **25 passed (25)**
- `apps/api/tests/governance.goalStudioRoutes.test.ts`: **3 passed (3)**
- `packages/core/tests/policyEngine.test.ts`: **23 passed (23)**
- **Total: 3 test files passed, 51 tests passed, 0 failures.**

---

## 6. Integration Notes & Remaining Risks

- **No changes required to `packages/goals/src/contracts.ts`**.
- **Coordinator wiring**: In `apps/api/src/goalStudio/services.ts`, pass `{ store, clock, workspaceRoot, graphs, ledger }` into `createGoalGovernance(...)` and assign the result to `services.governance`.
- **Remaining risks**: None in Workstream 10 scope.
