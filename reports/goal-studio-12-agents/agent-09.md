# Agent 09 Report: Model Routing and Worker Fleet (`feat/parallel-model-fleet`)

## 1. Agent & Workstream Metadata
- **Agent ID**: Agent 09
- **Role**: Model Routing and Worker Fleet (`feat/parallel-model-fleet`)
- **Worktree**: `/Users/wael/Code/Wazir-gs/agent-09`
- **Branch**: `feat/parallel-model-fleet`
- **Starting Commit SHA**: `e20355e30855f17cedeeeefb1ab7630f3e423ff6`

## 2. Files Owned & Touched
All changes strictly reside within Agent 09's ownership scope defined in `reports/goal-studio-12-agents/INTEGRATION-CONTRACTS.md`:
- `packages/goals/src/routing/index.ts`
- `packages/goals/src/routing/types.ts`
- `packages/goals/src/routing/capabilities.ts`
- `packages/goals/src/routing/hosting.ts`
- `packages/goals/src/routing/readinessProbe.ts`
- `packages/goals/src/routing/modelRouter.ts`
- `packages/goals/tests/routing/helpers.ts`
- `packages/goals/tests/routing/readinessProbe.test.ts`
- `packages/goals/tests/routing/modelRouter.test.ts`
- `apps/api/src/goalStudio/fleetRoutes.ts`
- `apps/api/tests/fleet.goalStudioRoutes.test.ts`
- `apps/web/public/goal-studio/fleet.js`
- `reports/goal-studio-12-agents/agent-09.md`

`packages/goals/src/contracts.ts` was **not** modified.

## 3. Architecture & Changes Implemented

### 3.1 Verified-Readiness Model Router (`packages/goals/src/routing/`)
- **Factory**: `createModelRouter(deps: ModelRouterDeps): FleetModelRouter` (implements `ModelRouter` from `packages/goals/src/contracts.ts`).
- **Verified-Readiness Gating**:
  - `RuntimeReadinessProbe` (`createReadinessProbe`) verifies local model instances via a real tiny generation request (`maxTokens <= 32`, `maxModelCalls: 1`, deterministic prompt) and optional native tool-call probe (`report_status`).
  - Configured-only, unloaded, draining, unhealthy, failed-probe, or expired-TTL models are **never** routed. Every rejected candidate is recorded in `decision.rejected` (and `explain().candidates`) with the exact human-readable reason.
  - Hosted (paid) providers are never probed by readiness sweeps (guaranteeing $0 probe cost); they require external execution evidence or explicit readiness records.
- **Local-First & Qwen Coding Model Preference**:
  - When `localFirst: true`, all eligible local ($0) instances rank in tier `0` ahead of any hosted provider (tier `1`).
  - Ready local Qwen coding models (`family === 'qwen'` or `/qwen/i.test(id)`) receive a `+3` local coding preference bonus so local Qwen coding models win over generic local models at equal residency/reliability.
- **Hard Hosted-Budget Enforcement**:
  - When `remainingHostedBudgetUsd <= 0`, hosted models are rejected (`hosted inference denied: remaining hosted budget is $0`), guaranteeing $0 paid inference when `hostedSpendUsd: 0`.
  - Hosted models without known pricing or whose estimated cost exceeds `remainingHostedBudgetUsd` are rejected with exact budget explanations.
- **Capability Matching & Mid-Run Fallback**:
  - `parseCapabilities` and `checkCapabilities` enforce declared capabilities, model flags (`vision`, `structuredOutput`, `reasoning`, `embedding`, `audio`), minimum effective context window (`context:32k`, `context>=16000`), `local` pin, and probe-verified `toolCalling`.
  - `excludeModelIds` and `router.fallback(...)` record failed outcomes, invalidate the failed instance's readiness, and re-route to the next verified-ready candidate.
- **Dynamic Fleet Registration**:
  - Added `router.registerModel(input: FleetModelRegistrationInput)` to register or update a model record, optional serving instance, and optional initial readiness state.

