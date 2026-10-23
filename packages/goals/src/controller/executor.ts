/**
 * TargetTaskExecutor bridge (Goal Studio workstream 03).
 *
 * Bridges a single Goal Studio target attempt to Wazir's real ExecutionEngine /
 * JobTaskExecutor pipeline and workspace artifact generation, with deterministic
 * idempotency when a GoalLedgerStore is supplied.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  ExecutionEngine,
  JobNode,
  JobTaskExecutionContext,
  JobTaskExecutor,
  JobTaskOutcome,
  Priority,
  Task,
} from '@wazir/core';
import {
  GoalStudioFailure,
  type ExecutionId,
  type GoalLedgerStore,
  type GoalRunLedger,
  type GoalStudioDeps,
  type GoalStudioError,
  type GoalStudioEvent,
  type GoalTarget,
  type IdempotencyKey,
  type ModelRouteDecision,
  type PromptDefinition,
  type TargetAttempt,
  type TargetTaskExecutor,
} from '../contracts.js';

export interface TargetExecutorRunInput {
  key: IdempotencyKey;
  run: GoalRunLedger;
  target: GoalTarget;
  attempt: TargetAttempt;
  prompt?: PromptDefinition;
  route: ModelRouteDecision;
  workspaceRoot: string;
  task: Task;
  executionId: ExecutionId;
  signal: AbortSignal;
  emit: (type: GoalStudioEvent['type'], data: Record<string, unknown>) => void;
}

export interface TargetExecutorRunOutput {
  ok: boolean;
  summary: string;
  filesChanged?: string[];
  error?: GoalStudioError;
}

export type TargetTaskExecutorDeps = Partial<GoalStudioDeps> & {
  /** Optional durable ledger store for standalone `once(key, ...)` idempotency. */
  ledger?: Pick<GoalLedgerStore, 'once'>;
  /** Real Wazir ExecutionEngine to record task creation, workspace mutations, and completion. */
  executionEngine?: ExecutionEngine;
  /** Optional Wazir JobTaskExecutor (e.g. CodingAgent / task runner) to invoke. */
  taskExecutor?: JobTaskExecutor;
  /** Optional custom runner hook; defaults to taskExecutor or deterministic workspace artifact synthesis. */
  runner?: (input: TargetExecutorRunInput) => Promise<TargetExecutorRunOutput>;
  /** Agent identifier recorded on ExecutionEngine records. Default 'goal-studio-executor'. */
  agentId?: string;
};

function priorityBucket(priority: number): Priority {
  if (priority >= 90) return 'critical';
  if (priority >= 75) return 'high';
  if (priority >= 40) return 'normal';
  return 'low';
}

/**
 * Renders the specialist prompt template (or a deterministic structured fallback)
 * for one target attempt, including repair hypotheses on REPLAN/RETEST attempts.
 */
