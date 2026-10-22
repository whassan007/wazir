# Competitive agent execution (schema v1)

Status: opt-in implementation with a tested native-agent vertical slice. This does not fulfill every requirement of the broader competitive orchestration proposal. See the final report for incomplete items.

## Inventory and implementation plan

Inventory taken from commit `f3b115a` before implementation. Existing uncommitted changes in the original checkout were deliberately excluded by creating a separate feature worktree.

| Component | Existing implementation | Reusable? | Required change |
|---|---|---|---|
| Scheduler | `packages/core/src/services/scheduler.ts`, CLI `routeAvailability.ts` | Yes | Add optional ordering of already eligible competitive configurations; keep normal `plan()` unchanged |
| Agent adapter | `packages/core/src/types/agent.ts`; `packages/agents/src/codingAgent.ts`, `acp/acpAgentAdapter.ts`, `externalAgent.ts` | Yes | Native CodingAgent per attempt, restricted controller runtime; external agents fail closed pending stronger isolation |
| Model providers | `packages/runtimes/{ollama,lmstudio,openai,anthropic,google,nvidia}`; CLI `hostedProviders.ts` | Yes | Use existing governed adapters; no new provider clients |
| Model registry/lifecycle | `modelRegistry.ts`, `modelLifecycleService.ts` | Yes | Existing eligibility/availability checks and `ensureReady()` |
| Verification | `verificationEngine.ts`, `verificationIntegrity.ts`, `verificationOracles.ts` | Yes | Controller captures patches and runs trusted commands in independent clean baseline worktrees; record oracle evidence |
| Learning service | `strategyLearningService.ts`, `modelIntelligenceService.ts`, `taskCapabilityClassifier.ts` | Yes | Add verified race-history ordering to ModelIntelligenceService; strategy extraction from race records remains incomplete |
| Worktree isolation | `worktreeManager.ts`; tools `paths.ts`, `sandbox.ts` | Yes | Optional explicit commit, no attach-to-old-branch fallback for races; canonical tool policy; strict subprocess sandbox |
| Merge workflow | `verifiedIntegrationCoordinator.ts` | Yes | Race promotion creates a manifest and calls existing `qualify()` against the current target |
| Persistence | `packages/shared/src/store.ts`; `packages/database/src/postgresStore.ts` | Yes | Versioned KV keys and atomic `update()`, no new database or daemon |
| Accounting/limits | core `resources/{budgetManager,ledger,accounts,router}.ts`; runtime `governAdapter` | Yes | Retain per-request admission/quota accounting; conservative race-wide reservations and bounded dispatch |
| CLI/interactive | `apps/cli/src/{index,commands,run}.ts` | Yes | Opt-in task flags, race management, replay, explain; no new interactive race screen |
| Recovery | `executionRecovery.ts`, `executionEngine.ts`, worktree cleanup; shared `terminateProcessTree` | Yes | Durable race claim and dead-owner fencing; uncertain effects never automatically repeated |

Implementation order: contracts and inventory; two-agent vertical slice; atomic lifecycle, cancellation and policy hardening; historical routing; budgets and progressive dispatch; replay, promotion and export; deterministic benchmarks. Collaborative finding exchange is deferred.

## API and contracts

`CompetitiveExecution` coordinates existing worktrees and a controller-owned `run` / `verify` boundary. It is not a second capability scheduler. CLI discovery calls `planTask()` / the existing scheduler for each model, uses the same native agent and tool surface for all participants, and rejects unavailable, remote or external placements. Each native CodingAgent has its own instance and runtime closure. Every attempt is linked to an existing ExecutionEngine record. That record holds local models active against eviction, receives independent evidence at the observed workspace revision, and is finalized only after controller verification. Native local inference activates through ModelLifecycleService; hosted inference uses the same governed runtime adapters as legacy execution.

