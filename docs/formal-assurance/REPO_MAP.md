# Wazir Formal Assurance — Repository Cartography (`REPO_MAP.md`)

> **Cartographer**: Agent 07 (`fa/07-repo-map`)
> **Scope**: Workspace & package layout, task engine (DAG & test-repair loop), policy engine, scheduler, state store & lease fencing, worktree manager & skill/prompt injection, CLI structure, and test conventions.

---

## Section 1: Workspace & Package Layout, Task Engine, Policy Engine

### 1.1 Workspace & Package Layout

Wazir is organized as a multi-package TypeScript monorepo managed via `pnpm` / `npm` workspaces with composite TypeScript project references and a unified root Vitest suite.

#### Workspace Manifests & Root Configurations
* [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) (L1–L5): Declares three workspace globs:
  * `packages/*`
  * `packages/runtimes/*`
  * `apps/*`
* [`package.json`](../../package.json) (L1–L106):
  * Package name `wazir` (`v0.2.13`, `AGPL-3.0-only`, Node `>=22.13.0` at L103–L105).
  * `workspaces` (L31–L35) mirrors `pnpm-workspace.yaml`.
  * Binary entry point `"wa": "./bin/wa.js"` (L36–L38).
  * Core scripts (L44–L84): `build` (`npm run build --workspaces --if-present && npm run bundle`), `test` (`npm run build && vitest run`), `typecheck` (`tsc --build --force`), `test:agent`, `test:tui`, `test:distributed`, `test:postgres`.
* [`tsconfig.base.json`](../../tsconfig.base.json) (L1–L27):
  * Targets `ES2022` with `module: "commonjs"`, `moduleResolution: "node"`, `composite: true`, `incremental: true`, `declaration: true`, `declarationMap: true`, `sourceMap: true`, `strict: false`.
  * Path aliases (L22–L25):
    * `@wazir/core` $\rightarrow$ `./packages/core/src/index.ts`
    * `@wazir/shared` $\rightarrow$ `./packages/shared/src/index.ts`
* [`tsconfig.json`](../../tsconfig.json) (L1–L29):
  * Root project-references solution file (`"files": []`) referencing 24 packages/apps in dependency order (`packages/core`, `packages/shared`, `packages/secrets`, `packages/runtimes/*`, `packages/registry`, `packages/evaluation`, `packages/observability`, `packages/memory`, `packages/database`, `packages/tools`, `packages/agents`, `packages/workers`, `packages/scheduler`, `packages/models`, `packages/policies`, `apps/cli`, `apps/api`, `apps/worker`).
* [`vitest.config.ts`](../../vitest.config.ts) (L1–L21):
  * Sets `fileParallelism: false` (L12) because database integration tests (`packages/database/tests`, `apps/cli/tests/createStore.test.ts`) share a single Postgres instance via `WAZIR_TEST_DATABASE_URL` and execute table-wide `TRUNCATE`/`clear()`.
  * Excludes (L15): `**/tmp/**`, `**/.wazir/**`, `**/.worktrees/**`, `**/.claude/**`, `scripts/**/*.test.mjs` (run via `node --test scripts/`), and `test/codex-dgx-execution/**`.
  * Injects deterministic test environment variables (L19): `WAZIR_SECRETS_BACKEND: 'encrypted-file'` and `WAZIR_LMS_DISABLE: '1'` so tests never probe the host OS keychain or local LM Studio server unless explicitly opted in.

#### Monorepo Directory Topology
* **`packages/`**:
  * `packages/core` (`@wazir/core`): Authoritative domain types, DAG `JobManager`, `JobOrchestrator`, `TaskPlanner`, `ExecutionEngine`, `PolicyEngine`, `VerificationEngine`, `VerifiedIntegrationCoordinator`, `WorktreeManager`, `Scheduler`, `RecoveryManager`, and context/memory services.
  * `packages/policies` (`@wazir/policies`): Facade re-exporting and wrapping `@wazir/core`'s `PolicyEngine`.
  * `packages/scheduler` (`@wazir/scheduler`): Facade re-exporting and wrapping `@wazir/core`'s `Scheduler`.
  * `packages/agents` (`@wazir/agents`): `CodingAgent`, `StepAgent`, `ChatAgent`, `ExternalAgent`, `NativeHarnessAdapter`, `ExternalHarnessAdapter`, ACP adapters, stop conditions, and protocol normalizers.
  * `packages/database` (`@wazir/database`): Durable `KeyValueStore` implementations (SQLite/file/Postgres, `PostgresStore`, migrations) and state persistence.
  * `packages/tools` (`@wazir/tools`): Built-in tool implementations (`read`, `write`, `edit`, `shell`, `git`, `glob`, `search`, `test`, `lint`, `typecheck`, `build`), OS sandbox wrappers (`bwrap`, `sandbox-exec`/`seatbelt`), and path/argument validators.
  * `packages/workers` (`@wazir/workers`): Distributed worker daemon, heartbeat emitters, and remote task execution bindings.
  * `packages/runtimes/*`: `interfaces`, `ollama`, `lmstudio`, `anthropic`, `openai`, `google`, `nvidia`.
  * `packages/models`, `packages/registry`, `packages/evaluation`, `packages/memory`, `packages/observability`, `packages/secrets`, `packages/shared`, `packages/lsp`.
* **`apps/`**:
  * `apps/cli` (`@wazir/cli`): The `wa` CLI and Fleet TUI.
  * `apps/api`, `apps/worker`, `apps/web`, `apps/desktop`, `apps/mobile`, `apps/ios`, `apps/android`.

---

### 1.2 Task Engine (DAG of Tasks, Orchestration & Test-Repair Loop)

The task engine spans four primary layers:
1. **Task & Job DAG Types** (`packages/core/src/types/task.ts`, `packages/core/src/types/job.ts`)
2. **DAG Construction, Cycle Detection & State Transitions** (`packages/core/src/services/jobManager.ts`, `packages/core/src/services/statusTransitions.ts`)
3. **Task Planning & Decomposition** (`packages/core/src/services/planner.ts`, `packages/core/src/services/complexity.ts`)
4. **DAG Pump Loop, Replanning & Retry Orchestration** (`packages/core/src/services/jobOrchestrator.ts`)
5. **Agent Turn Loop & Deterministic Test-Repair Loop** (`packages/agents/src/codingAgent.ts`, `packages/agents/src/diagnostics.ts`, `packages/agents/src/stopConditions.ts`, `packages/core/src/services/repairContextBuilder.ts`)

#### Core Task & DAG Types
* [`packages/core/src/types/task.ts`](../../packages/core/src/types/task.ts):
  * `TaskType` (L3–L14): `'chat' | 'coding' | 'research' | 'review' | 'debugging' | 'architecture' | 'code_analysis' | 'document_analysis' | 'benchmark' | 'evaluation' | 'agent'`.
  * `TaskStatus` (L18–L31): `'pending' | 'queued' | 'planning' | 'scheduled' | 'ready' | 'running' | 'waiting_for_approval' | 'verifying' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'blocked'`.
  * `WorkspaceMode` (L33): `'clean' | 'repository' | 'continue' | 'shared'`.
  * `TaskRequirements` (L35–L59): Hardware, OS/arch, GPU/CUDA, context, reasoning, and `agentCapabilities`/`capabilities` constraints.
  * `PolicyRequirements` (L61–L82): `dataClassification`, `localOnly`, `allowedComputers`, `allowedRuntimes`, `allowedModels`, `networkAccess`, `toolAccess`, `allowSubagentDispatch`, `maxExecutionTimeSeconds`, `projectRoot`, `allowHostedProviders`.
  * `ExecutionPreferences` (L86–L101): Pinning (`targetComputerId`, `targetRuntimeId`, `targetModelId`, `targetAgentId`), `routingMode` (`'AUTO' | 'LOCAL_ONLY' | 'NVIDIA' | 'HYBRID' | 'PROVIDER_ONLY'`), `allowFallback`.
  * `Task` (L103–L129): Full task record including `maxTurns` (L119), `maxRepairCycles` (L121), `maxRetries` (L123), `acceptanceContract` (L112), and `expectedEvidence`/`expectedArtifacts`.
