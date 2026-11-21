import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GoalStudioServices, ModelRouteDecision } from '../contracts.js';
import type { LoopItemSpec, WorkflowPlanRecord, WorkflowTargetHandler } from './contracts.js';

export interface WorkflowExecutorDeps {
  workspaceRoot: string;
  clock?: () => Date;
  getPlan?: (runId: string) => WorkflowPlanRecord | undefined | Promise<WorkflowPlanRecord | undefined>;
  targetHandler?: WorkflowTargetHandler;
  modelExecutor?: WorkflowTargetHandler;
}

function findLoopItem(plan: WorkflowPlanRecord | undefined, targetId: string): LoopItemSpec | undefined {
  if (!plan) return undefined;
  const direct = plan.loop?.items.find((item) => item.targetId === targetId);
  if (direct) return direct;
  for (const nested of plan.nestedLoops ?? []) {
    const found = nested.loop.items.find((item) => item.targetId === targetId);
    if (found) return found;
  }
  return undefined;
}

export function createWorkflowTargetExecutor(deps: WorkflowExecutorDeps): GoalStudioServices['executor'] {
  const now = () => (deps.clock ? deps.clock() : new Date()).toISOString();

  return {
    async execute(input) {
      const { run, target, attempt, route, signal } = input;
      if (signal.aborted) {
        return {
          executionId: `exec:${attempt.id}:aborted`,
          ok: false,
          summary: 'Target execution aborted',
          error: { code: 'CANCELLED', message: 'execution aborted', retryable: true },
        };
      }

      const plan = deps.getPlan ? await deps.getPlan(run.runId) : undefined;
      const loopItem = findLoopItem(plan, target.id);
      const workspaceRoot = plan?.workspaceRoot || input.workspaceRoot || deps.workspaceRoot;
      const primaryArtifact = target.artifacts[0] ?? `.wazir/artifacts/${run.graphId}/${target.id}.json`;
      const absArtifact = path.resolve(workspaceRoot, primaryArtifact);
      const artifactDir = path.dirname(absArtifact);
      const routedModel: ModelRouteDecision | undefined = route;

      const ctx = {
        run,
        target,
        attempt: attempt.attempt,
        repairHypothesis: attempt.repairHypothesis,
        plan,
        loopItem,
        workspaceRoot,
        artifactDir,
        model: routedModel
          ? {
              modelId: routedModel.modelId,
              runtimeId: routedModel.runtimeId,
              computerId: routedModel.computerId,
              hosted: routedModel.hosted,
            }
          : undefined,
        signal,
      };

      try {
        if (deps.targetHandler) {
          const custom = await deps.targetHandler(ctx);
          if (custom.ok && target.artifacts.length > 0 && custom.claimedDone !== false && !custom.filesWritten) {
            const exists = await fs
              .stat(absArtifact)
              .then((s) => s.size > 0)
              .catch(() => false);
            if (!exists) {
              await fs.mkdir(path.dirname(absArtifact), { recursive: true });
              await fs.writeFile(
                absArtifact,
                JSON.stringify(
                  {
                    targetId: target.id,
                    runId: run.runId,
                    attempt: attempt.attempt,
                    summary: custom.summary,
                    model: ctx.model,
                    completedAt: now(),
                  },
                  null,
                  2,
                ),
                'utf8',
              );
            }
          }
          return {
            executionId: custom.executorIdentity ?? `exec:${attempt.id}`,
            ok: custom.ok,
            summary: custom.summary,
            producedArtifacts: custom.filesWritten ?? target.artifacts,
            output: custom.output,
            error: custom.error
              ? {
                  code: 'EXECUTION_FAILED',
                  message: custom.error.message,
                  retryable: custom.error.retryable,
                  failureClass: custom.error.failureClass,
                }
              : undefined,
          };
        }

        if (deps.modelExecutor) {
          const modRes = await deps.modelExecutor(ctx);
          if (!modRes.ok) {
            return {
              executionId: modRes.executorIdentity ?? `exec:${attempt.id}`,
              ok: false,
              summary: modRes.summary,
              producedArtifacts: modRes.filesWritten ?? [],
              error: {
                code: 'EXECUTION_FAILED',
                message: modRes.error?.message ?? modRes.summary,
                retryable: modRes.error?.retryable ?? true,
                failureClass: modRes.error?.failureClass,
              },
            };
          }
          const exists = await fs
            .stat(absArtifact)
            .then((s) => s.size > 0)
            .catch(() => false);
          if (!exists) {
            await fs.mkdir(path.dirname(absArtifact), { recursive: true });
            await fs.writeFile(
              absArtifact,
              JSON.stringify(
                {
                  targetId: target.id,
                  runId: run.runId,
                  attempt: attempt.attempt,
                  mode: plan?.mode ?? 'graph',
                  item: loopItem,
                  summary: modRes.summary,
                  output: modRes.output,
                  filesWritten: modRes.filesWritten ?? [],
                  model: ctx.model,
                  completedAt: now(),
                },
                null,
                2,
              ),
              'utf8',
            );
          }
          return {
            executionId: modRes.executorIdentity ?? `exec:${attempt.id}`,
            ok: true,
            summary: modRes.summary,
            producedArtifacts: [primaryArtifact, ...(modRes.filesWritten ?? [])],
            output: modRes.output,
          };
        }

        let inspectedItemBytes: number | undefined;
        if (loopItem?.path) {
          const itemAbs = path.resolve(workspaceRoot, loopItem.path);
          inspectedItemBytes = await fs
            .stat(itemAbs)
            .then((s) => s.size)
            .catch(() => undefined);
        }

        await fs.mkdir(path.dirname(absArtifact), { recursive: true });
        const payload = {
          targetId: target.id,
          runId: run.runId,
          graphId: run.graphId,
          attempt: attempt.attempt,
          stage: target.stage,
          mode: plan?.mode ?? 'graph',
          item: loopItem,
          inspectedItemBytes,
          repairHypothesis: attempt.repairHypothesis,
          summary: `Executed ${target.title}`,
          model: ctx.model ?? { modelId: 'local-deterministic', runtimeId: 'wazir-local', computerId: 'local', hosted: false },
          completedAt: now(),
        };
        await fs.writeFile(absArtifact, JSON.stringify(payload, null, 2), 'utf8');

        return {
          executionId: `exec:${attempt.id}`,
          ok: true,
          summary: payload.summary,
          producedArtifacts: [primaryArtifact],
          output: payload,
        };
      } catch (err) {
        return {
          executionId: `exec:${attempt.id}:error`,
          ok: false,
          summary: (err as Error).message,
          error: {
            code: 'EXECUTION_FAILED',
            message: (err as Error).message,
            retryable: true,
          },
        };
      }
    },
  };
}
