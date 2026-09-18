import path from 'node:path';
import {
  effectiveContextTokens,
  type AgentAdapter,
  type AgentRuntime,
  type CheckRunRecord,
  type ContextPart,
  type JobTaskExecutionContext,
  type JobTaskExecutor,
  type JobTaskOutcome,
  type Task,
  type ToolResult,
  type WorkerExecutionEvent,
  type WorkerExecutionRequest,
  type WorktreeInfo,
} from '@wazir/core';
import type { GenerationEvent } from '@wazir/runtimes-interfaces';
import { buildSystemPrompt } from '@wazir/agents';
import { evaluateExecution } from '@wazir/evaluation';
import { generateId } from '@wazir/shared';
import { executeTool as runRegisteredTool } from '@wazir/tools';
import { dispatchRemote } from '@wazir/workers';
import type { RookEngine } from './engine.js';

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
      return undefined;
  }
}

const CHECK_TOOLS = new Set(['test', 'lint', 'typecheck', 'build']);
const WRITE_TOOLS = new Set(['write', 'edit']);
const OUTPUT_RESERVE_TOKENS = 4096;

export interface FleetRunnerOptions {
  useWorktrees?: boolean;
  autoMerge?: boolean;
  maxTurns?: number;
}

export function createFleetTaskExecutor(
  engine: RookEngine,
  runnerOptions: FleetRunnerOptions = {},
): JobTaskExecutor {
  return async (task: Task, context: JobTaskExecutionContext): Promise<JobTaskOutcome> => {
    const { jobId, taskId, assignment, signal } = context;

    // 1. Git Worktree Isolation
    let taskRoot = engine.projectRoot;
    let worktreeInfo: WorktreeInfo | undefined;
    const isGit = await engine.worktrees.isGitRepo(engine.projectRoot);

    if (runnerOptions.useWorktrees !== false && isGit) {
      try {
        worktreeInfo = await engine.worktrees.createWorktree(engine.projectRoot, jobId, taskId);
        taskRoot = worktreeInfo.worktreeDir;
      } catch (err) {
        // Fallback to project root if worktree creation fails
        taskRoot = engine.projectRoot;
      }
    }

    // 2. Fetch or create execution record
    const existingRecords = await engine.executions.listByTask(taskId);
    let executionId: string;

    if (existingRecords.length > 0) {
      executionId = existingRecords[0].execution.id;
    } else {
      const rec = await engine.executions.create({
        task,
        agentId: assignment.agentId,
        computerId: assignment.computerId,
        runtimeId: assignment.runtimeId,
        modelId: assignment.modelId,
        workerId: engine.worker.id,
      });
      executionId = rec.execution.id;
    }

    await engine.executions.setStatus(executionId, 'running');

    // 3. Resolve model and context
    const model = engine.models.getRequired(assignment.modelId);
    const parts: ContextPart[] = [
      {
        kind: 'system',
        label: 'system prompt',
        content: buildSystemPrompt(taskRoot, engine.tools.forModel()),
        priority: 'critical',
      },
      { kind: 'task', label: 'task', content: task.input, priority: 'critical' },
    ];

    const contextDecision = engine.compiler.compile(
      parts,
      {
        tokens: effectiveContextTokens(model),
        source: model.configuredContext !== undefined ? 'configured' : 'discovered',
      },
      OUTPUT_RESERVE_TOKENS,
    );

    // 4. Resolve agent
    const agent: AgentAdapter | undefined = engine.agents.get(assignment.agentId);
    if (!agent) {
      const err = `Agent '${assignment.agentId}' not registered`;
      await engine.executions.recordError(executionId, err);
      await engine.executions.setStatus(executionId, 'failed');
      return { success: false, error: err };
    }

    // 5. Build AgentRuntime
    const runtime: AgentRuntime = {
      tools: engine.tools.forModel(),

      async *generate(request) {
        await engine.executions.recordEvent(executionId, 'generation.started', { modelId: request.modelId });

        if (assignment.computerId === engine.worker.computerId) {
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
            contextTokens: contextDecision.available.tokens,
            stream: true,
          })) {
            if (event.type === 'token' && event.content) {
              context.onProgress?.({ kind: 'token', content: event.content });
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
          // Remote dispatch to another computer in the fleet
          const workerRequest: WorkerExecutionRequest = {
            executionId,
            requestId: generateId('req-'),
            modelId: request.modelId,
            messages: request.messages,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            contextTokens: contextDecision.available.tokens,
          };
          try {
            for await (const event of dispatchRemote(engine.config.apiUrl, assignment.computerId, workerRequest, { token: engine.config.apiToken })) {
              const generationEvent = toGenerationEvent(event);
              if (!generationEvent) continue;
              if (generationEvent.type === 'token' && generationEvent.content) {
                context.onProgress?.({ kind: 'token', content: generationEvent.content });
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
            error: `task scheduled on remote computer '${assignment.computerId}' but no control-plane API URL configured`,
          };
        }

        await engine.executions.recordEvent(executionId, 'generation.completed');
      },

      async executeTool(name, input): Promise<ToolResult> {
        const decision = await engine.policy.authorize({
          tool: name,
          input,
          executionId,
          projectRoot: taskRoot,
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
          context.onProgress?.({ kind: 'tool', tool: name, error: result.error });
          return result;
        }

        await engine.executions.recordToolStart(executionId, name, input);
        const result = await runRegisteredTool(engine.tools, name, input, {
          projectRoot: taskRoot,
          executionId,
          networkAllowed: engine.config.networkAllowed,
        });

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
              output: (result.ok ? result.output : result.error ?? result.output).slice(0, 4000),
              durationMs: result.durationMs,
            });
          }
        }

        if (WRITE_TOOLS.has(name) && result.ok && typeof input.path === 'string') {
          const relative = path
            .relative(taskRoot, path.resolve(taskRoot, input.path))
            .split(path.sep)
            .join('/');
          await engine.executions.recordFilesChanged(executionId, [relative]);
        }

        context.onProgress?.({
          kind: 'tool',
          tool: name,
          content: result.ok ? 'ok' : result.error,
        });

        return result;
      },
    };

    // 6. Run agent loop
    let summary: string | undefined;
    const errors: string[] = [];

    try {
      for await (const turn of agent.run(
        {
          modelId: assignment.modelId,
          taskDescription: task.input,
          taskType: task.type,
          projectRoot: taskRoot,
          maxTurns: runnerOptions.maxTurns,
          isCancelled: () => signal?.aborted ?? false,
          getSteeringInstruction: () => context.getSteeringInstruction?.(),
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

        context.onProgress?.({
          kind: turn.kind,
          phase: turn.phase,
          content: turn.content,
          tool: turn.tool,
          error: turn.error,
        });

        if (turn.kind === 'done') {
          summary = turn.content;
        } else if (turn.kind === 'error' && turn.error) {
          errors.push(turn.error);
          await engine.executions.recordError(executionId, turn.error);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(message);
      await engine.executions.recordError(executionId, message);
    }

    // 7. Deterministic evaluation
    const finalRecord = engine.executions.require(executionId);
    const evaluation = evaluateExecution(finalRecord);
    await engine.executions.setEvaluation(executionId, evaluation);
    if (summary) {
      await engine.executions.setResult(executionId, summary);
    }

    const wasCancelled = signal?.aborted ?? false;
    await engine.executions.setStatus(
      executionId,
      wasCancelled ? 'cancelled' : evaluation.success ? 'completed' : 'failed',
    );

    // 8. Commit worktree changes and auto-merge if requested
    if (worktreeInfo && evaluation.success && !wasCancelled) {
      const commitRes = await engine.worktrees.commitWorktree(
        worktreeInfo,
        `wazir(${jobId}): ${task.title || task.input.slice(0, 60)}`,
      );

      if (runnerOptions.autoMerge && commitRes.committed) {
        await engine.worktrees.mergeBranch(engine.projectRoot, worktreeInfo.branch);
      }
    }

    return {
      success: evaluation.success && !wasCancelled,
      result: summary ?? (evaluation.success ? 'completed' : 'failed'),
      error: errors[0],
      reasons: evaluation.reasons,
      filesChanged: finalRecord.filesChanged,
      usage: finalRecord.usage
        ? {
            input: finalRecord.usage.input,
            output: finalRecord.usage.output,
            total: finalRecord.usage.total ?? finalRecord.usage.input + finalRecord.usage.output,
          }
        : undefined,
    };
  };
}