* [`packages/core/src/types/job.ts`](../../packages/core/src/types/job.ts):
  * `JobStatus` (L9–L17): `'pending' | 'planning' | 'ready' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'`.
  * `TaskGraphEdge` (L19–L23): `{ from: string; to: string; condition?: 'success' | 'failure' | 'always' }`.
  * `AgentState` (L25–L32): `'idle' | 'assigned' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'`.
  * `JobGraph` (L34–L37) & `JobNode` (L39–L59): Node representation with `type: 'task' | 'aggregator' | 'evaluator' | 'supervisor'`, `dependencies: string[]`, `children: string[]`, `state: AgentState`, `retryCount`, `attempts`, and `workspaceRevision`.
  * `Job` (L123–L144): Top-level DAG container holding `ownership?: { ownerId: string; epoch: number; expiresAt: number }` (L126), `control?: { cancelRequestedAt?: number }` (L125), `tasks: Task[]`, `graph: JobGraph`, `concurrencyLimit`, `maxRetries`, `timeoutSeconds`.
  * `TaskReplanner` (L287–L292): Callback invoked on non-policy task failure to dynamically synthesize `repairTasks: JobTaskInput[]`.

#### DAG Construction, Validation & Dynamic Rewiring (`JobManager`)
* [`packages/core/src/services/jobManager.ts`](../../packages/core/src/services/jobManager.ts) (L42–L878):
  * `JobManager.create()` (L310–L402): Validates unique task IDs (L322–L333), invokes `buildGraph(params.tasks)` (L335), initializes `Task[]` with defaults (L336–L374), and persists the `Job`.
  * `JobManager.buildGraph()` (L708–L772):
    * Validates that every dependency ID exists in `knownIds` (L712–L720).
    * **Cycle Detection** (L722–L744): Runs depth-first search (`checkCycle`) with `visited` and `recursionStack` sets; throws `Cycle detected in task dependencies: ...` on back-edges.
    * Populates `JobNode[]` and `TaskGraphEdge[]` (`{ from: dep, to: nodeId }`) and wires `parentNode.children` (L746–L770).
  * `JobManager.dependenciesSatisfied(job, taskId)` (L774–L786): Returns `true` iff every node in `node.dependencies` has `depNode.state === 'completed'`.
  * `JobManager.hasFailedDependency(job, taskId)` (L788–L804): Returns `true` if any dependency node or task is in `'failed'` or `'cancelled'` state.
  * `JobManager.addTasksToJob(jobId, newTasks, { replacesTaskId })` (L590–L706): Dynamically splices repair subgraphs into a live `JobGraph` when `TaskReplanner` supersedes a failed node, rewiring upstream dependencies into the first repair node and downstream dependents to the final repair node (L669–L702).

#### Task Decomposition (`TaskPlanner`)
* [`packages/core/src/services/planner.ts`](../../packages/core/src/services/planner.ts) (L47–L417):
  * `TaskPlanner.plan(input, options)` (L53–L96): Classifies complexity (`classifyComplexity`), queries `StrategyLearningService` if provided (L59–L71), short-circuits `'trivial'` tasks to a single-node `implement` plan (`trivialPlan`, L102–L136), attempts LLM decomposition via `options.modelCaller` (`parseModelPlan`, L271–L297), and falls back to `heuristicPlan` (L299–L412: 4-step `inspect -> implement -> compile -> verify` for C/C++, or 3-step `inspect -> implement -> verify` default).
  * `TaskPlanner.planToJobTaskInputs(plan, baseTaskProps)` (L198–L241): Maps `PlanStep[]` into `JobTaskInput[]` with complexity-derived `maxTurns`, `maxRepairCycles`, and `maxRetries`.

#### DAG Execution Pump & Retry/Replan Loop (`JobOrchestrator`)
* [`packages/core/src/services/jobOrchestrator.ts`](../../packages/core/src/services/jobOrchestrator.ts) (L73–L1105):
  * `JobOrchestrator.runJob(jobId, options)` (L369–L397): Acquires job lease (`jobManager.acquire(jobId)`), starts a periodic lease renewal timer at `Math.floor(this.jobManager.leaseMs / 3)` (L377–L386), delegates to `runOwnedJob`, and releases lease in `finally`.
  * `JobOrchestrator.runOwnedJob(jobId, options)` (L399–L840):
    * Initializes `concurrencyLimit` (default 4, L418), `activeTasks` map, `retryCounts` map, and optional `timeoutTimer` (L454–L461).
    * `doPump()` (L530–L838) executes four reactive phases whenever a task starts, finishes, or job state changes:
      1. **Failure Cascade** (L538–L555): Fixed-point loop marking any `'idle'` node whose dependency failed (`hasFailedDependency`) as `'failed'` with `'Dependency failed'`.
      2. **Ready-Set Selection** (L557–L561): Filters nodes where `node.state === 'idle'` and `dependenciesSatisfied(job, taskId)` is `true`.
      3. **Bounded Concurrent Dispatch** (L567–L809): While `!paused && activeTasks.size < concurrencyLimit && readyNodes.length > 0`, shifts a ready node, calls `assignTask(job.id, taskId)` (which invokes `scheduler.plan` and `executionEngine.create`, L189–L235), transitions node/task to `'running'`, and launches `executor(task, executionContext)` asynchronously.
      4. **Post-Execution Outcome & Replan/Retry Handling** (L658–L807):
         * **Supervisor Gating** (L659–L669): Nodes with `node.type === 'supervisor'` require `outcome.supervisorDecision` with `decision: 'approve'` and non-empty `reason`; otherwise fails with `SUPERVISOR_DECISION_REQUIRED` or `SUPERVISOR_REJECTED`.
         * **Orphan Recovery** (L671–L694): If `reportExecutionOrphaned` (L292–L300) flagged the task due to worker heartbeat loss, increments `retryCount` up to `maxRetries` (default 3) and resets node to `'idle'` / task to `'pending'`.
         * **Dynamic Replanning** (L727–L769): On task failure where `!isPolicyDenial` and `options.replanner` is provided, invokes `options.replanner({ job, failedTask, node, outcome })`. If repair tasks are returned, marks the failed node superseded and splices the repair tasks into the DAG via `jobManager.addTasksToJob(..., { replacesTaskId: taskId })`.
         * **Standard Retry** (L771–L805): Policy denials force `maxRetries = 0` (L772). Otherwise, if `retries < maxRetries`, records attempt in `node.attempts`, increments `retryCount`, resets node to `'idle'`, and emits `'task:retry'`.

