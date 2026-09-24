import { executeMCPForAgent } from './mcp.js';
import path from 'node:path';
import { effectiveContextTokens, SchedulingError, taskAuthorizesVerificationChanges } from '@wazir/core';
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
import { buildSystemPrompt, resolvePreset } from '@wazir/agents';
import { evaluateExecution } from '@wazir/evaluation';
import { generateId, stripTerminalEscapes } from '@wazir/shared';
import { executeTool as runRegisteredTool } from '@wazir/tools';
import { dispatchRemote, runWorkerPreflight } from '@wazir/workers';
import { color } from './colors.js';
import type { RookEngine } from './engine.js';
import { StatusLoader } from './spinner.js';
import { recordTermination } from './termination.js';
import { createEscalationHandler, prepareGenerationPlacement } from './escalation.js';

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
  /** Per-invocation opt-in for routing to a hosted provider (Anthropic/OpenAI/Google).
   *  Overrides the engine-wide `providers.allowHostedProviders` default for this task only —
   *  never overrides `localOnly`/sensitive-data policy, which always wins (see
   *  PolicyEngine.checkHostedEligibility()). */
  allowHosted?: boolean;
  /** Runtime preset name (e.g. 'standard', 'minimal'). */
  preset?: string;
}

export interface TaskOutcome {
  success: boolean;
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
  /(^|&&|\|\||;)\s*(g\+\+|gcc|cc|c\+\+|clang\+\+|clang|rustc|javac|tsc|make|cmake|cargo\s+build|go\s+build|mvn\s+compile|gradle\s+build|dotnet\s+build|swiftc)(?=\s|$)/;
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
  options: Pick<ExecuteTaskOptions, 'type' | 'model' | 'agent' | 'allowHosted' | 'preset'> = {},
): Promise<PlanResult> {
  const preset = resolvePreset(options.preset);
  const task: Task = {
    id: generateId('task-'),
    type: options.type ?? 'coding',
    input: description,
    requirements: { minimumContext: MINIMUM_CONTEXT_TOKENS, runtimePreset: preset.name },
    policy: {
      networkAccess: engine.config.networkAllowed,
      projectRoot: engine.projectRoot,
      allowHostedProviders: options.allowHosted,
    },
    execution: { targetModelId: options.model, targetAgentId: options.agent, runtimePreset: preset.name },
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
  };

  const taskPolicy = engine.policy.evaluateTask(task);
  if (!taskPolicy.allowed) {
    return { ok: false, reasons: taskPolicy.reasons };
  }

  const allModelTools = engine.tools.forModel();
  const allowedTools = preset.tools === 'all'
    ? allModelTools
    : allModelTools.filter((t) => (preset.tools as string[]).includes(t.name));

  const baseParts: ContextPart[] = [
    { kind: 'system', label: 'system prompt', content: buildSystemPrompt(engine.projectRoot, allowedTools), priority: 'critical' },
    { kind: 'task', label: 'task', content: description, priority: 'critical' },
  ];

  const activeContextParts = await buildContextPartsFromActive(engine);
  const parts = [...baseParts, ...activeContextParts];
  const budget = engine.compiler.budget(parts, OUTPUT_RESERVE_TOKENS);

  let scheduling: SchedulerDecision;
  try {
    scheduling = engine.scheduler.plan({ task, requiredContextTokens: budget.requiredTokens });
  } catch (error) {
    const reasons = [error instanceof Error ? error.message : String(error)];
    if (error instanceof SchedulingError) {
      reasons.push(...error.modelReasons, ...error.computerReasons);
    }
    return { ok: false, reasons };
  }

  const model = engine.models.getRequired(scheduling.modelId);
  const context = engine.compiler.compile(
    parts,
    {
      tokens: effectiveContextTokens(model),
      source: model.configuredContext !== undefined ? 'configured' : 'discovered',
    },
    OUTPUT_RESERVE_TOKENS,
  );
  if (!context.fits) {
    return { ok: false, reasons: context.reasons };
  }

  const agent = scheduling.agentId ? engine.agents.get(scheduling.agentId) : undefined;
  if (!agent) {
    return { ok: false, reasons: [`scheduler selected agent '${scheduling.agentId ?? '(none)'}' but it is not registered`] };
  }

  return { ok: true, plan: { task, scheduling, context, agent } };
}

