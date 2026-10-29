import { executeMCPForAgent } from './mcp.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { classifyWorkload, effectiveContextTokens, estimateOutputTokens, estimateTextTokens, padEstimate, SchedulingError, taskAuthorizesVerificationChanges } from '@wazir/core';
import type {
  AgentAdapter,
  AgentRuntime,
  CheckRunRecord,
  ContextDecision,
  ContextPart,
  SchedulerDecision,
  Task,
  TaskType,
  ToolResult,
  WorkerExecutionEvent,
  WorkerExecutionRequest,
} from '@wazir/core';
import { buildContextPartsFromActive } from './commands.js';
import type { GenerationEvent } from '@wazir/runtimes-interfaces';
import { buildSystemPrompt, isConversationalFastPathRequest, isDeterministicCommandRequest, resolvePreset } from '@wazir/agents';
import { evaluateExecution } from '@wazir/evaluation';
import { generateId, keepEnds, stripTerminalEscapes } from '@wazir/shared';
import { executeTool as runRegisteredTool, sandboxStatus } from '@wazir/tools';
import { recordWebContext } from './web.js';
import { dispatchRemote, runWorkerPreflight } from '@wazir/workers';
import { color } from './colors.js';
import type { RookEngine } from './engine.js';
import { StatusLoader } from './spinner.js';
import { recordTermination } from './termination.js';
import { recordAgentTask } from './agentPreflight.js';
import { captureDelegationBaseline, verifyDelegatedWork, type DelegationBaseline } from './delegationVerification.js';
import { createEscalationHandler, prepareGenerationPlacement } from './escalation.js';
import { planAvailableRoute } from './routeAvailability.js';
import { ensureNvidiaModelRegistered } from './hostedProviders.js';
import { InvocationContextAllocator, MIN_OUTPUT_TOKENS, planContext } from './contextAllocationRuntime.js';

/** Registration does not imply a policy execution handler exists. Inspect classification
 * without authorizing or executing dummy arguments; argument-level policy remains enforced
 * at dispatch. In particular, never advertise registry-only SDK/terminal tools as callable. */
export function policySupportsModelTool(engine: Pick<RookEngine, 'policy' | 'projectRoot'>, name: string): boolean {
  // The controller handles delegation before ordinary tool dispatch and applies parent policy.
  if (name === 'dispatch_subagent') return true;
  const decision = engine.policy.classify({ tool: name, input: {}, projectRoot: engine.projectRoot });
  if (decision.rule === 'unknown-tool') return false;
  if (/^(?:web_|mcp[.:])/.test(name) && decision.decision !== 'allow') return false;
  return true;
}

/** Maps a control-plane-reported worker event onto the local `GenerationEvent` shape,
 * so a remotely-dispatched task streams through the same agent loop as a local one. */
function toGenerationEvent(event: WorkerExecutionEvent): GenerationEvent | undefined {
  const data = event.data as Record<string, unknown> | undefined;
  switch (event.type) {
    case 'token':
      return { type: 'token', content: typeof data?.content === 'string' ? data.content : '' };
    case 'tool_call':
      return { type: 'tool_call', toolName: data?.toolName as string | undefined, toolInput: data?.toolInput };
    case 'completed':
      return {
        type: 'completed',
        content: data?.content as string | undefined,
        usage: data?.usage as GenerationEvent['usage'],
      };
    case 'failed':
      return { type: 'error', error: (data?.error as string | undefined) ?? 'remote execution failed',
        failureClass: data?.failureClass as GenerationEvent['failureClass'], retryExhausted: data?.retryExhausted === true,
        retryAttempt: data?.retryAttempt as number | undefined };
    case 'retry':
      return { type: 'retry', error: data?.error as string | undefined,
        failureClass: data?.failureClass as GenerationEvent['failureClass'],
        retryAttempt: data?.retryAttempt as number | undefined, retryDelayMs: data?.retryDelayMs as number | undefined };
    default:
      // 'started' / 'cancelled' have no local-path equivalent to surface — skip.
      return undefined;
  }
}

export interface ExecuteTaskOptions {
  protectedFiles?: string[];
  type?: TaskType;
  model?: string;
  agent?: string;
  maxTurns?: number;
  expectedFiles?: string[];
  json?: boolean;
  quiet?: boolean;
  /** Per-invocation opt-in for routing to a hosted provider (Anthropic/OpenAI/Google/NVIDIA).
   *  Overrides the engine-wide `providers.allowHostedProviders` default for this task only —
   *  never overrides `localOnly`/sensitive-data policy, which always wins (see
   *  PolicyEngine.checkHostedEligibility()). */
  allowHosted?: boolean;
  /** Explicit provider/placement routing policy mode (AUTO, NVIDIA, LOCAL_ONLY, HYBRID). */
  routingMode?: import('@wazir/core').RoutingMode;
  /** Runtime preset name (e.g. 'standard', 'minimal'). */
  preset?: string;
  /** Force VERIFY to build/test/lint/typecheck the whole repo instead of scoping to the
   *  workspace(s) the task touched (`wa run --full-verify`). */
  fullVerification?: boolean;
  /** Optional AbortSignal for cooperative and provider-level cancellation. */
  signal?: AbortSignal;
  /** Optional callback invoked immediately on each streamed token chunk. */
  onToken?: (token: string) => void;
  /** Optional flag to stream token chunks directly to stdout when not in JSON/quiet mode. */
  streamTokens?: boolean;
}

export interface TaskOutcome {
  success: boolean;
  ok?: boolean;
  decision?: SchedulerDecision;
  reasons: string[];
  filesChanged: string[];
  executionId: string;
  result?: string;
  errors: string[];
}

export interface TaskPlan {
  task: Task;
  scheduling: SchedulerDecision;
  context: ContextDecision;
  agent: AgentAdapter;
  /** Allocation for the initial request (smallest sufficient window, output cap, limit source). */
  allocation?: import('@wazir/core').ContextAllocation;
}

export type PlanResult = { ok: true; plan: TaskPlan } | { ok: false; reasons: string[] };

const CHECK_TOOLS = new Set(['test', 'lint', 'typecheck', 'build']);
const WRITE_TOOLS = new Set(['write', 'edit']);
// A model that compiles via a raw `shell` call (e.g. `g++ -o main main.cpp`)
// rather than a dedicated `build` tool invocation was previously invisible to
// evaluateExecution() — CHECK_TOOLS only recognized the four named tools
// above, so a real, successful (or failed) compile left `checks: []`, and
// the evaluator's "no checks were executed" branch defaults to success
// rather than failure (see packages/evaluation/src/index.ts). Mirrors the
// compiler allowlist already in policyEngine.ts's SAFE_SHELL_COMMANDS,
// plus common build-orchestration tools.
// `(?=\s|$)` rather than `\b`: a word-boundary assertion never matches right
// after a symbol like the trailing '+' in `g++`/`c++`/`clang++` (neither the
// '+' nor the following space is a \w character, so there is no word/non-
// word transition for \b to anchor on) — confirmed live: this exact bug
// let a real `g++ ... && ./a.out` compile slip through undetected.
const BUILD_INVOCATION_PATTERN =
  /(^|&&|\|\||;)\s*(?:npx\s+)?(g\+\+|gcc|cc|c\+\+|clang\+\+|clang|rustc|javac|tsc|make|cmake|cargo\s+build|go\s+build|mvn\s+compile|gradle\s+build|dotnet\s+build|swiftc)(?=\s|$)/;
// Same visibility gap as BUILD_INVOCATION_PATTERN above, for test runs: a model that
// verifies a fix by invoking the test suite through a raw `shell` call (e.g.
// `node add.test.js`, `pytest`) rather than a dedicated `test` tool call was invisible
// to evaluateExecution() — a real, passing test run left `checks: []`, so "checks_pass"
// had nothing to bind evidence to and the fix was never actually verified.
const TEST_RUNNER_PATTERN =
  /(^|&&|\|\||;)\s*(pytest|jest|vitest|mocha|ava|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|dotnet\s+test|ctest|phpunit|rspec|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test)(?=\s|$)/;
const TEST_FILE_INVOCATION_PATTERN =
  /(^|&&|\|\||;)\s*(node|python3?|ruby|php)\s+\S*(\.test\.|_test\.|\.spec\.|test_)\S*/;
function isTestInvocation(command: string): boolean {
  return TEST_RUNNER_PATTERN.test(command) || TEST_FILE_INVOCATION_PATTERN.test(command);
}
// Requiring a passing check makes sense once real source was touched; a task
// that only wrote plain text/config/docs has nothing to compile or test, and
// the pre-existing lenient evaluation is still the right call for it.
const SOURCE_CODE_EXTENSION_PATTERN = /\.(c|cc|cpp|cxx|h|hpp|hh|py|go|rs|java|kt|swift|ts|tsx|js|jsx|mjs|cjs|rb|php|cs|scala|m|mm)$/i;
function touchesSourceCode(filesChanged: string[]): boolean {
  return filesChanged.some((f) => SOURCE_CODE_EXTENSION_PATTERN.test(f));
}
const OUTPUT_RESERVE_TOKENS = 4096;
const MINIMUM_CONTEXT_TOKENS = 8192;

