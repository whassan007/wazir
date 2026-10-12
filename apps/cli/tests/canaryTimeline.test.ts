import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentRegistry,
  ApprovalQueue,
  ComputerRegistry,
  ContextCompiler,
  ExecutionEngine,
  JobOrchestrator,
  ModelRegistry,
  PolicyEngine,
  RuntimeRegistry,
  Scheduler,
  WorktreeManager,
  CheckpointService,
  VerificationEngine,
  SolutionSearchService,
  type CanaryEvent,
  type ExperimentPlan,
} from '@wazir/core';
import { ToolRegistry, defaultTools } from '@wazir/tools';
import { MemoryStore } from '@wazir/shared';
import { EvaluationService, MetaOptimizerService, BenchmarkService, CanaryDeploymentService } from '@wazir/evaluation';
import { TuiTestHarness } from '../src/tui/inputHarness.js';
import type { RookEngine } from '../src/engine.js';
import { stripAnsi, stringDisplayWidth } from '../src/tui/unicode.js';
import {
  CanaryLiveEventBuffer,
  LIVE_BUFFER_MAX_EVENTS,
  LIVE_BUFFER_MAX_SAMPLES,
  TIMELINE_MAX_ENTRIES,
  UNKNOWN,
  buildCanaryRollbackWhy,
  filterTimeline,
  loadCanaryTimeline,
  renderCanaryTimelineModal,
} from '../src/tui/canaryTimeline.js';

const outcome = (canaryId: string, i: number, over: Record<string, unknown> = {}) => ({
  canaryId, executionId: `exec-${i}`, variant: 'canary' as const, taskSuccess: true, verificationSuccess: true,
  toolCallsCount: 1, toolFailuresCount: 0, repairCyclesCount: 0, tokensUsed: 100, wallTimeMs: 1000, ...over,
});

async function fixture(extra: Record<string, unknown> = {}) {
  const store = new MemoryStore();
  const service = new CanaryDeploymentService({ store });
  const live: CanaryEvent[] = [];
  service.onEvent((e) => live.push(e));
  const record = await service.registerCanary({
    candidateId: 'cand-1', candidateConfig: { strategy: 'x' } as any, baselineConfig: { strategy: 'y' } as any,
    domain: 'routing', qualificationStatus: 'QUALIFIED', ...extra,
  });
  const load = () => loadCanaryTimeline({ canaryId: record.canaryId, store, liveEvents: live, record: service.getDeployment(record.canaryId) });
  return { store, service, live, record, load };
}

