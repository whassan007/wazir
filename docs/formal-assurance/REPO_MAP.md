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