#### Agent Turn Loop & Test-Repair Loop (`CodingAgent`)
* [`packages/agents/src/codingAgent.ts`](../../packages/agents/src/codingAgent.ts) (L45–L2218):
  * `CodingAgentOptions` (L45–L133): Configures `maxTurns`, `maxRepairCycles`, `maxTokensPerTurn`, `maxWallClockMs`, `maxToolCalls`, `maxTokens`, `maxNoProgressIterations`, `maxModelEscalations`, `modelTurnTimeoutMs`, `toolRepeatLimit`, `contextCompactionRatio`, `maxProseBeforeActionChars`.
  * **Multi-Phase Execution**:
    * **Fast Paths** (L1384–L1533): `isDeterministicCommandRequest` (L207–L218) for exact read-only commands (`ls`, `pwd`, `git status/diff/log`) and `isConversationalFastPathRequest` (L233–L253) for non-mutating Q&A.
    * **PLAN Phase** (L1535–L1768): Compiles phase-scoped tool surface (`compileSurface('plan')`, L1537), allows up to 3 planning iterations with read-only exploration (`read`, `glob`, `search`) before requiring a `plan` or `done` action. Mutating tools (`write`, `edit`) are rejected during `plan` (L1856–L1858).
    * **WORK & REPAIR Loop** (L1770–L2078):
      * Compiles `'implement'` tool surface (`compileSurface('implement')`, L1771).
      * Evaluates centralized stop conditions (`checkStop('before_turn' | 'after_model_turn' | 'before_tool' | 'after_tool')`, L1274–L1281; defined in [`packages/agents/src/stopConditions.ts`](../../packages/agents/src/stopConditions.ts)).
      * Validates tool arguments (`validateAction`, L1348–L1382) and checks the identical-call circuit breaker (`checkCircuitBreaker`, L835–L841).
      * **In-Loop Test-Repair State Machine** (L798–L808, L1986–L2041):
        * Tracked via `repairState` (`{ active, cycle, triggeringFailure, diagnosticsBefore, filesModified, filesInspected, diagnosticsAfter, progress, consecutiveNoProgress }`).
        * Whenever `action.tool === 'build' || action.tool === 'test'` returns `!result.ok` (L1986–L1990):
          * **First failure** (L1991–L2006): Enters repair mode (`cycle: 1`), snapshots `diagnosticsBefore`, switches tool surface to `'repair'` (`compileSurface('repair')`), and yields `phase: 'repair'`.
          * **Subsequent failures** (L2007–L2034): Increments `repairState.cycle`, computes diagnostic progress via `detectProgress(repairState.diagnosticsBefore, outputString)` from [`packages/agents/src/diagnostics.ts`](../../packages/agents/src/diagnostics.ts) (`'PROGRESS' | 'NO_PROGRESS' | 'REGRESSION'`, L2010), and tracks `consecutiveNoProgress`.
          * **Stall / Budget Termination & Escalation** (L2018–L2032): Repair is considered stalled when `repairState.cycle > maxRepairCycles || repairState.consecutiveNoProgress >= 2`. If stalled while within `maxRepairCycles`, attempts model escalation (`tryEscalate('NO_PROGRESS', ...)`, L1209–L1260, L2021–L2022). If escalation is unavailable/declined or `cycle > maxRepairCycles`, terminates with `REPAIR_BUDGET_EXHAUSTED` (`terminationReason: 'MAX_REPAIRS' | 'NO_PROGRESS'`, `errorKind: 'verification'`).
          * **Recovery** (L2035–L2040): When `build`/`test` succeeds (`result.ok`), clears `repairState = null` and yields `phase: 'implement'`.
    * **VERIFY Phase (Deterministic Host-Side Gate)** (L2080–L2194):
      * Verifies physical file mutations occurred when `mutationRequired` is true (`filesChangedSet.size > 0`, L2089–L2091).
      * Verifies all `request.expectedArtifacts` exist on disk (L2093–L2110).
      * Computes workspace verification scope via `resolveVerificationScope(request.projectRoot, filesChangedSet)` ([`packages/agents/src/verificationScope.ts`](../../packages/agents/src/verificationScope.ts), L2129–L2142) and runs `['build', 'test', 'lint', 'typecheck']` (L2143–L2154).
      * Emits `terminationReason: 'VERIFICATION_PASSED'` only if `failures.length === 0` (L2167–L2176); otherwise yields `terminationReason: 'VERIFICATION_FAILED'` (L2178–L2193).

---

### 1.3 Policy Engine (`packages/policies` & `packages/core`)

#### Package Facade & Core Implementation
* [`packages/policies/src/index.ts`](../../packages/policies/src/index.ts) (L1–L31):
  * Facade package `@wazir/policies` re-exporting `PolicyEngine`, `PolicyActionRequest`, `PolicyDecision`, `PolicyEngineOptions` from `@wazir/core`, plus helper functions:
    * `createPolicyEngine(options: PolicyEngineOptions): PolicyEngine` (L18–L20)
    * `authorize(engine: PolicyEngine, request: PolicyActionRequest): Promise<PolicyDecision>` (L22–L27)
    * `evaluateTask(engine: PolicyEngine, task: Task): { allowed: boolean; reasons: string[] }` (L29–L31)
* [`packages/core/src/types/policy.ts`](../../packages/core/src/types/policy.ts) (L1–L67):
  * `PolicyEffect` (L1): `'allow' | 'ask' | 'deny'`.
  * `PolicyActionRequest` (L3–L8, augmented in `policyEngine.ts` L15–L19): `{ tool: string; input: Record<string, unknown>; executionId?: string; projectRoot?: string; effectiveIsolation?: string; requiredIsolation?: string }`.
  * `PolicyDecision` (L10–L16): `{ decision: PolicyEffect; rule: string; tool?: string; command?: string; reasons: string[] }`.
  * `PolicyRule` (L18–L24): `{ id: string; scope?: string; pattern?: string; description: string; effect: PolicyEffect }`.
  * `PolicyEngineOptions` (L26–L67): Configures `projectRoot`, `networkAllowed`, `allowCommands`, `denyCommands`, `allowedMcpServers`, `allowWorkspaceArtifactExecution`, `approveCallback`, `approvalQueue`, `allowHostedProvidersDefault`, `requiredIsolation`, `web`, `modelLifecycle`.
* [`packages/core/src/services/policyEngine.ts`](../../packages/core/src/services/policyEngine.ts) (L318–L1562):
  * **Effect Precedence**: `EFFECT_RANK = { allow: 0, ask: 1, deny: 2 }` (L162); `mostRestrictive(decisions)` (L241–L248) ensures compound shell commands take the maximum restriction across all segments, pipes, redirects, and `$()` substitutions.
  * **Protected Paths** (L128–L132, `protectedPathReason` L293–L305):
    * `PROTECTED_DIRS`: `.git`, `.wazir`, `.rook`, `.husky`, `.githooks`, `node_modules`, `.github`.
    * `PROTECTED_FILES`: `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmfile.cjs`, `pnpm-workspace.yaml`, `.envrc`.
    * Any write/edit or output redirect to these paths inside `projectRoot` is escalated from `allow` to `ask` (`rule: 'filesystem-protected-ask'`, L766–L769, L1490–L1493, L1515–L1518).
  * **Sandbox Isolation Compliance** (`checkIsolationCompliance`, L506–L551):
    * Fails closed (`decision: 'deny'`, `rule: 'isolation-unavailable'`) when `requiredIsolation` (`'os'`, `'container'`, `'bwrap'`, `'seatbelt'`, `'sandbox-exec'`) is set on the request or engine options and `effectiveIsolation` is missing, `'none'`, or `WAZIR_SANDBOX=none`.
  * **Action Classification (`doClassify`, L671–L801)**:
    1. Isolation compliance check (L672–L679).
    2. Built-in controller tools (`compact_memory`, `remember_fact`, `recall_facts`) $\rightarrow$ `allow` (L684–L697).
    3. Web tools (`web_search`, `web_fetch`) $\rightarrow$ gated by `options.networkAllowed === true` and `options.web` (L698–L704).
    4. MCP tools (`mcp.<tool>` via `mcpRules` map at L705–L708; `mcp:<server>:<tool>` via `options.allowedMcpServers` explicit allowlist at L711–L729) $\rightarrow$ default `deny` (`rule: 'mcp-explicit-approval'`).
    5. Project-scoped checks (`test`, `lint`, `typecheck`, `build`) $\rightarrow$ `allow` (`rule: 'project-checks-allow'`, L731–L738).
    6. Filesystem tools (`read`, `search`, `glob`, `write`, `edit`, L741–L783) $\rightarrow$ resolves path against `projectRoot`, denies outside `projectRoot` (`filesystem-outside-deny`), asks on protected paths (`filesystem-protected-ask`), tracks written paths per `executionId` (`trackWrittenPath`, L368–L385) so model-authored `.test.js` files cannot auto-approve their own interpreter execution (`classifyTestWorkspace`, L1074–L1101).
    7. Git (`classifyGit`, L803–L897) $\rightarrow$ denies global redirect/config-injection flags (`-c`, `-C`, `--git-dir`, `--work-tree`, `--exec-path`, L265, L818–L822), denies `reset --hard` and `GIT_DENY` (`push`, `clean`, `gc`, `filter-branch`, `update-ref`), allows read-only verbs (`GIT_ALLOW`, L253–L257) unless dangerous read flags (`--output`, `--ext-diff`, `--textconv`, `--exec`, `--no-index`) are present, inspects conditional verbs (`branch`, `remote`, `config`, L864–L897), and asks on write verbs (`GIT_ASK`: `add`, `commit`, `checkout`, `merge`, `rebase`, etc.).
    8. Shell (`classifyShell`, L899–L1557) $\rightarrow$ rejects multi-line commands (L908–L910), normalizes backticks to `$()`, parses via `shell-quote`, splits segments on `&&`, `||`, `;`, `|`, etc. (`splitSegments`, L184–L219), unwraps wrapper commands (`env`, `nice`, `nohup`, `time`, `timeout`, `xargs`, L155, `resolveCommand` L222–L239), checks redirects (`classifyRedirect`, L1497–L1526), allows tracked compiled binaries (`isTrackedCompiledOutput`, L1008–L1017) and sandboxed workspace artifacts (L1018–L1045), evaluates workspace build tools (`classifyBuildWorkspace`, L1103–L1365) and existing test files (`classifyTestWorkspace`, L1074–L1101), and classifies remaining commands against `DENY_SHELL_COMMANDS` (L134–L138), `NETWORK_COMMANDS` (L149–L152), `SAFE_SHELL_COMMANDS` (L28–L41) with path-containment (`classifySafeCommandArgs`, L1372–L1454), and `ASK_SHELL_COMMANDS` (L142–L147).
  * **Interactive & Queue Resolution (`resolveAsk`, L558–L647)**:
    * Never silently allows an `'ask'` decision: routes to `options.approvalQueue` (when subscribed) or `options.approveCallback`. If neither is available or session is non-interactive (`'unavailable'`), escalates `'ask'` to `'deny'` (`rule: '${decision.rule}+escalated-from-ask'`, L597–L614) and records an audit event via `appendAuditEvent`.