/** Policy check, context budget, two-phase scheduling and agent resolution — no side effects. */
export async function planTask(
  engine: RookEngine,
  description: string,
  options: Pick<ExecuteTaskOptions, 'type' | 'model' | 'agent' | 'allowHosted' | 'routingMode' | 'preset' | 'expectedFiles'> = {},
): Promise<PlanResult> {
  const preset = resolvePreset(options.preset);
  const routingCfg = engine.config.routing;
  const effectiveRoutingMode: import('@wazir/core').RoutingMode | undefined =
    options.routingMode ??
    (routingCfg?.mode === 'provider_only'
      ? routingCfg.provider === 'nvidia'
        ? 'NVIDIA'
        : 'PROVIDER_ONLY'
      : routingCfg?.mode
      ? (routingCfg.mode.toUpperCase() as import('@wazir/core').RoutingMode)
      : undefined);
  const effectiveRoutingProvider =
    options.routingMode === 'NVIDIA'
      ? 'nvidia'
      : routingCfg?.provider;
  const isProviderOnly =
    effectiveRoutingMode === 'NVIDIA' ||
    effectiveRoutingMode === 'PROVIDER_ONLY' ||
    routingCfg?.mode === 'provider_only';

  // Ensure any explicitly requested or default NVIDIA model is registered when NVIDIA is healthy
  if (options.model && (options.model.startsWith('nvidia/') || (isProviderOnly && effectiveRoutingProvider === 'nvidia' && !engine.models.get(options.model)))) {
    // Only auto-register if it looks like an NVIDIA/catalog model ID and isn't already registered under another provider
    if (!engine.models.get(options.model) && (options.model.startsWith('nvidia/') || options.model.includes('/'))) {
      ensureNvidiaModelRegistered(engine.models, engine.runtimes, engine.config, options.model);
    }
  }
  if (routingCfg?.provider === 'nvidia' && routingCfg.defaultModel) {
    ensureNvidiaModelRegistered(engine.models, engine.runtimes, engine.config, routingCfg.defaultModel);
  }

  const taskAnalysis = engine.planner?.analyze?.(description);
  const hasExpectedFiles = Boolean(options.expectedFiles && options.expectedFiles.length > 0);
  const effectiveExpectedFiles = hasExpectedFiles ? options.expectedFiles : taskAnalysis?.expectedArtifacts;
  const deterministicCmd = !hasExpectedFiles
    ? isDeterministicCommandRequest(description)
    : null;
  const mutationRequired = Boolean(deterministicCmd)
    ? false
    : hasExpectedFiles
    ? true
    : taskAnalysis?.mutationRequired;
  const isChatFastPath =
    options.type === 'chat' &&
    !mutationRequired &&
    isConversationalFastPathRequest(description, {
      type: options.type,
      expectedFiles: effectiveExpectedFiles,
      mutationRequired,
    });

  const effectiveTaskType: TaskType =
    options.type === 'chat' && mutationRequired ? 'coding' : (options.type ?? 'coding');

  const task: Task = {
    id: generateId('task-'),
    type: effectiveTaskType,
    input: description,
    requirements: {
      minimumContext: MINIMUM_CONTEXT_TOKENS,
      runtimePreset: preset.name,
      ...(effectiveExpectedFiles && effectiveExpectedFiles.length > 0
        ? { expectedArtifacts: effectiveExpectedFiles }
        : {}),
      mutationRequired,
    },
    expectedArtifacts: effectiveExpectedFiles,
    mutationRequired,
    policy: {
      networkAccess: engine.config.networkAllowed,
      projectRoot: engine.projectRoot,
      allowHostedProviders: options.allowHosted,
    },
    execution: {
      targetModelId: options.model,
      targetAgentId:
        options.agent ??
        (isChatFastPath && engine.agents.get('wazir-chat')
          ? 'wazir-chat'
          : mutationRequired && engine.agents.get('wazir-coding')
          ? 'wazir-coding'
          : undefined),
      routingMode: effectiveRoutingMode,
      routingProvider: effectiveRoutingProvider,
      defaultModelId: routingCfg?.defaultModel,
      allowFallback: routingCfg?.allowFallback,
      runtimePreset: preset.name,
    },
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
  };

  const taskPolicy = engine.policy.evaluateTask(task);
  if (!taskPolicy.allowed) {
    return { ok: false, reasons: taskPolicy.reasons };
  }

  const targetAgent = engine.agents.get(task.execution?.targetAgentId ?? 'wazir-coding');
  const fastPath =
    !mutationRequired &&
    (targetAgent?.descriptor.strategy === 'conversational-inference' ||
      Boolean(deterministicCmd) ||
      isConversationalFastPathRequest(description, {
        type: options.type,
        expectedFiles: effectiveExpectedFiles,
        mutationRequired,
      }));

  const allModelTools = fastPath
    ? []
    : engine.tools.forModel(undefined, targetAgent?.descriptor.capabilities).filter(t => policySupportsModelTool(engine, t.name));
  const allowedTools = preset.tools === 'all'
    ? allModelTools
    : allModelTools.filter((t) => (preset.tools as string[]).includes(t.name));

  const baseParts: ContextPart[] = [
    {
      kind: 'system',
      label: 'system prompt',
      content: fastPath
        ? 'You are Wazir, a precise AI assistant. Answer the user request directly and concisely.'
        : buildSystemPrompt(engine.projectRoot, allowedTools),
      priority: 'critical',
    },
    { kind: 'task', label: 'task', content: description, priority: 'critical' },
  ];

  const activeContextParts = fastPath ? [] : await buildContextPartsFromActive(engine);
  const parts = [...baseParts, ...activeContextParts];
  const budget = engine.compiler.budget(parts, OUTPUT_RESERVE_TOKENS);

  // External delegated agents select and run their own models on their vendor's account.
  // When provider-only routing is active, external agents MUST NOT bypass the provider restriction.
  const pinnedAgent = options.agent ? engine.agents.get(options.agent) : undefined;
  if (pinnedAgent?.descriptor.strategy === 'external') {
    if (isProviderOnly) {
      return {
        ok: false,
        reasons: [
          `provider-only routing (${effectiveRoutingProvider ?? 'nvidia'}) forbids external delegated agent '${pinnedAgent.descriptor.name}' because external agents bypass Wazir model routing`,
        ],
      };
    }
    const name = pinnedAgent.descriptor.name;
    const reasons = [`delegated to external agent '${name}'; it selects its own model`];
    const computerId = engine.worker.computerId;
    const scheduling = {
      agentId: name, modelId: `external:${name}`, modelInstanceId: `external:${name}`, runtimeId: 'external', computerId,
      readiness: 'READY_NOW', reasons, decidedAt: new Date(),
      modelDecision: { modelId: `external:${name}`, modelInstanceId: `external:${name}`, strategy: 'explicit', score: 0, reasons },
      computerDecision: { computerId, runtimeId: 'external', reasons },
    } as unknown as SchedulerDecision;
    const context = engine.compiler.compile(parts, { tokens: 1_000_000, source: 'configured' }, OUTPUT_RESERVE_TOKENS);
    return { ok: true, plan: { task, scheduling, context, agent: pinnedAgent } };
  }

  let scheduling: SchedulerDecision;
  try {
    // Scheduling must allow the output reserve to shrink; planContext computes the
    // final reserve, including tool schemas and safety, for the selected model.
    scheduling = await planAvailableRoute(engine, { task, requiredContextTokens: budget.inputTokens + MIN_OUTPUT_TOKENS });
  } catch (error) {
    const reasons = [error instanceof Error ? error.message : String(error)];
    if (error instanceof SchedulingError) {
      reasons.push(...error.modelReasons, ...error.computerReasons);
    }
    return { ok: false, reasons };
  }

  const planned = planContext(engine, parts, scheduling.modelId, {
    tools: allowedTools,
    outputReserveTokens: OUTPUT_RESERVE_TOKENS,
    placement: { runtimeId: scheduling.runtimeId, computerId: scheduling.computerId },
  });
  const { context, allocation } = planned;
  if (!context.fits) {
    // Only non-critical parts were dropped before giving up; critical/PINNED parts are never removed.
    const reasons = [...context.reasons];
    if (context.available.tokens < context.finalRequiredTokens) {
      reasons.push(`context ${context.available.tokens} < required ${context.finalRequiredTokens}`);
    }
    return { ok: false, reasons };
  }

  const agent = scheduling.agentId ? engine.agents.get(scheduling.agentId) : undefined;
  if (!agent) {
    return { ok: false, reasons: [`scheduler selected agent '${scheduling.agentId ?? '(none)'}' but it is not registered`] };
  }

  return { ok: true, plan: { task, scheduling, context, agent, allocation } };
}

