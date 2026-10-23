/**
 * Reference GoalController over the GoalStudioServices contract. It is a test
 * double that encodes the controller invariants (only `completed` unlocks,
 * pinned revisions, once()-guarded side effects, lease-fenced commits,
 * resume-from-ledger after restart). It is intentionally sequential
 * (maxConcurrentTargets is treated as 1).
 */
import { randomUUID } from 'node:crypto';
import {
  GoalStudioFailure,
  UNLOCKING_TARGET_STATUSES,
  idempotencyKey,
  type AcceptanceGateDecision,
  type GoalController,
  type GoalGraphDefinition,
  type GoalGraphRevisionRecord,
  type GoalPhase,
  type GoalRunId,
  type GoalRunLedger,
  type GoalRunStatus,
  type GoalStudioError,
  type GoalStudioEventType,
  type GoalStudioServices,
  type GoalTarget,
  type RunLease,
  type TargetAttempt,
  type TargetId,
  type TargetStatus,
  type TargetTransition,
} from '../../../packages/goals/src/contracts.js';
import { fail, systemClock, type Clock } from './util.js';

const PICKABLE: readonly TargetStatus[] = ['queued', 'eligible'];
const TERMINAL_RUN: readonly GoalRunStatus[] = ['completed', 'stopped', 'failed'];
const IN_FLIGHT: readonly TargetStatus[] = ['active', 'verifying', 'verified'];

/** Pure eligibility: queued/eligible targets whose dependencies are all `completed`, by priority desc then id. */
export function referenceEligibleTargets(run: GoalRunLedger, graph: GoalGraphDefinition): TargetId[] {
  const status = (id: TargetId) => run.targets[id]?.status;
  return graph.targets
    .filter((t) => PICKABLE.includes(status(t.id) ?? 'queued') && t.dependsOn.every((d) => UNLOCKING_TARGET_STATUSES.includes(status(d) as TargetStatus)))
    .sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((t) => t.id);
}

export interface FakeControllerOptions {
  services: Omit<GoalStudioServices, 'controller'>;
  workspaceRoot: string;
  holderId?: string;
  leaseTtlMs?: number;
  clock?: Clock;
  /** Continue to the next eligible target automatically after each one (default true). */
  autoAdvance?: boolean;
  /** Start executing as soon as a run is started (default false: callers use runEligible). */
  autoStart?: boolean;
}

interface RunCtx {
  lease: RunLease;
  graph: GoalGraphRevisionRecord;
  loop?: Promise<void>;
  abort: AbortController;
}

export class FakeGoalController implements GoalController {
  private readonly s: Omit<GoalStudioServices, 'controller'>;
  private readonly holderId: string;
  private readonly ttl: number;
  private readonly clock: Clock;
  private readonly runs = new Map<GoalRunId, RunCtx>();
  private readonly autoAdvance: boolean;
  private readonly autoStart: boolean;

  constructor(private readonly opts: FakeControllerOptions) {
    this.s = opts.services;
    this.holderId = opts.holderId ?? `controller-${randomUUID()}`;
    this.ttl = opts.leaseTtlMs ?? 30_000;
    this.clock = opts.clock ?? systemClock;
    this.autoAdvance = opts.autoAdvance ?? true;
    this.autoStart = opts.autoStart ?? false;
  }

  eligibleTargets(run: GoalRunLedger, graph: GoalGraphDefinition): TargetId[] {
    return referenceEligibleTargets(run, graph);
  }

  /** Waits for any background loop of the run to finish (test helper). */
  async settle(runId: GoalRunId): Promise<void> {
    await this.runs.get(runId)?.loop;
  }

  /** Simulates a crash: drops in-memory state without releasing leases. */
  crash(): void {
    for (const ctx of this.runs.values()) ctx.abort.abort();
    this.runs.clear();
  }

  // ---------------------------------------------------------------- events
  private async emit(type: GoalStudioEventType, runId: GoalRunId, data: Record<string, unknown>, extra: { targetId?: TargetId; attemptId?: string; executionId?: string } = {}) {
    const ev = await this.s.events.append({ type, runId, ...extra, data });
    return ev;
  }
  private async audit(type: GoalStudioEventType, runId: GoalRunId, data: Record<string, unknown>) {
    const ev = await this.emit(type, runId, data);
    await this.s.governance.audit(ev);
  }