#### Task, Hosted-Provider, Subagent, and Merge/Integration Policies & Roles
* **Task-Level & Hosted/Subagent Gating** (`PolicyEngine` in `packages/core/src/services/policyEngine.ts`):
  * `evaluateTask(task)` (L412–L437): Pre-scheduling check verifying `policy.toolAccess !== false` when `task.requirements.toolCalling` is required and `maxExecutionTimeSeconds > 0`.
  * `checkHostedEligibility(policy, provider)` (L453–L467): Single authoritative gate for hosted model routing. Deny-by-default (`allowHostedProviders ?? allowHostedProvidersDefault ?? false`), unconditionally overridden to `allowed: false` if `policy.localOnly === true` or `policy.dataClassification` is `'sensitive'` or `'restricted'`.
  * `checkSubagentEligibility(policy)` (L474–L491): Denies subagent dispatch when `dataClassification` is `'sensitive'` or `'restricted'`, or when `allowSubagentDispatch === false`.
  * `checkModelLifecycle(request)` (L329–L340): Enforces `allowedRuntimes`, `prohibitedComputers`, `maximumContext`, `maximumMemoryBytes`, `autoLoad`, and `eviction`/`protectedModels`.
* **Node Roles (`task` / `aggregator` / `evaluator` / `supervisor`)**:
  * Defined in [`packages/core/src/types/job.ts`](../../packages/core/src/types/job.ts) (`JobNode.type`, L42) and enforced in [`packages/core/src/services/jobOrchestrator.ts`](../../packages/core/src/services/jobOrchestrator.ts) (L659–L669): `supervisor` nodes act as approval gates in the DAG and must emit a structured `SupervisorDecision` (`{ decision: 'approve' | 'reject', reason: string }`); missing decisions fail with `SUPERVISOR_DECISION_REQUIRED` (`errorKind: 'protocol'`) and rejections fail with `SUPERVISOR_REJECTED` (`errorKind: 'verification'`), blocking downstream dependent nodes via step 1 of `doPump()`.
* **Merge & Integration Qualification Policy (`VerifiedIntegrationCoordinator`)**:
  * [`packages/core/src/services/verifiedIntegrationCoordinator.ts`](../../packages/core/src/services/verifiedIntegrationCoordinator.ts) (L147–L610):
    * Enforces merge and branch integration policies across parallel agent worktrees without mutating the protected target checkout.
    * `validateManifest(repository, manifest, expectedBranch)` (L186–L228): Verifies `AgentIntegrationManifest` schema version, valid branch/target refs, ancestor relationship (`git merge-base --is-ancestor`), exact match between manifest `changedFiles`/`fileChanges`/`fileHashes` and Git history/blob hashes, and requires `PASS` status (and `exitCode === 0`) across all `testsExecuted` and `verificationEvidence`.
    * **Test-Oracle & Protected-Path Protection** (L107–L117, L243–L245): By default (`protectTestOracles: true`), blocks any candidate branch that modifies test fixtures or oracle files (`tests/`, `fixtures/`, `__tests__/`, `*.test.*`, `*.spec.*`) or `protectedPaths` unless explicitly pre-authorized out-of-band in `authorizedTestChanges[taskId]`.
    * **Pairwise Conflict & Merge-Tree Verification** (`plan`, L230–L290): Checks file overlap (`same-file`, `rename-delete`, `dependency`, `test-fixture`, `generated-artifact`) and runs `git merge-tree --write-tree` (L257) between candidate pairs; sets `readyToBuildCandidate` (L288) only when `blockers.length === 0` and all conflicts are syntactically `'clean'`.
    * **Disposable Candidate Worktree Qualification** (`qualify`, L292–L390): Verifies the candidate directory is outside the protected repository (L295–L296), verifies target branch SHA has not moved (`target moved`, L297–L298) and target worktree is clean (L299–L300), creates a detached worktree, merges candidate branches in deterministic dependency order with `GIT_NO_HOOKS`, and runs `verifyCandidate` checks (`build`, `typecheck`, `unit-tests`, `integration-tests`).
* **Evidence & Completion Policy (`EvidencePolicy` & `VerificationEvidenceInspector`)**:
  * [`packages/core/src/services/evidencePolicy.ts`](../../packages/core/src/services/evidencePolicy.ts) (L1–L22) & [`packages/core/src/services/verificationEvidenceInspector.ts`](../../packages/core/src/services/verificationEvidenceInspector.ts): Binds `VerificationEvidence` (`BUILD`, `TEST`, `STATIC_CHECK`) to a specific `workspaceRevision`; `ExecutionEngine.setStatus(id, 'completed')` (in `executionEngine.ts` L429–L435) rejects completion with `ARTIFACT_CONTRACT_FAILED` if required verification evidence is missing or stale relative to the current `workspaceState.revision`.


---

## Section 2: Scheduler, State Store, Lease Fencing, Worktree Manager

### 2.1 Scheduler (`packages/scheduler`, `packages/core/src/services/scheduler.ts`, `packages/core/src/resources/router.ts`)

Wazir's scheduling layer is split between a thin facade package (`@wazir/scheduler`) and the full two-phase deterministic scheduler + resource router in `@wazir/core`.