describe('Canary Timeline Explorer — projection', () => {
  it('normal progression: started → stage entered → ready to promote, from actual events', async () => {
    const { service, record, load } = await fixture({
      promotionThresholds: { minStageSamples: 2, minTotalSamples: 6 },
    });
    for (let i = 0; i < 6; i++) await service.recordExecutionOutcome(outcome(record.canaryId, i));
    const { entries } = await load();
    const labels = entries.map((e) => e.label);
    expect(labels[0]).toBe('STARTED');
    expect(labels).toContain('CANARY_5');
    const stage = entries.find((e) => e.label === 'CANARY_5')!;
    expect(stage.allocation).toBe('5%');
    expect(stage.sampleCount).toBe('2');
    expect(stage.actor).toBe('controller:CanaryDeploymentService');
    const transitions = filterTimeline(entries, 'TRANSITIONS').map((e) => e.label);
    expect(transitions).not.toContain('SAMPLE');
  });

  it('normal progression: promotion readiness is recorded with its sample count', async () => {
    const { service, record, load } = await fixture({ promotionThresholds: { minStageSamples: 100, minTotalSamples: 3 } });
    for (let i = 0; i < 3; i++) await service.recordExecutionOutcome(outcome(record.canaryId, i));
    const ready = (await load()).entries.find((e) => e.label === 'READY_TO_PROMOTE')!;
    expect(ready).toMatchObject({ newState: 'READY_TO_PROMOTE', sampleCount: '3', isTransition: true });
  });

  it('pause/resume come from the durable canary/events store with stored actor and states', async () => {
    const { service, record, store } = await fixture();
    await service.pauseCanary(record.canaryId);
    await service.resumeCanary(record.canaryId);
    // No live events: proves they are read from the durable store.
    const { entries } = await loadCanaryTimeline({ canaryId: record.canaryId, store });
    const [pause, resume] = filterTimeline(entries, 'OPERATOR');
    expect(pause).toMatchObject({ label: 'PAUSED', previousState: 'ACTIVE', newState: 'PAUSED', actor: 'operator:cli', source: 'store', allocation: '0%' });
    expect(resume).toMatchObject({ label: 'RESUMED', previousState: 'PAUSED', newState: 'ACTIVE', allocation: '1%' });
  });

  it('manual advance and throttle record stage/allocation changes', async () => {
    const { service, record, load } = await fixture();
    await service.advanceCanaryStage(record.canaryId);
    await service.throttleCanary(record.canaryId, 2);
    const ops = filterTimeline((await load()).entries, 'OPERATOR');
    expect(ops.map((e) => e.label)).toEqual(['ADVANCED', 'THROTTLED']);
    expect(ops[0]).toMatchObject({ previousState: 'ACTIVE:CANARY_1', newState: 'STAGED_EXPANSION', stage: 'CANARY_5', allocation: '5%' });
    expect(ops[1]).toMatchObject({ reason: 'requestedAction=throttle:2', allocation: '2%', isTransition: true });
    // Live copy of persisted event is de-duplicated.
    expect((await load()).entries.filter((e) => e.label === 'ADVANCED')).toHaveLength(1);
  });

  it('automatic rollback carries exact RegressionGuard evidence and a grounded why', async () => {
    const { service, record, load } = await fixture();
    await service.recordExecutionOutcome(outcome(record.canaryId, 1, { taskSuccess: false }));
    const { entries } = await load();
    const regression = filterTimeline(entries, 'REGRESSION');
    expect(regression.map((e) => e.label)).toEqual(['REGRESSION', 'ROLLBACK']);
    const rb = regression[1];
    const stored = service.getDeployment(record.canaryId)!.rollbackReason!;
    expect(rb.guardEvidence).toMatchObject({ metric: stored.metric, baselineValue: String(stored.baselineValue), canaryValue: String(stored.canaryValue), threshold: String(stored.threshold) });
    expect(rb.reason).toBe(stored.description);
    const why = buildCanaryRollbackWhy(rb, record.canaryId);
    expect(why.rationale[0]).toBe(stored.description);
    expect(why.evidence.find((e) => e.label === 'Metric')?.value).toBe('task_failure_rate');
    expect(filterTimeline(entries, 'OPERATOR')).toHaveLength(0);
  });

  it('operator rollback is classified as OPERATOR, not REGRESSION', async () => {
    const { service, record, load } = await fixture();
    await service.rollbackCanary(record.canaryId, 'manual stop');
    const { entries } = await load();
    const ops = filterTimeline(entries, 'OPERATOR');
    expect(ops.map((e) => e.label)).toEqual(['ROLLBACK', 'ROLLBACK']);
    expect(ops.find((e) => e.eventType === 'canary.rollback.triggered')).toMatchObject({ reason: 'manual stop', actor: 'operator (operator_override)' });
    expect(ops.find((e) => e.eventType === 'canary.operator.action')).toMatchObject({ actor: 'operator:cli', previousState: 'ACTIVE', newState: 'ROLLED_BACK' });
    expect(filterTimeline(entries, 'REGRESSION').every((e) => e.guardEvidence?.metric === 'operator_override')).toBe(true);
  });

  it('record-derived rollback surfaces stored evidence after restart (no events available)', async () => {
    const { service, record, store } = await fixture();
    await service.recordExecutionOutcome(outcome(record.canaryId, 1, { taskSuccess: false }));
    const reloaded = new CanaryDeploymentService({ store });
    await reloaded.hydrate();
    const { entries } = await loadCanaryTimeline({ canaryId: record.canaryId, store, record: reloaded.getDeployment(record.canaryId) });
    expect(entries.map((e) => `${e.label}:${e.source}`)).toEqual(['REGISTERED:record', 'ROLLBACK:record']);
    expect(entries[1].guardEvidence?.metric).toBe('task_failure_rate');
  });

  it('unknown fields render as UNKNOWN instead of being invented', async () => {
    const bare = { id: 'e1', type: 'canary.operator.action', canaryId: 'c', candidateId: undefined, timestamp: 'garbage', data: {} } as any;
    const { entries } = await loadCanaryTimeline({ canaryId: 'c', liveEvents: [bare] });
    expect(entries[0]).toMatchObject({ previousState: UNKNOWN, newState: UNKNOWN, allocation: UNKNOWN, actor: UNKNOWN, sampleCount: UNKNOWN, stage: UNKNOWN });
    expect(entries[0].timestamp).toBeUndefined();
    const text = stripAnsi(renderCanaryTimelineModal({ canaryId: 'c', entries, filter: 'ALL', selectedIndex: 0, truncated: false, totalAvailable: 1, width: 100, maxRows: 40 }).join('\n'));
    expect(text).toContain('Guard          UNKNOWN');
    expect(text).toContain('--:--:--');
  });

  it('long history is bounded: live buffers cap per canary and timeline keeps the newest entries', async () => {
    const buf = new CanaryLiveEventBuffer();
    for (let i = 0; i < 1000; i++) {
      buf.push({ id: `s${i}`, type: 'canary.sample.recorded', canaryId: 'c', candidateId: 'x', domain: 'routing', timestamp: new Date(i) } as any);
      buf.push({ id: `t${i}`, type: 'canary.stage.entered', canaryId: 'c', candidateId: 'x', domain: 'routing', stage: 'CANARY_5', timestamp: new Date(i) } as any);
    }
    const kept = buf.get('c');
    expect(kept).toHaveLength(LIVE_BUFFER_MAX_EVENTS + LIVE_BUFFER_MAX_SAMPLES);
    const result = await loadCanaryTimeline({ canaryId: 'c', liveEvents: kept });
    expect(result.entries).toHaveLength(TIMELINE_MAX_ENTRIES);
    expect(result.truncated).toBe(true);
    expect(result.entries.at(-1)!.timestamp!.getTime()).toBe(999);
    const lines = renderCanaryTimelineModal({ canaryId: 'c', ...result, filter: 'ALL', selectedIndex: 120, width: 100, maxRows: 30 });
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(stripAnsi(lines.join('\n'))).toContain('oldest dropped');
  });

  it('empty history renders an explicit empty state', async () => {
    const { entries, totalAvailable } = await loadCanaryTimeline({ canaryId: 'none', store: new MemoryStore() });
    expect(entries).toEqual([]);
    const text = stripAnsi(renderCanaryTimelineModal({ canaryId: 'none', entries, filter: 'ALL', selectedIndex: 0, truncated: false, totalAvailable, width: 80, maxRows: 20 }).join('\n'));
    expect(text).toContain('No stored canary events for this canary.');
    expect(text).not.toContain('Timestamp');
  });

  it('shadow filter only selects shadow events', async () => {
    const { service, record, load } = await fixture();
    service.recordShadowExecution({
      canaryId: record.canaryId, taskId: 't1', executionId: 'ex-shadow',
      productionOutcome: { success: true, verificationSuccess: true, tokensUsed: 1, wallTimeMs: 1 },
      shadowOutcome: { success: true, verificationSuccess: true, tokensUsed: 1, wallTimeMs: 1 },
    });
    const shadow = filterTimeline((await load()).entries, 'SHADOW');
    expect(shadow.map((e) => e.label)).toEqual(['SHADOW_SAMPLE']);
    expect(shadow[0].relatedIds).toContain('execution:ex-shadow');
    expect(shadow[0].relatedIds).toContain('task:t1');
  });

  it('resize: modal never exceeds terminal width or row budget', async () => {
    const { service, record, load } = await fixture();
    await service.pauseCanary(record.canaryId);
    await service.resumeCanary(record.canaryId);
    await service.rollbackCanary(record.canaryId, 'a very long operator reason '.repeat(10));
    const r = await load();
    for (const width of [30, 60, 80, 120, 240]) {
      for (const maxRows of [8, 16, 40]) {
        const lines = renderCanaryTimelineModal({ canaryId: record.canaryId, ...r, filter: 'ALL', selectedIndex: 2, width, maxRows });
        expect(lines.length).toBeLessThanOrEqual(maxRows);
        for (const line of lines) expect(stringDisplayWidth(stripAnsi(line))).toBeLessThanOrEqual(Math.max(24, width));
      }
    }
  });
});