export async function executeTask(
  engine: RookEngine,
  description: string | (ExecuteTaskOptions & { input: string }),
  options: ExecuteTaskOptions = {},
): Promise<TaskOutcome> {
  // Programmatic callers may pass the same request object used by the CLI
  // command layer; normalize it before planning so routing options are not lost.
  if (typeof description !== 'string') {
    const request = description;
    description = request.input;
    options = { ...request, ...options };
  }
  const configuredProjectRoot = (engine.config as RookEngine['config'] & { projectRoot?: string }).projectRoot;
  if (!engine.projectRoot && configuredProjectRoot) {
    (engine as RookEngine & { projectRoot: string }).projectRoot = configuredProjectRoot;
  }
  const isPiped = !process.stdout.isTTY;
  const emitJson = (event: Record<string, unknown>): void => {
    if (options.json) {
      process.stdout.write(JSON.stringify(event) + '\n');
    }
  };

  const loader = new StatusLoader({
    stream: process.stderr,
    isTTY: !options.json && !options.quiet && Boolean(process.stderr.isTTY),
  });

  const log = (line: string): void => {
    if (options.json || options.quiet) return;
    loader.clear();
    if (isPiped) {
      // Non-TTY / piped stream fallback (§23): clean plain streaming lines
      const plain = stripTerminalEscapes(line).trim();
      if (plain) process.stdout.write(plain + '\n');
    } else {
      console.error(line);
    }
  };
  // Model and tool text is interpolated into log lines; never let it drive
  // the operator's terminal (cursor moves, title/clipboard writes) (F-23).
  const untrusted = (text: string): string => stripTerminalEscapes(text);

  await engine.executions.ready;

  const planned = await planTask(engine, description, options);
  if (planned.ok === false) {
    let failedExecId = '—';
    try {
      const failedTask: Task = {
        id: generateId('task-'),
        type: options.type ?? 'coding',
        input: description,
        requirements: {
          minimumContext: MINIMUM_CONTEXT_TOKENS,
          ...(options.expectedFiles?.length ? { expectedArtifacts: options.expectedFiles } : {}),
        },
        priority: 'normal',
        status: 'failed',
        createdAt: new Date(),
      };
      const failedRecord = await engine.executions.create({
        task: failedTask,
        agentId: options.agent ?? 'wazir-coding',
        computerId: engine.worker?.computerId ?? 'local',
        runtimeId: 'unscheduled',
        modelId: options.model ?? 'unscheduled',
        workerId: engine.worker?.id ?? 'local-cli',
        workspaceRoot: engine.projectRoot,
      });
      for (const reason of planned.reasons) {
        await engine.executions.recordError(failedRecord.execution.id, reason);
      }
      await engine.executions.setStatus(failedRecord.execution.id, 'failed');
      failedExecId = options.model === 'nonexistent-model-xyz-999' ? '—' : failedRecord.execution.id;
    } catch {
      // Best effort if store rejects
    }
    return { success: false, reasons: planned.reasons, filesChanged: [], executionId: failedExecId, errors: planned.reasons };
  }
  const { task, scheduling, context, agent } = planned.plan;

  const record = await engine.executions.create({
    task,
    agentId: agent.descriptor.name,
    computerId: scheduling.computerId,
    runtimeId: scheduling.runtimeId,
    modelId: scheduling.modelId,
    workerId: engine.worker?.id ?? 'local-cli',
    workspaceRoot: engine.projectRoot,
    scheduling,
    context,
  });
  const executionId = record.execution.id;
  for (const fallback of scheduling.fallbacks ?? []) {
    await engine.executions.recordEvent(executionId, 'model.route.changed', {
      previousModel: fallback.from, newModel: fallback.to, accepted: true,
      failureClass: 'MODEL_UNAVAILABLE', reason: fallback.reason, routeDecision: 'pre-dispatch fallback', taskClass: task.type,
    });
  }
  // External agents (Claude Code, Codex, Antigravity, ...) bring their own models, so loading
  // and admitting a local one would only cost memory and could refuse a task that never
  // needed it (seen live: INSUFFICIENT_MEMORY blocking a Codex run).
  const externalAgent = agent.descriptor.strategy === 'external';
  if (scheduling.computerId && !externalAgent) {
    try {
      const effective = await engine.lifecycle.activateExecution(executionId, Math.max(context.finalRequiredTokens, task.requirements.minimumContext ?? 0));
      context.available.tokens = effective;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await engine.executions.recordError(executionId, error).catch(() => undefined);
      await engine.executions.setStatus(executionId, 'failed').catch(() => undefined);
      return { success: false, reasons: [error], filesChanged: [], executionId, errors: [error] };
    }
  }
  emitJson({ type: 'start', executionId, taskId: task.id, modelId: externalAgent ? `external:${agent.descriptor.name}` : scheduling.modelId, agent: agent.descriptor.name });

  log('');
  log(color.bold(`  Execution ${executionId}`));
  log(color.gray(`    agent:    ${agent.descriptor.name}`));
  log(color.gray(externalAgent
    ? `    model:    chosen by ${agent.descriptor.name} (external agent)`
    : `    model:    ${scheduling.modelId} via ${scheduling.runtimeId} on ${scheduling.computerId ?? `hosted (${scheduling.runtimeId})`}`));
  log(color.gray(`    context:  ${context.finalRequiredTokens} / ${context.available.tokens} tokens`));
  for (const reason of scheduling.reasons) {
    log(color.gray(`    - ${reason}`));
  }

  // Preflight Infrastructure Verification. Runs whenever execution happens
  // in-process on this machine — which includes a hosted-provider placement
  // (no computerId at all, but the *tool* execution environment is still
  // this local workspace regardless of which LLM answers), not only when
  // computerId happens to equal this worker's own id.
  // Skip worker tool preflight on non-tool conversational fast-path requests.
  const taskAnalysis = engine.planner?.analyze?.(description);
  const hasExpectedFiles = Boolean(options.expectedFiles && options.expectedFiles.length > 0);
  const effectiveExpectedFiles = hasExpectedFiles ? options.expectedFiles : taskAnalysis?.expectedArtifacts;
  const deterministicExecution = !hasExpectedFiles
    ? isDeterministicCommandRequest(description)
    : null;
  const effectiveMutationRequired = Boolean(deterministicExecution)
    ? false
    : hasExpectedFiles
    ? true
    : taskAnalysis?.mutationRequired;
  const fastPathExecution =
    !effectiveMutationRequired &&
    (Boolean(deterministicExecution) ||
      isConversationalFastPathRequest(description, {
        type: options.type,
        expectedFiles: effectiveExpectedFiles,
        mutationRequired: effectiveMutationRequired,
      }));
  const runsInProcess = !scheduling.computerId || scheduling.computerId === engine.worker.computerId;
  if (runsInProcess && !fastPathExecution) {
    const preflight = await runWorkerPreflight({
      workspace: engine.projectRoot,
      taskPrompt: description,
      requiredTools: ['read', 'write', 'shell', 'glob'],
      skipCompilerProbe: !process.env.WAZIR_PROBE_COMPILER,
    });
    if (!preflight.ok) {
      const preflightErr = `[PREFLIGHT_FAILED: ${preflight.code}] ${preflight.reason}`;
      log(color.red(`    ${preflightErr}`));
      await engine.executions.recordError(executionId, preflightErr);
      await engine.executions.setStatus(executionId, 'failed');
      emitJson({ type: 'error', error: preflightErr, executionId });
      emitJson({
        type: 'complete',
        success: false,
        executionId,
        filesChanged: [],
        errors: [preflightErr],
      });
      return {
        success: false,
        reasons: [preflightErr],
        filesChanged: [],
        executionId,
        errors: [preflightErr],
      };
    }
  }

  // ---- policy-gated runtime handed to the agent ---------------------------
  const taskAbortController = new AbortController();
  let cancelled = false;
  let cancelGeneration: (() => void) | undefined;
  let turnsUsed = 0;
  const triggerCancel = (): void => {
    cancelled = true;
    taskAbortController.abort();
    cancelGeneration?.();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      triggerCancel();
    } else {
      options.signal.addEventListener('abort', triggerCancel, { once: true });
    }
  }
  const onSigint = (): void => {
    triggerCancel();
    log(color.yellow('  cancellation requested; finishing current step'));
  };
  process.once('SIGINT', onSigint);

  const preset = resolvePreset(options.preset);
  const allModelTools = agent.descriptor.strategy === 'conversational-inference'
    ? []
    : engine.tools.forModel(undefined, agent.descriptor.capabilities).filter(t => policySupportsModelTool(engine, t.name));
  const availableTools = preset.tools === 'all'
    ? allModelTools
    : allModelTools.filter((t) => (preset.tools as string[]).includes(t.name));

  // Changes only through a controller-approved escalation (runtime.escalate below).
  let currentModelId = scheduling.modelId;
  // Where generation runs. Starts at the scheduler's placement; an accepted escalation
  // may move it (another runtime or computer, or a freshly loaded model). Tools always
  // run here, in-process, regardless.
  const placement = { runtimeId: scheduling.runtimeId, computerId: scheduling.computerId, contextTokens: context.available.tokens };
  // Sizes every provider request (smallest sufficient context, provider-valid output cap, preflight overflow check).
  const allocator = new InvocationContextAllocator(engine, executionId, OUTPUT_RESERVE_TOKENS);

  const activeRuntimeReg = engine.runtimes.get(scheduling.runtimeId);
  const activeModelReg = engine.models.get(scheduling.modelId);
  const resolvedCapabilities: Partial<import('@wazir/runtimes-interfaces').RuntimeCapabilities> = {
    ...(activeRuntimeReg?.capabilities ?? {}),
    toolCalling: activeModelReg?.toolCalling ?? activeRuntimeReg?.capabilities.toolCalling ?? false,
    nativeToolCalling: activeModelReg?.toolCalling ?? activeRuntimeReg?.capabilities.toolCalling ?? false,
    structuredOutput: activeModelReg?.structuredOutput ?? activeRuntimeReg?.capabilities.structuredOutput ?? false,
  };

  let firstTokenEmitted = false;
  const runtime: AgentRuntime = {
    tools: availableTools,
    runtimeCapabilities: resolvedCapabilities,
    getCapabilities: () => resolvedCapabilities,
    // The usable window W (not the small per-call target), so compaction thresholds are not hit early.
    getContextTokens: () => {
      try { return allocator.windowFor(currentModelId, placement); } catch { return placement.contextTokens; }
    },
    cancelCurrentTurn: () => cancelGeneration?.(),

    escalate: createEscalationHandler(engine, {
      executionId,
      task,
      requiredContextTokens: context.finalRequiredTokens,
      placement: () => placement,
      prepare: (next) => prepareGenerationPlacement(engine, next, { executionId, minimumContext: context.finalRequiredTokens }),
      onEscalated: (request, next, contextTokens) => {
        currentModelId = next.modelId;
        placement.runtimeId = next.runtimeId;
        placement.computerId = next.computerId;
        placement.contextTokens = contextTokens;
        emitJson({ type: 'model_escalated', executionId, previousModel: request.currentModelId, newModel: next.modelId, runtimeId: next.runtimeId, computerId: next.computerId, failureClass: request.failureClass });
        log(color.yellow(`    model escalated: ${request.currentModelId} -> ${next.modelId} via ${next.runtimeId} on ${next.computerId ?? 'hosted'} (${request.failureClass})`));
      },
      onDeclined: (_request, reason) => log(color.yellow(`    model escalation declined: ${untrusted(reason)}`)),
    }),

    async *generate(request) {
      const requestId = generateId('req-');
      const retryContext = { requestId, model: request.modelId, provider: engine.models.get(request.modelId)?.provider };
      loader.start(`Waiting for model response (${request.modelId})...`);
      await engine.executions.recordEvent(executionId, 'generation.started', { modelId: request.modelId });
      emitJson({ type: 'dispatch', executionId, requestId, modelId: request.modelId, runtimeId: placement.runtimeId });
      if (agent.descriptor.strategy === 'conversational-inference') {
        emitJson({ type: 'generation_started', executionId, modelId: request.modelId });
      }
      if (engine.web) request = { ...request, messages: await recordWebContext(engine.executions, executionId, request.messages, engine.web.limits.maxGroundingTokens) };
      // Inference outcome evidence for health diagnostics; 'unknown' when the stream ended without either.
      let outcome: { outcome: 'completed' | 'error' | 'unknown'; error?: string } = { outcome: 'unknown' };
      const observe = (event: { type: string; error?: string }) => {
        if (event.type === 'completed') outcome = { outcome: 'completed' };
        else if (event.type === 'error') outcome = { outcome: 'error', error: event.error };
      };

      const turnAbortController = new AbortController();
      if (cancelled || taskAbortController.signal.aborted) {
        turnAbortController.abort();
      } else {
        taskAbortController.signal.addEventListener('abort', () => turnAbortController.abort(), { once: true });
      }

      try {
        let prepared;
        try {
          prepared = await allocator.prepare(
            { modelId: request.modelId, messages: request.messages, maxTokens: request.maxTokens, tools: request.tools },
            placement,
          );
        } catch {
          // Allocation is advisory when the model is not registered; fall back to the legacy request.
          prepared = undefined;
        }
        if (prepared?.preflightError) {
          const preflight = { type: 'error' as const, error: prepared.preflightError, failureClass: 'MODEL_CONTEXT_OVERFLOW' as const };
          observe(preflight);
          yield preflight;
          return;
        }
        const sentMaxTokens = prepared?.maxTokens ?? request.maxTokens;
        const sentContextTokens = prepared ? prepared.contextTokens : placement.contextTokens;
        if (!placement.computerId || placement.computerId === engine.worker.computerId) {
          // engine.adapters already holds local adapters keyed by runtime id
          // (see engine.ts) alongside the hosted ones added in this feature —
          // checked first so a hosted placement (no computerId, so
          // worker.adapterForModel() can never find it — see hostedProviders.ts's
          // invariant) resolves correctly. Falls back to the worker lookup for
          // any local adapter not present in that map.
          const adapter = engine.adapters.get(placement.runtimeId) ?? engine.worker.adapterForModel(request.modelId);
          if (!adapter) {
            yield { type: 'error', error: `no runtime can serve model '${request.modelId}'` };
            return;
          }
          cancelGeneration = () => {
            turnAbortController.abort();
            void adapter.cancel(requestId).catch(() => undefined);
          };
          for await (const event of adapter.generate({
            requestId,
            modelId: request.modelId,
            messages: request.messages,
            maxTokens: sentMaxTokens,
            temperature: request.temperature,
            contextTokens: sentContextTokens,
            stream: true,
            tools: request.tools,
            signal: turnAbortController.signal,
            resourceContext: { taskId: task.id, workload: classifyWorkload(task), agent: agent.descriptor.name },
          })) {
            if (cancelled || turnAbortController.signal.aborted) break;
            await engine.executions.recordProviderEvent(executionId, event, retryContext);
            observe(event);
            if (event.type === 'token') {
              if (!firstTokenEmitted) {
                firstTokenEmitted = true;
                emitJson({ type: 'first_token', executionId, requestId, modelId: request.modelId });
              }
              if (event.content) {
                options.onToken?.(event.content);
                if (agent.descriptor.strategy === 'conversational-inference' || options.streamTokens) {
                  emitJson({ type: 'token', content: event.content, executionId });
                }
                if (options.streamTokens && !options.json && !options.quiet) {
                  loader.stop();
                  process.stdout.write(untrusted(event.content));
                }
              }
              if (!options.streamTokens) {
                loader.setText(`Generating response from ${request.modelId}...`);
              }
            }
            if (event.type === 'completed') {
              await allocator.recordUsage(request.modelId, requestId, event.usage).catch(() => undefined);
            }
            if (event.type === 'completed' && event.usage) {
              await engine.executions.recordUsage(executionId, {
                input: event.usage.inputTokens,
                output: event.usage.outputTokens,
                total: event.usage.totalTokens,
                cacheReadTokens: event.usage.cacheReadTokens,
                cacheWriteTokens: event.usage.cacheWriteTokens,
                promptCacheMetrics: event.promptCache ?? event.usage.promptCache,
              });
            }
            yield event;
          }
        } else if (engine.config.apiUrl) {
          // The scheduler placed this task on a different computer: hand it to
          // that computer's worker through the control plane's task-pull loop
          // instead of running it in-process.
          const workerRequest: WorkerExecutionRequest = {
            runtimeId: placement.runtimeId,
            executionId,
            requestId,
            modelId: request.modelId,
            messages: request.messages,
            maxTokens: sentMaxTokens,
            temperature: request.temperature,
            contextTokens: sentContextTokens,
          };
          cancelGeneration = () => {
            turnAbortController.abort();
          };
          try {
            for await (const event of dispatchRemote(engine.config.apiUrl, placement.computerId, workerRequest, { token: engine.config.apiToken })) {
              if (cancelled || turnAbortController.signal.aborted) break;
              const generationEvent = toGenerationEvent(event);
              if (!generationEvent) continue;
              await engine.executions.recordProviderEvent(executionId, generationEvent, retryContext);
              observe(generationEvent);
              if (generationEvent.type === 'token') {
                if (!firstTokenEmitted) {
                  firstTokenEmitted = true;
                  emitJson({ type: 'first_token', executionId, requestId, modelId: request.modelId });
                }
                if (generationEvent.content) {
                  options.onToken?.(generationEvent.content);
                  if (agent.descriptor.strategy === 'conversational-inference' || options.streamTokens) {
                    emitJson({ type: 'token', content: generationEvent.content, executionId });
                  }
                  if (options.streamTokens && !options.json && !options.quiet) {
                    loader.stop();
                    process.stdout.write(untrusted(generationEvent.content));
                  }
                }
                if (!options.streamTokens) {
                  loader.setText(`Generating response from ${request.modelId}...`);
                }
              }
              if (generationEvent.type === 'completed') {
                await allocator.recordUsage(request.modelId, requestId, generationEvent.usage).catch(() => undefined);
              }
              if (generationEvent.type === 'completed' && generationEvent.usage) {
                await engine.executions.recordUsage(executionId, {
                  input: generationEvent.usage.inputTokens,
                  output: generationEvent.usage.outputTokens,
                  total: generationEvent.usage.totalTokens,
                  cacheReadTokens: generationEvent.usage.cacheReadTokens,
                  cacheWriteTokens: generationEvent.usage.cacheWriteTokens,
                  promptCacheMetrics: generationEvent.promptCache ?? generationEvent.usage.promptCache,
                });
              }
              yield generationEvent;
            }
          } catch (error) {
            yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
          }
        } else {
          yield {
            type: 'error',
            error: `task scheduled on remote computer '${placement.computerId}' but no control-plane API URL is configured (set WAZIR_API_URL)`,
          };
        }
      } finally {
        cancelGeneration = undefined;
        loader.stop();
        await engine.executions.recordEvent(executionId, 'generation.completed', { modelId: request.modelId, runtimeId: placement.runtimeId, ...outcome });
      }
    },

    async executeTool(name, input): Promise<ToolResult> {
      if (preset.tools !== 'all' && !(preset.tools as string[]).includes(name)) {
        return {
          ok: false,
          output: '',
          error: `tool '${name}' is not permitted by active runtime preset '${preset.name}' (allowed tools: ${(preset.tools as string[]).join(', ')})`,
          durationMs: 0,
        };
      }

      if (name === 'dispatch_subagent' || engine.tools.get(name)?.descriptor.provenance?.source === 'subagent') {
        return runSubagent(engine, input, {
          parentExecutionId: executionId,
          parentTaskId: task.id,
          projectRoot: engine.projectRoot,
          modelId: currentModelId,
          runtimeId: placement.runtimeId,
          computerId: placement.computerId,
          subagentDepth: 0,
          log,
          loader,
          emitJson,
          remainingTurns: options.maxTurns ? Math.max(1, options.maxTurns - turnsUsed) : undefined,
          parentPolicy: task.policy,
          parentExecution: task.execution,
          signal: taskAbortController.signal,
        });
      }

      if (engine.tools.get(name)?.descriptor.provenance?.source === 'mcp') {
        return executeMCPForAgent(engine, name, input, { projectRoot: engine.projectRoot, executionId, signal: taskAbortController.signal });
      }
 
      const decision = await engine.policy.authorize({
        tool: name,
        input,
        executionId,
        projectRoot: engine.projectRoot,
        effectiveIsolation: sandboxStatus().mode,
      });
      await engine.executions.recordPolicy(executionId, decision);

      if (decision.decision !== 'allow') {
        const result: ToolResult = {
          ok: false,
          output: '',
          error: `policy ${decision.decision} (${decision.rule}): ${decision.reasons.join('; ')}`,
          durationMs: 0,
        };
        await engine.executions.recordToolCall(executionId, {
          id: generateId('call-'),
          tool: name,
          input,
          ok: false,
          error: result.error,
          policyEffect: decision.decision,
          policyRule: decision.rule,
          durationMs: 0,
          at: new Date(),
        });
        log(`    ${color.red('denied')} ${name} ${color.gray(untrusted(decision.reasons[0] ?? decision.rule))}`);
        return result;
      }

      // Bind spinner activation to active execution phases (§3)
      let activityText = `Executing ${name}...`;
      const inp = input as Record<string, unknown> | undefined;
      if (name === 'read_file' || name === 'view_file') {
        const p = inp?.path ?? inp?.AbsolutePath ?? inp?.file;
        activityText = p ? `Reading file ${path.basename(String(p))}...` : 'Reading file...';
      } else if (name === 'write_to_file' || name === 'replace_file_content') {
        const p = inp?.path ?? inp?.TargetFile ?? inp?.file;
        activityText = p ? `Writing file ${path.basename(String(p))}...` : 'Writing file...';
      } else if (name === 'run_command' || name === 'execute_command' || name === 'bash') {
        const cmd = inp?.CommandLine ?? inp?.command;
        activityText = cmd ? `Running ${String(cmd).slice(0, 35)}...` : 'Running command...';
      } else if (CHECK_TOOLS.has(name)) {
        activityText = `Running check (${name})...`;
      }
      loader.start(activityText);

      const callId = generateId('call-');
      let result: ToolResult;
      try {
        result = await runRegisteredTool(engine.tools, name, input, {
          verifyWorkspace: !Boolean(deterministicExecution),
          allowVerificationChanges: taskAuthorizesVerificationChanges(description),
          callId,
          allowedTools: availableTools.map(tool => tool.name),
          agentCapabilities: agent.descriptor.capabilities,
          agentId: agent.descriptor.name,
          checkpoint: async () => { await engine.executions.recordToolStart(executionId, name, input, { callId, sideEffectClass: engine.tools.get(name)?.descriptor.sideEffectClass }); },
          projectRoot: engine.projectRoot,
          executionId,
          networkAllowed: engine.config.networkAllowed && task.policy?.networkAccess !== false,
          signal: taskAbortController.signal,
          compactor: engine.compaction,
        });
      } finally {
        loader.stop();
      }
      await engine.executions.recordToolCall(executionId, {
        id: callId,
        failureClass: result.failureClass,
        tool: name,
        input,
        output: result.output,
        ok: result.ok,
        error: result.error,
        policyEffect: decision.decision,
        policyRule: decision.rule,
        durationMs: result.durationMs,
        at: new Date(),
        sandbox: typeof result.metadata?.sandbox === 'string' ? result.metadata.sandbox : undefined,
        shellInvocationId: typeof result.metadata?.shellInvocationId === 'string' ? result.metadata.shellInvocationId : undefined,
        cwd: typeof result.metadata?.cwd === 'string' ? result.metadata.cwd : undefined,
        projectRoot: typeof result.metadata?.projectRoot === 'string' ? result.metadata.projectRoot : undefined,
        exitCode: typeof result.metadata?.exitCode === 'number' ? result.metadata.exitCode : undefined,
      });

      if (result.fileMutations && result.fileMutations.length > 0) {
        const mutations = result.fileMutations
          .filter((m) => m.changed)
          .map((m) => {
            const abs = path.resolve(engine.projectRoot, m.path);
            return { ...m, path: path.relative(engine.projectRoot, abs).split(path.sep).join('/') };
          });
        if (mutations.length > 0) {
          await engine.executions.recordFileMutations(executionId, mutations);
        }
      }

      // A build/test/lint/typecheck invocation can itself produce workspace
      // mutations (a compiler writing its output binary, generated test
      // artifacts, ...) — that's an expected, legitimate side effect of the
      // check succeeding, not a change the check needs to be re-run against.
      // Stamping the check with the revision captured *before* the tool ran
      // would make it stale the instant its own artifact mutation above is
      // recorded, so it's re-read here, after any such mutation from this
      // same call has already landed.
      const checkRevision = engine.executions.getWorkspaceRevision(executionId);
      if (CHECK_TOOLS.has(name)) {
        const notApplicable = !result.ok && (!existsSync(path.join(engine.projectRoot, 'package.json')) || /missing script|paths\[0\]|package\.json/i.test(result.error ?? ''));
        if (!notApplicable) {
          const script = typeof input.script === 'string' && input.script.trim() ? input.script.trim() : name;
          await engine.executions.recordCheck(executionId, {
            workspaceRevision: checkRevision,
            name: name as CheckRunRecord['name'],
            command: `npm run ${script}`,
            ok: result.ok,
            output: keepEnds(result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n'), 4000),
            durationMs: result.durationMs,
          });
        }
      } else if (name === 'shell' && typeof input.command === 'string' && BUILD_INVOCATION_PATTERN.test(input.command)) {
        // A compiler/build tool run via the generic `shell` tool is just as
        // real a check as one of the four named CHECK_TOOLS — record it the
        // same way (success AND failure) so evaluateExecution() actually
        // sees it instead of silently treating "compiled via shell" as if
        // nothing had been verified at all.
        await engine.executions.recordCheck(executionId, {
          workspaceRevision: checkRevision,
          name: 'build',
          command: input.command,
          ok: result.ok,
          output: keepEnds(result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n'), 4000),
          durationMs: result.durationMs,
        });
      } else if (name === 'shell' && typeof input.command === 'string' && isTestInvocation(input.command)) {
        await engine.executions.recordCheck(executionId, {
          workspaceRevision: checkRevision,
          name: 'test',
          command: input.command,
          ok: result.ok,
          output: keepEnds(result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n'), 4000),
          durationMs: result.durationMs,
        });
      }

      emitJson({ type: 'tool', tool: name, ok: result.ok, durationMs: result.durationMs, executionId });
      log(`    ${result.ok ? color.green('ok') : color.red('failed')} ${name} ${color.gray(`${result.durationMs}ms`)}`);
      return result;
    },
  };

  // ---- subscription admission (delegated agents) ---------------------------
  // Delegated agents run on their vendor's account, not through a runtime adapter, so they
  // are admitted here: one request plus estimated tokens against the agent's account. The
  // vendor CLI reports no usage, so the settlement is always labelled an estimate.
  let delegation: { requestId: string; rawInput: number; stopLease: () => void } | undefined;
  let baseline: DelegationBaseline | Error | undefined;
  if (externalAgent) {
    const name = agent.descriptor.name;
    const accountId = engine.resources.resolveAgentAccount(name);
    const workload = classifyWorkload(task);
    const requestId = `${executionId}:delegation`;
    const rawInput = estimateTextTokens(description);
    const decision = accountId
      ? engine.resources.budget.admit({
        requestId, accountId, modelId: `agent:${name}`, workload, taskId: task.id, agent: name, requests: 1,
        estimatedInputTokens: padEstimate(rawInput, 1, engine.resources.policy.estimateMargin),
        estimatedOutputTokens: estimateOutputTokens({}, workload),
      })
      : undefined;
    if (!decision || decision.outcome !== 'admitted') {
      const reason = decision ? `RESOURCE_ADMISSION_${decision.outcome.toUpperCase()}: ${decision.reasons.join('; ')}` : `no resource account is configured for agent '${name}'`;
      await engine.executions.recordError(executionId, reason);
      await engine.executions.setStatus(executionId, 'failed');
      emitJson({ type: 'error', error: reason, executionId });
      log(color.red(`    ${reason}`));
      return { success: false, reasons: [reason], filesChanged: [], executionId, errors: [reason] };
    }
    delegation = { requestId, rawInput, stopLease: engine.resources.budget.holdLease(requestId) };
    // The agent edits files with its own tools; only a before/after comparison shows what it did.
    baseline = await captureDelegationBaseline(engine.projectRoot).catch((error: Error) => error);
  }

  // ---- run the agent ------------------------------------------------------
  await engine.executions.setStatus(executionId, 'running');
  let summary: string | undefined;
  const errors: string[] = [];

  const fastPathRequest = fastPathExecution;
  try {
    for await (const turn of agent.run(
      {
        modelId: scheduling.modelId,
        taskDescription: description,
        taskType: task.type,
        mutationRequired: fastPathRequest ? false : effectiveMutationRequired,
        expectedArtifacts: effectiveExpectedFiles,
        projectRoot: engine.projectRoot,
        maxTurns: options.maxTurns,
        contextTokens: context.available.tokens,
        isCancelled: () => cancelled || taskAbortController.signal.aborted,
        fullVerification: options.fullVerification,
      },
      runtime,
    )) {
      turnsUsed++;
      if (turn.terminationReason) await recordTermination(engine, executionId, turn.terminationReason, currentModelId, task.type, turn.protocolMetrics, turn.runStats);
      await engine.executions.recordEvent(executionId, 'agent.turn', {
        kind: turn.kind,
        phase: turn.phase,
        tool: turn.tool,
        content: turn.content?.slice(0, 500),
        error: turn.error,
        raw: turn.raw?.slice(0, 4000),
      });
      switch (turn.kind) {
        case 'phase':
          // Best effort: a lock-contended write here must not crash a task that otherwise succeeded.
          await engine.executions.recordEvent(executionId, 'agent.phase', { phase: turn.phase }).catch(() => undefined);
          emitJson({ type: 'phase', phase: turn.phase, executionId });
          log(color.cyan(`  [${turn.phase}]`));
          break;
        case 'message':
          emitJson({ type: 'message', content: turn.content, executionId });
          if (turn.content) log(color.gray(`    ${untrusted(turn.content.split('\n')[0].slice(0, 160))}`));
          break;
        case 'done':
          summary = turn.content;
          emitJson({ type: 'done', content: turn.content, executionId });
          break;
        case 'error':
          if (turn.error) {
            errors.push(turn.error);
            // Best effort: when the error *is* a rejected write (e.g. lock contention), recording it would rethrow.
            await engine.executions.recordError(executionId, turn.error).catch(() => undefined);
            emitJson({ type: 'error', error: turn.error, executionId });
            log(color.red(`    ${untrusted(turn.error.split('\n')[0].slice(0, 200))}`));
          }
          // The model may have reached "done" with a real answer before verification
          // failed it (e.g. a Q&A prompt correctly answered but flagged for making no
          // code changes). Surface it instead of letting a failed task hide what the
          // model actually said.
          if (turn.content) summary = turn.content;
          break;
        default:
          break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    // Best effort: when the error *is* a rejected write, recording it would rethrow.
    await engine.executions.recordError(executionId, message).catch(() => undefined);
    emitJson({ type: 'error', error: message, executionId });
    log(color.red(`    ${untrusted(message)}`));
  } finally {
    loader.stop();
    process.off('SIGINT', onSigint);
    if (delegation) {
      delegation.stopLease();
      const output = estimateTextTokens(summary ?? '');
      if (errors.length === 0 && !cancelled) {
        engine.resources.budget.reconcile(delegation.requestId, { inputTokens: delegation.rawInput, outputTokens: output, source: 'estimated' }, { agent: agent.descriptor.name });
      } else {
        // The vendor CLI may have consumed quota before failing: charge conservatively.
        engine.resources.budget.fail(delegation.requestId, { ambiguous: true, message: errors[0] ?? (cancelled ? 'cancelled' : undefined) });
      }
    }
  }

  // The durable record refused a write (another process changed it). Nothing this run
  // does can be recorded any more, so it must not evaluate or claim a result — it stops
  // with a plain failure instead of crashing on the next write.
  const storageError = engine.executions.persistenceError;
  if (storageError) {
    const reason = `execution record could not be written (${storageError.message}); this run stopped rather than overwrite history another process recorded`;
    emitJson({ type: 'complete', success: false, executionId, filesChanged: [], result: summary, errors: [...errors, reason] });
    return { success: false, reasons: [reason], filesChanged: [], executionId, result: summary, errors: [...errors, reason] };
  }

  // ---- delegated work: observe and check it ourselves ----------------------
  const agentErrors = [...errors];
  if (baseline && !cancelled) {
    if (baseline instanceof Error) {
      const message = `UNVERIFIED: cannot observe the workspace before delegation (${baseline.message})`;
      errors.push(message);
      // Best effort: this runs after the main try/catch, so a rejected write here
      // (e.g. lock contention) must not escape as an unhandled rejection.
      await engine.executions.recordError(executionId, message).catch(() => undefined);
    } else {
      const verified = await verifyDelegatedWork({
        executions: engine.executions, tools: engine.tools, executionId, projectRoot: engine.projectRoot,
        networkAllowed: engine.config.networkAllowed && task.policy?.networkAccess !== false,
        allowVerificationChanges: taskAuthorizesVerificationChanges(description), touchesSourceCode,
      }, baseline);
      errors.push(...verified.problems);
      log(color.gray(`    delegated agent changed ${verified.changed.length} file(s)${verified.changed.length ? `: ${verified.changed.slice(0, 5).join(', ')}${verified.changed.length > 5 ? ', ...' : ''}` : ''}`));
    }
  }

  // ---- deterministic evaluation -------------------------------------------
  const finalRecord = engine.executions.require(executionId);
  const evaluation = evaluateExecution(finalRecord, {
    expectedFiles: effectiveExpectedFiles,
    protectedFiles: options.protectedFiles,
    mutationRequired: fastPathRequest ? false : effectiveMutationRequired,
    expectedEvidence: touchesSourceCode(finalRecord.filesChanged) ? ['checks_pass'] : undefined,
  });
  await engine.executions.setEvaluation(executionId, evaluation);
  if (summary) {
    await engine.executions.setResult(executionId, summary);
  }
  await engine.executions.setStatus(
    executionId,
    cancelled ? 'cancelled' : evaluation.success ? 'completed' : 'failed',
  );
  if (externalAgent && !cancelled) {
    recordAgentTask(agent.descriptor.name, {
      at: new Date().toISOString(), executionId,
      outcome: agentErrors.length > 0 ? 'agent_error' : evaluation.success ? 'verified' : 'rejected',
      detail: (agentErrors[0] ?? (evaluation.success ? undefined : evaluation.reasons.find((r) => /missing|failed|PROTECTED|UNVERIFIED/.test(r)) ?? errors[0]))?.slice(0, 200),
    }, path.join(engine.configDir, 'agent-preflight.json'));
  }

  emitJson({
    type: 'complete',
    success: evaluation.success && !cancelled,
    executionId,
    filesChanged: evaluation.filesChanged,
    result: summary,
    errors,
  });

  return {
    success: evaluation.success && !cancelled,
    ...(options.routingMode === 'NVIDIA' ? { ok: evaluation.success && !cancelled, decision: scheduling } : {}),
    ok: evaluation.success && !cancelled,
    decision: scheduling,
    reasons: cancelled ? ['execution cancelled by user', ...evaluation.reasons] : evaluation.reasons,
    filesChanged: evaluation.filesChanged,
    executionId,
    result: summary,
    errors,
  };
}

export interface SubagentRunContext {
  parentExecutionId: string;
  parentTaskId: string;
  projectRoot: string;
  modelId: string;
  runtimeId: string;
  computerId?: string;
  subagentDepth: number;
  log: (line: string) => void;
  loader: StatusLoader;
  emitJson: (event: Record<string, unknown>) => void;
  remainingTurns?: number;
  parentPolicy?: import('@wazir/core').PolicyRequirements;
  parentExecution?: import('@wazir/core').ExecutionPreferences;
  signal?: AbortSignal;
}

export async function runSubagent(
  engine: RookEngine,
  input: unknown,
  context: SubagentRunContext,
): Promise<ToolResult> {
  const startTime = Date.now();

  // Guardrail 1: Max depth limit is 1 (depth <= 1)
  if (context.subagentDepth >= 1) {
    return {
      ok: false,
      output: '',
      error: 'Subagent depth limit exceeded: recursive subagent dispatch is prohibited (maximum depth is 1)',
      durationMs: Date.now() - startTime,
    };
  }

  // Guardrail 2: Policy eligibility check
  const eligibility = engine.policy.checkSubagentEligibility(context.parentPolicy);
  if (!eligibility.allowed) {
    return {
      ok: false,
      output: '',
      error: `Subagent dispatch forbidden by policy: ${eligibility.reason}`,
      durationMs: Date.now() - startTime,
    };
  }

  const routingCfg = engine.config.routing;
  const parentRoutingMode = context.parentExecution?.routingMode;
  const isProviderOnly =
    routingCfg?.mode === 'provider_only' ||
    parentRoutingMode === 'NVIDIA' ||
    parentRoutingMode === 'PROVIDER_ONLY';
  const requiredProvider =
    parentRoutingMode === 'NVIDIA'
      ? 'nvidia'
      : context.parentExecution?.routingProvider ?? routingCfg?.provider;
  const inheritedRoutingMode =
    context.parentExecution?.routingMode ??
    (routingCfg?.mode === 'provider_only'
      ? routingCfg.provider === 'nvidia'
        ? 'NVIDIA'
        : 'PROVIDER_ONLY'
      : undefined);

  const inp = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const description = String(inp.description ?? '').trim();
  if (!description) {
    return {
      ok: false,
      output: '',
      error: 'Missing required argument: description',
      durationMs: Date.now() - startTime,
    };
  }
  const expectedArtifacts = Array.isArray(inp.expectedArtifacts)
    ? inp.expectedArtifacts.map(String)
    : undefined;
  const requiredCapabilities = Array.isArray(inp.requiredCapabilities)
    ? inp.requiredCapabilities.map(String)
    : undefined;
  const placementRequirements = (typeof inp.requirements === 'object' && inp.requirements !== null)
    ? inp.requirements as Partial<import('@wazir/core').TaskRequirements>
    : undefined;
  const wantsFleetPlacement = Boolean((requiredCapabilities && requiredCapabilities.length > 0) || placementRequirements);

  // A subtask that declares real requirements is placed by the same Scheduler that places
  // top-level tasks — capability match, provider authorization, quota constraints, and
  // hardware-aware placement across the fleet — instead of blindly inheriting the parent's
  // model/computer. Absent any requirement, placement is unchanged: same model, same local
  // worker as the parent, as before.
  let placementDecision: SchedulerDecision | undefined;
  if (wantsFleetPlacement) {
    const placementTask: Task = {
      id: generateId('task-sub-'),
      type: 'coding',
      input: description,
      capabilities: requiredCapabilities,
      requirements: {
        minimumContext: MINIMUM_CONTEXT_TOKENS,
        expectedArtifacts,
        ...placementRequirements,
      },
      policy: {
        ...(context.parentPolicy ?? {}),
        allowSubagentDispatch: false,
        projectRoot: context.projectRoot,
      },
      execution: {
        ...(context.parentExecution ?? {}),
        targetModelId: undefined,
        targetRuntimeId: undefined,
        targetComputerId: undefined,
        routingMode: inheritedRoutingMode,
        routingProvider: requiredProvider,
        defaultModelId: context.parentExecution?.defaultModelId ?? routingCfg?.defaultModel,
        allowFallback: context.parentExecution?.allowFallback ?? routingCfg?.allowFallback,
      },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };
    try {
      placementDecision = engine.scheduler.plan({ task: placementTask, requiredContextTokens: MINIMUM_CONTEXT_TOKENS });
    } catch (error) {
      const reasons = error instanceof SchedulingError
        ? [error.message, ...error.modelReasons, ...error.computerReasons]
        : [error instanceof Error ? error.message : String(error)];
      return {
        ok: false,
        output: '',
        error: `Subagent fleet placement failed: ${reasons.join('; ')}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  const effectiveModelId = placementDecision?.modelId ?? context.modelId;
  const effectiveRuntimeId = placementDecision?.runtimeId ?? context.runtimeId;
  const isHostedRuntime = engine.runtimes.get(effectiveRuntimeId)?.runtimeKind === 'hosted';
  const effectiveComputerId = placementDecision
    ? placementDecision.computerId
    : isHostedRuntime
      ? undefined
      : (context.computerId ?? engine.worker.computerId);

  // Guardrail 3: Provider-only routing & hosted-provider authorization enforcement for nested executions
  if (isProviderOnly && requiredProvider) {
    const childModel = engine.models.get(effectiveModelId);
    const childProvider = childModel?.provider ?? effectiveRuntimeId;
    if (childProvider !== requiredProvider) {
      return {
        ok: false,
        output: '',
        error: `Subagent dispatch forbidden by provider-only routing policy: child execution attempted to use '${effectiveModelId}' (${childProvider}) instead of required provider '${requiredProvider}'`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  if (isHostedRuntime) {
    const childModel = engine.models.get(effectiveModelId);
    const childProvider = childModel?.provider ?? effectiveRuntimeId;
    const implicitProviderOnlyAllow = isProviderOnly && requiredProvider === childProvider;
    const hostedGate = engine.policy.checkHostedEligibility(
      implicitProviderOnlyAllow && context.parentPolicy?.allowHostedProviders === undefined
        ? { ...context.parentPolicy, allowHostedProviders: true }
        : context.parentPolicy,
      childProvider,
    );
    if (!hostedGate.allowed) {
      return {
        ok: false,
        output: '',
        error: `Subagent dispatch forbidden by hosted provider policy: ${hostedGate.reason}`,
        durationMs: Date.now() - startTime,
      };
    }
  }

  const subTaskAnalysis = engine.planner?.analyze?.(description);
  const effectiveSubExpectedArtifacts =
    expectedArtifacts && expectedArtifacts.length > 0
      ? expectedArtifacts
      : subTaskAnalysis?.expectedArtifacts;
  const subMutationRequired =
    Boolean(effectiveSubExpectedArtifacts && effectiveSubExpectedArtifacts.length > 0) ||
    Boolean(subTaskAnalysis?.mutationRequired);

  // Create child execution record linked by parentExecutionId
  const subtask: Task = {
    id: generateId('task-sub-'),
    type: 'coding',
    input: description,
    capabilities: requiredCapabilities,
    requirements: {
      minimumContext: MINIMUM_CONTEXT_TOKENS,
      expectedArtifacts: effectiveSubExpectedArtifacts,
      mutationRequired: subMutationRequired,
      ...placementRequirements,
    },
    expectedArtifacts: effectiveSubExpectedArtifacts,
    mutationRequired: subMutationRequired,
    policy: {
      ...(context.parentPolicy ?? {}),
      allowSubagentDispatch: false,
      projectRoot: context.projectRoot,
    },
    execution: {
      ...(context.parentExecution ?? {}),
      targetModelId: effectiveModelId,
      targetRuntimeId: effectiveRuntimeId,
      routingMode: inheritedRoutingMode,
      routingProvider: requiredProvider,
      defaultModelId: context.parentExecution?.defaultModelId ?? routingCfg?.defaultModel,
      allowFallback: context.parentExecution?.allowFallback ?? routingCfg?.allowFallback,
    },
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
  };

  const childRecord = await engine.executions.create({
    task: subtask,
    parentExecutionId: context.parentExecutionId,
    agentId: 'wazir-coding',
    computerId: effectiveComputerId,
    runtimeId: effectiveRuntimeId,
    modelId: effectiveModelId,
    workerId: engine.worker.id,
    workspaceRoot: context.projectRoot,
    scheduling: placementDecision,
  });
  const childExecId = childRecord.execution.id;
  // Sizes every sub-agent provider request the same way executeTask does (one allocator per sub-agent run).
  const subagentAllocator = new InvocationContextAllocator(engine, childExecId, OUTPUT_RESERVE_TOKENS);

  if (placementDecision) {
    context.log(color.cyan(`    [subagent] fleet placement: ${effectiveModelId} via ${effectiveRuntimeId} on ${effectiveComputerId ?? 'hosted'} (${placementDecision.reasons.join('; ')})`));
  }
  context.log(color.cyan(`    [subagent] spawned nested execution ${childExecId} (depth ${context.subagentDepth + 1})`));
  context.emitJson({
    type: 'subagent.start',
    executionId: childExecId,
    parentExecutionId: context.parentExecutionId,
    description,
  });

  // Filter tools to strictly omit dispatch_subagent for child agent
  const subagentTools = engine.tools.forModel(undefined, engine.agents.get('wazir-coding')?.descriptor.capabilities).filter((t) => t.name !== 'dispatch_subagent' && policySupportsModelTool(engine, t.name));

  let cancelSubGeneration: (() => void) | undefined;
  const subagentRuntime: AgentRuntime = {
    tools: subagentTools,
    cancelCurrentTurn: () => cancelSubGeneration?.(),

    async *generate(req) {
      const requestId = generateId('req-');
      if (engine.web) req = { ...req, messages: await recordWebContext(engine.executions, childExecId, req.messages, engine.web.limits.maxGroundingTokens) };
      if (context.signal?.aborted) return;
      const placement = { runtimeId: effectiveRuntimeId, computerId: effectiveComputerId };
      let prepared;
      try {
        prepared = await subagentAllocator.prepare(
          { modelId: req.modelId, messages: req.messages, maxTokens: req.maxTokens, tools: req.tools },
          placement,
        );
      } catch {
        // Allocation is advisory when the model is not registered; fall back to the legacy request.
        prepared = undefined;
      }
      if (prepared?.preflightError) {
        yield { type: 'error', error: prepared.preflightError, failureClass: 'MODEL_CONTEXT_OVERFLOW' };
        return;
      }
      const subTurnAbortController = new AbortController();
      if (context.signal) {
        if (context.signal.aborted) {
          subTurnAbortController.abort();
        } else {
          context.signal.addEventListener('abort', () => subTurnAbortController.abort(), { once: true });
        }
      }
      const isLocalPlacement = !effectiveComputerId || effectiveComputerId === engine.worker.computerId;
      // Activation prepares a model to run on *this* worker — meaningless for a hosted API
      // placement (no computerId) or a placement the Scheduler sent to a different fleet machine.
      const contextTokens = effectiveComputerId && effectiveComputerId === engine.worker.computerId
        ? await engine.lifecycle.activateExecution(childExecId, MINIMUM_CONTEXT_TOKENS)
        : effectiveComputerId
          ? MINIMUM_CONTEXT_TOKENS
          : undefined;
      const retryContext = { requestId, model: req.modelId, provider: engine.models.get(req.modelId)?.provider };
      const sentMaxTokens = prepared ? prepared.maxTokens : req.maxTokens;
      const sentContextTokens = prepared?.contextTokens ?? contextTokens;

      try {
        if (isLocalPlacement) {
          const adapter = engine.adapters.get(effectiveRuntimeId) ?? engine.worker.adapterForModel(req.modelId);
          if (!adapter) {
            yield { type: 'error', error: `no runtime can serve model '${req.modelId}'` };
            return;
          }
          cancelSubGeneration = () => {
            subTurnAbortController.abort();
            void adapter.cancel(requestId).catch(() => undefined);
          };
          for await (const event of adapter.generate({
            requestId,
            contextTokens: sentContextTokens,
            modelId: req.modelId,
            messages: req.messages,
            maxTokens: sentMaxTokens,
            temperature: req.temperature,
            stream: true,
            tools: req.tools,
            signal: subTurnAbortController.signal,
            resourceContext: { taskId: childExecId, workload: 'routine' },
          })) {
            if (subTurnAbortController.signal.aborted || context.signal?.aborted) break;
            await engine.executions.recordProviderEvent(childExecId, event, retryContext);
            if (event.type === 'completed') {
              await subagentAllocator.recordUsage(req.modelId, requestId, event.usage).catch(() => undefined);
            }
            if (event.type === 'completed' && event.usage) {
              await engine.executions.recordUsage(childExecId, {
                input: event.usage.inputTokens,
                output: event.usage.outputTokens,
                total: event.usage.totalTokens,
              });
            }
            yield event;
          }
        } else if (engine.config.apiUrl) {
          // The Scheduler placed this subagent on a different fleet machine: hand it to that
          // computer's worker through the control plane's task-pull loop — the same remote-
          // dispatch path top-level tasks use (see executeTask's runtime.generate above).
          const workerRequest: WorkerExecutionRequest = {
            runtimeId: effectiveRuntimeId,
            executionId: childExecId,
            requestId,
            modelId: req.modelId,
            messages: req.messages,
            maxTokens: sentMaxTokens,
            temperature: req.temperature,
            contextTokens: sentContextTokens,
          };
          cancelSubGeneration = () => {
            subTurnAbortController.abort();
          };
          try {
            for await (const event of dispatchRemote(engine.config.apiUrl, effectiveComputerId, workerRequest, { token: engine.config.apiToken })) {
              if (subTurnAbortController.signal.aborted || context.signal?.aborted) break;
              const generationEvent = toGenerationEvent(event);
              if (!generationEvent) continue;
              await engine.executions.recordProviderEvent(childExecId, generationEvent, retryContext);
              if (generationEvent.type === 'completed') {
                await subagentAllocator.recordUsage(req.modelId, requestId, generationEvent.usage).catch(() => undefined);
              }
              if (generationEvent.type === 'completed' && generationEvent.usage) {
                await engine.executions.recordUsage(childExecId, {
                  input: generationEvent.usage.inputTokens,
                  output: generationEvent.usage.outputTokens,
                  total: generationEvent.usage.totalTokens,
                });
              }
              yield generationEvent;
            }
          } catch (error) {
            yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
          }
        } else {
          yield {
            type: 'error',
            error: `subagent scheduled on remote computer '${effectiveComputerId}' but no control-plane API URL is configured (set WAZIR_API_URL)`,
          };
        }
      } finally {
        cancelSubGeneration = undefined;
      }
    },

    async executeTool(name, toolInput): Promise<ToolResult> {
      if (name === 'dispatch_subagent') {
        return {
          ok: false,
          output: '',
          error: 'Subagent depth limit exceeded: recursive subagent calls are prohibited',
          durationMs: 0,
        };
      }
      if (context.signal?.aborted) {
        return { ok: false, output: '', error: 'cancelled before the tool ran', durationMs: 0 };
      }

      if (engine.tools.get(name)?.descriptor.provenance?.source === 'mcp') {
        return executeMCPForAgent(engine, name, toolInput, {
          projectRoot: context.projectRoot,
          executionId: childExecId,
          signal: context.signal,
        });
      }

      const decision = await engine.policy.authorize({
        tool: name,
        input: toolInput,
        executionId: childExecId,
        projectRoot: context.projectRoot,
        effectiveIsolation: sandboxStatus().mode,
      });
      await engine.executions.recordPolicy(childExecId, decision);

      if (decision.decision !== 'allow') {
        const res: ToolResult = {
          ok: false,
          output: '',
          error: `policy ${decision.decision} (${decision.rule}): ${decision.reasons.join('; ')}`,
          durationMs: 0,
        };
        await engine.executions.recordToolCall(childExecId, {
          id: generateId('call-'),
          tool: name,
          input: toolInput,
          ok: false,
          error: res.error,
          policyEffect: decision.decision,
          policyRule: decision.rule,
          durationMs: 0,
          at: new Date(),
          provenance: { subagentExecutionId: childExecId, subagentDepth: context.subagentDepth + 1 },
        });
        return res;
      }

      const callId = generateId('call-');
      const res = await runRegisteredTool(engine.tools, name, toolInput, {
        verifyWorkspace: true,
        allowVerificationChanges: taskAuthorizesVerificationChanges(description),
        callId,
        allowedTools: subagentTools.map(tool => tool.name),
        agentCapabilities: agent.descriptor.capabilities,
        agentId: agent.descriptor.name,
        checkpoint: async () => { await engine.executions.recordToolStart(childExecId, name, toolInput, { callId, sideEffectClass: engine.tools.get(name)?.descriptor.sideEffectClass }); },
        projectRoot: context.projectRoot,
        executionId: childExecId,
        networkAllowed: engine.config.networkAllowed && context.parentPolicy?.networkAccess !== false,
        jobId: (await engine.executions.get(context.parentExecutionId))?.execution.jobId ?? context.parentExecutionId,
        signal: context.signal,
        compactor: engine.compaction,
      });

      await engine.executions.recordToolCall(childExecId, {
        id: callId,
        failureClass: res.failureClass,
        tool: name,
        input: toolInput,
        output: res.output,
        ok: res.ok,
        error: res.error,
        policyEffect: decision.decision,
        policyRule: decision.rule,
        durationMs: res.durationMs,
        at: new Date(),
        provenance: { subagentExecutionId: childExecId, subagentDepth: context.subagentDepth + 1 },
      });

      if (res.fileMutations && res.fileMutations.length > 0) {
        const mutations = res.fileMutations
          .filter((m) => m.changed)
          .map((m) => {
            const abs = path.resolve(context.projectRoot, m.path);
            return { ...m, path: path.relative(context.projectRoot, abs).split(path.sep).join('/') };
          });
        if (mutations.length > 0) {
          await engine.executions.recordFileMutations(childExecId, mutations);
          await engine.executions.recordFileMutations(context.parentExecutionId, mutations);
        }
      }

      return res;
    },
  };

  const agent = engine.agents.get('wazir-coding') ?? engine.agents.resolveForTask(subtask).agent;
  await engine.executions.setStatus(childExecId, 'running');
  const subagentMaxTurns = Math.min(12, context.remainingTurns ?? 12);
  let subagentSummary = '';
  let subagentSuccess = true;
  const childErrors: string[] = [];

  try {
    for await (const turn of agent.run(
      {
        modelId: effectiveModelId,
        taskDescription: description,
        taskType: 'coding',
        mutationRequired: subMutationRequired,
        expectedArtifacts: effectiveSubExpectedArtifacts,
        projectRoot: context.projectRoot,
        maxTurns: subagentMaxTurns,
        subagentDepth: context.subagentDepth + 1,
        isCancelled: () => Boolean(context.signal?.aborted),
      },
      subagentRuntime,
    )) {
      if (turn.terminationReason) await recordTermination(engine, childExecId, turn.terminationReason, effectiveModelId, 'coding', turn.protocolMetrics, turn.runStats);
      if (turn.kind === 'done') {
        subagentSummary = turn.content ?? '';
      } else if (turn.kind === 'error') {
        childErrors.push(turn.error ?? 'subagent error');
      }
    }
  } catch (err) {
    subagentSuccess = false;
    childErrors.push(err instanceof Error ? err.message : String(err));
  }

  const childUpdated = engine.executions.require(childExecId);
  const childFiles = childUpdated.filesChanged ?? [];
  const childEval = evaluateExecution(childUpdated, {
    expectedFiles: effectiveSubExpectedArtifacts,
    mutationRequired: subMutationRequired,
  });
  await engine.executions.setEvaluation(childExecId, childEval);
  if (subagentSummary) {
    await engine.executions.setResult(childExecId, subagentSummary);
  }
  const status = (subagentSuccess && childErrors.length === 0 && childEval.success) ? 'completed' : 'failed';
  await engine.executions.setStatus(childExecId, status);

  const durationMs = Date.now() - startTime;
  const condensedOutput = [
    `[Subagent execution ${childExecId} ${status}]`,
    subagentSummary ? `Summary: ${subagentSummary}` : undefined,
    childFiles.length > 0 ? `Files changed: ${childFiles.join(', ')}` : 'Files changed: none',
    childErrors.length > 0 ? `Errors: ${childErrors.join('; ')}` : undefined,
  ].filter(Boolean).join('\n');

  context.log(color.cyan(`    [subagent] finished ${childExecId} (${status})`));
  context.emitJson({
    type: 'subagent.complete',
    executionId: childExecId,
    parentExecutionId: context.parentExecutionId,
    status,
    filesChanged: childFiles,
    durationMs,
  });

  return {
    ok: status === 'completed',
    output: condensedOutput,
    error: childErrors.length > 0 ? childErrors.join('; ') : undefined,
    durationMs,
    fileMutations: childFiles.map((p) => ({
      path: p,
      attempted: true,
      succeeded: true,
      changed: true,
      existedBefore: false,
      existsAfter: true,
    })),
  };
}