| File | Key Symbols & Lines | Responsibility |
| --- | --- | --- |
| `packages/scheduler/src/index.ts` | `SchedulerFacade` (`L9–L11`), `createScheduler` (`L13–L18`), `describeDecision` (`L20–L41`) | Facade re-exporting `@wazir/core`'s `Scheduler` (`plan`, `routeModel`, `scheduleComputer`) and human-readable decision summary formatting. |
| `packages/core/src/services/scheduler.ts` | `Scheduler` (`L149–L1340`), `SchedulerDependencies` (`L65–L90`), `SchedulingContext` (`L92–L116`), `ScoredModel` (`L118–L130`), `ScoredPlacement` (`L132–L145`), `RoutingConstraint` (`L147`), `resolveRoutingConstraint` (`L160–L203`) | Two-phase deterministic scheduler: **Phase 1** (`routeModel`, `L319–L575` & `scoreModel`, `L759–L977`) selects a model; **Phase 2** (`scheduleComputer`, `L1005–L1335`) places the selected model onto a concrete `Computer` and `Runtime`. |
| `packages/core/src/resources/router.ts` | `ResourceRouter` (`L158–L587`), `RouterAssessmentInput` (`L63–L71`), `CandidateAssessment` (`L94–L134`), `RouterConfig` (`L136–L147`) | Evaluates model/provider/account admissibility (budgets, rate-limit cooldowns, token/request quotas, KV-cache fit, minimum verified success rate, max cost, deadline) and computes weighted utility scores. |

#### Feasibility Set $F(t)$ Construction

Given a task $t$, `Scheduler.plan(task, context)` (`packages/core/src/services/scheduler.ts` `L205–L317`) constructs the feasible model-and-placement set $F(t)$ in two strict phases before selecting an execution plan:

1. **Phase 1 — Model Feasibility (`routeModel`, `L319–L575` & `scoreModel`, `L759–L977`)**:
   - Evaluates every registered `ModelRecord` from `ModelRegistry.list()` (`L330`). A candidate is admitted to `eligible` (`s.rejected.length === 0`, `L408`) iff it passes all hard feasibility gates in `scoreModel`:
     - **Capabilities & Modalities**: All `task.requirements.capabilities` must exist in `record.capabilities` (`L771–L777`); `toolCalling` (`L779–L783`), `vision` (`L785–L787`), and `reasoning === 'high'` (`L788–L790`) must be supported when requested.
     - **Effective Context Window**: `effectiveContextTokens(record) >= requiredContext` (`L792–L799`, where `effectiveContextTokens` at `L651–L657` takes `min(record.contextWindow, min(instance.configuredContextLength))`).
     - **Policy Model Allowlist & Hosted Eligibility**: `task.policy.allowedModels` (`L801–L803`) and `deps.policy.checkHostedEligibility(task)` (`L808–L828`) must permit the model (checking `localOnly`, `allowExternalNetwork`, `dataSensitivity`, and `requireEncryption` for hosted models).
     - **Routing Mode Constraints (`resolveRoutingConstraint`, `L160–L203`)**:
       - `LOCAL_ONLY`: Rejects any model with `record.hosted === true` (`L830–L831`).
       - `PROVIDER_ONLY`: Strictly rejects any model whose provider (`resolveModelProvider`, `L723–L757`) does not match `routing.targetProvider`, **even if the model was explicitly pinned** (`L832–L840`).
       - `HYBRID` / `UNCONSTRAINED`: Permits both local and hosted models subject to preference weights (`L899–L925`).
     - **Instance Health & Availability**: At least one registered `ModelInstance` must have `state !== 'UNAVAILABLE'` and `health !== 'unavailable'` (`L847–L850`).
     - **Reliability Circuit Breaker**: `deps.reliability.status(record.id, task.type)` must not be `'OPEN'` (rejected at `L852–L857` unless explicitly pinned via `task.execution?.targetModelId === record.id`).
     - **Exclusion Set (`excludeModelIds`)**: Rejects any model in `context.excludeModelIds` (`L338`), which accumulates models that failed placement in the `plan()` preflight loop (`L235–L279`) or failed mid-execution during escalation.
     - **ResourceRouter Admissibility (`ResourceRouter.assess`, `packages/core/src/resources/router.ts` `L172–L280`, wired at `scheduler.ts` `L342–L406`)**: Evaluates `CandidateAssessment.admissible` across all accounts/providers for the model (`evaluateCandidate`, `router.ts` `L354–L491`), enforcing:
       - Account availability (cooldown expiry, active concurrency limit, request/token quota remaining, budget window cap).
       - `kvCacheFits` (context tokens + expected output $\le$ configured context length and local GPU/unified memory capacity).
       - `minVerifiedSuccessRate` (historical verified success rate $\ge$ threshold).
       - `maxCostUSD` (estimated task cost + retry multiplier $\le$ ceiling) and `deadlineMs` (estimated latency $\le$ deadline).
   - Admissible candidates are ranked using either the ResourceRouter utility formula (`q * quality + r * reliability + c * capacity - k * cost - l * latency - u * quotaRisk`, `router.ts` `L153`, `L479–L486`) or the heuristic multi-factor score (`scheduler.ts` `L859–L976`), with `applyComplexityFloor` (`L581–L649`) demoting under-sized models when a high-tier model is available.

2. **Phase 2 — Placement & Host Capability Feasibility (`scheduleComputer`, `L1005–L1335`)**:
   - Given the chosen `ModelRecord`, evaluates every `ModelInstance` in `record.instances` (`L1014`) to construct feasible `ScoredPlacement[]` (`L1013`):
     - **Lifecycle State & Target Pinning**: Rejects instances in `'DRAINING'`, `'UNLOADING'`, or `'LOADING'` states (`L1016–L1018`); enforces `task.execution?.targetComputerId` (`L1019`) and `task.execution?.targetRuntimeId` (`L1020–L1023`).
     - **Hosted vs. Local Branch**:
       - For **hosted instances** (`instance.hosted || instance.computerId === 'hosted'`, `L1035–L1102`): Verifies runtime online status (`L1037–L1044`) and `policy.checkHostedEligibility` (`L1046–L1050`). Critically, **hosted placements are rejected whenever hardware/OS constraints are specified** (`task.requirements.os`, `task.requirements.architecture`, `requiresGpu`, `requiresCuda`, or `task.policy.allowedComputers`, `L1053–L1074`).
       - For **local/remote `Computer` nodes** (`L1104–L1305`): Verifies `computer.status === 'online'` (`L1105–L1108`) and checks heterogeneous host capabilities:
         - **OS Platform**: Normalizes `'mac' | 'macos' | 'osx' -> 'darwin'` and `'win' | 'win32' -> 'windows'` (`normalizePlatform`, `L36–L42`) and checks against `computer.os` (`L1111–L1119`).
         - **CPU Architecture**: Normalizes `'aarch64' -> 'arm64'` and `'x86_64' | 'amd64' -> 'x64'` (`normalizeArch`, `L44–L49`) and checks against `computer.hardware.architecture` (`L1122–L1130`).
         - **GPU & CUDA**: Enforces `task.requirements.requiresGpu` against `computer.hardware.gpus.length` (`L1133–L1136`) and `requiresCuda` against `gpu.cudaAvailable` (`L1137–L1140`).
         - **Policy Computer & Runtime Allowlists**: Enforces `allowedComputers` (`L1142–L1145`), `localOnly` (`computer.local`, `L1146–L1149`), and `allowedRuntimes` (`L1151–L1154`).
         - **Memory & KV-Cache Admission**: Checks system RAM (`requiredSystemGB <= computer.hardware.memoryGB` and active `reservations`, `L1173–L1192`) and GPU VRAM (`requiredGpuGB + kvCacheGB <= totalGpuMemoryGB` and unreserved `usableGpuGB`, `L1194–L1241`, where `estimateKvCacheGB` at `L659–L665` adds 25% of base weight per 32k tokens beyond the baseline 4k window).
   - **Preflight Fallback Loop (`plan`, `L235–L279`)**: If the top-ranked model from Phase 1 has no feasible placement in Phase 2 (`scheduleComputer` throws `SchedulingError`), `plan()` catches the error, appends `route.chosenModel.id` to `excludeModelIds`, and re-runs Phase 1 + Phase 2 until a model with a valid placement is found or all candidates are exhausted.

#### Model Router Bypass & Pinning Rules

