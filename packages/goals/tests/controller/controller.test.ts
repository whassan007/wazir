import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExecutionEngine } from '@wazir/core';
import { MemoryStore } from '@wazir/shared';
import {
  GoalStudioFailure,
  UNLOCKING_TARGET_STATUSES,
  idempotencyKey,
  type AcceptanceGateDecision,
  type EvidenceRecord,
  type GoalEventLog,
  type GoalGovernance,
  type GoalGraphDefinition,
  type GoalGraphRevisionRecord,
  type GoalGraphStore,
  type GoalLedgerStore,
  type GoalPhase,
  type GoalRunId,
  type GoalRunLedger,
  type GoalRunStatus,
  type GoalStudioError,
  type GoalStudioEvent,
  type GoalStudioServices,
  type GoalTarget,
  type GraphId,
  type GraphRevision,
  type IdempotencyKey,
  type ModelRouteDecision,
  type ModelRouter,
  type PromptDefinition,
  type PromptStore,
  type RecoveryDecision,
  type RecoveryService,
  type RunLease,
  type TargetAttempt,
  type TargetId,
  type TargetTransition,
  type VerificationService,
} from '../../src/contracts.js';
import {
  assertTargetTransition,
  canTransitionTarget,
  computeCriticality,
  computeEligibleTargets,
  createGoalController,
  createTargetTaskExecutor,
  dependenciesCompleted,
  eligibleTargets,
  newlyUnlockedTargets,
  type ContinuousGoalController,
} from '../../src/controller/index.js';

// ---------------------------------------------------------------------------
// In-memory test doubles implementing the exact Goal Studio v1 contracts.
// ---------------------------------------------------------------------------

function makeGraphDefinition(overrides: Partial<GoalGraphDefinition> = {}): GoalGraphDefinition {
  return {
    schemaVersion: '1.0',
    name: 'test-goal-graph',
    purpose: 'Verify continuous goal controller lifecycle and branch isolation',
    constitution: {
      objectiveOwner: 'human',
      invariants: ['Never mark completed without independent verification'],
      resourceLimits: {
        maxTasksPerRun: 20,
        maxRepairsPerTask: 2,
        maxSameActionNoProgress: 2,
        maxRunMinutes: 60,
        hostedSpendUsd: 0,
        localModelFirst: true,
        maxConcurrentWritersPerWorktree: 1,
        maxConcurrentTargets: 2,
      },
      allowedUnattended: ['drafting code and running tests'],
      needsApproval: ['paid API usage', 'external publication'],
    },
    targets: [
      {
        id: 'Y1.1',
        stage: 'foundational_research',
        title: 'Define formal safety claim',
        dependsOn: [],
        priority: 100,
        executor: 'axiomatize',
        artifacts: ['scope.md', 'formal-claim.md'],
        acceptance: ['Assumptions explicit', 'Counterexample documented'],
      },
      {
        id: 'Y1.2',
        stage: 'foundational_research',
        title: 'Encode invariants',
        dependsOn: ['Y1.1'],
        priority: 95,
        executor: 'formal_verify',
        artifacts: ['proof-evidence.json'],
        acceptance: ['Solver output verified'],
      },
      {
        id: 'Y1.3',
        stage: 'foundational_research',
        title: 'Prototype enforcement gate',
        dependsOn: ['Y1.2'],
        priority: 90,
        executor: 'fleet_harness',
        artifacts: ['reference-gate/'],
        acceptance: ['Gate enforced'],
      },
    ],
    executionGraph: {
      entry: 'LOAD_LEDGER',
      nodes: [{ id: 'LOAD_LEDGER', next: ['SELECT_TARGET'] }],
    },
    ...overrides,
  };
}

class InMemoryLedgerStore implements GoalLedgerStore {
  private readonly runs = new Map<GoalRunId, GoalRunLedger>();
  private readonly leases = new Map<GoalRunId, RunLease>();
  private readonly transitionLog = new Map<GoalRunId, TargetTransition[]>();
  private readonly attemptMap = new Map<string, TargetAttempt>();
  private readonly idempotencyRecords = new Map<IdempotencyKey, unknown>();
  private runSeq = 0;

  constructor(private readonly clock: () => Date) {}

