import path from 'node:path';
import { effectiveContextTokens, SchedulingError } from '@wazir/core';
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
import { buildSystemPrompt } from '@wazir/agents';
import { evaluateExecution } from '@wazir/evaluation';
import { generateId, stripTerminalEscapes } from '@wazir/shared';
import { executeTool as runRegisteredTool } from '@wazir/tools';
import { dispatchRemote } from '@wazir/workers';
import { color } from './colors.js';
import type { RookEngine } from './engine.js';
import { StatusLoader } from './spinner.js';

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
      return { type: 'error', error: (data?.error as string | undefined) ?? 'remote execution failed' };
    default:
      // 'started' / 'cancelled' have no local-path equivalent to surface — skip.
      return undefined;
  }
}

export interface ExecuteTaskOptions {
  type?: TaskType;
  model?: string;
  agent?: string;
  maxTurns?: number;
  expectedFiles?: string[];
  json?: boolean;
  quiet?: boolean;
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
const OUTPUT_RESERVE_TOKENS = 4096;
const MINIMUM_CONTEXT_TOKENS = 8192;

/** Policy check, context budget, two-phase scheduling and agent resolution — no side effects. */
export async function planTask(
  engine: RookEngine,
  description: string,
  options: Pick<ExecuteTaskOptions, 'type' | 'model' | 'agent'> = {},
): Promise<PlanResult> {
  const task: Task = {
    id: generateId('task-'),
    type: options.type ?? 'coding',
    input: description,
    requirements: { minimumContext: MINIMUM_CONTEXT_TOKENS },
    policy: { networkAccess: engine.config.networkAllowed, projectRoot: engine.projectRoot },
    execution: { targetModelId: options.model, targetAgentId: options.agent },
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
  };

  const taskPolicy = engine.policy.evaluateTask(task);
  if (!taskPolicy.allowed) {
    return { ok: false, reasons: taskPolicy.reasons };
  }

  const baseParts: ContextPart[] = [
    { kind: 'system', label: 'system prompt', content: buildSystemPrompt(engine.projectRoot, engine.tools.forModel()), priority: 'critical' },
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
    if (options.json) return;
    loader.clear();
    if (isPiped) {
      // Non-TTY / piped stream fallback (§23): clean plain streaming lines
      const plain = stripTerminalEscapes(line).trim();
      if (plain) process.stdout.write(plain + '\n');
    } else if (!options.quiet) {
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
    scheduling,
    context,
  });
  const executionId = record.execution.id;
  emitJson({ type: 'start', executionId, taskId: task.id, modelId: scheduling.modelId, agent: agent.descriptor.name });

  log('');
  log(color.bold(`  Execution ${executionId}`));
  log(color.gray(`    agent:    ${agent.descriptor.name}`));
  log(color.gray(`    model:    ${scheduling.modelId} via ${scheduling.runtimeId} on ${scheduling.computerId}`));
  log(color.gray(`    context:  ${context.finalRequiredTokens} / ${context.available.tokens} tokens`));
  for (const reason of scheduling.reasons) {
    log(color.gray(`    - ${reason}`));
  }

  // ---- policy-gated runtime handed to the agent ---------------------------
  let cancelled = false;
  const onSigint = (): void => {
    cancelled = true;
    log(color.yellow('  cancellation requested; finishing current step'));
  };
  process.once('SIGINT', onSigint);

  const runtime: AgentRuntime = {
    tools: engine.tools.forModel(),

    async *generate(request) {
      loader.start(`Waiting for model response (${request.modelId})...`);
      await engine.executions.recordEvent(executionId, 'generation.started', { modelId: request.modelId });

      try {
        if (scheduling.computerId === engine.worker.computerId) {
          const adapter = engine.worker.adapterForModel(request.modelId);
          if (!adapter) {
            yield { type: 'error', error: `no runtime can serve model '${request.modelId}'` };
            return;
          }
          for await (const event of adapter.generate({
            modelId: request.modelId,
            messages: request.messages,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            contextTokens: context.available.tokens,
            stream: true,
          })) {
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
            executionId,
            requestId: generateId('req-'),
            modelId: request.modelId,
            messages: request.messages,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            contextTokens: context.available.tokens,
          };
          try {
            for await (const event of dispatchRemote(engine.config.apiUrl, scheduling.computerId, workerRequest, { token: engine.config.apiToken })) {
              const generationEvent = toGenerationEvent(event);
              if (!generationEvent) continue;
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
            error: `task scheduled on remote computer '${scheduling.computerId}' but no control-plane API URL is configured (set WAZIR_API_URL)`,
          };
        }
      } finally {
        loader.stop();
        await engine.executions.recordEvent(executionId, 'generation.completed');
      }
    },

    async executeTool(name, input): Promise<ToolResult> {
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

      await engine.executions.recordToolStart(executionId, name, input);
      let result: ToolResult;
      try {
        result = await runRegisteredTool(engine.tools, name, input, {
          projectRoot: engine.projectRoot,
          executionId,
          networkAllowed: engine.config.networkAllowed,
        });
      } finally {
        loader.stop();
      }
      await engine.executions.recordToolCall(executionId, {
        id: generateId('call-'),
        tool: name,
        input,
        output: result.output.slice(0, 4000),
        ok: result.ok,
        error: result.error,
        policyEffect: decision.decision,
        policyRule: decision.rule,
        durationMs: result.durationMs,
        at: new Date(),
        sandbox: typeof result.metadata?.sandbox === 'string' ? result.metadata.sandbox : undefined,
      });

      if (CHECK_TOOLS.has(name)) {
        const notApplicable = !result.ok && /missing script/i.test(result.error ?? '');
        if (!notApplicable) {
          const script = typeof input.script === 'string' && input.script.trim() ? input.script.trim() : name;
          await engine.executions.recordCheck(executionId, {
            name: name as CheckRunRecord['name'],
            command: `npm run ${script}`,
            ok: result.ok,
            output: (result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n')).slice(0, 4000),
            durationMs: result.durationMs,
          });
        }
      }

      if (WRITE_TOOLS.has(name) && result.ok && typeof input.path === 'string') {
        const relative = path.relative(engine.projectRoot, path.resolve(engine.projectRoot, input.path)).split(path.sep).join('/');
        await engine.executions.recordFilesChanged(executionId, [relative]);
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
  const evaluation = evaluateExecution(finalRecord, { expectedFiles: options.expectedFiles });
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
