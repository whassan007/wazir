# Agent 08 — Prompt Studio (`feat/parallel-prompt-studio`)

## Summary

Implemented the **Prompt Studio** subsystem (`@wazir/goals` prompts area, Express HTTP routes, and Goal Studio web module) against `packages/goals/src/contracts.ts` v1 without modifying any files outside Agent 08's ownership.

## Factory & Public API (`packages/goals/src/prompts/index.ts`)

```ts
createPromptStore(deps: GoalStudioDeps & PromptStoreOptions): PromptStudio
```

Where `PromptStudio = PromptStore & PromptAdmin`:
- **`PromptStore` (contract)**:
  - `latest(executorKey)` — resolves the latest immutable `PromptDefinition` bound to `executorKey` via `GOAL_STORE_KEYS.promptHead(executorKey)` and authoritative version slots.
  - `get(promptId, version)` — returns an immutable clone of `GOAL_STORE_KEYS.prompt(promptId, version)`.
- **`PromptAdmin` extensions**:
  - `create(draft, actor)` / `publish(draft, actor)` — validates `PromptDraft` (ID/executorKey regex, template/schema byte caps, Draft-07 JSON Schema compilation via `ajv`, capability normalization, optimistic concurrency via `expectedVersion`), computes canonical SHA-256 `digest`, claims monotonic version slot (`KeyValueStore.update` when available, per-key mutex fallback otherwise), advances head, and emits `prompt.version` events. Identical content at head is a no-op (`created: false`).
  - `rollback(promptId, toVersion, actor, note?)` — appends a **new** monotonic version copying `toVersion`'s content with `rollbackOf: toVersion` and `source: 'rollback'`. Historical versions and `TargetAttempt.promptRef` bindings are never rewritten.
  - `seedFromGraph(seeds?, actor?)` & `seedDefaults(actor?)` — idempotently seeds specialist prompts at v1 with derived input schemas (`deriveInputSchema`), never reverting operator edits on re-seed. `DEFAULT_PROMPT_SEEDS` includes all 21 `nobel_goal_graph.yaml` execution-graph/target executors plus the 9 Nobel scientific agent executors (`LiteratureSynthesisAgent`, `HypothesisGeneratorAgent`, `TheoryConstraintAgent`, `ObservablePredictionAgent`, `ExperimentalDesignAgent`, `DataAnalysisAgent`, `ReplicationPackageAgent`, `AdversarialReviewerAgent`, `PaperDraftingAgent`).
  - `diff(promptId, a, b)` — LCS line diff (`diffLines`) on templates plus structural JSON diff (`diffJson`) on `inputSchema`, `outputSchema`, `role`, and `requiredCapabilities`.
  - `renderPrompt(def, inputs)` — validates `inputs` against `inputSchema`, verifies all `{{var}}` / `{{a.b}}` placeholders resolve to defined own properties, and renders variables while leaving single-brace literals (`Return {a, b}`) untouched.
  - `evaluate(promptId, version, cases, actor)` & `compareVersions(promptId, a, b, cases, actor)` — executes golden cases sequentially through an injected `PromptRunner` with per-case timeouts, JSON extraction (raw or fenced), `outputSchema` validation, `contains` / `notContains` / `matches` / `equals` / `subset` / `renderFails` checks, and persists results under `goals/prompts/<promptId>/eval/<evalId>`.

## HTTP Routes (`apps/api/src/goalStudio/promptRoutes.ts`)

Mounted at `/api/v1/goal-studio/prompts`:
- `GET /prompts` (`requireViewerOrOperator`) — list prompt summaries and `canEvaluate`.
- `GET /prompts/:id` (`requireViewerOrOperator`) — head version and metadata.
- `GET /prompts/:id/versions` (`requireViewerOrOperator`) — full immutable version history.
- `GET /prompts/:id/versions/:version` (`requireViewerOrOperator`) — resolve specific historical version.
- `GET /prompts/:id/diff?a=&b=` (`requireViewerOrOperator`) — line & schema diff between versions (`from`/`to` aliases also supported).
- `GET /prompts/:id/evaluations` (`requireViewerOrOperator`) — stored evaluation runs (optional `?version=`).
- `POST /prompts/:id/render` (`requireViewerOrOperator`) — side-effect-free template render preview with input schema & variable validation.
- `POST /prompts` (`requireOperator`) — create prompt or publish new version + governance audit event.
- `POST /prompts/:id/versions` (`requireOperator`) — publish new version on `:id` with optional `expectedVersion` CAS.
- `POST /prompts/:id/rollback` (`requireOperator`) — append rollback version copying `toVersion` + governance audit event.
- `POST /prompts/:id/evaluate` (`requireOperator`) — run evaluation cases or `compareWith` version comparison (returns `503` when no runner is configured).

When `ctx.services.prompts` is not yet wired, all routes respond `503 { error: { code: 'INTERNAL', message: 'prompts not configured' } }` per `INTEGRATION-CONTRACTS.md` §10.

## Web Module (`apps/web/public/goal-studio/prompts.js`)

Vanilla ES module registering `window.WazirGoalStudio.register('prompts', { mount(el, ctx), unmount() })`:
- Sidebar with executor/role search filter, version badge, and `+ New` draft button.
- Prompt definition editor (template, role, capabilities, release note, input/output JSON Schemas) with optimistic concurrency (`expectedVersion`).
- Immutable version history list with `Inspect`, `Compare Diff` line viewer, and one-click `Rollback to vN`.
- Interactive Render Preview panel and Golden Case Evaluation / Version Comparison runner.
- Subscribes to `prompt.version` SSE events via `ctx.events` when a run is active.

## Files Owned & Modified

- `packages/goals/src/prompts/index.ts`
- `packages/goals/src/prompts/types.ts`
- `packages/goals/src/prompts/canonical.ts`
- `packages/goals/src/prompts/schema.ts`
- `packages/goals/src/prompts/render.ts`
- `packages/goals/src/prompts/diff.ts`
- `packages/goals/src/prompts/evaluation.ts`
- `packages/goals/src/prompts/seeds.ts`
- `packages/goals/src/prompts/store.ts`
- `packages/goals/tests/prompts/{helpers.ts,store.test.ts,binding.test.ts,diff.test.ts,render.test.ts,seed.test.ts,evaluation.test.ts}`
- `apps/api/src/goalStudio/promptRoutes.ts`
- `apps/api/tests/prompts.goalStudioRoutes.test.ts`
- `apps/web/public/goal-studio/prompts.js`
- `reports/goal-studio-12-agents/agent-08.md`

## Verification

- `npx tsc --build` — exited `0` (zero errors).
- `npx vitest run packages/goals/tests/prompts apps/api/tests/prompts.goalStudioRoutes.test.ts` — **7 test files passed, 51 tests passed**.

## Integration Notes for Coordinator

1. **Wiring in `apps/api/src/goalStudio/services.ts`**:
   ```ts
   import { createPromptStore } from '@wazir/goals';
   const prompts = createPromptStore({
     store: deps.store,
     workspaceRoot: deps.workspaceRoot,
     clock: deps.clock,
     onEvent: (ev) => governance.audit({ seq: 0, ...ev }),
   });
   await prompts.seedDefaults('system:startup');
   ```
2. **`packages/goals/package.json`**: `packages/goals/src/prompts/schema.ts` imports `ajv` (already hoisted at workspace root `node_modules/ajv`). Adding `"ajv": "^8.17.1"` to `packages/goals/package.json` `dependencies` is recommended for strict package isolation.