- **Explicit Model Pinning (`task.execution?.targetModelId`, `scheduler.ts` `L473–L516`)**:
  - When `targetModelId` is set, `routeModel` sets `strategy: 'explicit'` (`L506`) and skips comparative score ranking (`eligible.sort` is not used to override the pin).
  - **Crucial Invariant**: Explicit pinning **never bypasses the feasibility set $F(t)$**. `routeModel` looks up `preferred` inside `eligible` (`L476`). If the pinned model was rejected by any hard constraint (policy, routing mode, context window, or capabilities), `routeModel` immediately throws `SchedulingError('Explicitly requested model ... is not eligible: ... No silent fallback will be performed.')` (`L477–L483`). Similarly, inside `plan()` (`L255–L257`), if a pinned model fails Phase 2 computer placement, the fallback loop is aborted and `SchedulingError` is rethrown immediately.
- **External Delegated Agent Guard (`scheduler.ts` `L211–L231`)**:
  - External CLI agents (`source === 'external'` in `AgentRegistry`, such as `claude-code`, `codex`, `gemini-cli`) manage their own internal model selection and would bypass Wazir's model router. Therefore, when `routing.mode === 'PROVIDER_ONLY'`, `Scheduler.plan()` checks `deps.agents.get(targetAgentId)` and throws `SchedulingError` (`L223–L229`), blocking external agent delegation so provider lock-in cannot be circumvented.
- **Deterministic Read-Only Command Fast Path (`packages/agents/src/codingAgent.ts` `L207–L218`, `L1384–L1412`)**:
  - For single-command read-only inspection prompts (`ls`, `pwd`, `git status|diff|log`), `CodingAgent` bypasses LLM generation (`modelSelected` is still recorded from the scheduler plan, `L1294–L1301`), but routes execution directly through `runtime.executeTool('run_command', ...)` so all `PolicyEngine` and sandbox checks remain enforced.

---

### 2.2 State Store & Two-Level Lease Fencing (`packages/database`, `packages/shared`, `packages/core`)

| File | Key Symbols & Lines | Responsibility |
| --- | --- | --- |
| `packages/shared/src/store.ts` | `KeyValueStore` (`L11–L18`), `InMemoryStore` (`L263–L287`), `JsonFileStore` (`L289–L538`), `withFileLock` (`L55–L105`), `reviveDatesInPlace` (`L201–L240`) | Core storage abstraction (`update`, `put`, `get`, `list`, `delete`, `clear`), in-memory test store, and crash-safe local file store with advisory lockfile and atomic rename. |
| `packages/database/src/postgresStore.ts` | `PostgresStore` (`L14–L62`), `PoolLike` (`L7–L9`) | PostgreSQL implementation of `KeyValueStore` backed by `wazir_kv_store` (`packages/database/kv-schema.sql`). |
| `packages/database/src/index.ts` | `Database` (`L10–L28`) | Connection wrapper around `PostgresStore` (`createStore()`). |
| `packages/core/src/services/executionPersistence.ts` | `persistExecutionRecord` (`L17–L48`), `executionValuesEqual` (`L3–L15`) | Enforces monotonic `storageRevision` increments and append-only `events` prefix invariance on every `ExecutionRecord` write. |
| `packages/core/src/services/jobManager.ts` | `JobManager` (`L43–L809`), `acquire` (`L126–L191`), `renew` (`L193–L201`), `release` (`L203–L211`), `assertOwnership` (`L213–L218`), `findUnknownMutationsByTask` (`L89–L124`) | **Level 1 (Job-Level) Lease Fencing**: Manages `Job.ownership` (`ownerId`, `epoch`, `expiresAt`) and prevents duplicate or unsafe job replay. |
| `packages/core/src/services/executionEngine.ts` | `ExecutionLease` (`L44–L54`), `LeaseClaimant` (`L56–L62`), `StaleWorkerLeaseError` (`L64–L90`), `acquireLease` (`L1185–L1247`), `renewLease` (`L1253–L1299`), `releaseLease` (`L1305–L1337`), `assertLease` (`L1349–L1414`), `flush` (`L1651–L1667`) | **Level 2 (Execution-Level) Lease & Epoch Fencing**: Guards every in-memory and persisted state transition on an `ExecutionRecord` with worker ID, monotonic epoch, cryptographic lease token, and TTL expiry. |
| `packages/core/src/services/recoveryManager.ts` | `RecoveryManager` (`L69–L266`), `reassignExecutionLease` (`L86–L128`), `sweep` (`L159–L211`), `reconcileFromPhysicalState` (`L213–L238`) | Detects dead workers via heartbeat timeout, reconciles in-flight physical mutations, increments lease epochs on takeover, and fences out zombie workers. |
| `packages/core/src/services/executionRecovery.ts` | `reconcileBeforeCrossHarnessResume` (`L54–L249`), `verifyLeaseFencing` (`L257–L300`) | Cross-harness crash recovery: inspects git worktrees and filesystem artifacts to classify interrupted tool calls before bumping lease epochs. |

#### Durable `KeyValueStore` Implementations & Atomic Read-Modify-Write

1. **`JsonFileStore` (`packages/shared/src/store.ts` `L289–L538`)**:
   - **Cross-Process Lockfile (`withFileLock`, `L55–L105`)**: Serializes all writes via an exclusive lockfile (`<filePath>.lock`) opened with `fs.open(lockFile, 'wx', 0o600)` (`L60`). Writes `{ pid, token, createdAt }` into the lockfile (`L56–L64`). If contended (`EEXIST`), checks whether the lock is older than `LOCK_STALE_AFTER_MS = 30_000` (`L19`, `L78`) and whether the holder PID is dead via `process.kill(holderPid, 0)` (`isProcessAlive`, `L31–L42`); only if dead or malformed does it atomically steal the lock via `fs.rename(lockFile, breakPath)` (`L83`).
   - **Crash-Safe Write Pipeline (`writeDataUnlocked`, `L425–L468`)**: Writes serialized JSON to a sibling temporary file, calls `handle.sync()` (`fsync`, `L448`), closes the descriptor, atomically replaces the target via `fs.rename(tempFile, this.filePath)` (`L451`), and calls `fsyncDir(dir)` (`L452`).
   - **Atomic `update<T>(key, mutate)` (`L470–L489`)**: Acquires the file lock, reloads disk state (`readFromDiskUnlocked`), clones and revives ISO date strings into `Date` instances (`reviveDatesInPlace`, `L201–L240`), runs `mutate(current)`, and persists via `writeDataUnlocked`.

2. **`PostgresStore` (`packages/database/src/postgresStore.ts` `L14–L62`)**:
   - Stores records in `wazir_kv_store (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ)` (`packages/database/kv-schema.sql`).
   - **Transactional Advisory Locking (`update<T>`, `L17–L28`)**: Checks out a dedicated client from the pool, runs `BEGIN`, executes `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))` (`L21`) to serialize concurrent updates on the same key (even when the row does not yet exist), reads the row (`readWithClient`), applies `mutate`, upserts (`writeWithClient`), and `COMMIT`s (`L25`).

3. **Optimistic Storage Revision & Append-Only Event Log (`persistExecutionRecord`, `packages/core/src/services/executionPersistence.ts` `L17–L48`)**:
   - Every `ExecutionEngine.flush()` (`packages/core/src/services/executionEngine.ts` `L1651–L1667`) increments `record.storageRevision` and calls `persistExecutionRecord(store, key, snapshot)`.
   - Inside `store.update`:
     - **Revision Check (`L25–L30`)**: Verifies `nextRevision === currentRevision + 1`; otherwise throws `WazirError('EXECUTION_STORAGE_CONFLICT', ...)` (`L27`).
     - **History Prefix Check (`L31–L45`)**: Verifies `record.events.length >= current.events.length` and checks deep equality (`executionValuesEqual`) for every existing event `0 .. current.events.length - 1`; otherwise throws `WazirError('EXECUTION_HISTORY_CONFLICT', ...)` (`L33`, `L40`).
     - If `flush()` catches any persistence conflict, it latches `this.persistenceFailure = err` (`executionEngine.ts` `L1662–L1665`) and rethrows on all subsequent flushes so a split-brain writer halts permanently.

#### Two-Level Lease Fencing Protocol

