import {
  GoalStudioFailure,
  type EvidenceRecord,
  type GoalGraphDefinition,
  type GoalGraphRevisionRecord,
  type GoalRunId,
  type GoalRunLedger,
  type GoalRunStatus,
  type GoalStudioEvent,
  type GoalStudioServices,
  type ModelRouteDecision,
  type ModelRouter,
  type TargetId,
} from '../contracts.js';
import { createGoalController, type ContinuousGoalController } from '../controller/index.js';
import { createGoalGovernance } from '../governance/index.js';
import { createGoalGraphStore, type GoalGraphStoreExtended } from '../graph/index.js';
import { createGoalEventLog, createLedgerStore, type DurableGoalEventLog } from '../ledger/index.js';
import { createPromptStore } from '../prompts/index.js';
import { createRecoveryService, type RepairHypothesisGenerator } from '../recovery/index.js';
import { createVerificationService, type CheckRunner, type DeclaredCheck } from '../verification/index.js';
import type { KeyValueStore } from '@wazir/shared';
import { compileWorkflow } from './goalCompiler.js';
import { createWorkflowTargetExecutor } from './executor.js';
import {
  WORKFLOW_STORE_KEYS,
  type WorkflowCompileRequest,
  type WorkflowControlSignal,
  type WorkflowInspection,
  type WorkflowJobSummary,
  type WorkflowMode,
  type WorkflowPlanRecord,
  type WorkflowTargetHandler,
} from './contracts.js';

export interface WorkflowRuntimeDeps {
  store: KeyValueStore;
  workspaceRoot: string;
  clock?: () => Date;
  holderId?: string;
  leaseTtlMs?: number;
  router?: ModelRouter;
  defaultModel?: string;
  defaultComputer?: string;
  checkRunner?: CheckRunner;
  targetHandler?: WorkflowTargetHandler;
  modelExecutor?: WorkflowTargetHandler;
  hypothesisGenerator?: RepairHypothesisGenerator;
  autoAdvance?: boolean;
}

export interface WorkflowRuntimeService {
  readonly graphs: GoalGraphStoreExtended;
  readonly ledger: ReturnType<typeof createLedgerStore>;
  readonly events: DurableGoalEventLog;
  readonly controller: ContinuousGoalController;
  compile(request: WorkflowCompileRequest): Promise<{
    graph: GoalGraphRevisionRecord;
    plan: WorkflowPlanRecord;
    validation: ReturnType<typeof compileWorkflow>['validation'];
  }>;
  start(
    request: WorkflowCompileRequest & { autoAdvance?: boolean },
  ): Promise<{ run: GoalRunLedger; plan: WorkflowPlanRecord; graph: GoalGraphRevisionRecord }>;
  executeToCompletion(
    request: WorkflowCompileRequest & {
      interruptAfterCompletedTargets?: number;
      onEvent?: (event: GoalStudioEvent) => void;
    },
  ): Promise<{ run: GoalRunLedger; plan: WorkflowPlanRecord; evidence: EvidenceRecord[]; interrupted?: boolean }>;
  listJobs(filter?: { status?: GoalRunStatus; mode?: WorkflowMode; projectId?: string }): Promise<WorkflowJobSummary[]>;
  getStatus(runId: GoalRunId): Promise<WorkflowJobSummary | undefined>;
  inspect(runId: GoalRunId): Promise<WorkflowInspection | undefined>;
  pause(runId: GoalRunId, actor?: string, reason?: string): Promise<GoalRunLedger>;
  resume(runId: GoalRunId, actor?: string, options?: { wait?: boolean }): Promise<GoalRunLedger>;
  stop(runId: GoalRunId, actor?: string, reason?: string): Promise<GoalRunLedger>;
  approve(runId: GoalRunId, targetId: TargetId, actor?: string, note?: string): Promise<GoalRunLedger>;
  recover(options?: { wait?: boolean }): Promise<GoalRunLedger[]>;
  replan(
    runId: GoalRunId,
    mutate: (definition: GoalGraphDefinition) => GoalGraphDefinition,
    actor?: string,
  ): Promise<GoalGraphRevisionRecord>;
  shutdown(options?: { releaseLeases?: boolean }): Promise<void>;
}

