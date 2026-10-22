# Competitive execution implementation report

## Implementation

A native-agent competitive vertical slice is implemented and tested. The broader assignment is **not fully complete**. Unsupported execution paths fail closed; the omissions below are not implied to be implemented.

Feature branch: `feature/competitive-agent-execution`. Dedicated worktree: `/private/tmp/wazir-competitive`. Baseline: `f3b115a`. The original checkout's pre-existing and concurrent changes were preserved; it was not switched, merged or reset.

Actual source changes:

- `packages/core/src/services/competitiveExecution.ts`: typed schema-v1 contracts; race coordination; atomic claim/state/attempt updates; common-commit worktrees; patch capture and ownership protection; fresh verification; gate-first ranking; budget reservations; progressive dispatch; abort settlement; recovery fencing; replay; export; promotion via VerifiedIntegrationCoordinator.
- `packages/core/src/services/{index,scheduler,modelIntelligenceService,worktreeManager}.ts`: exports, opt-in empirical ordering, explicit baseline and refusal to reuse existing race branches. The existing scheduler remains authoritative for eligibility.
- `packages/core/src/types/execution.ts`: typed race verification/recovery events in the existing execution-event union.
- `packages/tools/src/sandbox.ts`: opt-in strict verification profile with immutable inputs, isolated temporary writes and no shared Git or network access; legacy sandbox behavior unchanged.
- `apps/cli/src/competitive.ts`: existing native CodingAgent/runtime/provider integration, source-only canonical tool policy, existing ExecutionEngine and ModelLifecycleService integration, independent VerificationEngine evidence, CLI policy/configuration selection and provider-derived accounting.
- `apps/cli/src/index.ts`: opt-in task flags; race list/status/inspect/compare/cancel/recover/cleanup/promote/export; race replay; `wa explain` integration.
- `tests/competitive-execution/`: functional/failure/recovery tests, real native two-model CLI-entry test with a deterministic provider, real macOS sandbox tests, reproducible benchmark, actual CSV/JSON output, legacy execution fixture helper and example policy.
- `docs/architecture/{competitive-agent-execution,adaptive-agent-routing,competitive-execution-threat-model}.md`: inventory, contracts, design decisions, security boundaries, upstream pattern review and limitations.

Reused components: Scheduler, planTask/routeAvailability, CodingAgent/AgentRuntime, governed runtime adapters, ModelRegistry, ModelLifecycleService, ExecutionEngine, VerificationEngine, VerifiedIntegrationCoordinator, WorktreeManager, TaskCapabilityClassifier, ModelIntelligenceService, ResourceRouter/TokenBudgetManager/AccountRegistry, canonical filesystem tools, OS sandboxing, process-tree termination, KeyValueStore/JsonFileStore/PostgresStore. No dependency, scheduler, daemon, network service or persistence framework was added. StrategyLearningService's structural extraction remains unconnected to race outcomes.

New public core APIs include CompetitiveExecution and its create/run/get/list/cancel/recover/cleanup/replay/promote/export operations, versioned race types and evidence helpers; Scheduler/ModelIntelligenceService gain optional competitive ordering. Normal task execution is unchanged unless `--race` or `--routing` is supplied.

CLI usage and policy example are in the architecture document. A trusted `--race-policy` is mandatory. Model-only experiments keep the native agent/tooling fixed. An explicit model pin never silently changes model. Race management currently renders JSON. `promote` prepares/re-verifies a candidate for review and never updates the target branch.

Migration: no SQL migration. New `competitive:v1:` and `competitive-event:v1:` key namespaces use the existing atomic KV mutation mechanism; stores without atomic update are rejected. Existing records and default routes remain compatible.

## Verification

Commands executed:

```sh
npm run typecheck
npm run build
node scripts/bundle.mjs
npx vitest run tests/competitive-execution/competitive.test.ts
npx vitest run tests/competitive-execution/native.test.ts tests/competitive-execution/sandbox.test.ts tests/competitive-execution/competitive.test.ts
npx vitest run packages/core/tests packages/agents/tests packages/tools/tests apps/cli/tests tests/competitive-execution --exclude '**/improvementSupervisor*.test.ts'
WAZIR_WRITE_COMPETITIVE_BENCHMARK=1 npx vitest run tests/competitive-execution/benchmark.test.ts
git diff --check
node bin/wa.js task run --help
node bin/wa.js task race --help
```