`RaceConfiguration`, `RacePolicy`, `RaceAttempt`, `RaceRecord`, `RaceCheck` and `AttemptMeasurement` are exported from core. A record captures task input, baseline commit, target branch, exact policy and policy hash, configuration/version, owner host/PID, timestamps, patches, evidence, reservations, decisions and audit events. Optional measurements stay absent when providers do not report them. `estimatedCostUsd` denotes a calculation using configured prices, not observed provider invoices. No LLM judges are used.

A race has 1–8 participants and policy-limited concurrency (maximum 8). A common commit is resolved once. Existing branch/worktree collisions fail closed. Candidate patches include staged and untracked additions; protected paths, unauthorized ownership, symlinks and submodules reject the candidate before verification. Empty patches cannot win. Worktrees are retained for review; explicit cleanup removes worktrees, retaining commits/branches, patches and telemetry.

## Lifecycle and recovery

Normal durable transitions:

`CREATED → SCHEDULING → PREPARING → RUNNING → VERIFYING → COMPARING → WINNER_SELECTED → AWAITING_MERGE`.

`COMPLETED` is reserved for a future authorized merge workflow. This release never merges the target. Attempts may already be verified while other attempts are still running; race VERIFYING is the barrier recording that their independent checks have settled.

Failure terminals: `FAILED`, `TIMED_OUT`, `CANCELLED`, `NO_VALID_WINNER`, `RECOVERY_REQUIRED`. Atomic claim rejects duplicate dispatch from another coordinator. Updates use the store's atomic mutation operation, preserving concurrent cancellation requests. Callback settlement after abort is required. A non-settling adapter becomes `RECOVERY_REQUIRED`, and cleanup is refused. Verifier commands terminate their process groups before settlement. Dead local owners can be fenced by `recover`; foreign hosts need explicit external fencing. Recovery does not blindly rerun a paid request or uncertain tool operation. PID reuse, cross-host fencing and automatic continuation are not solved.

Cancellation polls durable requests every 100 ms. Race timeout includes preparation, execution and verification, plus bounded cancellation grace. Git operations have their own 30-second ceiling. A crash between worktree creation and recording its result can leave an orphan directory; deterministic names and fail-closed recovery preserve it for inspection. There is no automatic orphan sweep.

## Independent verification and ranking

The verifier receives trusted command arrays from the captured policy, never an agent-supplied command. Each patch is applied with `git apply --index` to a fresh worktree at the recorded baseline. The whole verification workspace is read-only to subprocesses except `.wazir` and declared generated-output directories (`verificationWritablePaths`, default dist/build/coverage). Output paths overlapping tracked inputs are refused. Tracked files also have explicit immutable mounts/denials, so renaming a test directory cannot bypass protection. Commands have no inherited credentials or network, no writable shared Git metadata, private HOME/TMP, bounded output and process-tree termination. Every named required check must have exactly one passing result, exit code zero and an output digest.

Worktrees do not share node_modules or mutable dependency caches. Dependency provisioning and service-backed integration environments are not implemented; nontrivial projects need an independently provisioned environment before these checks can succeed. Baseline symlinks are refused by production verification.

Policy authors must supply real build, unit, applicable integration, formatting/lint, types, security and acceptance commands for their repository. The initial implementation does **not** automatically discover these or establish a universal security scanner. The example policy (`tests/competitive-execution/policy.example.json`) is a template whose script names must be replaced with actual repository commands; choosing insufficient checks cannot prove full correctness. Named checks report actual exit codes and hashes; test counts are not inferred from logs. VerificationEngine records oracle evidence; race eligibility additionally binds it to the controller-captured patch. Agent completion claims never satisfy gates.

Ranking first excludes failed, incomplete or policy-violating attempts. All remaining candidates have equal demonstrated quality on the captured checks. Comparable measured estimated cost breaks ties when every eligible candidate has it; otherwise cost is omitted for the whole comparison. Next comes measured duration, then lexical attempt ID. Diff size is never a maintainability score. Qualitative maintainability scoring, customizable ranking weights and additional quality metrics remain future work.

## CLI