function summarizeRun(run: GoalRunLedger, plan: WorkflowPlanRecord | undefined, graphName?: string): WorkflowJobSummary {
  const entries = Object.values(run.targets);
  let completed = 0;
  let active = 0;
  let blocked = 0;
  let failed = 0;
  let queued = 0;
  let needsApproval = 0;

  for (const t of entries) {
    if (t.status === 'completed') completed += 1;
    else if (t.status === 'active' || t.status === 'verifying' || t.status === 'verified' || t.status === 'repairing') active += 1;
    else if (t.status === 'blocked' || t.status === 'stopped') blocked += 1;
    else if (t.status === 'failed') failed += 1;
    else queued += 1;
    if (t.status === 'needs_approval' || (t.status === 'verified' && t.blockers.some((b) => /approval/i.test(b)))) {
      needsApproval += 1;
    }
  }

  let cursor: number | undefined;
  if (plan?.loop) {
    cursor = plan.loop.items.filter((item) => {
      const s = run.targets[item.targetId]?.status;
      return s === 'completed' || s === 'blocked' || s === 'stopped';
    }).length;
  }

  return {
    runId: run.runId,
    graphId: run.graphId,
    graphRevision: run.graphRevision,
    projectId: plan?.projectId ?? 'wazir-default',
    mode: plan?.mode ?? 'graph',
    originInterface: plan?.originInterface ?? 'cli',
    status: run.status,
    prompt: plan?.prompt ?? graphName ?? run.graphId,
    createdBy: run.createdBy,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    progress: {
      total: entries.length,
      completed,
      active,
      blocked,
      failed,
      queued,
      needsApproval,
      cursor,
    },
  };
}