Build/type-check: full workspace build and CLI bundle passed. Subsequent code changes were checked with a fresh TypeScript build and CLI bundle. Root package.json has no lint script; whitespace validation passed. Existing policy/security tests are included in the regression command. No new external scanner dependency was introduced.

An initial run inside Codex's sandbox encountered local-socket/process-probe restrictions (18 failures, 7 unhandled errors). The host rerun removed those environmental failures; its one remaining new native-race failure exposed missing execution completion evidence. That integration was repaired by binding actual independent evidence and evaluation to the existing execution revision. A related coordinator bug incorrectly classified finalization failures as timeouts; it is fixed and regression tested. The final relevant regression pass passed **1,835 tests with 13 skips (236 files passed, one skipped)**. A later focused pass after read-only-workspace hardening passed **38 tests with 10 platform skips**. The final command and counts are recorded in `tests/competitive-execution/verification-summary.json`.

New tests cover two valid candidates, one/all failures, provider outage substitute, invalid configurations, monetary reservation and missing-usage denial, bounded/progressive dispatch, isolated baseline worktrees and collisions, test/policy tampering, symlink rejection, denied tools, stable ties, missing evidence, durable-store restart and duplicate claim, live/dead owner fencing, cancellation before/during dispatch, cooperative timeout, uncooperative abort fencing, fresh target qualification and regression blocking, replay preservation/exclusion from learning, concurrent races, and honest absent telemetry.

Real macOS sandbox tests execute the production verifier: a correct patch passes; attempted acceptance overwrite, primary-workspace reads, credential inheritance and network access and parent-directory renames fail. The native end-to-end test exercises the CLI race entry, existing scheduler/lifecycle/execution records, two separate CodingAgent instances, a deterministic runtime and production verification. No paid model API is required. Linux bubblewrap profile construction is tested; Linux runtime execution is unverified here.

## Performance

Actual results are committed in `tests/competitive-execution/benchmark-results.csv` and `benchmark-summary.json`. Five deterministic fixtures per mode; fixture version 20261021; Darwin, Node v22.23.3. Success is determined by real independent assertions against the resulting files, not the agent's completion statement.

| Mode | Verified successes | Median ms | p95 ms |
|---|---:|---:|---:|
| Existing single-agent execution | 3/5 | 115.012 | 143.109 |
| Two-agent race | 5/5 | 274.162 | 280.511 |
| Three-agent race | 5/5 | 314.793 | 370.755 |
| Adaptive, cold start | 3/5 | 226.933 | 244.408 |
| Progressive racing | 5/5 | 281.226 | 478.069 |

These measurements demonstrate deterministic gate/selection behavior and actual orchestration overhead, **not statistical model-quality improvements**. A is scripted to fail two fixtures; B/C produce correct candidates. The legacy baseline uses executeTask and a scripted CodingAgent provider, while coordinator modes use a controller fake file agent. That tooling difference prevents attributing the latency/quality difference to model routing. Adaptive mode deliberately has no invented training history and falls back to scheduler order. Five samples are insufficient for statistical claims or a stable tail estimate.

CSV also records first output, time to first independently verified implementation, actual attempt count, tool calls/failure rates, process RSS delta, eligible-winner accuracy and binary-success regret where alternatives actually ran (not cost/latency regret). Token/cost fields are blank because fake execution has no real tokenization or provider bill. Provider charges, recovery performance and regret for unexecuted alternatives are not fabricated. RSS deltas include allocator/GC noise and are not OS-isolated resource accounting. Real local/hosted model comparisons and a warmed adaptive routing benchmark remain unverified.

## Risks and incomplete integrations