```sh
wa task run 'Fix authentication' --race 2 --race-policy /trusted/race-policy.json
wa task run 'Fix authentication' --routing auto --race-policy /trusted/race-policy.json
wa task run 'Fix authentication' --routing cheapest --race-policy /trusted/race-policy.json
wa task run 'Fix authentication' --routing highest-quality --race-policy /trusted/race-policy.json
wa task run 'Fix authentication' --race 3 --progressive --max-cost 2 --timeout 300 --race-policy /trusted/race-policy.json
wa task race list
wa task race status <race-id>
wa task race inspect <race-id>
wa task race compare <race-id>
wa task race promote <race-id>
wa task race cancel <race-id>
wa task race recover <race-id>
wa task race cleanup <race-id>
wa task race export <race-id> --format csv
wa task replay <race-id> --model provider/model
wa explain <race-id>
```

These options are initially on `wa task run`, not the legacy `wa run` alias. Existing invocations without race/routing flags take the original path. Routing-only mode uses one competitor. `--race N` means N independent configurations unless explicit progressive execution stops escalation. An explicit model pin cannot silently expand to other models. Legacy presets/expected-file/full-verification options cannot redefine a race contract; put acceptance criteria in the policy. `--max-turns` overrides the captured call limit.

Status/inspect/compare currently return the durable JSON record; export supports JSON with tool events or a CSV summary. Replay accepts a **race id**, not arbitrary legacy task ids. It preserves the baseline/policy and original winner, uses a new record, and is labeled approximate because toolchains, dependencies and hosted model versions are not environmentally pinned. Replays never enter routing history. CLI replay with a metered dollar ceiling currently fails closed if alternative pricing has not been resolved; no synthetic price is substituted.

## Promotion and rollback

Promotion reconstructs a manifest at the immutable winning commit and delegates to VerifiedIntegrationCoordinator. That coordinator merges into a disposable integration worktree at the *current* target, checks conflicts and dependencies, reruns required checks and checks target drift. The journal, fresh checks, target SHA and rollback SHA are recorded. A passing result remains awaiting human review. Repeated promotion creates another integration candidate; prior candidate cleanup is manual. No push, branch update, release or protected-checkout mutation occurs. Regression blocks qualification, so rollback normally means discarding the candidate. Actual post-merge automated rollback is not implemented.

## Persistence and migration

Keys: `competitive:v1:<race-id>` for versioned records, `competitive-event:v1:<attempt-id>:<uuid>` for metadata-only tool/agent/provider-usage events. Existing JsonFileStore and PostgresStore supply atomic `update()`; no SQL schema migration is necessary. Stores lacking atomic update are rejected. v1 readers reject unsupported record versions. Existing keys and single-agent records remain unchanged. Patches and necessary task inputs are stored for replay; event payloads omit raw tool arguments, model text and credentials. History retention and prompt redaction are operator concerns; no new data-export service exists.

## Upstream review

No dependencies were added and no framework code was copied. Patterns adapted at the design level:

- [OpenHands runtime settings](https://docs.openhands.dev/api-reference/store-settings): runtime isolation must be distinct from a working-directory convention; this implementation uses the existing Wazir sandbox.
- [OpenCode permissions](https://opencode.ai/v2/docs/permissions): enforce directory and action boundaries at dispatch. Races use an even narrower source-only surface.
- [LiteLLM routing](https://docs.litellm.ai/docs/routing) and [budgets](https://docs.litellm.ai/docs/proxy/users): separate admission/reservation from actual usage and availability. Wazir already has these primitives.
- [LangGraph persistence](https://langchain-ai.github.io/langgraph/concepts/durable_execution/): checkpoint boundaries and explicit side-effect replay semantics; interrupted race callbacks are fenced instead of implicitly repeated.
- [RouteLLM](https://github.com/lm-sys/RouteLLM): empirical quality/cost routing is useful, but its router/training stack is unnecessary for this small verified-history policy.
- [Promptfoo deterministic assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/): deterministic mandatory gates precede comparative scoring. No model judge is required.

Adopting any upstream code later would require pinning the exact revision and reviewing its license and maintenance costs. No such licensing obligation is introduced by this change.