export function createWorkflowRuntimeService(deps: WorkflowRuntimeDeps): WorkflowRuntimeService {
  const store = deps.store;
  const clock = deps.clock ?? (() => new Date());
  const now = () => clock().toISOString();
  const planCache = new Map<string, WorkflowPlanRecord>();

  const baseDeps = { store, workspaceRoot: deps.workspaceRoot, clock };
  const graphs = createGoalGraphStore(baseDeps);
  const ledger = createLedgerStore(baseDeps);
  const events = createGoalEventLog(baseDeps);
  const prompts = createPromptStore(baseDeps);
  const governance = createGoalGovernance(baseDeps);
  const recovery = createRecoveryService({ ...baseDeps, hypothesisGenerator: deps.hypothesisGenerator });

  const loadPlanForRun = async (runId: GoalRunId): Promise<WorkflowPlanRecord | undefined> => {
    const cached = planCache.get(runId);
    if (cached) return cached;
    const stored = await store.get<WorkflowPlanRecord>(WORKFLOW_STORE_KEYS.run(runId));
    if (stored) {
      planCache.set(runId, stored);
      return stored;
    }
    return undefined;
  };

  const verification = createVerificationService({
    ...baseDeps,
    events,
    checks: deps.checkRunner,
    plan: async ({ run, target }): Promise<DeclaredCheck[]> => {
      const plan = await loadPlanForRun(run.runId);
      const declared = plan?.targetChecks[target.id];
      if (declared && declared.length > 0) return declared;
      const fallback: DeclaredCheck[] = [];
      for (let i = 0; i < target.artifacts.length; i += 1) {
        fallback.push({
          id: `auto-non-empty-${i + 1}`,
          kind: 'non-empty',
          artifact: target.artifacts[i]!,
          criterion: target.acceptance[Math.min(i, target.acceptance.length - 1)] ?? '#1',
        });
      }
      return fallback;
    },
  });

  const router: ModelRouter = deps.router ?? {
    async route(input): Promise<ModelRouteDecision> {
      const modelId = deps.defaultModel ?? 'local-deterministic';
      const looksHosted =
        /\b(gpt-4|gpt-5|claude-|gemini-|o1|o3|sonnet|opus|openai|anthropic|hosted)/i.test(modelId) &&
        !deps.defaultComputer;
      if (looksHosted && input.remainingHostedBudgetUsd <= 0) {
        return {
          modelId,
          runtimeId: 'hosted-blocked',
          computerId: 'hosted',
          hosted: true,
          estimatedCostUsd: 0.05,
          reasons: ['Hosted model selected with remainingHostedBudgetUsd=0; subject to governance spend check'],
          rejected: [],
          decidedAt: now(),
        };
      }
      return {
        modelId,
        runtimeId: 'wazir-local',
        computerId: deps.defaultComputer ?? 'local',
        hosted: false,
        estimatedCostUsd: 0,
        reasons: ['local-first verified workflow router'],
        rejected: [],
        decidedAt: now(),
      };
    },
  };

  const executor = createWorkflowTargetExecutor({
    workspaceRoot: deps.workspaceRoot,
    clock,
    getPlan: loadPlanForRun,
    targetHandler: deps.targetHandler,
    modelExecutor: deps.modelExecutor,
  });

  const services: Omit<GoalStudioServices, 'controller'> = {
    graphs,
    ledger,
    prompts,
    router,
    governance,
    executor,
    verification,
    recovery,
    events,
  };

  const controller = createGoalController({
    store,
    workspaceRoot: deps.workspaceRoot,
    clock,
    services,
    holderId: deps.holderId ?? `wazir-workflow:${process.pid}`,
    leaseTtlMs: deps.leaseTtlMs ?? 30_000,
    autoStart: true,
    autoAdvance: deps.autoAdvance ?? true,
  });

  const controlMonitors = new Map<string, ReturnType<typeof setInterval>>();

  const stopControlMonitor = (runId: GoalRunId) => {
    const existing = controlMonitors.get(runId);
    if (existing) {
      clearInterval(existing);
      controlMonitors.delete(runId);
    }
  };

  const pollControlSignal = async (runId: GoalRunId): Promise<'pause' | 'stop' | undefined> => {
    try {
      const signal = await store.get<WorkflowControlSignal>(WORKFLOW_STORE_KEYS.control(runId));
      if (!signal || signal.acknowledgedAt) return undefined;
      if (signal.action === 'pause') {
        await controller.pause(runId, signal.actor).catch(() => undefined);
        await store.put(WORKFLOW_STORE_KEYS.control(runId), { ...signal, acknowledgedAt: now() }).catch(() => undefined);
        stopControlMonitor(runId);
        return 'pause';
      }
      if (signal.action === 'stop') {
        await controller.stop(runId, signal.actor).catch(() => undefined);
        await store.put(WORKFLOW_STORE_KEYS.control(runId), { ...signal, acknowledgedAt: now() }).catch(() => undefined);
        stopControlMonitor(runId);
        return 'stop';
      }
    } catch {
      // Ignore transient store errors during teardown
    }
    return undefined;
  };

  const startControlMonitor = (runId: GoalRunId) => {
    stopControlMonitor(runId);
    const timer = setInterval(() => {
      void pollControlSignal(runId);
    }, 50);
    if (typeof timer.unref === 'function') timer.unref();
    controlMonitors.set(runId, timer);
  };

  const syncLoopCursor = (plan: WorkflowPlanRecord | undefined, run: GoalRunLedger | undefined): WorkflowPlanRecord | undefined => {
    if (!plan) return undefined;
    if (!plan.loop || !run) return plan;
    const doneCount = plan.loop.items.filter((item) => {
      const s = run.targets[item.targetId]?.status;
      return s === 'completed' || s === 'blocked' || s === 'stopped';
    }).length;
    return {
      ...plan,
      updatedAt: run.updatedAt,
      loop: {
        ...plan.loop,
        cursor: doneCount,
      },
    };
  };

  const isLeaseHeldError = (err: unknown): boolean =>
    err instanceof GoalStudioFailure &&
    (err.code === 'STALE_LEASE' || err.code === 'LEDGER_CONFLICT' || /(lease|another controller)/i.test(err.message));

  return {
    graphs,
    ledger,
    events,
    controller,

    async compile(request) {
      const actor = request.actor ?? 'user:local';
      const compiled = compileWorkflow(request);
      if (!compiled.validation.valid) {
        throw new GoalStudioFailure(
          'VALIDATION',
          `Compiled workflow failed DAG validation: ${compiled.validation.issues[0]?.message ?? 'invalid graph'}`,
          { details: { issues: compiled.validation.issues } },
        );
      }
      if (compiled.plan.explanation.policyAssessment.blockedUnsafeActions.length > 0 && !request.approveAll) {
        throw new GoalStudioFailure(
          'VALIDATION',
          `Policy rejected unsafe request: ${compiled.plan.explanation.policyAssessment.blockedUnsafeActions.join('; ')}`,
          { details: { policyFlags: compiled.plan.explanation.signals.policyFlags, policyViolation: true } },
        );
      }

      const { record: graph } = await graphs.createGraph(compiled.plan.projectId, compiled.definition, actor);
      const ts = now();
      const plan: WorkflowPlanRecord = {
        ...compiled.plan,
        graphId: graph.graphId,
        graphRevision: graph.revision,
        createdAt: ts,
        updatedAt: ts,
      };
      await store.put(WORKFLOW_STORE_KEYS.compiled(graph.graphId, graph.revision), plan);
      return { graph, plan, validation: compiled.validation };
    },

    async start(request) {
      const { graph, plan: compiledPlan } = await this.compile(request);
      const actor = request.actor ?? 'user:local';
      if (request.dryRun) {
        const previewRun = await ledger.createRun({ graph, createdBy: actor });
        const plan: WorkflowPlanRecord = {
          ...compiledPlan,
          runId: previewRun.runId,
          dryRun: true,
          updatedAt: now(),
        };
        planCache.set(previewRun.runId, plan);
        await store.put(WORKFLOW_STORE_KEYS.run(previewRun.runId), plan);
        return { run: previewRun, plan, graph };
      }

      const started = await controller.startRun({
        graphId: graph.graphId,
        graphRevision: graph.revision,
        principal: actor,
      });

      const plan: WorkflowPlanRecord = {
        ...compiledPlan,
        runId: started.runId,
        dryRun: false,
        updatedAt: now(),
      };
      planCache.set(started.runId, plan);
      await store.put(WORKFLOW_STORE_KEYS.run(started.runId), plan);
      startControlMonitor(started.runId);
      return { run: started, plan, graph };
    },

    async executeToCompletion(request) {
      const { run: initialRun, plan: initialPlan } = await this.start(request);
      const collectedEvidence = (): Promise<EvidenceRecord[]> => verification.evidence(initialRun.runId);

      if (request.dryRun) {
        return { run: initialRun, plan: initialPlan, evidence: [] };
      }

      let unsub: (() => void) | undefined;
      if (request.onEvent) {
        unsub = events.subscribe(initialRun.runId, request.onEvent);
      }

      let interrupted = false;
      startControlMonitor(initialRun.runId);

      try {
        if (request.interruptAfterCompletedTargets && request.interruptAfterCompletedTargets > 0) {
          const threshold = request.interruptAfterCompletedTargets;
          await new Promise<void>((resolve) => {
            let done = false;
            let poll: ReturnType<typeof setInterval> | undefined;
            let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
            let unsubCheck: (() => void) | undefined;

            const cleanup = () => {
              done = true;
              if (poll) clearInterval(poll);
              if (timeoutHandle) clearTimeout(timeoutHandle);
              if (unsubCheck) unsubCheck();
            };

            const check = async () => {
              if (done) return;
              try {
                const cur = await ledger.getRun(initialRun.runId);
                if (done || !cur) return;
                const completedCount = Object.values(cur.targets).filter((t) => t.status === 'completed').length;
                if (
                  completedCount >= threshold ||
                  cur.status === 'completed' ||
                  cur.status === 'stopped' ||
                  cur.status === 'failed' ||
                  cur.status === 'paused' ||
                  cur.status === 'idle'
                ) {
                  cleanup();
                  if (completedCount >= threshold && cur.status === 'running') {
                    interrupted = true;
                    await controller.pause(initialRun.runId, request.actor ?? 'user:local').catch(() => undefined);
                  }
                  resolve();
                }
              } catch {
                // Ignore store race during shutdown
              }
            };

            unsubCheck = events.subscribe(initialRun.runId, () => {
              void check();
            });
            poll = setInterval(() => {
              void check();
            }, 30);
            timeoutHandle = setTimeout(() => {
              if (!done) {
                cleanup();
                resolve();
              }
            }, 60_000);
            void check();
          });
        } else {
          await controller.settled(initialRun.runId);
        }
      } finally {
        stopControlMonitor(initialRun.runId);
        if (unsub) unsub();
      }

      const finalRun = (await ledger.getRun(initialRun.runId)) ?? initialRun;
      const updatedPlan = syncLoopCursor(initialPlan, finalRun) ?? initialPlan;
      await store.put(WORKFLOW_STORE_KEYS.run(initialRun.runId), updatedPlan);
      const evidence = await collectedEvidence();
      return { run: finalRun, plan: updatedPlan, evidence, interrupted };
    },

    async listJobs(filter) {
      const runs = await ledger.listRuns(filter?.status ? { status: filter.status } : undefined);
      const out: WorkflowJobSummary[] = [];
      for (const run of runs) {
        const plan = syncLoopCursor(await loadPlanForRun(run.runId), run);
        if (filter?.mode && plan?.mode !== filter.mode) continue;
        if (filter?.projectId && plan?.projectId !== filter.projectId) continue;
        const graph = await graphs.getGraph(run.graphId).catch(() => undefined);
        out.push(summarizeRun(run, plan, graph?.name));
      }
      return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getStatus(runId) {
      const run = await ledger.getRun(runId);
      if (!run) return undefined;
      const plan = syncLoopCursor(await loadPlanForRun(runId), run);
      const graph = await graphs.getGraph(run.graphId).catch(() => undefined);
      return summarizeRun(run, plan, graph?.name);
    },

    async inspect(runId) {
      const run = await ledger.getRun(runId);
      if (!run) return undefined;
      const graph = await graphs.getRevision(run.graphId, run.graphRevision);
      if (!graph) return undefined;
      const plan = syncLoopCursor(await loadPlanForRun(runId), run);
      const summary = summarizeRun(run, plan, graph.definition.name);
      const evidence = await verification.evidence(runId);
      const evLog = await events.read(runId, 0, 500);
      return {
        summary,
        run,
        graph,
        plan,
        targets: graph.definition.targets,
        evidence,
        events: evLog,
      };
    },

    async pause(runId, actor = 'user:local', reason) {
      try {
        return await controller.pause(runId, actor);
      } catch (err) {
        if (isLeaseHeldError(err)) {
          await store.put(WORKFLOW_STORE_KEYS.control(runId), {
            runId,
            action: 'pause',
            actor,
            reason,
            requestedAt: now(),
          } satisfies WorkflowControlSignal);
          for (let i = 0; i < 30; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
            const cur = await ledger.getRun(runId);
            if (cur && cur.status === 'paused') return cur;
          }
        }
        throw err;
      }
    },

    async resume(runId, actor = 'user:local', options) {
      const resumed = await controller.resume(runId, actor);
      if (options?.wait) {
        const controlTimer = setInterval(() => {
          void pollControlSignal(runId);
        }, 100);
        try {
          await controller.settled(runId);
        } finally {
          clearInterval(controlTimer);
        }
        return (await ledger.getRun(runId)) ?? resumed;
      }
      return resumed;
    },

    async stop(runId, actor = 'user:local', reason) {
      try {
        return await controller.stop(runId, actor);
      } catch (err) {
        if (isLeaseHeldError(err)) {
          await store.put(WORKFLOW_STORE_KEYS.control(runId), {
            runId,
            action: 'stop',
            actor,
            reason,
            requestedAt: now(),
          } satisfies WorkflowControlSignal);
          for (let i = 0; i < 30; i += 1) {
            await new Promise((r) => setTimeout(r, 100));
            const cur = await ledger.getRun(runId);
            if (cur && cur.status === 'stopped') return cur;
          }
        }
        throw err;
      }
    },

    async approve(runId, targetId, actor = 'user:local', note) {
      return controller.resolveApproval(runId, targetId, {
        granted: true,
        principal: actor,
        reason: note ?? 'Explicit operator approval',
      });
    },

    async recover(options) {
      const runIds = await controller.recoverRuns();
      const out: GoalRunLedger[] = [];
      for (const runId of runIds) {
        if (options?.wait) {
          await controller.settled(runId);
        }
        const cur = await ledger.getRun(runId);
        if (cur) out.push(cur);
      }
      return out;
    },

    async replan(runId, mutate, actor = 'user:local') {
      const run = await ledger.getRun(runId);
      if (!run) throw new GoalStudioFailure('NOT_FOUND', `run ${runId} not found`);
      const current = await graphs.getRevision(run.graphId, run.graphRevision);
      if (!current) throw new GoalStudioFailure('NOT_FOUND', `graph ${run.graphId} revision ${run.graphRevision} not found`);
      const nextDef = mutate(structuredClone(current.definition));
      return graphs.createRevision(run.graphId, nextDef, actor, current.revision);
    },

    async shutdown(options) {
      for (const timer of controlMonitors.values()) {
        clearInterval(timer);
      }
      controlMonitors.clear();
      await controller.shutdown(options);
    },
  };
}