  // ---------------------------------------------------------------- ledger helpers
  private async commit(runId: GoalRunId, mutate: (l: GoalRunLedger) => TargetTransition[] | void): Promise<GoalRunLedger> {
    const ctx = this.ctx(runId);
    for (let i = 0; i < 5; i++) {
      const current = await this.s.ledger.getRun(runId);
      if (!current) fail('NOT_FOUND', `run ${runId} not found`);
      let transitions: TargetTransition[] = [];
      const probe = structuredClone(current);
      transitions = mutate(probe) ?? [];
      try {
        const committed = await this.s.ledger.commit(runId, current.ledgerRevision, ctx.lease, (l) => void mutate(l), transitions);
        for (const t of transitions) await this.emit('target.transition', runId, { from: t.fromState, to: t.toState, reason: t.reason, actor: t.actor }, { targetId: t.targetId, attemptId: t.attemptId });
        return committed;
      } catch (error) {
        if ((error as GoalStudioError).code === 'LEDGER_CONFLICT') continue;
        throw error;
      }
    }
    fail('LEDGER_CONFLICT', `could not commit to ${runId} after retries`);
  }

  private setTarget(l: GoalRunLedger, targetId: TargetId, to: TargetStatus, reason: string, actor: string, extra: { attemptId?: string; evidenceIds?: string[] } = {}): TargetTransition | undefined {
    const entry = l.targets[targetId]!;
    if (entry.status === to) return undefined;
    const t: TargetTransition = { runId: l.runId, targetId, fromState: entry.status, toState: to, reason, actor, timestamp: this.clock().toISOString(), ...extra };
    entry.status = to;
    entry.updatedAt = t.timestamp;
    if (extra.evidenceIds) entry.evidenceIds = extra.evidenceIds;
    return t;
  }

  private markEligible(l: GoalRunLedger, def: GoalGraphDefinition, reason: string): TargetTransition[] {
    const out: TargetTransition[] = [];
    for (const id of referenceEligibleTargets(l, def)) {
      if (l.targets[id]!.status === 'queued') {
        const t = this.setTarget(l, id, 'eligible', reason, 'controller');
        if (t) out.push(t);
      }
    }
    return out;
  }

  private ctx(runId: GoalRunId): RunCtx {
    const c = this.runs.get(runId);
    if (!c) fail('STALE_LEASE', `this controller does not hold run ${runId}`);
    return c;
  }

  private async attach(run: GoalRunLedger): Promise<RunCtx | undefined> {
    const existing = this.runs.get(run.runId);
    if (existing) return existing;
    const lease = await this.s.ledger.acquireLease(run.runId, this.holderId, this.ttl);
    if (!lease) return undefined;
    const graph = await this.s.graphs.getRevision(run.graphId, run.graphRevision);
    if (!graph) fail('NOT_FOUND', `pinned graph ${run.graphId}@${run.graphRevision} missing`);
    if (graph.digest !== run.graphDigest) fail('VALIDATION', 'pinned graph digest mismatch');
    const ctx: RunCtx = { lease, graph, abort: new AbortController() };
    this.runs.set(run.runId, ctx);
    return ctx;
  }

  // ---------------------------------------------------------------- control
  async startRun(input: { graphId: string; graphRevision?: number; principal: string }): Promise<GoalRunLedger> {
    if (!input.principal.startsWith('user:')) fail('FORBIDDEN', 'only a human principal may start a run');
    const graph = await this.s.graphs.getRevision(input.graphId, input.graphRevision);
    if (!graph) fail('NOT_FOUND', `graph ${input.graphId}@${input.graphRevision ?? 'latest'} not found`);
    const created = await this.s.ledger.createRun({ graph, createdBy: input.principal });
    await this.emit('run.created', created.runId, { graphId: graph.graphId, graphRevision: graph.revision, graphDigest: graph.digest, principal: input.principal });
    const ctx = await this.attach(created);
    if (!ctx) fail('STALE_LEASE', 'could not acquire lease for new run');
    const run = await this.commit(created.runId, (l) => {
      l.status = 'running';
      return this.markEligible(l, graph.definition, 'dependencies completed');
    });
    await this.audit('run.status', run.runId, { status: 'running', principal: input.principal });
    if (this.autoStart) this.kick(run.runId);
    return run;
  }

  private kick(runId: GoalRunId): void {
    const ctx = this.runs.get(runId);
    if (!ctx || ctx.loop) return;
    ctx.loop = this.loop(runId).finally(() => {
      const c = this.runs.get(runId);
      if (c) c.loop = undefined;
    });
  }