### 3.2 Goal Studio Fleet HTTP Routes (`apps/api/src/goalStudio/fleetRoutes.ts`)
Mounted under `/api/v1/goal-studio`:
- `GET /api/v1/goal-studio/fleet/models` (`auth.requireViewerOrOperator`): Returns model fleet readiness, capabilities, circuit-breaker reliability, cost/latency accounting, and runtime statuses.
- `GET /api/v1/goal-studio/fleet/workers` (`auth.requireViewerOrOperator`): Returns worker/computer health, heartbeat freshness, RAM/VRAM resource snapshots, and attached runtimes.
- `POST /api/v1/goal-studio/fleet/models/probe` (`auth.requireOperator`): Triggers local readiness probing (for all local models or a specific `modelId`/`instanceId`), skipping hosted models and emitting an audit event.
- `POST /api/v1/goal-studio/fleet/route` (`auth.requireViewerOrOperator`): Runs `router.explain(request)` for route simulation and candidate rejection inspection without side effects.
- `POST /api/v1/goal-studio/fleet/models/register` (`auth.requireOperator`): Registers a model and optional instance into the fleet and emits an audit event.
- Degrades cleanly to HTTP `503` `{ error: { code: 'INTERNAL', message: 'router not configured' } }` when `ctx.services.router` is not yet wired.

### 3.3 Web Shell Module (`apps/web/public/goal-studio/fleet.js`)
- Vanilla ES module registering `window.WazirGoalStudio.register('fleet', { mount(el, ctx), unmount() })`.
- Displays:
  - Fleet summary banner (verified-ready models, hosted count, online workers, healthy runtimes, readiness TTL).
  - Model Readiness & Capability Inventory table with `LOCAL ($0)` vs `HOSTED (PAID)` badges, `VERIFIED READY` / `STALE / FAILED` / `UNVERIFIED` badges, capability tags, tool-use verification status, circuit-breaker state, and per-model / fleet-wide probe triggers.
  - Route Simulator form (`requiredCapabilities`, `remainingHostedBudgetUsd`, `excludeModelIds`, `localFirst`) showing the selected route or rejection reasons for every candidate.
  - Worker & Computer Fleet Health cards with memory headroom and heartbeat state.
  - Operator Model Registration form.

## 4. Integration Notes for Coordinator (`apps/api/src/goalStudio/services.ts`)
Wire `services.router` using `createModelRouter` from `@wazir/goals`:
```ts
import { createModelRouter } from '@wazir/goals';

const router = createModelRouter({
  store: deps.store,
  clock: deps.clock,
  workspaceRoot: deps.workspaceRoot,
  models: state.models,
  runtimes: state.runtimes,
  computers: state.computers,
  adapters: new Map(state.discovered.map((d) => [d.id, d.adapter])),
});
```

## 5. Verification & Test Evidence
Commands executed in `/Users/wael/Code/Wazir-gs/agent-09`:
1. `npx tsc --build` -> **Exit 0** (clean TypeScript build across all project references).
2. `npx vitest run packages/goals/tests/routing apps/api/tests/fleet.goalStudioRoutes.test.ts` -> **Exit 0**:
   - `packages/goals/tests/routing/readinessProbe.test.ts`: **14 passed (14)**
   - `packages/goals/tests/routing/modelRouter.test.ts`: **24 passed (24)**
   - `apps/api/tests/fleet.goalStudioRoutes.test.ts`: **5 passed (5)**
   - **Total**: **3 test files passed, 43 tests passed (0 failures)**.

## 6. Remaining Risks / Known Limitations
- Hosted model pricing is supplied via the optional `pricing(modelId, runtimeId)` callback in `ModelRouterDeps`. When no pricing callback is provided, hosted models are safely rejected (`hosted model has no known pricing; spend cannot be bounded`), preserving the fail-closed hosted spend guarantee.
