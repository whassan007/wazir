import { executeMCPForAgent } from './mcp.js';
import { runSubagent } from './run.js';
import { recordTermination } from './termination.js';
import { createEscalationHandler, prepareGenerationPlacement } from './escalation.js';
import { localOutcomeInspector, planTaskResume } from './recovery.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  effectiveContextTokens,
  type AgentAdapter,
  type AgentErrorKind,
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
  type AgentResumeContext,
  taskAuthorizesVerificationChanges,
} from '@wazir/core';
import type { GenerationEvent } from '@wazir/runtimes-interfaces';
import { buildSystemPrompt } from '@wazir/agents';
import { evaluateExecution } from '@wazir/evaluation';
import { generateId } from '@wazir/shared';
import { executeTool as runRegisteredTool } from '@wazir/tools';
import { recordWebContext } from './web.js';
import { dispatchRemote, runWorkerPreflight } from '@wazir/workers';
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
      return { type: 'error', error: (data?.error as string | undefined) ?? 'remote execution failed',
        failureClass: data?.failureClass as GenerationEvent['failureClass'], retryExhausted: data?.retryExhausted === true,
        retryAttempt: data?.retryAttempt as number | undefined };
    case 'retry':
      return { type: 'retry', error: data?.error as string | undefined,
        failureClass: data?.failureClass as GenerationEvent['failureClass'],
        retryAttempt: data?.retryAttempt as number | undefined, retryDelayMs: data?.retryDelayMs as number | undefined };
    default:
      return undefined;
  }
}

const CHECK_TOOLS = new Set(['test', 'lint', 'typecheck', 'build']);
const WRITE_TOOLS = new Set(['write', 'edit']);
// Kept in sync with the identical constant + branch in apps/cli/src/run.ts —
// see that file's comment for why this exists: a compiler run via the
// generic `shell` tool was invisible to evaluateExecution()'s check
// tracking, letting a task "complete" with zero recorded evidence even when
// the model had genuinely compiled (or failed to compile) real code.
// `(?=\s|$)` rather than `\b` — see the identical helper in run.ts for why.
const BUILD_INVOCATION_PATTERN =
  /(^|&&|\|\||;)\s*(g\+\+|gcc|cc|c\+\+|clang\+\+|clang|rustc|javac|tsc|make|cmake|cargo\s+build|go\s+build|mvn\s+compile|gradle\s+build|dotnet\s+build|swiftc)(?=\s|$)/;
// Kept in sync with the identical helper in apps/cli/src/run.ts.
const SOURCE_CODE_EXTENSION_PATTERN = /\.(c|cc|cpp|cxx|h|hpp|hh|py|go|rs|java|kt|swift|ts|tsx|js|jsx|mjs|cjs|rb|php|cs|scala|m|mm)$/i;
function touchesSourceCode(filesChanged: string[]): boolean {
  return filesChanged.some((f) => SOURCE_CODE_EXTENSION_PATTERN.test(f));
}
const OUTPUT_RESERVE_TOKENS = 4096;

export interface FleetRunnerOptions {
  useWorktrees?: boolean;
  shareJobWorktree?: boolean;
  autoMerge?: boolean;
  maxTurns?: number;
}