describe('Canary Timeline Explorer — Mission Control integration', () => {
  let projectRoot: string;
  let harness: TuiTestHarness;
  let canaryService: CanaryDeploymentService;
  let store: MemoryStore;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-canary-timeline-'));
    const executions = new ExecutionEngine({ workspace: projectRoot });
    await executions.ready;
    const worktrees = new WorktreeManager({ worktreeRootDir: path.join(projectRoot, '.wazir', 'worktrees') });
    store = new MemoryStore();
    canaryService = new CanaryDeploymentService({ store });
    const checkpointService = new CheckpointService({ executionEngine: executions, worktreeManager: worktrees, defaultWorkspaceRoot: projectRoot });
    const evaluationService = new EvaluationService();
    const benchmarkService = new BenchmarkService(evaluationService);
    const optimizer = new MetaOptimizerService({
      worktreeManager: worktrees, checkpointService, verificationEngine: new VerificationEngine({ projectRoot }),
      evaluationService, benchmarkService, projectRoot, canaryDeploymentService: canaryService,
    });
    const computers = new ComputerRegistry();
    const runtimes = new RuntimeRegistry();
    const models = new ModelRegistry();
    const agents = new AgentRegistry();
    const tools = new ToolRegistry(defaultTools);
    const compiler = new ContextCompiler();
    const approvalQueue = new ApprovalQueue();
    const orchestrator = new JobOrchestrator({ computers, runtimes, models, agents, tools, compiler, executions, approvalQueue }, { defaultConcurrencyLimit: 2 });
    const engine = {
      config: { models: { startup: { mode: 'none' } }, modelContext: {}, modelCapabilities: {}, networkAllowed: false, allowCommands: [], denyCommands: [], allowedMcpServers: [] } as any,
      configDir: path.join(projectRoot, '.wazir'), projectRoot, computers, runtimes, models, agents, tools,
      policy: new PolicyEngine(), scheduler: new Scheduler(computers, runtimes, models, agents, executions), compiler, executions,
      approvalQueue, orchestrator, worktrees, checkpoints: checkpointService,
      solutionSearch: new SolutionSearchService({ checkpointService, worktreeManager: worktrees, executionEngine: executions, projectRoot }),
      evaluation: evaluationService, benchmark: benchmarkService, optimizer, planner: {} as any, adapters: new Map(), discovered: [],
      worker: {} as any, store, secretBroker: {} as any, hostedAdapters: new Map(),
    } as unknown as RookEngine;
    harness = new TuiTestHarness({ engine, concurrencyLimit: 2, useWorktrees: false });
    await harness.start();
    engine.optimizer!.registerExperiment({
      experimentId: 'exp-rt', name: 'routing', hypothesis: { domain: 'routing', statement: 's' } as any, baselineCheckpointId: 'b',
      primaryMetric: 'tokens' as any, secondaryMetrics: [], benchmarkCategories: [], benchmarkTasks: [], sampleSize: 1,
      budget: { maxWallTimeMs: 1, maxTotalTokens: 1 }, createdAt: new Date(),
    } as ExperimentPlan);
  });

  afterEach(async () => {
    harness.stop();
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('opens with [l], filters, answers why rollback from stored evidence, and is read-only', async () => {
    const canary = await canaryService.registerCanary({
      candidateId: 'cand-rt', candidateConfig: {} as any, baselineConfig: {} as any, domain: 'routing', qualificationStatus: 'QUALIFIED',
    });
    await canaryService.pauseCanary(canary.canaryId);
    await canaryService.resumeCanary(canary.canaryId);
    await canaryService.recordExecutionOutcome(outcome(canary.canaryId, 1, { verificationSuccess: false, taskSuccess: true }));
    const before = JSON.stringify(canaryService.getDeployment(canary.canaryId));
    const storedKeys = (await store.list('canary/events/')).length;

    harness.sendKey('2');
    harness.sendKey('l');
    await settle();
    const tl = harness.tui.getCanaryTimeline()!;
    expect(tl.canaryId).toBe(canary.canaryId);
    expect(tl.entries.map((e) => e.label)).toEqual(expect.arrayContaining(['PAUSED', 'RESUMED', 'REGRESSION', 'ROLLBACK']));
    expect(harness.tui.getSelectedCanaryTimelineEntry()?.label).toBe('ROLLBACK');
    expect(stripAnsi(harness.getScreenBuffer())).toContain('CANARY TIMELINE');

    harness.sendKey('f'); // TRANSITIONS
    harness.sendKey('f'); // OPERATOR
    expect(harness.tui.getCanaryTimeline()!.filter).toBe('OPERATOR');
    expect(harness.tui.getSelectedCanaryTimelineEntry()?.label).toBe('RESUMED');
    harness.sendKey('f'); // REGRESSION
    harness.sendKey('w');
    expect(harness.tui.isWhyModalOpen()).toBe(true);
    const stored = canaryService.getDeployment(canary.canaryId)!.rollbackReason!;
    expect(stripAnsi(harness.getScreenBuffer())).toContain(stored.metric);

    // "why rollback" command is grounded in the same stored evidence.
    const why = harness.tui.buildWhyExplanation('rollback');
    expect(why.rationale[0]).toBe(stored.description);
    expect(why.evidence.find((e) => e.label === 'Metric')?.value).toBe('verification_failure_rate');

    harness.sendKey('\u001b'); // close why
    harness.sendKey('p'); // must NOT reach the pause handler while the timeline is open
    harness.sendKey('\u001b'); // close timeline
    expect(harness.tui.getCanaryTimeline()).toBeUndefined();
    expect(JSON.stringify(canaryService.getDeployment(canary.canaryId))).toBe(before);
    expect((await store.list('canary/events/')).length).toBe(storedKeys);
  });

  it('shows empty state and survives a terminal resize while open', async () => {
    const canary = await canaryService.registerCanary({
      candidateId: 'cand-rt', candidateConfig: {} as any, baselineConfig: {} as any, domain: 'routing', qualificationStatus: 'QUALIFIED',
    });
    await harness.tui.openCanaryTimeline(canary.canaryId);
    // The TUI subscribed at start(), so the live canary.started emission is captured.
    expect(harness.tui.getCanaryTimeline()!.entries.map((e) => e.label)).toEqual(['STARTED']);
    for (const cols of [40, 80, 160]) {
      harness.outStream.columns = cols;
      harness.outStream.emit('resize');
      harness.tui.draw();
      for (const line of harness.getLines()) expect(stringDisplayWidth(stripAnsi(line))).toBeLessThanOrEqual(cols);
    }
    harness.tui.setCanaryTimelineFilter('REGRESSION');
    expect(stripAnsi(harness.getScreenBuffer())).toContain('No events match filter REGRESSION');
  });
});