- **ACP/vendor/external agents and remote workers are not admitted.** Existing external adapters bypass the controller tool policy, and the available sandbox has only an on/off network policy, not provider-only egress. Passing them worktree paths would not meet the isolation requirement. A validated process/egress/credential/cancellation boundary is a prerequisite.
- **Independent dependency/service provisioning is absent.** Worktrees do not share mutable node_modules, caches, databases or services. Nontrivial project checks need a separately provisioned isolated environment. Baseline symlinks are refused. There is no unsafe host/network fallback.
- **Verification coverage is trusted-policy dependent.** Build/unit/applicable integration/lint/format/types/security/acceptance commands must actually exist and be sufficient. There is no universal auto-discovery or security scanner; an underspecified policy cannot prove every P0 dimension. Test counts are not parsed or invented.
- **Recovery fences rather than resumes.** Dead-owner/uncertain work becomes RECOVERY_REQUIRED with no duplicate dispatch. Cross-host fencing, PID-reuse defense, automatic continuation and orphan sweeping are incomplete. An uncooperative adapter blocks cleanup. Determinate races retain worktrees until explicit cleanup; full automatic disk cleanup is not implemented.
- **Routing is deliberately small.** It uses verified outcomes, policy/category/language/complexity and configuration versions, an uncertainty-aware posterior and minimum-evidence exploration. Rich repository/context/tool features, critical-task policies, calibrated probability estimates, configurable ranking weights/maintainability metrics and confidence/value-driven escalation remain incomplete. Structural StrategyLearningService ingestion is not implemented.
- **Replay is approximate and race-only.** Arbitrary legacy task replay, exact dependency/environment reproduction and alternative-model CLI price resolution under a captured dollar ceiling are incomplete. Original results are preserved; replay metrics do not train production routing.
- **Promotion ends at review.** Fresh verification, conflict/dependency checks, target drift and rollback refs are implemented through the existing coordinator. Actual authorized target update, post-merge regression monitoring and automatic revert are not implemented. Repeated qualification can retain old integration worktrees requiring manual inspection/cleanup.
- **Provider evidence remains limited.** Provider terms/quota controls reuse existing adapters, but paid-provider race execution/billing, physical local model concurrency and Linux sandbox execution were not exercised. Monetary bounds are conservative internal estimates, not provider-invoice guarantees. Unknown prices/usage are never zeroed to qualify a metered candidate.
- **History retention is not automatic.** Captured task inputs and patches are necessary for replay and may be sensitive. Tool events omit raw arguments/model text/credentials, but operators need an appropriate storage/retention policy. No signed remote attestation or hostile multi-tenant guarantee is provided.

No DGX configuration, infrastructure, deployment, hardware optimization, push, merge, protected-branch update or release was performed.

Rollback: the primary branch was never modified. Stop/fence uncertain processes, retain the audit record, remove determinate candidate worktrees with `wa task race cleanup`, and discontinue the feature branch if needed. Promotion stores the current target's rollback SHA and blocks readiness on regressions. Any later human merge needs a normal reviewed Git revert; automatic post-merge rollback is incomplete.

## Acceptance status

| Acceptance criterion | Status |
|---|---|
| N independent configurations via `wa task run --race N` | Implemented/tested for eligible local native-agent placements and deterministic provider; hosted adapter code reused but live hosted race unverified; external/remote incomplete |
| Isolated worktrees at a common baseline | Implemented/tested |
| Trusted criteria protected; independent verification | Implemented/tested on macOS; sufficient project checks/provisioning remain operator prerequisites |
| Deterministic explanation, failed candidates excluded, no-valid-winner | Implemented/tested |
| Budgets and bounded concurrency | Implemented/tested with fake accounting; existing per-provider governor reused; real billing unverified |
| Cancellation/timeouts clean resources | Processes/settlement tested; worktrees retained for explicit cleanup; uncooperative adapters fenced |
| Restart recovery | Atomic claim/dead-owner fencing tested; automatic continuation incomplete |
| Durable state/telemetry | Implemented/tested with existing JSON store; existing Postgres interface reused |
| Single-agent compatibility | Covered by existing regression suite |
| Verified-outcome adaptive routing and cold fallback | Implemented/tested; advanced learning/criticality incomplete |
| Promotion re-verifies a clean current target | Implemented/tested; target stays unchanged for review |
| Regression tests | 1,835 passed; later focused hardening pass 38 passed; see final verification summary |
| Real benchmark artifacts | Actual deterministic execution measurements committed; no real-model performance claim |
| Accurate documentation and no DGX changes | Delivered |

## Git state

Implementation commit: `0f817a8` (`feat: add isolated native agent races and verified adaptive routing`). This report and final whitespace cleanup are committed separately; the report commit hash is listed in the final handoff. The feature worktree is clean after the report commit; changes are confined to the feature worktree listed above. Generated bundles/dist/native build outputs are ignored rather than committed. The original checkout contains unrelated work and was preserved. Nothing was pushed or merged. Review especially the controller callback contract, strict sandbox profiles, policy coverage, native lifecycle finalization and the incomplete acceptance rows before enabling this outside isolated test repositories.