  private async loop(runId: GoalRunId): Promise<void> {
    const ctx = this.runs.get(runId);
    while (ctx && !ctx.abort.signal.aborted) {
      const run = await this.s.ledger.getRun(runId);
      if (!run || run.status !== 'running') return;
      const next = referenceEligibleTargets(run, ctx.graph.definition)[0];
      if (!next) {
        await this.settleIdle(runId);
        return;
      }
      await this.executeTarget(runId, next);
      if (!this.autoAdvance) return;
    }
  }

  private async settleIdle(runId: GoalRunId): Promise<void> {
    const run = await this.s.ledger.getRun(runId);
    if (!run || run.status !== 'running') return;
    const allDone = Object.values(run.targets).every((t) => t.status === 'completed');
    const status: GoalRunStatus = allDone ? 'completed' : 'idle';
    await this.commit(runId, (l) => {
      l.status = status;
    });
    const summary = Object.fromEntries(Object.values(run.targets).map((t) => [t.targetId, t.status]));
    await this.emit(status === 'idle' ? 'run.idle' : 'run.status', runId, { status, targets: summary });
  }

  async runEligible(runId: GoalRunId, targetId: TargetId, principal: string): Promise<GoalRunLedger> {
    if (!principal.startsWith('user:') && principal !== 'controller') fail('FORBIDDEN', 'principal may not run targets');
    const run = await this.s.ledger.getRun(runId);
    if (!run) fail('NOT_FOUND', `run ${runId} not found`);
    const ctx = await this.attach(run);
    if (!ctx) fail('STALE_LEASE', `run ${runId} is held by another controller`);
    await ctx.loop;
    const fresh = (await this.s.ledger.getRun(runId))!;
    if (fresh.status === 'idle') await this.commit(runId, (l) => void (l.status = 'running'));
    else if (fresh.status !== 'running') fail('VALIDATION', `run is ${fresh.status}`);
    if (!referenceEligibleTargets(fresh, ctx.graph.definition).includes(targetId)) fail('VALIDATION', `target ${targetId} is not eligible`, { status: fresh.targets[targetId]?.status });
    await this.executeTarget(runId, targetId);
    if (this.autoAdvance) this.kick(runId);
    return (await this.s.ledger.getRun(runId))!;
  }

  async pause(runId: GoalRunId, principal: string) {
    return this.setRunStatus(runId, principal, ['running', 'idle'], 'paused');
  }
  async resume(runId: GoalRunId, principal: string) {
    const r = await this.setRunStatus(runId, principal, ['paused', 'idle'], 'running');
    this.kick(runId);
    return r;
  }
  async stop(runId: GoalRunId, principal: string) {
    const ctx = this.runs.get(runId);
    ctx?.abort.abort();
    const r = await this.setRunStatus(runId, principal, ['created', 'running', 'pausing', 'paused', 'idle'], 'stopped');
    return r;
  }

  private async setRunStatus(runId: GoalRunId, principal: string, from: GoalRunStatus[], to: GoalRunStatus): Promise<GoalRunLedger> {
    if (!principal.startsWith('user:')) fail('FORBIDDEN', 'only a human principal may change run state');
    const run = await this.s.ledger.getRun(runId);
    if (!run) fail('NOT_FOUND', `run ${runId} not found`);
    if (!from.includes(run.status)) fail('VALIDATION', `cannot move run from ${run.status} to ${to}`);
    const ctx = await this.attach(run);
    if (!ctx) fail('STALE_LEASE', `run ${runId} is held by another controller`);
    if (to !== 'running') await ctx.loop;
    const committed = await this.commit(runId, (l) => void (l.status = to));
    await this.audit('run.status', runId, { status: to, principal });
    return committed;
  }

  async retryTarget(runId: GoalRunId, targetId: TargetId, principal: string): Promise<GoalRunLedger> {
    if (!principal.startsWith('user:')) fail('FORBIDDEN', 'only a human principal may retry targets');
    const run = await this.s.ledger.getRun(runId);
    if (!run) fail('NOT_FOUND', `run ${runId} not found`);
    const entry = run.targets[targetId];
    if (!entry) fail('NOT_FOUND', `target ${targetId} not in run`);
    if (!['blocked', 'failed', 'awaiting_external', 'needs_approval', 'stopped'].includes(entry.status)) fail('VALIDATION', `target is ${entry.status}`);
    const ctx = await this.attach(run);
    if (!ctx) fail('STALE_LEASE', 'run held elsewhere');
    const committed = await this.commit(runId, (l) => {
      const t = this.setTarget(l, targetId, 'queued', 'retry requested', principal);
      l.targets[targetId]!.blockers = [];
      return [t, ...this.markEligible(l, ctx.graph.definition, 'retry')].filter(Boolean) as TargetTransition[];
    });
    await this.audit('target.transition', runId, { targetId, action: 'retry', principal });
    return committed;
  }

