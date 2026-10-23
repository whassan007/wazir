# Agent 02 Report: Goal Graph and Data Model (`feat/parallel-goal-graph`)

## 1. Summary of Work

Workstream 02 (`@wazir/goals/src/graph` and `apps/api/src/goalStudio/graphRoutes.ts`) implements the Goal Studio goal-graph data model, strict YAML parser/importer, structural and graph-theoretic validator, canonical SHA-256 digest and immutable revision store, structural revision diffing, and Express HTTP control-plane routes.

All implementations strictly conform to `packages/goals/src/contracts.ts` (v1) without modifying coordinator-owned contracts.

## 2. Factory Signature & Composition (`INTEGRATION-CONTRACTS.md` §10)

```ts
import { createGoalGraphStore, type GoalGraphStoreDeps, type GoalGraphStoreExtended } from '@wazir/goals';

export interface GoalGraphStoreDeps extends GoalStudioDeps {
  /** Optional hook invoked after a revision is durably written (e.g. to emit a `graph.revision` event). */
  onRevision?: (record: GoalGraphRevisionRecord) => void | Promise<void>;
}

export function createGoalGraphStore(deps: GoalGraphStoreDeps): GoalGraphStoreExtended;
```

`GoalGraphStoreExtended` satisfies `GoalGraphStore` (`importYaml`, `createRevision`, `getRevision`, `listRevisions`, `listGraphs`, `validate`) and adds helper methods (`getGraph`, `diff`, `criticalPath`).

## 3. Files Owned & Touched

- `packages/goals/src/graph/index.ts` — Barrel exporting YAML parser, canonical digest, validation/cycle/topological/critical-path helpers, YAML importer, revision diffing, and `createGoalGraphStore`.
- `packages/goals/src/graph/yaml.ts` — Dependency-free strict YAML parser supporting block mappings/sequences, flow collections, literal/folded block scalars, and rejecting tabs, duplicate keys, anchors/aliases/tags, and excessive nesting/size.
- `packages/goals/src/graph/importer.ts` — Maps `nobel_goal_graph.yaml` (as well as `program`, `stages`, `execution_graph`, and top-level `completion_states` schema variants) into `GoalGraphDefinition`, keeping the target DAG (`targets`) distinct from the reusable execution/prompt graph (`executionGraph`), and extracting `PromptSeed[]` via `extractPromptSeeds`.
- `packages/goals/src/graph/validation.ts` — Pure structural and graph validator (`SCHEMA`, `DUPLICATE_TARGET`, `UNKNOWN_DEPENDENCY`, `CYCLE`, `SELF_DEPENDENCY`, `UNKNOWN_EXECUTOR`, `INVALID_LIMIT`), iterative Tarjan SCC cycle finder (`findCycles`), deterministic priority-weighted `topologicalOrder`, `criticalPath`, `dependents`, and `rootTargets`.
- `packages/goals/src/graph/canonical.ts` — Recursive key-sorted `canonicalJson`, `sha256Hex`, and `graphDigest`.
- `packages/goals/src/graph/diff.ts` — Pure structural `diffRevisions(from, to)` across metadata, constitution, targets, and executionGraph nodes.
- `packages/goals/src/graph/store.ts` — `createGoalGraphStore` persisting immutable `GoalGraphRevisionRecord` entries under `GOAL_STORE_KEYS.graph(graphId)` and `GOAL_STORE_KEYS.graphRevision(graphId, revision)` with atomic compare-and-set (`KeyValueStore.update` or per-key lock), optimistic `parentRevision` concurrency (`LEDGER_CONFLICT`), and read-time SHA-256 integrity verification.
- `apps/api/src/goalStudio/graphRoutes.ts` — Express routes mounted under `/api/v1/goal-studio/graphs` (`POST /import`, `POST /validate`, `GET /`, `GET /:graphId`, `GET /:graphId/revisions`, `GET /:graphId/revisions/:rev`, `POST /:graphId/revisions`, `GET /:graphId/critical-path`, `GET /:graphId/diff`) enforcing `auth.requireViewerOrOperator` for reads, `auth.requireOperator` for mutations, `GOAL_STUDIO_HTTP_STATUS` mapping, and 503 degradation when `ctx.services.graphs` is unconfigured.
- `packages/goals/tests/graph/helpers.ts` — Fixture loader for `packages/goals/fixtures/nobel_goal_graph.yaml` and minimal test graph builder.
- `packages/goals/tests/graph/validationAndImport.test.ts` — Unit tests for `nobel_goal_graph.yaml` import, `stages`/`program`/`execution_graph` variants, YAML parser rejection cases, all 7 `GraphValidationIssueCode`s, cycle detection, topological ordering, critical path, canonical digests, and revision diffing.
- `packages/goals/tests/graph/storeAndRoutes.test.ts` — Persistence, revision immutability, stale `parentRevision` conflict detection, tamper detection, and end-to-end HTTP route + RBAC tests.

## 4. Verification Evidence

1. TypeScript project references build cleanly:
   - Command: `npx tsc --build`
   - Result: Exit code `0` (0 errors).
2. Goal graph unit and HTTP route test suite:
   - Command: `npx vitest run packages/goals/tests/graph`
   - Result: `2 passed (2)` test files, `10 passed (10)` tests.

## 5. Integration Notes

- No changes to `packages/goals/src/contracts.ts` are required.
- Coordinator wiring in `apps/api/src/goalStudio/services.ts` can instantiate `graphs: createGoalGraphStore(deps)` directly.
- Workstream 08 (Prompt Studio) can call `extractPromptSeeds(yaml)` from `@wazir/goals` (or consume `prompts` returned by `importYaml`) to seed specialist prompts from imported YAML graphs.