Wazir enforces lease fencing at two distinct granularities:

1. **Level 1 — Job Ownership Lease (`JobManager`, `packages/core/src/services/jobManager.ts` `L126–L218`)**:
   - Each `Job` carries `ownership?: { ownerId: string; epoch: number; expiresAt: Date }`.
   - `acquire(jobId)` (`L126–L191`) runs inside `store.update`:
     - Rejects if `current.ownership && current.ownership.expiresAt > now` (`JOB_LEASE_BUSY`, `L134–L141`).
     - Before taking over a previously `RUNNING` job (`L142–L151`), calls `findUnknownMutationsByTask(jobId)` (`L89–L124`) to scan all task execution records for any mutating tool call (`write_file`, `apply_patch`, `run_command`, `git_ops`) that has a `tool.started` event without a matching `tool.completed` event or terminal `record.toolCalls` entry. If found, it marks the job `FAILED` and throws `WazirError('UNKNOWN_MUTATION_OUTCOME', ...)` (`L165–L184`) rather than risking duplicate side effects.
     - Increments `nextEpoch = (current.ownership?.epoch ?? 0) + 1` (`L153`), writes `ownership`, and caches `this.claims.set(jobId, nextEpoch)` (`L189`).
   - `assertOwnership(job)` (`L213–L218`) verifies `job.ownership.ownerId === this.ownerId`, `job.ownership.epoch === claimedEpoch`, and `job.ownership.expiresAt > this.now()`, throwing `WazirError('JOB_LEASE_LOST', ...)` on mismatch.

2. **Level 2 — Execution Worker Lease & Epoch Fencing (`ExecutionEngine`, `packages/core/src/services/executionEngine.ts` `L44–L90`, `L1185–L1414`)**:
   - `ExecutionLease` (`L44–L54`): `{ workerId: string; epoch: number; acquiredAt: Date; expiresAt: Date; released?: boolean; token?: string }`.
   - **Acquisition & Epoch Bump (`acquireLease`, `L1185–L1247`)**:
     - Rejects acquisition on terminal executions (`COMPLETED`, `FAILED`, `CANCELLED`, `L1187–L1199`).
     - If an unreleased, unexpired lease is held by a **different** `workerId` (`L1203–L1215`), throws `StaleWorkerLeaseError` (`code = 'STALE_WORKER_LEASE'`) unless `options.force === true` (used by `RecoveryManager` after heartbeat timeout).
     - Computes `nextEpoch = (current?.epoch ?? 0) + 1` (`L1217`), generates a cryptographic `token = randomUUID()` (`L1220`), sets `this.activeLease`, updates `this.record.lease`, and emits a durable `lease.acquired` event (`L1231–L1244`).
   - **Pre-Mutation Fencing Gate (`assertLease`, `L1349–L1414`)**:
     - Called as the very first line of **every** mutating method on `ExecutionEngine`: `setStatus` (`L1420`), `recordPolicy` (`L1450`), `recordToolStart` (`L1464`), `recordToolCall` (`L1486`), `recordCheck` (`L1514`), `recordEvidence` (`L1537`), `recordEvent` (`L1557`), `recordError` (`L1579`), `recordUsage` (`L1598`), `recordFilesChanged` (`L1613`), `setResult` (`L1622`), and `setEvaluation` (`L1638`).
     - When `this.fencingEnabled` is true (automatically enabled on the first `acquireLease` or when rehydrated from persisted `lease.*` events via `reconstructLeaseFromEvents` at `L288–L324`), `assertLease` checks:
       1. `this.activeLease` exists and `!current.released` (`L1354–L1379`).
       2. `claimedEpoch === current.epoch` (`L1381–L1389`).
       3. `claimedWorker === current.workerId` (`L1391–L1399`).
       4. `claimedToken === current.token` (`L1401–L1405`).
       5. `current.expiresAt.getTime() > now.getTime()` (`L1407–L1413`).
     - Any failure throws `StaleWorkerLeaseError`, immediately halting the zombie worker before it can mutate memory or flush to storage.
   - **Crash Recovery & Physical Reconciliation (`RecoveryManager` in `packages/core/src/services/recoveryManager.ts` & `executionRecovery.ts`)**:
     - `RecoveryManager.sweep()` (`L159–L211`) scans registered workers for missed heartbeats (`now - lastHeartbeat > heartbeatTimeoutMs`, default 30s).
     - Before reassigning an orphaned execution (`reassignExecutionLease`, `L86–L128`), `reconcileFromPhysicalState` (`L213–L238`) and `reconcileBeforeCrossHarnessResume` (`executionRecovery.ts` `L54–L249`) inspect the physical git worktree (`git status --porcelain`, target file existence/content) to determine whether an interrupted tool call (`tool.started` without `tool.completed`) actually took effect on disk, recording a `recovery.reconciled` event before calling `engine.acquireLease(newWorkerId, ttl, { force: true })` to increment the epoch and fence out the old worker.

---

### 2.3 Worktree Manager & Agent Skill / Prompt Injection (`packages/core`, `packages/agents`, `packages/tools`, `packages/workers`)