  async recoverRuns(): Promise<GoalRunId[]> {
    const recovered: GoalRunId[] = [];
    for (const run of await this.s.ledger.listRuns()) {
      if (TERMINAL_RUN.includes(run.status) || run.status === 'paused') continue;
      const ctx = await this.attach(run);
      if (!ctx) continue;
      recovered.push(run.runId);
      await this.emit('run.status', run.runId, { status: run.status, recovered: true, holderId: this.holderId, epoch: ctx.lease.epoch });
      if (this.autoStart) this.kick(run.runId);
    }
    return recovered;
  }

  // ---------------------------------------------------------------- one target
  private async executeTarget(runId: GoalRunId, targetId: TargetId): Promise<void> {
    const ctx = this.ctx(runId);
    const target = ctx.graph.definition.targets.find((t) => t.id === targetId)!;
    const limits = ctx.graph.definition.constitution.resourceLimits;
    let run = (await this.s.ledger.getRun(runId))!;
    const entry = run.targets[targetId]!;
    // Resume the same attempt if a crash interrupted it, so once() replays its side effects.
    const resuming = IN_FLIGHT.includes(entry.status);
    const attemptNo = resuming ? entry.attempts : entry.attempts + 1;
    const attemptId = `${runId}:${targetId}:${attemptNo}`;
    if (!resuming && run.resource.tasksStarted >= limits.maxTasksPerRun) {
      await this.commit(runId, (l) => void (l.status = 'idle'));
      await this.emit('run.idle', runId, { reason: 'maxTasksPerRun reached' });
      return;
    }
    const prior = await this.s.ledger.attempts(runId, targetId);
    const attempt: TargetAttempt = prior.find((a) => a.id === attemptId) ?? { id: attemptId, runId, targetId, attempt: attemptNo, phase: 'SELECT_TARGET', startedAt: this.clock().toISOString() };
    const phase = async (p: GoalPhase) => {
      attempt.phase = p;
      await this.s.ledger.saveAttempt(attempt);
      await this.emit('target.phase', runId, { phase: p }, { targetId, attemptId });
    };

    if (!resuming) {
      run = await this.commit(runId, (l) => {
        l.targets[targetId]!.attempts = attemptNo;
        l.targets[targetId]!.lastAttemptId = attemptId;
        l.resource.tasksStarted += 1;
        return [this.setTarget(l, targetId, 'active', 'selected', 'controller', { attemptId })].filter(Boolean) as TargetTransition[];
      });
      await this.emit('attempt.started', runId, { attempt: attemptNo }, { targetId, attemptId });
    }
    await phase('PLAN_TASK');
    const prompt = await this.s.prompts.latest(target.executor);
    if (prompt) attempt.promptRef = { promptId: prompt.id, version: prompt.version };

    await phase('ROUTE_MODEL');
    const remaining = Math.max(0, limits.hostedSpendUsd - run.resource.hostedSpendUsd);
    const route = attempt.modelRoute ?? (await this.s.router.route({ requiredCapabilities: prompt?.requiredCapabilities ?? [], remainingHostedBudgetUsd: remaining, localFirst: limits.localModelFirst }));
    if (!route) return this.finish(runId, target, attempt, 'blocked', 'NO_ROUTE: no verified-ready model satisfies requirements and budget', { code: 'NO_ROUTE', message: 'no route', retryable: true });
    attempt.modelRoute = route;
    await this.emit('route.decided', runId, { modelId: route.modelId, runtimeId: route.runtimeId, hosted: route.hosted, reasons: route.reasons, rejected: route.rejected }, { targetId, attemptId });

    await phase('PREFLIGHT');
    const pre = await this.s.governance.preflight({ run, target, route, principal: 'controller' });
    if (pre.effect === 'deny') {
      await this.audit('governance.denied', runId, { targetId, reasons: pre.reasons });
      return this.finish(runId, target, attempt, 'blocked', `POLICY_DENIED: ${pre.reasons.join('; ')}`, { code: 'POLICY_DENIED', message: pre.reasons.join('; '), retryable: false });
    }
    if (pre.effect === 'ask') {
      await this.emit('approval.requested', runId, { approvalScope: pre.approvalScope, reasons: pre.reasons }, { targetId, attemptId });
      return this.finish(runId, target, attempt, 'needs_approval', `approval required (${pre.approvalScope})`);
    }
    if (route.hosted) {
      const spend = this.s.governance.authorizeSpend(run, route.estimatedCostUsd);
      if (spend.effect !== 'allow') return this.finish(runId, target, attempt, 'blocked', `BUDGET_EXCEEDED: ${spend.reasons.join('; ')}`, { code: 'BUDGET_EXCEEDED', message: 'spend denied', retryable: false });
    }

    await phase('EXECUTE');
    const key = idempotencyKey(runId, targetId, attemptNo, 'EXECUTE');
    let exec: Awaited<ReturnType<GoalStudioServices['executor']['execute']>>;
    try {
      const { result } = await this.s.ledger.once(key, () =>
        this.s.executor.execute({
          key, run, target, attempt, prompt, route, workspaceRoot: this.opts.workspaceRoot, signal: ctx.abort.signal,
          onEvent: (e) => void this.emit('execution.event', runId, e.data ?? {}, { targetId, attemptId, executionId: e.executionId }).catch(() => undefined),
        }),
      );
      exec = result;
    } catch (error) {
      const err = error instanceof GoalStudioFailure ? error.toJSON() : { code: 'EXECUTION_FAILED' as const, message: String((error as Error)?.message ?? error), retryable: true };
      return this.recover(runId, target, attempt, err);
    }
    attempt.executionId = exec.executionId;
    if (!exec.ok) return this.recover(runId, target, attempt, exec.error ?? { code: 'EXECUTION_FAILED', message: exec.summary, retryable: false });

    run = await this.commit(runId, (l) => {
      l.targets[targetId]!.lastExecutionId = exec.executionId;
      return [this.setTarget(l, targetId, 'verifying', 'execution finished', 'controller', { attemptId })].filter(Boolean) as TargetTransition[];
    });
    await phase('INDEPENDENT_VERIFY');
    const evidence = await this.s.verification.verify({ run, target, attempt, workspaceRoot: this.opts.workspaceRoot, executorIdentity: `model:${route.modelId}` });
    for (const e of evidence) await this.emit('verification.evidence', runId, { evidenceId: e.id, verdict: e.verdict, criterion: e.criterion, validator: e.validatorIdentity, method: e.validationMethod }, { targetId, attemptId });
    await phase('ACCEPTANCE_GATE');
    const gate = this.s.verification.gate({ run, target, attempt, evidence });
    await this.emit('gate.decided', runId, { decision: gate.decision, reasons: gate.reasons }, { targetId, attemptId });
    const ids = gate.perCriterion.flatMap((c) => c.evidenceIds);
    switch (gate.decision) {
      case 'completed': {
        await phase('COMMIT_PROGRESS');
        await this.s.ledger.once(idempotencyKey(runId, targetId, attemptNo, 'COMMIT_PROGRESS'), async () => {
          await this.commit(runId, (l) => {
            const ts = [this.setTarget(l, targetId, 'verified', 'independent evidence PASS', 'verifier', { attemptId, evidenceIds: ids }), this.setTarget(l, targetId, 'completed', 'acceptance gate completed', 'controller', { attemptId, evidenceIds: ids })];
            ts.push(...this.markEligible(l, ctx.graph.definition, `dependency ${targetId} completed`));
            return ts.filter(Boolean) as TargetTransition[];
          });
          return true;
        });
        await phase('UNLOCK_DEPENDENCIES');
        attempt.outcome = 'succeeded';
        attempt.endedAt = this.clock().toISOString();
        await this.s.ledger.saveAttempt(attempt);
        await this.emit('attempt.finished', runId, { outcome: 'succeeded' }, { targetId, attemptId });
        return;
      }
      case 'repair':
        return this.recover(runId, target, attempt, undefined, gate);
      case 'needs_approval':
        await this.emit('approval.requested', runId, { reasons: gate.reasons }, { targetId, attemptId });
        return this.finish(runId, target, attempt, 'needs_approval', gate.reasons.join('; '), undefined, ids);
      case 'awaiting_external':
        return this.finish(runId, target, attempt, 'awaiting_external', gate.reasons.join('; '), undefined, ids);
      default:
        return this.finish(runId, target, attempt, 'blocked', gate.reasons.join('; '), { code: 'VERIFICATION_FAILED', message: gate.reasons.join('; '), retryable: false }, ids);
    }
  }