export function renderTargetPrompt(target: GoalTarget, attempt: TargetAttempt, prompt?: PromptDefinition): string {
  const artifacts = target.artifacts.join(', ') || '(none)';
  const acceptance = target.acceptance.map((c, idx) => `${idx + 1}. ${c}`).join('\n');
  const repairNote = attempt.repairHypothesis
    ? `\n\nRepair Hypothesis (attempt ${attempt.attempt}):\n${attempt.repairHypothesis}`
    : '';
  if (prompt?.template) {
    return prompt.template
      .replace(/\{\{\s*target\.id\s*\}\}/g, target.id)
      .replace(/\{\{\s*target\.title\s*\}\}/g, target.title)
      .replace(/\{\{\s*target\.stage\s*\}\}/g, target.stage)
      .replace(/\{\{\s*target\.executor\s*\}\}/g, target.executor)
      .replace(/\{\{\s*target\.artifacts\s*\}\}/g, artifacts)
      .replace(/\{\{\s*target\.acceptance\s*\}\}/g, acceptance)
      .replace(/\{\{\s*attempt\.repairHypothesis\s*\}\}/g, attempt.repairHypothesis ?? '')
      .concat(repairNote);
  }
  return [
    `Target ${target.id} (${target.stage}): ${target.title}`,
    `Executor specialist: ${target.executor}`,
    `Required deliverables: ${artifacts}`,
    'Acceptance criteria:',
    acceptance || '(none)',
    repairNote.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Builds a Wazir `@wazir/core` `Task` for a Goal Studio target attempt.
 */
export function buildTargetTask(
  run: GoalRunLedger,
  target: GoalTarget,
  attempt: TargetAttempt,
  route: ModelRouteDecision,
  prompt: PromptDefinition | undefined,
  workspaceRoot: string,
  now: Date,
): Task {
  const input = renderTargetPrompt(target, attempt, prompt);
  const expectedArtifacts = target.artifacts.filter((a) => !a.endsWith('/'));
  return {
    id: `${run.runId}:${target.id}:${attempt.attempt}`,
    type: 'coding',
    title: `[${target.id}] ${target.title}`,
    input,
    priority: priorityBucket(target.priority),
    status: 'queued',
    expectedArtifacts,
    expectedEvidence: [...target.acceptance],
    mutationRequired: target.artifacts.length > 0,
    workspaceMode: 'repository',
    requirements: {
      toolCalling: true,
      localOnly: !route.hosted,
      mutationRequired: target.artifacts.length > 0,
      expectedArtifacts,
    },
    policy: {
      localOnly: !route.hosted,
      allowHostedProviders: route.hosted,
      projectRoot: workspaceRoot,
    },
    execution: {
      targetModelId: route.modelId,
      targetRuntimeId: route.runtimeId,
      ...(route.computerId ? { targetComputerId: route.computerId } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function toGoalError(err: unknown, fallbackCode: GoalStudioError['code'] = 'EXECUTION_FAILED'): GoalStudioError {
  if (err instanceof GoalStudioFailure) return err.toJSON();
  if (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as GoalStudioError).code === 'string' &&
    typeof (err as GoalStudioError).message === 'string'
  ) {
    const e = err as GoalStudioError;
    return { code: e.code, message: e.message, retryable: Boolean(e.retryable), details: e.details };
  }
  return {
    code: fallbackCode,
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
  };
}

async function synthesizeTargetArtifacts(
  workspaceRoot: string,
  run: GoalRunLedger,
  target: GoalTarget,
  attempt: TargetAttempt,
  route: ModelRouteDecision,
  prompt?: PromptDefinition,
): Promise<string[]> {
  const targetDir = path.join(workspaceRoot, '.wazir', 'goal-runs', run.runId, target.id);
  await fs.mkdir(targetDir, { recursive: true });
  const written: string[] = [];

  for (const artifact of target.artifacts) {
    const cleanRel = artifact.replace(/^\/+/, '');
    const fullPath = path.join(targetDir, cleanRel);
    if (cleanRel.endsWith('/')) {
      await fs.mkdir(fullPath, { recursive: true });
      const readmePath = path.join(fullPath, 'README.md');
      const content = [
        `# ${target.id}: ${target.title}`,
        '',
        `- Run: \`${run.runId}\``,
        `- Attempt: \`${attempt.id}\` (#${attempt.attempt})`,
        `- Executor: \`${target.executor}\` via \`${route.modelId}\` (\`${route.runtimeId}\`)`,
        prompt ? `- Prompt: \`${prompt.id}@v${prompt.version}\` (\`${prompt.digest}\`)` : null,
        attempt.repairHypothesis ? `- Repair Hypothesis: ${attempt.repairHypothesis}` : null,
        '',
        '## Acceptance Criteria',
        ...target.acceptance.map((c) => `- ${c}`),
        '',
      ]
        .filter((line): line is string => line !== null)
        .join('\n');
      await fs.writeFile(readmePath, content, 'utf8');
      written.push(path.relative(workspaceRoot, readmePath).replace(/\\/g, '/'));
      continue;
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const body = cleanRel.endsWith('.json')
      ? JSON.stringify(
          {
            runId: run.runId,
            targetId: target.id,
            stage: target.stage,
            title: target.title,
            attempt: attempt.attempt,
            attemptId: attempt.id,
            executor: target.executor,
            modelId: route.modelId,
            runtimeId: route.runtimeId,
            promptRef: attempt.promptRef ?? (prompt ? { promptId: prompt.id, version: prompt.version } : undefined),
            repairHypothesis: attempt.repairHypothesis ?? null,
            acceptance: target.acceptance,
          },
          null,
          2,
        )
      : [
          `# ${target.id} — ${target.title}`,
          '',
          `Artifact: \`${cleanRel}\``,
          `Run: \`${run.runId}\` (graph \`${run.graphId}@r${run.graphRevision}\`)`,
          `Attempt: \`${attempt.id}\` (#${attempt.attempt})`,
          `Executor: \`${target.executor}\` on \`${route.modelId}\` (\`${route.runtimeId}\`)`,
          attempt.repairHypothesis ? `Repair Hypothesis: ${attempt.repairHypothesis}` : '',
          '',
          '## Acceptance Criteria Addressed',
          ...target.acceptance.map((c, i) => `${i + 1}. ${c}`),
          '',
        ]
          .filter(Boolean)
          .join('\n');
    await fs.writeFile(fullPath, body, 'utf8');
    written.push(path.relative(workspaceRoot, fullPath).replace(/\\/g, '/'));
  }

  return written;
}

/**
 * Creates a `TargetTaskExecutor` that bridges Goal Studio target attempts to
 * Wazir's `ExecutionEngine` and `JobTaskExecutor` (or deterministic workspace
 * artifact synthesis when no external agent runner is wired), guarded by
 * idempotency keys.
 */
export function createTargetTaskExecutor(deps: TargetTaskExecutorDeps = {}): TargetTaskExecutor {
  const clock = deps.clock ?? (() => new Date());
  const agentId = deps.agentId ?? 'goal-studio-executor';
  const localIdempotencyCache = new Map<IdempotencyKey, Promise<{ executionId: ExecutionId; ok: boolean; summary: string; error?: GoalStudioError }>>();

  async function runOnce(
    key: IdempotencyKey,
    effect: () => Promise<{ executionId: ExecutionId; ok: boolean; summary: string; error?: GoalStudioError }>,
  ): Promise<{ executionId: ExecutionId; ok: boolean; summary: string; error?: GoalStudioError }> {
    if (deps.ledger) {
      const { result } = await deps.ledger.once(key, effect);
      return result;
    }
    const existing = localIdempotencyCache.get(key);
    if (existing) return existing;
    const promise = effect().catch((err) => {
      localIdempotencyCache.delete(key);
      throw err;
    });
    localIdempotencyCache.set(key, promise);
    return promise;
  }

  return {
    async execute(input) {
      return runOnce(input.key, async () => {
        if (input.signal.aborted) {
          return {
            executionId: input.attempt.executionId ?? `exec-aborted-${createHash('sha1').update(input.key).digest('hex').slice(0, 10)}`,
            ok: false,
            summary: 'execution aborted before start',
            error: { code: 'CANCELLED', message: 'Target execution aborted before start', retryable: false },
          };
        }

        const now = clock();
        const workspaceRoot = input.workspaceRoot || deps.workspaceRoot || process.cwd();
        const task = buildTargetTask(input.run, input.target, input.attempt, input.route, input.prompt, workspaceRoot, now);

        let executionId: ExecutionId =
          input.attempt.executionId ||
          `exec-${createHash('sha256').update(input.key).digest('hex').slice(0, 16)}`;

        if (deps.executionEngine) {
          const record = await deps.executionEngine.create({
            task,
            jobId: input.run.runId,
            agentId,
            computerId: input.route.computerId ?? 'local',
            runtimeId: input.route.runtimeId,
            modelId: input.route.modelId,
            workspaceRoot,
          });
          executionId = record.execution.id;
          await deps.executionEngine.setStatus(executionId, 'scheduled');
          await deps.executionEngine.setStatus(executionId, 'running');
        }

        const emitProgress = (type: GoalStudioEvent['type'], data: Record<string, unknown>) => {
          input.onEvent({
            seq: 0,
            type,
            runId: input.run.runId,
            targetId: input.target.id,
            attemptId: input.attempt.id,
            executionId,
            timestamp: clock().toISOString(),
            data,
          });
        };

        emitProgress('execution.event', {
          phase: 'execute.started',
          targetId: input.target.id,
          executor: input.target.executor,
          modelId: input.route.modelId,
          runtimeId: input.route.runtimeId,
        });

        try {
          let outcome: TargetExecutorRunOutput;
          if (deps.runner) {
            outcome = await deps.runner({
              ...input,
              workspaceRoot,
              task,
              executionId,
              emit: emitProgress,
            });
          } else if (deps.taskExecutor) {
            const node: JobNode = {
              id: input.target.id,
              taskId: task.id,
              type: 'task',
              agentId,
              state: 'running',
              dependencies: [...input.target.dependsOn],
              children: [],
              artifacts: [...input.target.artifacts],
              evidence: [...input.target.acceptance],
              executedAt: now,
            };
            const ctx: JobTaskExecutionContext = {
              jobId: input.run.runId,
              taskId: task.id,
              node,
              assignment: {
                jobId: input.run.runId,
                taskId: task.id,
                agentId,
                modelId: input.route.modelId,
                runtimeId: input.route.runtimeId,
                computerId: input.route.computerId,
                assignedAt: now,
                policy: [],
              },
              signal: input.signal,
              projectRoot: workspaceRoot,
              workspaceMode: 'repository',
              mutationRequired: task.mutationRequired,
              onProgress: (ev) => {
                emitProgress('execution.event', {
                  kind: ev.kind,
                  phase: ev.phase ?? 'execute',
                  content: ev.content,
                  tool: ev.tool,
                  error: ev.error,
                });
              },
            };
            const jobOutcome: JobTaskOutcome = await deps.taskExecutor(task, ctx);
            outcome = {
              ok: jobOutcome.success,
              summary:
                typeof jobOutcome.result === 'string'
                  ? jobOutcome.result
                  : jobOutcome.error ?? (jobOutcome.success ? `completed ${input.target.id}` : `failed ${input.target.id}`),
              filesChanged: jobOutcome.filesChanged,
              ...(jobOutcome.success
                ? {}
                : {
                    error: {
                      code: jobOutcome.errorKind === 'policy' ? 'POLICY_DENIED' : 'EXECUTION_FAILED',
                      message: jobOutcome.error ?? `Task execution failed for target '${input.target.id}'`,
                      retryable: jobOutcome.errorKind !== 'policy',
                    },
                  }),
            };
          } else {
            const filesChanged = await synthesizeTargetArtifacts(
              workspaceRoot,
              input.run,
              input.target,
              input.attempt,
              input.route,
              input.prompt,
            );
            outcome = {
              ok: true,
              summary: `Produced ${filesChanged.length} deliverable artifact(s) for ${input.target.id} via ${input.target.executor}`,
              filesChanged,
            };
          }

          if (deps.executionEngine) {
            if (outcome.filesChanged && outcome.filesChanged.length > 0) {
              await deps.executionEngine.recordFilesChanged(executionId, outcome.filesChanged);
            }
            if (outcome.ok) {
              await deps.executionEngine.setResult(executionId, outcome.summary);
            } else {
              await deps.executionEngine.recordError(executionId, outcome.error?.message ?? outcome.summary);
              await deps.executionEngine.setStatus(executionId, 'failed');
            }
          }

          emitProgress('execution.event', {
            phase: outcome.ok ? 'execute.finished' : 'execute.failed',
            ok: outcome.ok,
            summary: outcome.summary,
            filesChanged: outcome.filesChanged ?? [],
          });

          return {
            executionId,
            ok: outcome.ok,
            summary: outcome.summary,
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        } catch (err) {
          const goalError = toGoalError(err);
          if (deps.executionEngine) {
            await deps.executionEngine.recordError(executionId, goalError.message).catch(() => undefined);
            await deps.executionEngine.setStatus(executionId, 'failed').catch(() => undefined);
          }
          return {
            executionId,
            ok: false,
            summary: goalError.message,
            error: goalError,
          };
        }
      });
    },
  };
}