export function createFleetTaskExecutor(
  engine: RookEngine,
  runnerOptions: FleetRunnerOptions = {},
): JobTaskExecutor {
  return async (task: Task, context: JobTaskExecutionContext): Promise<JobTaskOutcome> => {
    const { jobId, taskId, assignment, signal } = context;

    // 1. Workspace Isolation
    let taskRoot = engine.projectRoot;
    let worktreeInfo: WorktreeInfo | undefined;
    const isGit = await engine.worktrees.isGitRepo(engine.projectRoot);
    const mode = context.workspaceMode ?? task.workspaceMode;

    if (context.worktreeDir) {
      taskRoot = context.worktreeDir;
    } else if (mode === 'clean') {
      try {
        worktreeInfo = await engine.worktrees.createCleanWorkspace(engine.projectRoot, jobId, taskId);
        taskRoot = worktreeInfo.worktreeDir;
      } catch {
        taskRoot = engine.projectRoot;
      }
    } else if (runnerOptions.useWorktrees !== false && isGit) {
      try {
        worktreeInfo = runnerOptions.shareJobWorktree !== false
          ? await engine.worktrees.getOrCreateJobWorktree(engine.projectRoot, jobId)
          : await engine.worktrees.createWorktree(engine.projectRoot, jobId, taskId);
        taskRoot = worktreeInfo.worktreeDir;
      } catch (err) {
        // Fallback to project root if worktree creation fails
        taskRoot = engine.projectRoot;
      }
    }

    await fs.mkdir(path.join(taskRoot, '.wazir', 'tmp'), { recursive: true }).catch(() => {});
    await fs.mkdir(path.join(taskRoot, '.wazir', 'home'), { recursive: true }).catch(() => {});
    await fs.mkdir(path.join(taskRoot, '.wazir', 'cache'), { recursive: true }).catch(() => {});

    // 2. Worker Preflight Infrastructure Verification
    const preflight = await runWorkerPreflight({
      workspace: taskRoot,
      taskPrompt: task.input,
      capabilities: task.capabilities,
      requiredTools: ['read', 'write', 'shell', 'glob'],
      skipCompilerProbe: runnerOptions.useWorktrees === false && !process.env.WAZIR_PROBE_COMPILER,
    });

    if (!preflight.ok) {
      const preflightErr = `[PREFLIGHT_FAILED: ${preflight.code}] ${preflight.reason}`;
      context.onProgress?.({
        kind: 'infra',
        phase: 'plan',
        error: preflightErr,
      });

      const existingRecs = await engine.executions.listByTask(taskId);
      const rec = existingRecs.length > 0 ? existingRecs[0] : await engine.executions.create({
        task,
        jobId,
        agentId: assignment.agentId,
        computerId: assignment.computerId,
        runtimeId: assignment.runtimeId,
        modelId: assignment.modelId,
        workerId: engine.worker.id,
        workspaceRoot: taskRoot,
      });
      await engine.executions.recordError(rec.execution.id, preflightErr);
      await engine.executions.setStatus(rec.execution.id, 'failed');

      return {
        success: false,
        error: preflightErr,
        errorKind: 'infrastructure',
        reasons: [preflightErr],
      };
    }

    // 3. Fetch or create execution record
    const existingRecords = await engine.executions.listByTask(taskId);
    let executionId: string;

    // A retry of this task continues its existing execution — but only when durable
    // facts say that's safe (planTaskResume): provable outcomes are reconciled first,
    // and an unresolved side effect refuses rather than risking a repeat.
    let resume: AgentResumeContext | undefined;
    if (existingRecords.length > 0) {
      executionId = existingRecords[0].execution.id;
      const resumePlan = await planTaskResume(engine.executions, executionId, localOutcomeInspector(engine.projectRoot, engine.worker.computerId ?? 'local'));
      if (resumePlan.action === 'refuse') {
        const error = `RESUME_REFUSED: ${resumePlan.reasons.join(' | ')}`;
        context.onProgress?.({ kind: 'error', phase: 'plan', error });
        // 'policy': a controller safety refusal — retrying or replanning can't clear it.
        return { success: false, error, errorKind: 'policy', reasons: resumePlan.reasons };
      }
      resume = resumePlan.resume;
      context.onProgress?.({ kind: 'message', phase: 'plan', content: `resuming execution ${executionId} (attempt ${resume.attempt}): ${resumePlan.reasons.join('; ')}` });
    } else {
      const rec = await engine.executions.create({
        task,
        jobId,
        agentId: assignment.agentId,
        computerId: assignment.computerId,
        runtimeId: assignment.runtimeId,
        modelId: assignment.modelId,
        workerId: engine.worker.id,
        workspaceRoot: taskRoot,
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
        content: buildSystemPrompt(taskRoot, engine.tools.forModel(undefined, engine.agents.get(assignment.agentId)?.descriptor.capabilities)),
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

    if (assignment.computerId) {
      try {
        contextDecision.available.tokens = await engine.lifecycle.activateExecution(executionId,
          Math.max(contextDecision.finalRequiredTokens, task.requirements.minimumContext ?? 0));
        await engine.executions.setStatus(executionId, 'running');
      } catch (e) {
        return { success: false, error: e instanceof Error ? e.message : String(e), errorKind: 'infrastructure' };
      }
    }

    // 4. Resolve agent
    const agent: AgentAdapter | undefined = engine.agents.get(assignment.agentId);
    if (!agent) {
      const err = `Agent '${assignment.agentId}' not registered`;
      await engine.executions.recordError(executionId, err);
      await engine.executions.setStatus(executionId, 'failed');
      return { success: false, error: err };
    }

    // 5. Build AgentRuntime
    let currentTurn: { adapter: import('@wazir/runtimes-interfaces').RuntimeAdapter; requestId: string } | undefined;
    // Changes only through a controller-approved escalation (runtime.escalate below).
    let currentModelId = assignment.modelId;
    // Where generation runs; an accepted escalation may move it. Tools always run in taskRoot.
    const placement = { runtimeId: assignment.runtimeId, computerId: assignment.computerId, contextTokens: contextDecision.available.tokens };
    const runtime: AgentRuntime = {
      tools: engine.tools.forModel(undefined, agent.descriptor.capabilities),

      cancelCurrentTurn(): void {
        void currentTurn?.adapter.cancel?.(currentTurn.requestId);
      },

      // Same controller-owned escalation as `wa run`: the Scheduler picks, the
      // placement stays, every decision is recorded as model.route.changed.
      escalate: createEscalationHandler(engine, {
        executionId,
        task,
        requiredContextTokens: contextDecision.finalRequiredTokens,
        placement: () => placement,
        prepare: (next) => prepareGenerationPlacement(engine, next, { executionId, minimumContext: contextDecision.finalRequiredTokens }),
        onEscalated: (_request, next, contextTokens) => {
          currentModelId = next.modelId;
          placement.runtimeId = next.runtimeId;
          placement.computerId = next.computerId;
          placement.contextTokens = contextTokens;
        },
      }),

      async *generate(request) {
        const requestId = generateId('req-');
        const retryContext = { requestId, model: request.modelId, provider: engine.models.get(request.modelId)?.provider };
        await engine.executions.recordEvent(executionId, 'generation.started', { modelId: request.modelId });
        if (engine.web) request = { ...request, messages: await recordWebContext(engine.executions, executionId, request.messages, engine.web.limits.maxGroundingTokens) };
        // The `agent.turn` event below only records `content.slice(0, 500)` of the
        // *parsed* action — the model's raw completion (including any reasoning
        // prose before/around the JSON action) is otherwise never durably stored,
        // only streamed transiently to the TUI. Captured here so a finished or
        // crashed job's exact model output is still inspectable afterward.
        let completedContent = '';

        // No computerId means a hosted-provider assignment (Anthropic/OpenAI/
        // Google) — still executes in-process on this machine, same as
        // apps/cli/src/run.ts's equivalent branch. engine.adapters is checked
        // first since worker.adapterForModel() can never resolve a hosted
        // adapter (it only searches the worker's own hardware-bound list).
        if (!placement.computerId || placement.computerId === engine.worker.computerId) {
          const adapter = engine.adapters.get(placement.runtimeId) ?? engine.worker.adapterForModel(request.modelId);
          if (!adapter) {
            yield { type: 'error', error: `no runtime can serve model '${request.modelId}'` };
            return;
          }
          currentTurn = { adapter, requestId };
          for await (const event of adapter.generate({
            modelId: request.modelId,
            messages: request.messages,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            contextTokens: placement.contextTokens,
            stream: true,
            tools: request.tools,
            requestId,
          })) {
            await engine.executions.recordProviderEvent(executionId, event, retryContext);
            if (event.type === 'token' && event.content) {
              context.onProgress?.({ kind: 'token', content: event.content });
            }
            if (event.type === 'completed') {
              completedContent = event.content ?? '';
              if (event.usage) {
                const usage = {
                  input: event.usage.inputTokens,
                  output: event.usage.outputTokens,
                  total: event.usage.totalTokens ?? event.usage.inputTokens + event.usage.outputTokens,
                };
                await engine.executions.recordUsage(executionId, usage);
                // Per-turn usage, not the cumulative execution total: `input` here is the
                // size of the prompt the model was just sent, i.e. the real context-window
                // occupancy right now — the only honest number for a "Context N/M" gauge.
                context.onProgress?.({ kind: 'usage', usage, breakdown: contextDecision.breakdown });
              }
            }
            yield event;
          }
          currentTurn = undefined;
        } else if (engine.config.apiUrl) {
          // Remote dispatch to another computer in the fleet
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
              if (generationEvent.type === 'token' && generationEvent.content) {
                context.onProgress?.({ kind: 'token', content: generationEvent.content });
              }
              if (generationEvent.type === 'completed') {
                completedContent = generationEvent.content ?? '';
                if (generationEvent.usage) {
                  const usage = {
                    input: generationEvent.usage.inputTokens,
                    output: generationEvent.usage.outputTokens,
                    total: generationEvent.usage.totalTokens ?? generationEvent.usage.inputTokens + generationEvent.usage.outputTokens,
                  };
                  await engine.executions.recordUsage(executionId, usage);
                  context.onProgress?.({ kind: 'usage', usage, breakdown: contextDecision.breakdown });
                }
              }
              yield generationEvent;
            }
          } catch (error) {
            yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
          }
        } else {
          yield {
            type: 'error',
            error: `task scheduled on remote computer '${placement.computerId}' but no control-plane API URL configured`,
          };
        }

        await engine.executions.recordEvent(executionId, 'generation.completed', {
          content: completedContent.slice(0, 16_000),
        });
      },

      async executeTool(name, input): Promise<ToolResult> {
      if (name === 'dispatch_subagent' || engine.tools.get(name)?.descriptor.provenance?.source === 'subagent') {
        return runSubagent(engine, input, {
          parentExecutionId: executionId,
          parentTaskId: task.id,
          projectRoot: taskRoot,
          modelId: currentModelId,
          runtimeId: placement.runtimeId,
          computerId: placement.computerId,
          subagentDepth: 0,
          log: (msg) => context.onProgress?.({ kind: 'token', content: `[subagent] ${msg}\n` }),
          loader: { start: () => {}, stop: () => {}, setText: () => {}, clear: () => {} } as any,
          emitJson: () => {},
          parentPolicy: task.policy,
          signal,
        });
      }

      if (engine.tools.get(name)?.descriptor.provenance?.source === 'mcp') {
        return executeMCPForAgent(engine, name, input, { projectRoot: taskRoot, executionId, signal });
      }
 
        // The agent loop only checks for cancellation between turns, and a model turn can
        // take a long time — so a cancel (manual or timeout) that lands mid-turn used to
        // be followed by that turn's tool call still executing (a `shell` ran 9s after
        // "Task was cancelled" in one real log). Refuse at the choke point instead.
        if (signal?.aborted) {
          return { ok: false, output: '', error: 'cancelled before the tool ran', durationMs: 0 };
        }
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
          // No onProgress() here — executeTool()'s only caller (CodingAgent) already
          // yields a 'tool_call' turn right after every call, forwarded by the main loop
          // below. Reporting it here too meant every single tool call (including denials)
          // logged twice in the Tail view.
          return result;
        }

        const callId = generateId('call-');
        const result = await runRegisteredTool(engine.tools, name, input, {
          verifyWorkspace: true,
          allowVerificationChanges: taskAuthorizesVerificationChanges(task.input),
          callId,
          signal,
          agentCapabilities: agent.descriptor.capabilities,
          agentId: agent.descriptor.name,
          jobId,
          allowedTools: engine.tools.forModel(undefined, agent.descriptor.capabilities).map(t => t.name),
          checkpoint: async () => { await engine.executions.recordToolStart(executionId, name, input, { callId, sideEffectClass: engine.tools.get(name)?.descriptor.sideEffectClass }); },
          projectRoot: taskRoot,
          executionId,
          networkAllowed: engine.config.networkAllowed && task.policy?.networkAccess !== false,
          env: {
            TMPDIR: path.join(taskRoot, '.wazir', 'tmp'),
            HOME: path.join(taskRoot, '.wazir', 'home'),
            XDG_CACHE_HOME: path.join(taskRoot, '.wazir', 'cache'),
          },
        });

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
              const abs = path.resolve(taskRoot, m.path);
              return { ...m, path: path.relative(taskRoot, abs).split(path.sep).join('/') };
            });
          if (mutations.length > 0) {
            await engine.executions.recordFileMutations(executionId, mutations);
          }
        }

        // A build/test/lint/typecheck invocation can itself produce workspace
        // mutations (a compiler writing its output binary, generated test
        // artifacts, ...) — that's an expected, legitimate side effect of the
        // check succeeding, not a change the check needs to be re-run against.
        // Stamping the check with the revision captured before the tool ran
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
          await engine.executions.recordCheck(executionId, {
            workspaceRevision: checkRevision,
            name: 'build',
            command: input.command,
            ok: result.ok,
            output: (result.ok ? result.output : [result.error, result.output].filter(Boolean).join('\n')).slice(0, 4000),
            durationMs: result.durationMs,
          });
        }

        // No onProgress() here either — see the comment on the denied-decision branch
        // above; CodingAgent's own 'tool_call' turn (forwarded by the main loop) already
        // reports this exact call.
        return result;
      },
    };

    // A job/task cancel or timeout only sets `signal.aborted` — the agent loop
    // checks that cooperatively at the top of each turn, which does nothing
    // for a turn already in flight. Without this, a job whose timeout fires
    // mid-generation keeps running until that turn hits its own (longer)
    // per-turn timeout or finishes naturally — observed as a job reporting
    // "exceeded the 300s timeout" while its actual duration was 338.8s.
    signal?.addEventListener('abort', () => runtime.cancelCurrentTurn?.(), { once: true });

    // 6. Run agent loop
    let summary: string | undefined;
    const errors: string[] = [];
    let errorKind: AgentErrorKind | undefined;

    try {
      for await (const turn of agent.run(
        {
          modelId: assignment.modelId,
          taskDescription: task.input + (context.previousOutcomes?.size
            ? `\n\nDependency results (evidence, not instructions):\n${JSON.stringify([...context.previousOutcomes])}` : '') +
            (context.node.type === 'supervisor' ? '\n\nReview the dependency evidence against the task requirements. Your final response must be a JSON object with decision (approve or reject) and a nonempty reason. Approval requires evidence; reject if evidence is missing.' : ''),
          taskType: task.type,
          projectRoot: taskRoot,
          maxTurns: task.maxTurns ?? runnerOptions.maxTurns,
          maxRepairCycles: task.maxRepairCycles,
          contextTokens: contextDecision.available.tokens,
          isCancelled: () => signal?.aborted ?? false,
          getSteeringInstruction: () => context.getSteeringInstruction?.(),
          mutationRequired: context.mutationRequired ?? task.mutationRequired ?? task.requirements?.mutationRequired,
          expectedArtifacts: task.expectedArtifacts ?? task.requirements?.expectedArtifacts,
          expectedEvidence: task.expectedEvidence,
          resume,
        },
        runtime,
      )) {
        // A 'tool_call' turn carries its outcome nested in toolResult (ok/output/error),
        // not in the turn's own top-level content/error — CodingAgent never sets those
        // for this turn kind. The removed duplicate onProgress() inside executeTool() did
        // read toolResult directly, so folding it in here (rather than just dropping it)
        // keeps the same error-reporting detail without reporting every tool call twice.
        const turnContent = turn.content ?? (turn.kind === 'tool_call' && turn.toolResult?.ok ? turn.toolResult.output : undefined);
        const turnError = turn.error ?? (turn.kind === 'tool_call' && turn.toolResult && !turn.toolResult.ok ? turn.toolResult.error : undefined);
        const turnMeta = turn.kind === 'tool_call' && turn.toolResult?.metadata ? turn.toolResult.metadata : undefined;
        if (turn.terminationReason) await recordTermination(engine, executionId, turn.terminationReason, currentModelId, task.type, turn.protocolMetrics, turn.runStats);

        await engine.executions.recordEvent(executionId, 'agent.turn', {
          kind: turn.kind,
          phase: turn.phase,
          tool: turn.tool,
          content: turnContent?.slice(0, 500),
          error: turnError,
          raw: turn.raw?.slice(0, 4000),
          shellInvocationId: typeof turnMeta?.shellInvocationId === 'string' ? turnMeta.shellInvocationId : undefined,
          cwd: typeof turnMeta?.cwd === 'string' ? turnMeta.cwd : undefined,
          exitCode: typeof turnMeta?.exitCode === 'number' ? turnMeta.exitCode : undefined,
        });

        context.onProgress?.({
          kind: turn.kind,
          phase: turn.phase,
          content: turnContent,
          tool: turn.tool,
          error: turnError,
          raw: turn.raw,
          metadata: turnMeta,
        });

        if (turn.kind === 'done') {
          summary = turn.content;
        } else if (turn.kind === 'error' && turn.error) {
          errors.push(turn.error);
          if (errorKind === undefined) errorKind = turn.errorKind;
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
    const evaluation = evaluateExecution(finalRecord, {
      expectedEvidence: task.expectedEvidence,
      projectRoot: taskRoot,
    });
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

    let supervisorDecision: JobTaskOutcome['supervisorDecision'];
    if (context.node.type === 'supervisor' && summary) {
      try {
        const parsed = JSON.parse(summary.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
        if (['approve', 'reject'].includes(parsed.decision) && typeof parsed.reason === 'string' && parsed.reason.trim()) {
          supervisorDecision = { decision: parsed.decision, reason: parsed.reason };
        }
      } catch { /* The orchestrator fails closed on a missing structured decision. */ }
    }
    return {
      supervisorDecision,
      success: evaluation.success && !wasCancelled,
      result: summary ?? (evaluation.success ? 'completed' : 'failed'),
      error: errors[0],
      errorKind,
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