  private async recover(runId: GoalRunId, target: GoalTarget, attempt: TargetAttempt, error?: GoalStudioError, gate?: AcceptanceGateDecision): Promise<void> {
    await this.emit('target.phase', runId, { phase: 'DIAGNOSE' }, { targetId: target.id, attemptId: attempt.id });
    const run = (await this.s.ledger.getRun(runId))!;
    const priorAttempts = await this.s.ledger.attempts(runId, target.id);
    const decision = await this.s.recovery.decide({ run, target, attempt, priorAttempts, gate, error });
    if (decision.action === 'repair') {
      await this.emit('target.phase', runId, { phase: 'REPAIR_HYPOTHESIS', hypothesis: decision.hypothesis }, { targetId: target.id, attemptId: attempt.id });
    }
    await this.emit('recovery.decided', runId, { action: decision.action, failureClass: decision.failureClass, diagnosis: decision.diagnosis, hypothesis: decision.hypothesis, failureSignature: decision.failureSignature }, { targetId: target.id, attemptId: attempt.id });
    const storedError: GoalStudioError = error ?? { code: 'VERIFICATION_FAILED', message: `failing criteria: ${(gate?.perCriterion ?? []).filter((c) => c.verdict !== 'PASS').map((c) => c.criterion).sort().join(' | ')}`, retryable: false };
    attempt.error = storedError;
    attempt.outcome = decision.action === 'block' ? 'blocked' : 'failed';
    attempt.repairHypothesis = decision.hypothesis;
    attempt.endedAt = this.clock().toISOString();
    attempt.phase = decision.action === 'block' ? 'BLOCK_TARGET' : 'REPLAN';
    await this.emit('target.phase', runId, { phase: attempt.phase }, { targetId: target.id, attemptId: attempt.id });
    if (decision.action === 'repair') {
      await this.emit('target.phase', runId, { phase: 'RETEST' }, { targetId: target.id, attemptId: attempt.id });
    }
    await this.s.ledger.saveAttempt(attempt);
    await this.emit('attempt.finished', runId, { outcome: attempt.outcome, error: storedError }, { targetId: target.id, attemptId: attempt.id });
    await this.commit(runId, (l) => {
      const ts: Array<TargetTransition | undefined> = [];
      if (decision.action === 'block') {
        l.targets[target.id]!.blockers = [decision.diagnosis, ...decision.reasons];
        ts.push(this.setTarget(l, target.id, 'blocked', `recovery: ${decision.failureClass}`, 'recovery', { attemptId: attempt.id }));
      } else {
        if (decision.action === 'repair') l.targets[target.id]!.repairs += 1;
        ts.push(this.setTarget(l, target.id, 'failed', `attempt failed: ${decision.failureClass}`, 'recovery', { attemptId: attempt.id }));
        if (decision.action === 'repair') {
          ts.push(this.setTarget(l, target.id, 'repairing', `recovery: ${decision.hypothesis ?? 'repair'}`, 'recovery', { attemptId: attempt.id }));
        }
        ts.push(this.setTarget(l, target.id, 'eligible', 'ready for next attempt', 'recovery', { attemptId: attempt.id }));
      }
      return ts.filter(Boolean) as TargetTransition[];
    });
  }

  private async finish(runId: GoalRunId, target: GoalTarget, attempt: TargetAttempt, to: TargetStatus, reason: string, error?: GoalStudioError, evidenceIds?: string[]): Promise<void> {
    attempt.outcome = to === 'needs_approval' ? 'awaiting_approval' : to === 'blocked' ? 'blocked' : 'failed';
    if (error) attempt.error = error;
    attempt.endedAt = this.clock().toISOString();
    await this.s.ledger.saveAttempt(attempt);
    await this.commit(runId, (l) => {
      if (to === 'blocked') l.targets[target.id]!.blockers = [reason];
      return [this.setTarget(l, target.id, to, reason, 'controller', { attemptId: attempt.id, ...(evidenceIds ? { evidenceIds } : {}) })].filter(Boolean) as TargetTransition[];
    });
    await this.emit('attempt.finished', runId, { outcome: attempt.outcome, reason }, { targetId: target.id, attemptId: attempt.id });
  }
}