export async function executeTask(
  engine: RookEngine,
  description: string,
  options: ExecuteTaskOptions = {},
): Promise<TaskOutcome> {
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
    return { success: false, reasons: planned.reasons, filesChanged: [], executionId: '—', errors: [] };
  }
  const { task, scheduling, context, agent } = planned.plan;

  const record = await engine.executions.create({
    task,
    agentId: agent.descriptor.name,
    computerId: scheduling.computerId,
    runtimeId: scheduling.runtimeId,
    modelId: scheduling.modelId,
    workerId: engine.worker.id,
    workspaceRoot: engine.projectRoot,
    scheduling,
    context,
  });
  const executionId = record.execution.id;
  if (scheduling.computerId) {
    try {
      const effective = await engine.lifecycle.activateExecution(executionId, Math.max(context.finalRequiredTokens, task.requirements.minimumContext ?? 0));
      context.available.tokens = effective;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { success: false, reasons: [error], filesChanged: [], executionId, errors: [error] };
    }
  }
  emitJson({ type: 'start', executionId, taskId: task.id, modelId: scheduling.modelId, agent: agent.descriptor.name });

  log('');
  log(color.bold(`  Execution ${executionId}`));
  log(color.gray(`    agent:    ${agent.descriptor.name}`));
  log(color.gray(`    model:    ${scheduling.modelId} via ${scheduling.runtimeId} on ${scheduling.computerId ?? `hosted (${scheduling.runtimeId})`}`));
  log(color.gray(`    context:  ${context.finalRequiredTokens} / ${context.available.tokens} tokens`));
  for (const reason of scheduling.reasons) {
    log(color.gray(`    - ${reason}`));
  }

  // Preflight Infrastructure Verification. Runs whenever execution happens
  // in-process on this machine — which includes a hosted-provider placement
  // (no computerId at all, but the *tool* execution environment is still
  // this local workspace regardless of which LLM answers), not only when
  // computerId happens to equal this worker's own id.
  const runsInProcess = !scheduling.computerId || scheduling.computerId === engine.worker.computerId;
  if (runsInProcess) {
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
  let cancelled = false;
  let turnsUsed = 0;
  const onSigint = (): void => {
    cancelled = true;
    log(color.yellow('  cancellation requested; finishing current step'));
  };
  process.once('SIGINT', onSigint);

  const preset = resolvePreset(options.preset);
  const allModelTools = engine.tools.forModel();
  const availableTools = preset.tools === 'all'
    ? allModelTools
    : allModelTools.filter((t) => (preset.tools as string[]).includes(t.name));

  // Changes only through a controller-approved escalation (runtime.escalate below).
  let currentModelId = scheduling.modelId;
  // Where generation runs. Starts at the scheduler's placement; an accepted escalation
  // may move it (another runtime or computer, or a freshly loaded model). Tools always
  // run here, in-process, regardless.
  const placement = { runtimeId: scheduling.runtimeId, computerId: scheduling.computerId, contextTokens: context.available.tokens };

  const runtime: AgentRuntime = {
    tools: availableTools,

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

      try {
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
          for await (const event of adapter.generate({
            requestId,
            modelId: request.modelId,
            messages: request.messages,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            contextTokens: placement.contextTokens,
            stream: true,
            tools: request.tools,
          })) {
            await engine.executions.recordProviderEvent(executionId, event, retryContext);
            if (event.type === 'token') {
              loader.setText(`Generating response from ${request.modelId}...`);
            }
            if (event.type === 'completed' && event.usage) {
              await engine.executions.recordUsage(executionId, {
                input: event.usage.inputTokens,
                output: event.usage.outputTokens,
                total: event.usage.totalTokens,
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
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            contextTokens: placement.contextTokens,
          };
          try {
            for await (const event of dispatchRemote(engine.config.apiUrl, placement.computerId, workerRequest, { token: engine.config.apiToken })) {
              const generationEvent = toGenerationEvent(event);
              if (!generationEvent) continue;
              await engine.executions.recordProviderEvent(executionId, generationEvent, retryContext);
              if (generationEvent.type === 'token') {
                loader.setText(`Generating response from ${request.modelId}...`);
              }
              if (generationEvent.type === 'completed' && generationEvent.usage) {
                await engine.executions.recordUsage(executionId, {
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
            error: `task scheduled on remote computer '${placement.computerId}' but no control-plane API URL is configured (set WAZIR_API_URL)`,
          };
        }
      } finally {
        loader.stop();
        await engine.executions.recordEvent(executionId, 'generation.completed');
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
        });
      }

      if (engine.tools.get(name)?.descriptor.provenance?.source === 'mcp') {
        return executeMCPForAgent(engine, name, input, { projectRoot: engine.projectRoot, executionId });
      }
 
      const decision = await engine.policy.authorize({ tool: name, input, executionId, projectRoot: engine.projectRoot });
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
          verifyWorkspace: true,
          allowVerificationChanges: taskAuthorizesVerificationChanges(description),
          callId,
          allowedTools: availableTools.map(tool => tool.name),
          checkpoint: async () => { await engine.executions.recordToolStart(executionId, name, input, { callId, sideEffectClass: engine.tools.get(name)?.descriptor.sideEffectClass }); },
          projectRoot: engine.projectRoot,
          executionId,
          networkAllowed: engine.config.networkAllowed,
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
        const notApplicable = !result.ok && /missing script/i.test(result.error ?? '');
        if (!notApplicable) {
          const script = typeof input.script === 'string' && input.script.trim() ? input.script.trim() : name;
          await engine.executions.recordCheck(executionId, {
            workspaceRevision: checkRevision,
            name: name as CheckRunRecord['name'],
            command: `npm run ${script}`,
            ok: result.ok,
            output: (result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n')).slice(0, 4000),
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
          output: (result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n')).slice(0, 4000),
          durationMs: result.durationMs,
        });
      } else if (name === 'shell' && typeof input.command === 'string' && isTestInvocation(input.command)) {
        await engine.executions.recordCheck(executionId, {
          workspaceRevision: checkRevision,
          name: 'test',
          command: input.command,
          ok: result.ok,
          output: (result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n')).slice(0, 4000),
          durationMs: result.durationMs,
        });
      }

      emitJson({ type: 'tool', tool: name, ok: result.ok, durationMs: result.durationMs, executionId });
      log(`    ${result.ok ? color.green('ok') : color.red('failed')} ${name} ${color.gray(`${result.durationMs}ms`)}`);
      return result;
    },
  };

  // ---- run the agent ------------------------------------------------------
  await engine.executions.setStatus(executionId, 'running');
  let summary: string | undefined;
  const errors: string[] = [];

  try {
    for await (const turn of agent.run(
      {
        modelId: scheduling.modelId,
        taskDescription: description,
        taskType: task.type,
        projectRoot: engine.projectRoot,
        maxTurns: options.maxTurns,
        isCancelled: () => cancelled,
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
          await engine.executions.recordEvent(executionId, 'agent.phase', { phase: turn.phase });
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
            await engine.executions.recordError(executionId, turn.error);
            emitJson({ type: 'error', error: turn.error, executionId });
            log(color.red(`    ${untrusted(turn.error.split('\n')[0].slice(0, 200))}`));
          }
          break;
        default:
          break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    await engine.executions.recordError(executionId, message);
    emitJson({ type: 'error', error: message, executionId });
    log(color.red(`    ${untrusted(message)}`));
  } finally {
    loader.stop();
    process.off('SIGINT', onSigint);
  }

  // ---- deterministic evaluation -------------------------------------------
  const finalRecord = engine.executions.require(executionId);
  const evaluation = evaluateExecution(finalRecord, {
    expectedFiles: options.expectedFiles,
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

  // Create child execution record linked by parentExecutionId
  const subtask: Task = {
    id: generateId('task-sub-'),
    type: 'coding',
    input: description,
    requirements: {
      minimumContext: MINIMUM_CONTEXT_TOKENS,
      expectedArtifacts,
    },
    policy: {
      ...(context.parentPolicy ?? {}),
      allowSubagentDispatch: false,
      projectRoot: context.projectRoot,
    },
    execution: {
      targetModelId: context.modelId,
      targetRuntimeId: context.runtimeId,
    },
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
  };

  const childRecord = await engine.executions.create({
    task: subtask,
    parentExecutionId: context.parentExecutionId,
    agentId: 'wazir-coding',
    computerId: context.computerId ?? engine.worker.computerId,
    runtimeId: context.runtimeId,
    modelId: context.modelId,
    workerId: engine.worker.id,
    workspaceRoot: context.projectRoot,
  });
  const childExecId = childRecord.execution.id;

  context.log(color.cyan(`    [subagent] spawned nested execution ${childExecId} (depth ${context.subagentDepth + 1})`));
  context.emitJson({
    type: 'subagent.start',
    executionId: childExecId,
    parentExecutionId: context.parentExecutionId,
    description,
  });

  // Filter tools to strictly omit dispatch_subagent for child agent
  const subagentTools = engine.tools.forModel().filter((t) => t.name !== 'dispatch_subagent');

  const subagentRuntime: AgentRuntime = {
    tools: subagentTools,

    async *generate(req) {
      const requestId = generateId('req-');
      if (context.signal?.aborted) return;
      const adapter = engine.adapters.get(context.runtimeId) ?? engine.worker.adapterForModel(req.modelId);
      if (!adapter) {
        yield { type: 'error', error: `no runtime can serve model '${req.modelId}'` };
        return;
      }
      const effective = context.computerId ? await engine.lifecycle.activateExecution(childExecId, MINIMUM_CONTEXT_TOKENS) : undefined;
      for await (const event of adapter.generate({
        requestId,
        contextTokens: effective,
        modelId: req.modelId,
        messages: req.messages,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
        tools: req.tools,
      })) {
        await engine.executions.recordProviderEvent(childExecId, event, {
          requestId, model: req.modelId, provider: engine.models.get(req.modelId)?.provider,
        });
        if (event.type === 'completed' && event.usage) {
          await engine.executions.recordUsage(childExecId, {
            input: event.usage.inputTokens,
            output: event.usage.outputTokens,
            total: event.usage.totalTokens,
          });
        }
        yield event;
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
        checkpoint: async () => { await engine.executions.recordToolStart(childExecId, name, toolInput, { callId, sideEffectClass: engine.tools.get(name)?.descriptor.sideEffectClass }); },
        projectRoot: context.projectRoot,
        executionId: childExecId,
        networkAllowed: engine.config.networkAllowed,
        signal: context.signal,
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
        modelId: context.modelId,
        taskDescription: description,
        taskType: 'coding',
        projectRoot: context.projectRoot,
        maxTurns: subagentMaxTurns,
        subagentDepth: context.subagentDepth + 1,
        isCancelled: () => Boolean(context.signal?.aborted),
      },
      subagentRuntime,
    )) {
      if (turn.terminationReason) await recordTermination(engine, childExecId, turn.terminationReason, context.modelId, 'coding', turn.protocolMetrics, turn.runStats);
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

  const childUpdated = await engine.executions.get(childExecId);
  const childFiles = childUpdated?.filesChanged ?? [];
  const status = (subagentSuccess && childErrors.length === 0) ? 'completed' : 'failed';
  await engine.executions.setStatus(childExecId, status);
  if (subagentSummary) {
    await engine.executions.setResult(childExecId, subagentSummary);
  }

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
  };
}
