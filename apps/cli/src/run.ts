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
import type { GenerationEvent } from '@wazir/runtimes-interfaces';
import { buildSystemPrompt } from '@wazir/agents';
import { evaluateExecution } from '@wazir/evaluation';
import { generateId } from '@wazir/shared';
import { executeTool as runRegisteredTool } from '@wazir/tools';
import { dispatchRemote } from '@wazir/workers';
import { color } from './colors.js';
import type { RookEngine } from './engine.js';

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
export function planTask(
  engine: RookEngine,
  description: string,
  options: Pick<ExecuteTaskOptions, 'type' | 'model' | 'agent'> = {},
): PlanResult {
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

  const parts: ContextPart[] = [
    { kind: 'system', label: 'system prompt', content: buildSystemPrompt(engine.projectRoot, engine.tools.forModel()), priority: 'critical' },
    { kind: 'task', label: 'task', content: description, priority: 'critical' },
  ];
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
  const log = (line: string): void => {
    if (!options.quiet) console.error(line);
  };

  await engine.executions.ready;

  const planned = planTask(engine, description, options);
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
      await engine.executions.recordEvent(executionId, 'generation.started', { modelId: request.modelId });

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
          for await (const event of dispatchRemote(engine.config.apiUrl, scheduling.computerId, workerRequest)) {
            const generationEvent = toGenerationEvent(event);
            if (!generationEvent) continue;
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

      await engine.executions.recordEvent(executionId, 'generation.completed');
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
        log(`    ${color.red('denied')} ${name} ${color.gray(decision.reasons[0] ?? decision.rule)}`);
        return result;
      }

      await engine.executions.recordToolStart(executionId, name, input);
      const result = await runRegisteredTool(engine.tools, name, input, { projectRoot: engine.projectRoot, executionId });
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
      });

      if (CHECK_TOOLS.has(name)) {
        const notApplicable = !result.ok && /missing script/i.test(result.error ?? '');
        if (!notApplicable) {
          const script = typeof input.script === 'string' && input.script.trim() ? input.script.trim() : name;
          await engine.executions.recordCheck(executionId, {
            name: name as CheckRunRecord['name'],
            command: `npm run ${script}`,
            ok: result.ok,
            output: (result.ok ? result.output : result.error ?? result.output).slice(0, 4000),
            durationMs: result.durationMs,
          });
        }
      }

      if (WRITE_TOOLS.has(name) && result.ok && typeof input.path === 'string') {
        const relative = path.relative(engine.projectRoot, path.resolve(engine.projectRoot, input.path)).split(path.sep).join('/');
        await engine.executions.recordFilesChanged(executionId, [relative]);
      }

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
      });
      switch (turn.kind) {
        case 'phase':
          await engine.executions.recordEvent(executionId, 'agent.phase', { phase: turn.phase });
          log(color.cyan(`  [${turn.phase}]`));
          break;
        case 'message':
          if (turn.content) log(color.gray(`    ${turn.content.split('\n')[0].slice(0, 160)}`));
          break;
        case 'done':
          summary = turn.content;
          break;
        case 'error':
          if (turn.error) {
            errors.push(turn.error);
            await engine.executions.recordError(executionId, turn.error);
            log(color.red(`    ${turn.error.split('\n')[0].slice(0, 200)}`));
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
    log(color.red(`    ${message}`));
  } finally {
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

  return {
    success: evaluation.success && !cancelled,
    reasons: cancelled ? ['execution cancelled by user', ...evaluation.reasons] : evaluation.reasons,
    filesChanged: evaluation.filesChanged,
    executionId,
    result: summary,
    errors,
  };
}