  async createRun(input: { graph: GoalGraphRevisionRecord; createdBy: string; runId?: GoalRunId }): Promise<GoalRunLedger> {
    const runId = input.runId ?? `run-${++this.runSeq}`;
    const now = this.clock().toISOString();
    const targets: GoalRunLedger['targets'] = {};
    for (const t of input.graph.definition.targets) {
      targets[t.id] = {
        targetId: t.id,
        status: 'queued',
        attempts: 0,
        repairs: 0,
        evidenceIds: [],
        blockers: [],
        updatedAt: now,
      };
    }
    const deadlineAt = new Date(
      this.clock().getTime() + input.graph.definition.constitution.resourceLimits.maxRunMinutes * 60_000,
    ).toISOString();
    const ledger: GoalRunLedger = {
      runId,
      graphId: input.graph.graphId,
      graphRevision: input.graph.revision,
      graphDigest: input.graph.digest,
      status: 'created',
      ledgerRevision: 1,
      targets,
      resource: {
        tasksStarted: 0,
        hostedSpendUsd: 0,
        startedAt: now,
        deadlineAt,
      },
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(runId, structuredClone(ledger));
    this.transitionLog.set(runId, []);
    return structuredClone(ledger);
  }

  async getRun(runId: GoalRunId): Promise<GoalRunLedger | undefined> {
    const r = this.runs.get(runId);
    return r ? structuredClone(r) : undefined;
  }

  async listRuns(filter?: { graphId?: GraphId; status?: GoalRunStatus }): Promise<GoalRunLedger[]> {
    return [...this.runs.values()]
      .filter((r) => (!filter?.graphId || r.graphId === filter.graphId) && (!filter?.status || r.status === filter.status))
      .map((r) => structuredClone(r));
  }

  async commit(
    runId: GoalRunId,
    expectedRevision: number,
    lease: RunLease,
    mutate: (ledger: GoalRunLedger) => void,
    transitions: TargetTransition[],
  ): Promise<GoalRunLedger> {
    const currentLease = this.leases.get(runId);
    if (
      !currentLease ||
      currentLease.holderId !== lease.holderId ||
      currentLease.epoch !== lease.epoch ||
      Date.parse(currentLease.expiresAt) <= this.clock().getTime()
    ) {
      throw new GoalStudioFailure('STALE_LEASE', `Stale or expired lease for ${runId}`);
    }
    const current = this.runs.get(runId);
    if (!current) throw new GoalStudioFailure('NOT_FOUND', `Run ${runId} not found`);
    if (current.ledgerRevision !== expectedRevision) {
      throw new GoalStudioFailure('LEDGER_CONFLICT', `Expected revision ${expectedRevision}, got ${current.ledgerRevision}`, { retryable: true });
    }
    const next = structuredClone(current);
    mutate(next);
    next.ledgerRevision += 1;
    next.updatedAt = this.clock().toISOString();
    this.runs.set(runId, next);
    const list = this.transitionLog.get(runId) ?? [];
    list.push(...transitions.map((t) => structuredClone(t)));
    this.transitionLog.set(runId, list);
    return structuredClone(next);
  }

  async transitions(runId: GoalRunId, targetId?: TargetId): Promise<TargetTransition[]> {
    const list = this.transitionLog.get(runId) ?? [];
    return list.filter((t) => !targetId || t.targetId === targetId).map((t) => structuredClone(t));
  }

  async acquireLease(runId: GoalRunId, holderId: string, ttlMs: number): Promise<RunLease | undefined> {
    const now = this.clock().getTime();
    const existing = this.leases.get(runId);
    if (existing && existing.holderId !== holderId && Date.parse(existing.expiresAt) > now) {
      return undefined;
    }
    const lease: RunLease = {
      runId,
      holderId,
      epoch: (existing?.epoch ?? 0) + 1,
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    this.leases.set(runId, lease);
    return structuredClone(lease);
  }

  async renewLease(lease: RunLease, ttlMs: number): Promise<RunLease> {
    const now = this.clock().getTime();
    const existing = this.leases.get(lease.runId);
    if (!existing || existing.holderId !== lease.holderId || existing.epoch !== lease.epoch || Date.parse(existing.expiresAt) <= now) {
      throw new GoalStudioFailure('STALE_LEASE', `Cannot renew stale lease for ${lease.runId}`);
    }
    const renewed: RunLease = {
      ...existing,
      expiresAt: new Date(now + ttlMs).toISOString(),
    };
    this.leases.set(lease.runId, renewed);
    return structuredClone(renewed);
  }

  async releaseLease(lease: RunLease): Promise<void> {
    const existing = this.leases.get(lease.runId);
    if (existing && existing.holderId === lease.holderId && existing.epoch === lease.epoch) {
      this.leases.set(lease.runId, { ...existing, expiresAt: new Date(0).toISOString() });
    }
  }

  async once<T>(key: IdempotencyKey, effect: () => Promise<T>): Promise<{ result: T; replayed: boolean }> {
    if (this.idempotencyRecords.has(key)) {
      return { result: structuredClone(this.idempotencyRecords.get(key) as T), replayed: true };
    }
    const result = await effect();
    this.idempotencyRecords.set(key, structuredClone(result));
    return { result: structuredClone(result), replayed: false };
  }

  async saveAttempt(attempt: TargetAttempt): Promise<void> {
    this.attemptMap.set(`${attempt.runId}::${attempt.id}`, structuredClone(attempt));
  }

  async attempts(runId: GoalRunId, targetId?: TargetId): Promise<TargetAttempt[]> {
    const out: TargetAttempt[] = [];
    for (const [k, v] of this.attemptMap.entries()) {
      if (!k.startsWith(`${runId}::`)) continue;
      if (targetId && v.targetId !== targetId) continue;
      out.push(structuredClone(v));
    }
    return out.sort((a, b) => a.attempt - b.attempt);
  }
}

class InMemoryEventLog implements GoalEventLog {
  private readonly byRun = new Map<GoalRunId, GoalStudioEvent[]>();
  private readonly listeners = new Map<GoalRunId, Set<(event: GoalStudioEvent) => void>>();

  constructor(private readonly clock: () => Date) {}

  async append(event: Omit<GoalStudioEvent, 'seq' | 'timestamp'> & { timestamp?: string }): Promise<GoalStudioEvent> {
    const runId = event.runId ?? 'global';
    const list = this.byRun.get(runId) ?? [];
    const full: GoalStudioEvent = {
      ...event,
      seq: list.length + 1,
      timestamp: event.timestamp ?? this.clock().toISOString(),
    };
    list.push(full);
    this.byRun.set(runId, list);
    for (const fn of this.listeners.get(runId) ?? []) fn(full);
    return full;
  }

  async read(runId: GoalRunId, afterSeq = 0, limit?: number): Promise<GoalStudioEvent[]> {
    const list = (this.byRun.get(runId) ?? []).filter((e) => e.seq > afterSeq);
    return limit !== undefined ? list.slice(0, limit) : list;
  }

  subscribe(runId: GoalRunId, listener: (event: GoalStudioEvent) => void): () => void {
    const set = this.listeners.get(runId) ?? new Set();
    set.add(listener);
    this.listeners.set(runId, set);
    return () => {
      set.delete(listener);
    };
  }
}

class InMemoryGraphStore implements GoalGraphStore {
  private readonly records = new Map<string, GoalGraphRevisionRecord>();

  put(definition: GoalGraphDefinition, graphId = 'g-1', revision = 1): GoalGraphRevisionRecord {
    const digest = createHash('sha256').update(JSON.stringify(definition)).digest('hex');
    const record: GoalGraphRevisionRecord = {
      graphId,
      projectId: 'proj-1',
      revision,
      definition: structuredClone(definition),
      digest,
      createdAt: new Date().toISOString(),
      createdBy: 'user:test',
    };
    this.records.set(`${graphId}@${revision}`, record);
    this.records.set(`${graphId}@latest`, record);
    return record;
  }

  async importYaml(): Promise<{ record?: GoalGraphRevisionRecord; validation: { valid: boolean; issues: never[] } }> {
    return { validation: { valid: true, issues: [] } };
  }

  async createRevision(graphId: GraphId, definition: GoalGraphDefinition, _actor: string, parentRevision: GraphRevision): Promise<GoalGraphRevisionRecord> {
    return this.put(definition, graphId, parentRevision + 1);
  }

  async getRevision(graphId: GraphId, revision?: GraphRevision): Promise<GoalGraphRevisionRecord | undefined> {
    const key = revision !== undefined ? `${graphId}@${revision}` : `${graphId}@latest`;
    const r = this.records.get(key);
    return r ? structuredClone(r) : undefined;
  }

  async listRevisions(): Promise<[]> {
    return [];
  }

  async listGraphs(): Promise<[]> {
    return [];
  }

  validate(): { valid: boolean; issues: never[] } {
    return { valid: true, issues: [] };
  }
}

interface HarnessOptions {
  graph?: GoalGraphDefinition;
  routeFn?: ModelRouter['route'];
  verifyFn?: VerificationService['verify'];
  gateFn?: VerificationService['gate'];
  recoveryFn?: RecoveryService['decide'];
  preflightFn?: GoalGovernance['preflight'];
  authorizeSpendFn?: GoalGovernance['authorizeSpend'];
  executorFn?: GoalStudioServices['executor']['execute'];
  leaseTtlMs?: number;
}

interface TestHarness {
  workspaceRoot: string;
  clock: { now: Date; advanceMs: (ms: number) => void; fn: () => Date };
  graphs: InMemoryGraphStore;
  ledger: InMemoryLedgerStore;
  events: InMemoryEventLog;
  audits: GoalStudioEvent[];
  controller: ContinuousGoalController;
  services: Omit<GoalStudioServices, 'controller'>;
  createSecondController: (holderId: string) => ContinuousGoalController;
}

async function createHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-goal-ctrl-'));
  const current = { now: new Date('2026-10-23T00:00:00.000Z') };
  const clockFn = () => new Date(current.now.getTime());

  const graphs = new InMemoryGraphStore();
  const graphDef = options.graph ?? makeGraphDefinition();
  graphs.put(graphDef, 'g-1', 1);

  const ledger = new InMemoryLedgerStore(clockFn);
  const events = new InMemoryEventLog(clockFn);
  const audits: GoalStudioEvent[] = [];

  const prompts: PromptStore = {
    async latest(executorKey: string): Promise<PromptDefinition | undefined> {
      return {
        id: `prompt-${executorKey}`,
        version: 1,
        executorKey,
        role: 'specialist',
        template: 'Execute {{target.id}}: {{target.title}} producing {{target.artifacts}}',
        requiredCapabilities: ['coding'],
        digest: 'sha256:prompt',
        createdAt: clockFn().toISOString(),
        createdBy: 'system',
      };
    },
    async get(promptId: string, version: number): Promise<PromptDefinition | undefined> {
      const key = promptId.replace(/^prompt-/, '');
      return {
        id: promptId,
        version,
        executorKey: key,
        role: 'specialist',
        template: 'Execute {{target.id}}: {{target.title}} producing {{target.artifacts}}',
        requiredCapabilities: ['coding'],
        digest: 'sha256:prompt',
        createdAt: clockFn().toISOString(),
        createdBy: 'system',
      };
    },
  };

  const router: ModelRouter = {
    route:
      options.routeFn ??
      (async (): Promise<ModelRouteDecision> => ({
        modelId: 'qwen2.5-coder:14b',
        runtimeId: 'ollama-local',
        computerId: 'local-mac',
        hosted: false,
        estimatedCostUsd: 0,
        reasons: ['local verified-ready model'],
        rejected: [],
        decidedAt: clockFn().toISOString(),
      })),
  };

  const governance: GoalGovernance = {
    preflight:
      options.preflightFn ??
      (async () => ({
        effect: 'allow',
        reasons: ['allowed unattended'],
      })),
    authorizeSpend:
      options.authorizeSpendFn ??
      ((run, amountUsd) => {
        if (amountUsd <= 0) return { effect: 'allow', reasons: ['zero spend'] };
        return { effect: 'deny', reasons: [`hosted spend ${amountUsd} denied for ${run.runId}`] };
      }),
    async audit(event: GoalStudioEvent): Promise<void> {
      audits.push(event);
    },
  };

  const defaultExecutor = createTargetTaskExecutor({
    workspaceRoot,
    clock: clockFn,
  });

  const executor: GoalStudioServices['executor'] = {
    execute: options.executorFn ?? ((input) => defaultExecutor.execute(input)),
  };

  const storedEvidence = new Map<GoalRunId, EvidenceRecord[]>();
  const verification: VerificationService = {
    verify:
      options.verifyFn ??
      (async ({ run, target, attempt, executorIdentity }) => {
        const records: EvidenceRecord[] = target.acceptance.map((criterion, idx) => ({
          id: `ev-${target.id}-${attempt.attempt}-${idx + 1}`,
          runId: run.runId,
          targetId: target.id,
          attemptId: attempt.id,
          graphRevision: run.graphRevision,
          workspaceRevision: `rev-${attempt.attempt}`,
          artifacts: target.artifacts.map((a) => ({ uri: a, digest: 'sha256:deadbeef' })),
          validationMethod: target.externalDependency ? 'external-record' : 'independent-check',
          validatorIdentity: `independent-verifier-${idx + 1}`,
          executorIdentity,
          verdict: 'PASS',
          criterion,
          exitCode: 0,
          limitations: [],
          createdAt: clockFn().toISOString(),
        }));
        const existing = storedEvidence.get(run.runId) ?? [];
        existing.push(...records);
        storedEvidence.set(run.runId, existing);
        return records;
      }),
    gate:
      options.gateFn ??
      (({ run, target, attempt, evidence }): AcceptanceGateDecision => ({
        runId: run.runId,
        targetId: target.id,
        attemptId: attempt.id,
        decision: 'completed',
        perCriterion: target.acceptance.map((criterion) => ({
          criterion,
          verdict: 'PASS',
          evidenceIds: evidence.filter((e) => e.criterion === criterion).map((e) => e.id),
        })),
        reasons: ['all acceptance criteria independently verified'],
        decidedAt: clockFn().toISOString(),
      })),
    async evidence(runId: GoalRunId, targetId?: TargetId): Promise<EvidenceRecord[]> {
      return (storedEvidence.get(runId) ?? []).filter((e) => !targetId || e.targetId === targetId);
    },
  };

  const recovery: RecoveryService = {
    decide:
      options.recoveryFn ??
      (async ({ target, attempt }): Promise<RecoveryDecision> => ({
        action: 'repair',
        failureClass: 'verification',
        diagnosis: `Failure on ${target.id} attempt ${attempt.attempt}`,
        hypothesis: `Refine ${target.id} deliverable on repair #${attempt.attempt}`,
        failureSignature: `sig-${target.id}-${attempt.attempt}`,
        reasons: ['repairable verification failure'],
      })),
  };

  const services: Omit<GoalStudioServices, 'controller'> = {
    graphs,
    ledger,
    events,
    verification,
    recovery,
    prompts,
    router,
    governance,
    executor,
  };

  const store = new MemoryStore();
  const controller = createGoalController({
    store,
    workspaceRoot,
    clock: clockFn,
    services,
    holderId: 'controller-primary',
    leaseTtlMs: options.leaseTtlMs ?? 60_000,
  });

  return {
    workspaceRoot,
    clock: {
      get now() {
        return current.now;
      },
      advanceMs(ms: number) {
        current.now = new Date(current.now.getTime() + ms);
      },
      fn: clockFn,
    },
    graphs,
    ledger,
    events,
    audits,
    controller,
    services,
    createSecondController: (holderId: string) =>
      createGoalController({
        store,
        workspaceRoot,
        clock: clockFn,
        services,
        holderId,
        leaseTtlMs: options.leaseTtlMs ?? 60_000,
      }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoalController & Eligibility (Workstream 03)', () => {
  const tempDirs: string[] = [];
  const controllers: ContinuousGoalController[] = [];

  beforeEach(() => {
    tempDirs.length = 0;
    controllers.length = 0;
  });

  afterEach(async () => {
    for (const c of controllers) {
      await c.shutdown().catch(() => undefined);
    }
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('computes deterministic eligibility: verified NEVER unlocks dependents, only completed does; sorts by critical path, priority, and id', async () => {
    const graph = makeGraphDefinition({
      targets: [
        {
          id: 'A',
          stage: 's1',
          title: 'Root with deep chain',
          dependsOn: [],
          priority: 50,
          executor: 'ex',
          artifacts: ['a.md'],
          acceptance: ['ok'],
        },
        {
          id: 'B',
          stage: 's1',
          title: 'Root with higher priority but no dependents',
          dependsOn: [],
          priority: 99,
          executor: 'ex',
          artifacts: ['b.md'],
          acceptance: ['ok'],
        },
        {
          id: 'C1',
          stage: 's1',
          title: 'Tie-break 1',
          dependsOn: [],
          priority: 80,
          executor: 'ex',
          artifacts: ['c1.md'],
          acceptance: ['ok'],
        },
        {
          id: 'C2',
          stage: 's1',
          title: 'Tie-break 2',
          dependsOn: [],
          priority: 80,
          executor: 'ex',
          artifacts: ['c2.md'],
          acceptance: ['ok'],
        },
        {
          id: 'D1',
          stage: 's2',
          title: 'Depends on A',
          dependsOn: ['A'],
          priority: 90,
          executor: 'ex',
          artifacts: ['d1.md'],
          acceptance: ['ok'],
        },
        {
          id: 'D2',
          stage: 's3',
          title: 'Depends on D1',
          dependsOn: ['D1'],
          priority: 90,
          executor: 'ex',
          artifacts: ['d2.md'],
          acceptance: ['ok'],
        },
      ],
    });

    const criticality = computeCriticality(graph);
    expect(criticality.get('A')).toEqual({
      targetId: 'A',
      transitiveDependents: 2,
      longestDownstreamChain: 2,
    });
    expect(criticality.get('B')).toEqual({
      targetId: 'B',
      transitiveDependents: 0,
      longestDownstreamChain: 0,
    });

    const h = await createHarness({ graph });
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const rev = (await h.graphs.getRevision('g-1', 1))!;
    const run = await h.ledger.createRun({ graph: rev, createdBy: 'user:alice' });

    // A has 2 transitive dependents so it ranks ahead of B (0 dependents, higher priority),
    // followed by B (priority 99), then C1 before C2 (priority 80, alphabetical id tie-break).
    expect(eligibleTargets(run, graph)).toEqual(['A', 'B', 'C1', 'C2']);
    expect(computeEligibleTargets(run, graph)).toEqual(['A', 'B', 'C1', 'C2']);
    expect(h.controller.eligibleTargets(run, graph)).toEqual(['A', 'B', 'C1', 'C2']);

    // Mark A as `verified` (not `completed`): D1 must NOT be unlocked!
    expect(UNLOCKING_TARGET_STATUSES).toEqual(['completed']);
    run.targets['A'].status = 'verified';
    expect(dependenciesCompleted(run, graph.targets.find((t) => t.id === 'D1')!)).toBe(false);
    expect(eligibleTargets(run, graph)).not.toContain('D1');
    expect(newlyUnlockedTargets(run, graph)).not.toContain('D1');

    // Only when A reaches `completed` does D1 become eligible.
    run.targets['A'].status = 'completed';
    expect(dependenciesCompleted(run, graph.targets.find((t) => t.id === 'D1')!)).toBe(true);
    expect(eligibleTargets(run, graph)).toContain('D1');
    expect(newlyUnlockedTargets(run, graph)).toContain('D1');
  });

  it('drives the full lifecycle from LOAD_LEDGER through UNLOCK_DEPENDENCIES and SELECT_NEXT_TARGET to run completion', async () => {
    const h = await createHarness();
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const started = await h.controller.startRun({ graphId: 'g-1', principal: 'alice' });
    const finalRun = (await h.controller.settled(started.runId))!;
    expect(finalRun.status).toBe('completed');
    expect(finalRun.targets['Y1.1'].status).toBe('completed');
    expect(finalRun.targets['Y1.2'].status).toBe('completed');
    expect(finalRun.targets['Y1.3'].status).toBe('completed');
    expect(finalRun.resource.tasksStarted).toBe(3);

    // Check phase ordering for Y1.1
    const allEvents = await h.events.read(started.runId);
    const runPhases = allEvents.filter((e) => e.type === 'target.phase').map((e) => e.data.phase as GoalPhase);
    expect(runPhases).toContain('LOAD_LEDGER');

    const y11Phases = allEvents
      .filter((e) => e.type === 'target.phase' && e.targetId === 'Y1.1')
      .map((e) => e.data.phase as GoalPhase);

    expect(y11Phases).toEqual([
      'UNLOCK_DEPENDENCIES',
      'SELECT_TARGET',
      'PLAN_TASK',
      'PREFLIGHT',
      'ROUTE_MODEL',
      'EXECUTE',
      'CHALLENGE',
      'INDEPENDENT_VERIFY',
      'ACCEPTANCE_GATE',
      'COMMIT_PROGRESS',
      'SELECT_NEXT_TARGET',
    ]);

    // Check transitions for Y1.1: queued -> eligible -> active -> verifying -> verified -> completed
    const transitions = await h.ledger.transitions(started.runId, 'Y1.1');
    expect(transitions.map((t) => `${t.fromState}->${t.toState}`)).toEqual([
      'queued->eligible',
      'eligible->active',
      'active->verifying',
      'verifying->verified',
      'verified->completed',
    ]);
  });

  it('refuses self-certified completion when validatorIdentity equals executorIdentity and triggers repair instead', async () => {
    let callCount = 0;
    const graph = makeGraphDefinition({
      targets: [
        {
          id: 'T1',
          stage: 's1',
          title: 'Single target',
          dependsOn: [],
          priority: 100,
          executor: 'axiomatize',
          artifacts: ['claim.md'],
          acceptance: ['Independently checked'],
        },
      ],
    });

    const h = await createHarness({
      graph,
      verifyFn: async ({ run, target, attempt, executorIdentity }) => {
        callCount++;
        return [
          {
            id: `ev-${attempt.attempt}`,
            runId: run.runId,
            targetId: target.id,
            attemptId: attempt.id,
            graphRevision: run.graphRevision,
            workspaceRevision: `rev-${attempt.attempt}`,
            artifacts: [{ uri: 'claim.md', digest: 'sha256:111' }],
            validationMethod: 'independent-check',
            // Attempt 1 tries to self-certify with the same identity as executor; attempt 2 uses an independent verifier
            validatorIdentity: callCount === 1 ? executorIdentity : 'independent-verifier',
            executorIdentity,
            verdict: 'PASS',
            criterion: 'Independently checked',
            limitations: [],
            createdAt: new Date().toISOString(),
          },
        ];
      },
    });
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const started = await h.controller.startRun({ graphId: 'g-1', principal: 'alice' });
    const finalRun = (await h.controller.settled(started.runId))!;
    expect(finalRun.status).toBe('completed');
    expect(finalRun.targets['T1'].status).toBe('completed');
    expect(finalRun.targets['T1'].attempts).toBe(2);
    expect(finalRun.targets['T1'].repairs).toBe(1);
  });

  it('executes the repair loop (DIAGNOSE -> REPAIR_HYPOTHESIS -> REPLAN -> RETEST) and blocks after maxRepairsPerTask', async () => {
    const graph = makeGraphDefinition({
      constitution: {
        ...makeGraphDefinition().constitution,
        resourceLimits: {
          ...makeGraphDefinition().constitution.resourceLimits,
          maxRepairsPerTask: 2,
          maxSameActionNoProgress: 5,
        },
      },
      targets: [
        {
          id: 'FAILING',
          stage: 's1',
          title: 'Target that keeps failing verification',
          dependsOn: [],
          priority: 100,
          executor: 'axiomatize',
          artifacts: ['out.md'],
          acceptance: ['Must pass'],
        },
      ],
    });

    const h = await createHarness({
      graph,
      gateFn: ({ run, target, attempt }) => ({
        runId: run.runId,
        targetId: target.id,
        attemptId: attempt.id,
        decision: 'repair',
        perCriterion: [{ criterion: 'Must pass', verdict: 'FAIL', evidenceIds: [] }],
        reasons: [`verification failed on attempt ${attempt.attempt}`],
        decidedAt: new Date().toISOString(),
      }),
    });
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const started = await h.controller.startRun({ graphId: 'g-1', principal: 'alice' });
    const finalRun = (await h.controller.settled(started.runId))!;

    // Initial attempt (1) + 2 repairs (attempts 2 and 3) = 3 attempts total, then BLOCK_TARGET
    expect(finalRun.targets['FAILING'].status).toBe('blocked');
    expect(finalRun.targets['FAILING'].attempts).toBe(3);
    expect(finalRun.targets['FAILING'].repairs).toBe(2);
    expect(finalRun.status).toBe('idle');

    const events = await h.events.read(started.runId);
    const phases = events.filter((e) => e.type === 'target.phase' && e.targetId === 'FAILING').map((e) => e.data.phase as GoalPhase);
    expect(phases).toContain('DIAGNOSE');
    expect(phases).toContain('REPAIR_HYPOTHESIS');
    expect(phases).toContain('REPLAN');
    expect(phases).toContain('RETEST');
    expect(phases).toContain('BLOCK_TARGET');
    expect(phases).toContain('RECORD_EVIDENCE');
  });

  it('blocks one exhausted branch (BLOCK_TARGET -> RECORD_EVIDENCE) while continuing unrelated eligible branches to completion', async () => {
    const graph = makeGraphDefinition({
      constitution: {
        ...makeGraphDefinition().constitution,
        resourceLimits: {
          ...makeGraphDefinition().constitution.resourceLimits,
          maxRepairsPerTask: 1,
          maxConcurrentTargets: 2,
        },
      },
      targets: [
        {
          id: 'BAD_ROOT',
          stage: 's1',
          title: 'Failing branch root',
          dependsOn: [],
          priority: 100,
          executor: 'axiomatize',
          artifacts: ['bad.md'],
          acceptance: ['Pass bad'],
        },
        {
          id: 'BAD_CHILD',
          stage: 's2',
          title: 'Depends on failing root',
          dependsOn: ['BAD_ROOT'],
          priority: 95,
          executor: 'axiomatize',
          artifacts: ['bad-child.md'],
          acceptance: ['Pass child'],
        },
        {
          id: 'GOOD_ROOT',
          stage: 's1',
          title: 'Healthy branch root',
          dependsOn: [],
          priority: 80,
          executor: 'formal_verify',
          artifacts: ['good.md'],
          acceptance: ['Pass good'],
        },
        {
          id: 'GOOD_CHILD',
          stage: 's2',
          title: 'Depends on healthy root',
          dependsOn: ['GOOD_ROOT'],
          priority: 75,
          executor: 'formal_verify',
          artifacts: ['good-child.md'],
          acceptance: ['Pass good child'],
        },
      ],
    });

    const h = await createHarness({
      graph,
      gateFn: ({ run, target, attempt, evidence }) => {
        if (target.id === 'BAD_ROOT') {
          return {
            runId: run.runId,
            targetId: target.id,
            attemptId: attempt.id,
            decision: 'repair',
            perCriterion: [{ criterion: 'Pass bad', verdict: 'FAIL', evidenceIds: [] }],
            reasons: ['bad root failed check'],
            decidedAt: new Date().toISOString(),
          };
        }
        return {
          runId: run.runId,
          targetId: target.id,
          attemptId: attempt.id,
          decision: 'completed',
          perCriterion: target.acceptance.map((c) => ({
            criterion: c,
            verdict: 'PASS',
            evidenceIds: evidence.map((e) => e.id),
          })),
          reasons: ['passed'],
          decidedAt: new Date().toISOString(),
        };
      },
    });
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const started = await h.controller.startRun({ graphId: 'g-1', principal: 'alice' });
    const settled = (await h.controller.settled(started.runId))!;

    expect(settled.targets['BAD_ROOT'].status).toBe('blocked');
    expect(settled.targets['BAD_CHILD'].status).toBe('queued');
    expect(settled.targets['GOOD_ROOT'].status).toBe('completed');
    expect(settled.targets['GOOD_CHILD'].status).toBe('completed');
    expect(settled.status).toBe('idle');
  });

  it('pauses only the affected branch on AWAIT_APPROVAL and awaiting_external while completing unrelated eligible branches, then completes upon approval resolution and retryTarget', async () => {
    let externalReady = false;
    const graph = makeGraphDefinition({
      targets: [
        {
          id: 'APPROVAL_BRANCH',
          stage: 's1',
          title: 'Needs human approval',
          dependsOn: [],
          priority: 100,
          executor: 'standards_strategy',
          artifacts: ['standards.md'],
          acceptance: ['Drafted'],
          requiresApproval: true,
        },
        {
          id: 'APPROVAL_DEPENDENT',
          stage: 's2',
          title: 'Unlocked only after approval branch completes',
          dependsOn: ['APPROVAL_BRANCH'],
          priority: 90,
          executor: 'standards_strategy',
          artifacts: ['followup.md'],
          acceptance: ['Followup done'],
        },
        {
          id: 'EXTERNAL_BRANCH',
          stage: 's1',
          title: 'Needs external record',
          dependsOn: [],
          priority: 95,
          executor: 'external_evidence',
          artifacts: ['adoption.md'],
          acceptance: ['External record attached'],
          externalDependency: true,
        },
        {
          id: 'UNRELATED_BRANCH',
          stage: 's1',
          title: 'Runs unattended to completion',
          dependsOn: [],
          priority: 70,
          executor: 'axiomatize',
          artifacts: ['unattended.md'],
          acceptance: ['Unattended pass'],
        },
      ],
    });

    const h = await createHarness({
      graph,
      verifyFn: async ({ run, target, attempt, executorIdentity }) => {
        const isExternalPass = target.id === 'EXTERNAL_BRANCH' && externalReady;
        return target.acceptance.map((criterion, i) => ({
          id: `ev-${target.id}-${attempt.attempt}-${i}`,
          runId: run.runId,
          targetId: target.id,
          attemptId: attempt.id,
          graphRevision: run.graphRevision,
          workspaceRevision: `rev-${attempt.attempt}`,
          artifacts: [{ uri: target.artifacts[0], digest: 'sha256:abc' }],
          // On first run of EXTERNAL_BRANCH, only 'independent-check' is present (no 'external-record'),
          // so enforceGate transitions it to 'awaiting_external'.
          validationMethod: isExternalPass ? 'external-record' : 'independent-check',
          validatorIdentity: 'verifier-1',
          executorIdentity,
          verdict: 'PASS',
          criterion,
          limitations: [],
          createdAt: new Date().toISOString(),
        }));
      },
    });
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const started = await h.controller.startRun({ graphId: 'g-1', principal: 'alice' });
    const firstPass = (await h.controller.settled(started.runId))!;

    expect(firstPass.status).toBe('idle');
    expect(firstPass.targets['APPROVAL_BRANCH'].status).toBe('needs_approval');
    expect(firstPass.targets['APPROVAL_DEPENDENT'].status).toBe('queued');
    expect(firstPass.targets['EXTERNAL_BRANCH'].status).toBe('awaiting_external');
    expect(firstPass.targets['UNRELATED_BRANCH'].status).toBe('completed');

    const events = await h.events.read(started.runId);
    expect(events.some((e) => e.type === 'approval.requested' && e.targetId === 'APPROVAL_BRANCH')).toBe(true);
    const approvalPhases = events
      .filter((e) => e.type === 'target.phase' && e.targetId === 'APPROVAL_BRANCH')
      .map((e) => e.data.phase);
    expect(approvalPhases).toContain('AWAIT_APPROVAL');
    expect(approvalPhases).toContain('PERSIST_STATE');

    // Grant completion approval for APPROVAL_BRANCH -> unlocks and completes APPROVAL_DEPENDENT
    await h.controller.resolveApproval(started.runId, 'APPROVAL_BRANCH', {
      granted: true,
      principal: 'alice',
      reason: 'Reviewed and approved',
    });
    const secondPass = (await h.controller.settled(started.runId))!;
    expect(secondPass.targets['APPROVAL_BRANCH'].status).toBe('completed');
    expect(secondPass.targets['APPROVAL_DEPENDENT'].status).toBe('completed');
    expect(secondPass.targets['EXTERNAL_BRANCH'].status).toBe('awaiting_external');
    expect(secondPass.status).toBe('idle');

    // Now supply external record and retry EXTERNAL_BRANCH -> run reaches 'completed'
    externalReady = true;
    await h.controller.retryTarget(started.runId, 'EXTERNAL_BRANCH', 'alice');
    const thirdPass = (await h.controller.settled(started.runId))!;
    expect(thirdPass.targets['EXTERNAL_BRANCH'].status).toBe('completed');
    expect(thirdPass.status).toBe('completed');
  });

  it('supports pause, resume, stop, and crash recovery (recoverRuns) with idempotent EXECUTE replay', async () => {
    let releaseFirstTarget!: () => void;
    const firstTargetGate = new Promise<void>((resolve) => {
      releaseFirstTarget = resolve;
    });
    let notifyFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      notifyFirstStarted = resolve;
    });

    let executeCallsForY11 = 0;

    const graph = makeGraphDefinition({
      constitution: {
        ...makeGraphDefinition().constitution,
        resourceLimits: {
          ...makeGraphDefinition().constitution.resourceLimits,
          maxConcurrentTargets: 1,
        },
      },
    });

    const h = await createHarness({
      graph,
      leaseTtlMs: 300,
      executorFn: async (input) => {
        if (input.target.id === 'Y1.1') {
          executeCallsForY11++;
          notifyFirstStarted();
          await firstTargetGate;
        }
        return {
          executionId: `exec-${input.target.id}-${input.attempt.attempt}`,
          ok: true,
          summary: `executed ${input.target.id}`,
        };
      },
    });
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const started = await h.controller.startRun({ graphId: 'g-1', principal: 'operator' });
    await firstStarted;

    // Pause while Y1.1 is in flight -> status becomes 'pausing', then 'paused' once Y1.1 finishes
    const pausingLedger = await h.controller.pause(started.runId, 'operator');
    expect(['pausing', 'paused']).toContain(pausingLedger.status);

    releaseFirstTarget();
    const pausedLedger = (await h.controller.settled(started.runId))!;
    expect(pausedLedger.status).toBe('paused');
    expect(pausedLedger.targets['Y1.1'].status).toBe('completed');
    expect(pausedLedger.targets['Y1.2'].status).toBe('queued');

    // Resume the run and simulate a process crash (shutdown without releasing leases) after Y1.1
    await h.controller.resume(started.runId, 'operator');
    const completedRun = (await h.controller.settled(started.runId))!;
    expect(completedRun.status).toBe('completed');
    expect(executeCallsForY11).toBe(1);

    // Now test crash recovery on a second run where EXECUTE already succeeded in `ledger.once`
    // before the process crashed while target was still `active`.
    const rev = (await h.graphs.getRevision('g-1', 1))!;
    const crashRun = await h.ledger.createRun({ graph: rev, createdBy: 'user:operator', runId: 'run-crash-1' });
    const lease = (await h.ledger.acquireLease(crashRun.runId, 'dead-controller', 100))!;
    let crashExecCount = 0;
    const execKey = idempotencyKey(crashRun.runId, 'Y1.1', 1, 'EXECUTE');
    await h.ledger.once(execKey, async () => {
      crashExecCount++;
      return { executionId: 'exec-recorded-before-crash', ok: true, summary: 'pre-crash execution' };
    });
    await h.ledger.saveAttempt({
      id: `${crashRun.runId}:Y1.1:1`,
      runId: crashRun.runId,
      targetId: 'Y1.1',
      attempt: 1,
      phase: 'EXECUTE',
      startedAt: h.clock.now.toISOString(),
    });
    await h.ledger.commit(
      crashRun.runId,
      crashRun.ledgerRevision,
      lease,
      (l) => {
        l.status = 'running';
        l.targets['Y1.1'].status = 'active';
        l.targets['Y1.1'].attempts = 1;
        l.targets['Y1.1'].lastAttemptId = `${crashRun.runId}:Y1.1:1`;
        l.resource.tasksStarted = 1;
      },
      [],
    );

    // Advance clock past the dead controller's lease TTL so the secondary controller can recover it
    h.clock.advanceMs(500);
    const secondController = h.createSecondController('controller-recovery');
    controllers.push(secondController);

    const recoveredIds = await secondController.recoverRuns();
    expect(recoveredIds).toContain(crashRun.runId);

    const recoveredFinal = (await secondController.settled(crashRun.runId))!;
    expect(recoveredFinal.status).toBe('completed');
    expect(recoveredFinal.targets['Y1.1'].status).toBe('completed');
    expect(recoveredFinal.targets['Y1.2'].status).toBe('completed');
    expect(recoveredFinal.targets['Y1.3'].status).toBe('completed');
    // EXECUTE for Y1.1 was replayed from ledger.once, not re-executed!
    expect(crashExecCount).toBe(1);
  });

  it('supports operator stop() cancelling in-flight targets and transitioning the run to stopped', async () => {
    let notifyStarted!: () => void;
    const startedPromise = new Promise<void>((r) => {
      notifyStarted = r;
    });

    const h = await createHarness({
      executorFn: async ({ signal, target }) => {
        notifyStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          executionId: `exec-${target.id}`,
          ok: false,
          summary: 'aborted',
          error: { code: 'CANCELLED', message: 'aborted', retryable: false },
        };
      },
    });
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const run = await h.controller.startRun({ graphId: 'g-1', principal: 'operator' });
    await startedPromise;

    await h.controller.stop(run.runId, 'operator');
    const finalRun = (await h.controller.settled(run.runId))!;
    expect(finalRun.status).toBe('stopped');
    expect(finalRun.targets['Y1.1'].status).toBe('stopped');
  });

  it('enforces constitution.resourceLimits (maxTasksPerRun, maxSameActionNoProgress, hostedSpendUsd, maxRunMinutes)', async () => {
    // 1. maxTasksPerRun ceiling stops the run after the allowed number of tasks
    const maxTasksGraph = makeGraphDefinition({
      constitution: {
        ...makeGraphDefinition().constitution,
        resourceLimits: {
          ...makeGraphDefinition().constitution.resourceLimits,
          maxTasksPerRun: 1,
          maxConcurrentTargets: 1,
        },
      },
    });
    const h1 = await createHarness({ graph: maxTasksGraph });
    tempDirs.push(h1.workspaceRoot);
    controllers.push(h1.controller);

    const r1 = await h1.controller.startRun({ graphId: 'g-1', principal: 'alice' });
    const f1 = (await h1.controller.settled(r1.runId))!;
    expect(f1.targets['Y1.1'].status).toBe('completed');
    expect(f1.targets['Y1.2'].status).toBe('eligible');
    expect(f1.resource.tasksStarted).toBe(1);
    expect(f1.status).toBe('stopped');

    // 2. hostedSpendUsd: 0 blocks hosted model routes immediately
    const h2 = await createHarness({
      routeFn: async () => ({
        modelId: 'claude-3-7-sonnet',
        runtimeId: 'anthropic',
        hosted: true,
        estimatedCostUsd: 0.25,
        reasons: ['hosted fallback'],
        rejected: [],
        decidedAt: new Date().toISOString(),
      }),
    });
    tempDirs.push(h2.workspaceRoot);
    controllers.push(h2.controller);

    const r2 = await h2.controller.startRun({ graphId: 'g-1', principal: 'alice' });
    const f2 = (await h2.controller.settled(r2.runId))!;
    expect(f2.targets['Y1.1'].status).toBe('blocked');
    expect(f2.targets['Y1.1'].blockers.some((b) => b.includes('BUDGET_EXCEEDED'))).toBe(true);

    // 3. maxSameActionNoProgress blocks immediately when the same failureSignature repeats
    const noProgressGraph = makeGraphDefinition({
      constitution: {
        ...makeGraphDefinition().constitution,
        resourceLimits: {
          ...makeGraphDefinition().constitution.resourceLimits,
          maxRepairsPerTask: 5,
          maxSameActionNoProgress: 2,
        },
      },
      targets: [
        {
          id: 'STUCK',
          stage: 's1',
          title: 'Repeated identical failure signature',
          dependsOn: [],
          priority: 100,
          executor: 'axiomatize',
          artifacts: ['stuck.md'],
          acceptance: ['Pass'],
        },
      ],
    });
    const h3 = await createHarness({
      graph: noProgressGraph,
      gateFn: ({ run, target, attempt }) => ({
        runId: run.runId,
        targetId: target.id,
        attemptId: attempt.id,
        decision: 'repair',
        perCriterion: [{ criterion: 'Pass', verdict: 'FAIL', evidenceIds: [] }],
        reasons: ['identical failure'],
        decidedAt: new Date().toISOString(),
      }),
      recoveryFn: async ({ attempt }) => ({
        action: 'repair',
        failureClass: 'verification',
        diagnosis: 'identical error',
        hypothesis: `Novel hypothesis #${attempt.attempt}`,
        failureSignature: 'sig-identical-stuck',
        reasons: ['same signature'],
      }),
    });
    tempDirs.push(h3.workspaceRoot);
    controllers.push(h3.controller);

    const r3 = await h3.controller.startRun({ graphId: 'g-1', principal: 'alice' });
    const f3 = (await h3.controller.settled(r3.runId))!;
    expect(f3.targets['STUCK'].status).toBe('blocked');
    expect(f3.targets['STUCK'].attempts).toBe(2);
    expect(f3.targets['STUCK'].blockers.some((b) => b.includes('NO_PROGRESS'))).toBe(true);

    // 4. maxRunMinutes deadline stops the run when clock reaches deadlineAt
    const deadlineGraph = makeGraphDefinition({
      constitution: {
        ...makeGraphDefinition().constitution,
        resourceLimits: {
          ...makeGraphDefinition().constitution.resourceLimits,
          maxRunMinutes: 10,
        },
      },
    });
    const h4 = await createHarness({
      graph: deadlineGraph,
      leaseTtlMs: 120 * 60_000, // 2h lease TTL so advancing clock by 11m does not expire the lease
      executorFn: async (input) => {
        if (input.target.id === 'Y1.1') {
          // Advance past the 10-minute deadline during Y1.1 execution
          h4.clock.advanceMs(11 * 60_000);
        }
        return {
          executionId: `exec-${input.target.id}`,
          ok: true,
          summary: 'done',
        };
      },
    });
    tempDirs.push(h4.workspaceRoot);
    controllers.push(h4.controller);

    const r4 = await h4.controller.startRun({ graphId: 'g-1', principal: 'alice' });
    const f4 = (await h4.controller.settled(r4.runId))!;
    expect(f4.status).toBe('stopped');
    expect(f4.targets['Y1.1'].status).toBe('completed');
    expect(f4.targets['Y1.2'].status).toBe('eligible');
  });

  it('honors runEligible() operator preference ahead of default critical-path order', async () => {
    const executedOrder: TargetId[] = [];
    const graph = makeGraphDefinition({
      constitution: {
        ...makeGraphDefinition().constitution,
        resourceLimits: {
          ...makeGraphDefinition().constitution.resourceLimits,
          maxConcurrentTargets: 1,
        },
      },
      targets: [
        {
          id: 'HIGH_PRIORITY',
          stage: 's1',
          title: 'Higher priority root',
          dependsOn: [],
          priority: 100,
          executor: 'axiomatize',
          artifacts: ['hp.md'],
          acceptance: ['ok'],
        },
        {
          id: 'PREFERRED_LOW',
          stage: 's1',
          title: 'Operator preferred root',
          dependsOn: [],
          priority: 10,
          executor: 'axiomatize',
          artifacts: ['pl.md'],
          acceptance: ['ok'],
        },
      ],
    });

    const h = await createHarness({
      graph,
      executorFn: async (input) => {
        executedOrder.push(input.target.id);
        return {
          executionId: `exec-${input.target.id}`,
          ok: true,
          summary: 'ok',
        };
      },
    });
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const rev = (await h.graphs.getRevision('g-1', 1))!;
    const run = await h.ledger.createRun({ graph: rev, createdBy: 'user:alice', runId: 'run-pref-1' });
    await h.controller.runEligible(run.runId, 'PREFERRED_LOW', 'alice');
    const finalRun = (await h.controller.settled(run.runId))!;
    expect(finalRun.status).toBe('completed');
    expect(executedOrder).toEqual(['PREFERRED_LOW', 'HIGH_PRIORITY']);
  });

  it('bridges createTargetTaskExecutor to Wazir ExecutionEngine and writes artifacts idempotently per key', async () => {
    const h = await createHarness();
    tempDirs.push(h.workspaceRoot);
    controllers.push(h.controller);

    const engine = new ExecutionEngine({ workspace: h.workspaceRoot, fastStartup: true });
    const taskExecutor = createTargetTaskExecutor({
      workspaceRoot: h.workspaceRoot,
      clock: h.clock.fn,
      ledger: h.ledger,
      executionEngine: engine,
    });

    const rev = (await h.graphs.getRevision('g-1', 1))!;
    const run = await h.ledger.createRun({ graph: rev, createdBy: 'user:alice' });
    const target = rev.definition.targets[0];
    const attempt: TargetAttempt = {
      id: `${run.runId}:${target.id}:1`,
      runId: run.runId,
      targetId: target.id,
      attempt: 1,
      phase: 'EXECUTE',
      startedAt: h.clock.now.toISOString(),
    };
    const route: ModelRouteDecision = {
      modelId: 'qwen2.5-coder:14b',
      runtimeId: 'ollama-local',
      computerId: 'local-mac',
      hosted: false,
      estimatedCostUsd: 0,
      reasons: ['local'],
      rejected: [],
      decidedAt: h.clock.now.toISOString(),
    };

    const emitted: GoalStudioEvent[] = [];
    const key = idempotencyKey(run.runId, target.id, 1, 'EXECUTE');
    const first = await taskExecutor.execute({
      key,
      run,
      target,
      attempt,
      route,
      workspaceRoot: h.workspaceRoot,
      signal: new AbortController().signal,
      onEvent: (e) => emitted.push(e),
    });

    expect(first.ok).toBe(true);
    expect(first.executionId).toBeTruthy();
    expect(emitted.length).toBeGreaterThanOrEqual(2);

    const record = await engine.get(first.executionId);
    expect(record).toBeDefined();
    expect(record!.filesChanged.length).toBe(target.artifacts.length);

    // Re-running with the same idempotency key returns the exact same executionId without creating a new ExecutionRecord
    const second = await taskExecutor.execute({
      key,
      run,
      target,
      attempt,
      route,
      workspaceRoot: h.workspaceRoot,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(second.executionId).toBe(first.executionId);
    expect((await engine.list()).length).toBe(1);

    // Also verify transition state machine helper guardrails
    expect(canTransitionTarget('verified', 'completed', 'controller')).toBe(true);
    expect(canTransitionTarget('needs_approval', 'completed', 'controller')).toBe(false);
    expect(canTransitionTarget('needs_approval', 'completed', 'user:alice')).toBe(true);
    expect(() => assertTargetTransition('Y1.1', 'queued', 'completed', 'controller')).toThrow();
  });
});