| File | Key Symbols & Lines | Responsibility |
| --- | --- | --- |
| `packages/core/src/services/worktreeManager.ts` | `WorktreeManager` (`L55–L424`), `WorktreeInfo` (`L14–L29`), `MergeResult` (`L31–L35`), `createWorktree` (`L103–L204`), `createCleanWorkspace` (`L210–L242`), `commitWorktree` (`L244–L305`), `diffWorktree` (`L307–L324`), `mergeBranch` (`L326–L377`), `removeWorktree` (`L379–L397`) | Creates isolated git worktrees per task/job from exact base commits, disables repository git hooks (`GIT_NO_HOOKS`), commits/merges task branches, and cleans up worktrees. |
| `packages/core/src/services/skillsRegistry.ts` | `SkillsRegistry` (`L27–L191`), `SkillDefinition` (`L11–L20`), `parseSkillFile` (`L97–L141`), `toAgentDescriptors` (`L69–L88`) | Discovers `.wazir/skills/**/*.md` files, parses YAML frontmatter + markdown instruction body, and exposes skills as routable `AgentDescriptor`s or injectable instructions. |
| `packages/core/src/services/instructionResolver.ts` | `ScopedInstructionResolver` (`L34–L238`), `DEFAULT_CONTEXT_FILE_PATTERNS` (`L15–L21`), `discover` (`L42–L72`), `resolve` (`L77–L137`) | Discovers hierarchical instruction files (`.wazir/INSTRUCTIONS.md`, `WAZIR.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`) and resolves root + package-scoped instructions matching active files/directories. |
| `packages/core/src/services/contextCompiler.ts` | `ContextCompiler` (`L149–L785`), `SystemContextProvider` (`L283–L312`), `TaskContextProvider` (`L314–L404`), `InstructionContextProvider` (`L406–L472`), `ExecutionStateContextProvider` (`L474–L562`), `CodeIntelligenceContextProvider` (`L564–L673`), `HistoryContextProvider` (`L675–L784`), `WEB_TRUST_INSTRUCTION` (`L34–L35`) | Assembles token-budgeted context items across providers, injects untrusted-web-content warnings, and delegates ordering to `PromptLayoutPlanner`. |
| `packages/core/src/services/promptLayoutPlanner.ts` | `PromptLayoutPlanner` (`L38–L161`), `StabilityTier` (`L12`), `planLayout` (`L44–L72`) | Orders prompt items into `STATIC` $\rightarrow$ `SEMI_STABLE` $\rightarrow$ `VOLATILE` tiers under `CACHE_STABLE_PREFIX` strategy so volatile turn state never invalidates prefix KV caches. |
| `packages/core/src/services/toolSurfaceCompiler.ts` | `ToolSurfaceCompiler` (`L221–L416`), `ExecutionPhase` (`L18`), `InteractionMode` (`L24`), `compile` (`L228–L314`), `selectProtocol` (`L148–L172`) | Compiles phase-scoped (`plan`, `implement`, `repair`, `verify`) tool schemas, selects calling protocol (`native_tool_call`, `structured_output`, `legacy_text`), and renders tool instructions. |
| `packages/agents/src/configurationDiscovery.ts` | `discoverAgentConfiguration` (`L62–L118`), `DiscoveredAgentConfiguration` (`L18–L25`) | Scans workspace root for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.wazir/instructions.md`, and `.wazir/skills/*.md` to build `combinedInstructions` for agent runs. |
| `packages/agents/src/externalAgent.ts` | `ExternalCliAgent` (`L25–L213`), `PRESET_EXTERNAL_AGENTS` (`packages/agents/src/presets.ts` `L4–L36`) | Wraps external CLI coding agents (`claude-code`, `codex`, `gemini-cli`, `aider`) as `AgentRunner` implementations running inside the task's isolated workspace. |
| `packages/tools/src/registry.ts` | `ToolRegistry` (`L101–L157`), `executeTool` (`L193–L287`), `proposedOracleWeakening` (`L167–L190`) | Validates tool input/output JSON schemas, runs pre-dispatch test-oracle weakening detection on test files, records workspace before/after snapshots, and dispatches tools. |
| `packages/tools/src/sandbox.ts` | `SandboxExecutor` (`L211–L563`), `buildBubblewrapArgs` (`L65–L130`), `buildSeatbeltProfile` (`L136–L175`) | OS-level process sandboxing (`bwrap` + seccomp on Linux, `sandbox-exec` seatbelt profiles on macOS) restricting filesystem writes to `workspaceRoot` and gating network access. |
| `packages/workers/src/worker.ts` | `Worker` (`L52–L474`), `executeRequest` (`packages/workers/src/taskExecutor.ts` `L24–L83`), `dispatchRemote` (`packages/workers/src/remoteDispatch.ts` `L50–L96`) | Execution-plane daemon that registers hardware/runtime capabilities, heartbeats to the control plane, executes dispatched tasks, and filters internal `lease_*` events at the remote boundary. |

#### Worktree Isolation & Git Lifecycle (`WorktreeManager`)

- **Path Sanitization & Hook Neutralization (`packages/core/src/services/worktreeManager.ts` `L37–L41`, `L413–L420`)**:
  - `assertSafeId` (`L413–L420`) validates `jobId` and `taskId` against `/^[a-zA-Z0-9._-]+$/` to prevent path traversal outside `.wazir/worktrees`.
  - Every `git` invocation passes `GIT_NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']` (`L41`) so untrusted repository git hooks (`post-checkout`, `pre-commit`, etc.) cannot execute arbitrary code during worktree creation or commits.
- **Worktree Creation (`createWorktree`, `L103–L204`)**:
  - Resolves `baseSha` (defaults to `HEAD`), constructs `worktreePath = <repoPath>/.wazir/worktrees/<jobId>-<taskId>` and `branch = wazir/<jobId>/<taskId>`, and runs `git -c core.hooksPath=/dev/null worktree add -B <branch> <worktreePath> <baseSha>` (`L153–L165`).
  - Creates isolated `.wazir/{tmp,home,cache}` subdirectories inside the worktree (`ensureRuntimeDirs`, `L95–L101`) so tool subprocesses have private `TMPDIR`, `HOME`, and `XDG_CACHE_HOME` directories.
  - Falls back to a filtered recursive directory copy (`copyWorkspaceFiltered`, `L185–L203`) if the workspace is not a git repository or if `git worktree add` fails.
- **Commit, Diff, Merge & Cleanup (`L244–L410`)**:
  - `commitWorktree` (`L244–L305`): Stages all changes (`git add -A`), unstages internal `.wazir` runtime directories (`git reset -q HEAD -- .wazir`), checks `git status --porcelain`, and creates a commit with `GIT_AUTHOR_NAME=Wazir`, returning the new commit SHA and changed file list.
  - `mergeBranch` (`L326–L377`): Merges a task branch into the target branch using `--no-ff` (`L345`); on merge conflict, extracts conflicted files (`git diff --name-only --diff-filter=U`), runs `git merge --abort` (`L364`) to leave the repository clean, and returns `{ success: false, conflictedFiles }`.
  - `removeWorktree` (`L379–L397`) & `cleanupDirectory` (`L399–L410`): Verifies `path.resolve(worktreePath)` starts with `path.resolve(this.worktreeRoot) + path.sep` before running `git worktree remove --force` and `fs.rm`.

#### Skill Discovery, Hierarchical Instructions & Cache-Stable Prompt Injection

1. **Skills Discovery (`SkillsRegistry`, `packages/core/src/services/skillsRegistry.ts` `L27–L191`)**:
   - Recursively scans `.wazir/skills` for `.md` files (`discover`, `L34–L53`).
   - `parseSkillFile` (`L97–L141`) parses YAML frontmatter (`name`, `description`, `version`, `capabilities`, `taskTypes`) and extracts the markdown body as `instructions`.
   - Skills can be projected into `AgentDescriptor` records (`id: "skill:<name>"`, `source: 'skill'`, `L69–L88`) for `AgentRegistry` routing, or discovered alongside workspace instructions via `discoverAgentConfiguration` (`packages/agents/src/configurationDiscovery.ts` `L62–L118`).

2. **Scoped Instruction Resolution (`ScopedInstructionResolver`, `packages/core/src/services/instructionResolver.ts` `L34–L238`)**:
   - Scans up to directory depth 4 for `DEFAULT_CONTEXT_FILE_PATTERNS` (`L15–L21`): `.wazir/INSTRUCTIONS.md` (priority 90), `WAZIR.md` (85), `AGENTS.md` (80), `CLAUDE.md` (70), and `.cursorrules` (65).
   - `resolve(request)` (`L77–L137`) always includes root-level (`scope === '.'`) instruction files and selectively includes subdirectory-scoped instruction files when `activeFiles`, `workingDirectory`, or task description keywords match that scope (`findMatchingScopes`, `L171–L206`), truncating at `maxTotalChars` (default 12,000 chars).

3. **Prompt Compilation & KV-Cache Stability (`ContextCompiler` & `PromptLayoutPlanner`)**:
   - `ContextCompiler.compile(input)` (`packages/core/src/services/contextCompiler.ts` `L172–L280`) gathers `ContextItem`s from six ordered providers (`SystemContextProvider`, `TaskContextProvider`, `InstructionContextProvider`, `ExecutionStateContextProvider`, `CodeIntelligenceContextProvider`, `HistoryContextProvider`, `L159–L166`), enforces per-section and total token budgets, and prepends `WEB_TRUST_INSTRUCTION` (`L34–L35`, `L207–L217`) whenever untrusted web search/fetch results are present in task evidence.
   - `PromptLayoutPlanner.planLayout(items, budget)` (`packages/core/src/services/promptLayoutPlanner.ts` `L44–L160`) partitions items into three stability tiers (`StabilityTier`, `L12`):
     - `STATIC` (tier 0): System instructions, workspace root instructions, and tool surface definitions.
     - `SEMI_STABLE` (tier 1): Task specification, scoped instructions, and code-intelligence symbol maps.
     - `VOLATILE` (tier 2): Current execution state, turn history, verification failures, and repair hints.
   - Under the default `CACHE_STABLE_PREFIX` strategy (`L74–L160`), `STATIC` and `SEMI_STABLE` items are locked at the beginning of the prompt in deterministic priority/key order, while `VOLATILE` items are appended at the tail—ensuring multi-turn agent loops preserve prefix KV-cache hits.
   - Finally, `CodingAgent.buildSystemPrompt` (`packages/agents/src/codingAgent.ts` `L575–L606`) combines the base agent persona, phase-compiled tool definitions from `ToolSurfaceCompiler.compile()` (`packages/core/src/services/toolSurfaceCompiler.ts` `L228–L314`), untrusted-content injection defense rules, and `context.systemPromptExtra` (discovered skills and scoped instructions).
