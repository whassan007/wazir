import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyShellInput } from '@wazir/core';
import {
  DEFAULT_VALIDATOR_IDENTITY,
  GoalStudioFailure,
  createGoalGovernance,
  createVerificationService,
  createWorkflowRuntimeService,
  evaluateGate,
  findCycles,
  type CheckRunner,
  type EvidenceRecord,
  type GoalRunLedger,
  type GoalTarget,
  type TargetAttempt,
} from '@wazir/goals';
import { JsonFileStore, MemoryStore } from '@wazir/shared';
import { createInitialShellState, executeShellLine } from '../../apps/cli/src/commands/shellCommand.js';

function makeClock(startIso = '2026-11-21T14:00:00.000Z') {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advanceMs: (delta: number) => {
      ms += delta;
    },
  };
}

describe('Wazir Loop, Graph, Goal & Universal Shell Acceptance Suite', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-acceptance-lgg-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  it('Scenario 9: maintains shared JsonFileStore parity across separate runtime instances (list/status/inspect/pause/resume/stop)', async () => {
    const storeFile = path.join(workspaceRoot, '.wazir', 'shared-runtime.json');
    await fs.writeFile(
      path.join(workspaceRoot, 'cities.json'),
      JSON.stringify([{ name: 'Solis' }, { name: 'Vespera' }, { name: 'Aurelia' }]),
      'utf8',
    );

    const execCounts: Record<string, number> = {};
    let notifyItem2Started!: () => void;
    const item2Started = new Promise<void>((resolve) => {
      notifyItem2Started = resolve;
    });
    let releaseItem2!: () => void;
    const item2Gate = new Promise<void>((resolve) => {
      releaseItem2 = resolve;
    });

    const runtimeShell = createWorkflowRuntimeService({
      store: new JsonFileStore(storeFile),
      workspaceRoot,
      holderId: 'shell-instance',
      targetHandler: async (ctx) => {
        execCounts[ctx.target.id] = (execCounts[ctx.target.id] ?? 0) + 1;
        if (ctx.target.id === 'L-002') {
          notifyItem2Started();
          await item2Gate;
        }
        return { ok: true, summary: `done ${ctx.target.id}`, claimedDone: true };
      },
    });

    const runtimeApi = createWorkflowRuntimeService({
      store: new JsonFileStore(storeFile),
      workspaceRoot,
      holderId: 'api-instance',
      targetHandler: async (ctx) => {
        execCounts[ctx.target.id] = (execCounts[ctx.target.id] ?? 0) + 1;
        return { ok: true, summary: `resumed ${ctx.target.id}`, claimedDone: true };
      },
    });

    const execPromise = runtimeShell.executeToCompletion({
      prompt: 'Improve every Lorecraft city',
      originInterface: 'shell',
      maxConcurrency: 1,
      workspaceRoot,
    });

    await item2Started;

    const jobsFromApi = await runtimeApi.listJobs();
    expect(jobsFromApi).toHaveLength(1);
    const runId = jobsFromApi[0]!.runId;
    expect(jobsFromApi[0]!.mode).toBe('loop');
    expect(jobsFromApi[0]!.originInterface).toBe('shell');

    const statusFromApi = await runtimeApi.getStatus(runId);
    expect(statusFromApi?.runId).toBe(runId);
    expect(statusFromApi?.progress.completed).toBe(1);

    const inspected = await runtimeApi.inspect(runId);
    expect(inspected?.run.runId).toBe(runId);
    expect(inspected?.plan?.mode).toBe('loop');
    expect(inspected?.targets).toHaveLength(3);
    expect(inspected?.events.length).toBeGreaterThan(0);

    // Pause from instance 2 while instance 1 holds the lease
    const pausePromise = runtimeApi.pause(runId, 'user:api-operator', 'operator pause');
    await new Promise((r) => setTimeout(r, 150));
    releaseItem2();

    const pausedLedger = await pausePromise;
    expect(pausedLedger.status).toBe('paused');
    await execPromise;
    await runtimeShell.shutdown();

    expect(execCounts['L-003'] ?? 0).toBe(0);

    // Resume from instance 2 to finish L-003
    const finished = await runtimeApi.resume(runId, 'user:web-operator', { wait: true });
    expect(finished.status).toBe('completed');
    expect(execCounts['L-001']).toBe(1);
    expect(execCounts['L-002']).toBe(1);
    expect(execCounts['L-003']).toBe(1);

    // Also verify stop from instance 2 on a second active run
    let notifyStopReady!: () => void;
    const stopReady = new Promise<void>((resolve) => {
      notifyStopReady = resolve;
    });
    const runtimeShell2 = createWorkflowRuntimeService({
      store: new JsonFileStore(storeFile),
      workspaceRoot,
      holderId: 'shell-instance-2',
      targetHandler: async (ctx) => {
        if (ctx.target.id === 'L-001') {
          notifyStopReady();
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { ok: false, summary: 'aborted by stop', error: { code: 'CANCELLED', message: 'stopped', retryable: false } };
        }
        return { ok: true, summary: 'done', claimedDone: true };
      },
    });
    const exec2 = runtimeShell2.executeToCompletion({
      prompt: 'Improve every Lorecraft city',
      maxConcurrency: 1,
      workspaceRoot,
    });
    await stopReady;
    const allJobs = await runtimeApi.listJobs();
    const run2Id = allJobs.find((j) => j.runId !== runId)!.runId;
    const stoppedLedger = await runtimeApi.stop(run2Id, 'user:cli-operator', 'operator stop');
    expect(stoppedLedger.status).toBe('stopped');
    await exec2;

    await runtimeShell2.shutdown();
    await runtimeApi.shutdown();
  });

  it('Scenario 10: recovers Lorecraft city Loop after crash/restart with zero duplicate execution of verified cities', async () => {
    const storeFile = path.join(workspaceRoot, '.wazir', 'lorecraft-recovery.json');
    await fs.mkdir(path.join(workspaceRoot, 'lorecraft'), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, 'lorecraft', 'cities.json'),
      JSON.stringify([
        { id: 'aldervale', name: 'Aldervale' },
        { id: 'briarhollow', name: 'Briarhollow' },
        { id: 'cinderford', name: 'Cinderford' },
      ]),
      'utf8',
    );

    const clock = makeClock();
    const execCounts: Record<string, number> = {};
    let notifyCity2InFlight!: () => void;
    const city2InFlight = new Promise<void>((resolve) => {
      notifyCity2InFlight = resolve;
    });

    const checkRunner: CheckRunner = {
      async run() {
        return { exitCode: 0, stdout: 'city verified', stderr: '', timedOut: false, durationMs: 4, sandbox: 'none' };
      },
    };

    const runtime1 = createWorkflowRuntimeService({
      store: new JsonFileStore(storeFile),
      workspaceRoot,
      clock: clock.now,
      holderId: 'crash-worker',
      leaseTtlMs: 80,
      checkRunner,
      targetHandler: async (ctx) => {
        const key = ctx.loopItem?.itemId ?? ctx.target.id;
        execCounts[key] = (execCounts[key] ?? 0) + 1;
        if (ctx.target.id === 'L-002') {
          notifyCity2InFlight();
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          return { ok: false, summary: 'process crashed', error: { code: 'CANCELLED', message: 'crash', retryable: true } };
        }
        return { ok: true, summary: `Verified ${key}`, claimedDone: true };
      },
    });

    const started = await runtime1.start({
      prompt: 'Improve every Lorecraft city and test it',
      maxConcurrency: 1,
      verifyCommands: ['npm run verify:city'],
      workspaceRoot,
    });
    expect(started.plan.loop?.collectionSource).toBe('lorecraft/cities.json');

    await city2InFlight;
    await runtime1.shutdown({ releaseLeases: false });
    clock.advanceMs(500);

    const runtime2 = createWorkflowRuntimeService({
      store: new JsonFileStore(storeFile),
      workspaceRoot,
      clock: clock.now,
      holderId: 'recovered-worker',
      leaseTtlMs: 5_000,
      checkRunner,
      targetHandler: async (ctx) => {
        const key = ctx.loopItem?.itemId ?? ctx.target.id;
        execCounts[key] = (execCounts[key] ?? 0) + 1;
        return { ok: true, summary: `Recovered ${key}`, claimedDone: true };
      },
    });

    const recovered = await runtime2.recover({ wait: true });
    await runtime2.shutdown();

    const finalRun = recovered.find((r) => r.runId === started.run.runId);
    expect(finalRun?.status).toBe('completed');
    expect(finalRun?.targets['L-001']?.status).toBe('completed');
    expect(finalRun?.targets['L-002']?.status).toBe('completed');
    expect(finalRun?.targets['L-003']?.status).toBe('completed');
    expect(execCounts['aldervale']).toBe(1);
    expect(execCounts['cinderford']).toBe(1);
  });

  it('Scenario 11: rejects agent false completion, drives bounded diagnosis/block, and blocks unsafe/unapproved actions', async () => {
    const failingRunner: CheckRunner = {
      async run() {
        return { exitCode: 1, stdout: '', stderr: 'Tests failed: 1 failing', timedOut: false, durationMs: 5, sandbox: 'none' };
      },
    };

    const runtime = createWorkflowRuntimeService({
      store: new MemoryStore(),
      workspaceRoot,
      checkRunner: failingRunner,
      targetHandler: async () => ({
        ok: true,
        summary: 'Agent insists status is done',
        claimedDone: true,
        filesWritten: [],
      }),
    });

    const falseDoneRes = await runtime.executeToCompletion({
      prompt: 'Implement login handler',
      overrideMode: 'single',
      verifyCommands: ['npm test'],
      maxRepairsPerTask: 3,
      maxSameActionNoProgress: 2,
      workspaceRoot,
    });

    expect(falseDoneRes.run.status).toBe('idle');
    expect(falseDoneRes.run.targets['T1']?.status).toBe('blocked');
    expect(falseDoneRes.run.targets['T1']?.blockers.some((b) => b.includes('NO_PROGRESS'))).toBe(true);
    expect(falseDoneRes.evidence.some((e) => e.verdict === 'FAIL')).toBe(true);

    // Policy gate 1: out-of-workspace deletion rejected before execution
    await expect(
      runtime.start({ prompt: 'delete all files outside workspace in /etc', workspaceRoot }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Policy gate 2: production deploy pauses at needs_approval until approved
    const cleanRuntime = createWorkflowRuntimeService({
      store: new MemoryStore(),
      workspaceRoot,
    });
    const gated = await cleanRuntime.executeToCompletion({
      prompt: 'Build backend API, run QA tests, and deploy directly to production',
      workspaceRoot,
    });
    expect(gated.run.targets['G7.prod_release_gate']?.status).toBe('needs_approval');
    expect(gated.run.status).toBe('idle');

    await cleanRuntime.approve(gated.run.runId, 'G7.prod_release_gate', 'user:sec-lead', 'Approved prod deploy');
    await cleanRuntime.controller.settled(gated.run.runId);
    await cleanRuntime.approve(gated.run.runId, 'G7.prod_release_gate', 'user:sec-lead', 'Approved prod signoff');
    const released = await cleanRuntime.controller.settled(gated.run.runId);
    expect(released?.status).toBe('completed');

    await runtime.shutdown();
    await cleanRuntime.shutdown();
  });

  it('Scenario 12: constructs acyclic multi-branch DAG, computes critical path, and isolates blocked branch from unrelated parallel branch', async () => {
    const executionOrder: string[] = [];
    const runtime = createWorkflowRuntimeService({
      store: new MemoryStore(),
      workspaceRoot,
      targetHandler: async (ctx) => {
        executionOrder.push(ctx.target.id);
        if (ctx.target.id === 'G2.multiplayer') {
          return {
            ok: false,
            summary: 'Multiplayer server dependency missing',
            error: { code: 'EXECUTION_FAILED', message: 'missing multiplayer socket runtime', retryable: false },
          };
        }
        return { ok: true, summary: `Completed ${ctx.target.id}`, claimedDone: true };
      },
    });

    const prompt =
      'Build multiplayer platform with paid accounts, authentication, subscriptions, multiplayer servers, player synchronization, deployment and QA';
    const compiled = await runtime.compile({ prompt, maxRepairsPerTask: 1, maxSameActionNoProgress: 2, workspaceRoot });
    expect(compiled.validation.valid).toBe(true);
    expect(findCycles(compiled.graph.definition.targets)).toEqual([]);
    expect(compiled.plan.mode).toBe('graph');
    expect(compiled.plan.criticalPath.targets.length).toBeGreaterThanOrEqual(4);
    expect(compiled.plan.criticalPath.targets[0]).toBe('G1.architecture');

    const res = await runtime.executeToCompletion({
      prompt,
      maxRepairsPerTask: 1,
      maxSameActionNoProgress: 2,
      workspaceRoot,
    });
    await runtime.shutdown();

    // Blocked G2.multiplayer stops downstream G3.backend / G5.staging_deploy / G6.qa...
    expect(res.run.targets['G2.multiplayer']?.status).toBe('blocked');
    expect(res.run.targets['G6.qa']?.status).toBe('queued');
    expect(executionOrder).not.toContain('G6.qa');

    // ...while unrelated parallel branch G2.auth -> G3.billing completes cleanly!
    expect(res.run.targets['G1.architecture']?.status).toBe('completed');
    expect(res.run.targets['G2.auth']?.status).toBe('completed');
    expect(res.run.targets['G3.billing']?.status).toBe('completed');
  });

  it('Scenario 13: preserves OS Shell semantics (cd, quoted dirs, env vars, pipelines, exit codes) and Wazir command escapes', async () => {
    const spacedDir = path.join(workspaceRoot, 'nested dir with spaces');
    const binDir = path.join(workspaceRoot, 'fake-bin');
    await fs.mkdir(spacedDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });

    const statusMarker = path.join(workspaceRoot, 'os-status.out');
    const statusBin = path.join(binDir, process.platform === 'win32' ? 'status.cmd' : 'status');
    await fs.writeFile(statusBin, `#!/bin/sh\necho "NATIVE_STATUS_OK" > "${statusMarker}"\n`, { mode: 0o755 });

    const state = createInitialShellState({
      initialCwd: workspaceRoot,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
    });

    expect(await executeShellLine(`cd "${spacedDir}"`, state)).toBe(0);
    expect(await fs.realpath(state.cwd)).toBe(await fs.realpath(spacedDir));
    expect(await executeShellLine('cd -', state)).toBe(0);
    expect(await fs.realpath(state.cwd)).toBe(await fs.realpath(workspaceRoot));

    expect(await executeShellLine('export WAZIR_ACCEPT="0.4.0"', state)).toBe(0);
    expect(await executeShellLine('WAZIR_TAG=verified', state)).toBe(0);

    const pipeFile = path.join(workspaceRoot, 'pipeline.out');
    expect(
      await executeShellLine(`! printf "$WAZIR_ACCEPT:$WAZIR_TAG\\nother\\n" | grep verified > "${pipeFile}"`, state),
    ).toBe(0);
    expect((await fs.readFile(pipeFile, 'utf8')).trim()).toBe('0.4.0:verified');

    expect(await executeShellLine('! sh -c "exit 23"', state)).toBe(23);
    expect(state.lastExitCode).toBe(23);

    // Reserved Wazir commands vs escapes
    expect(classifyShellInput('loop "Improve X && test it"')).toMatchObject({ mode: 'wazir', wazirCommand: 'loop' });
    expect(classifyShellInput('jobs | wc -l').mode).toBe('shell');
    expect(classifyShellInput('! jobs')).toMatchObject({ mode: 'shell', explicit: true, command: 'jobs' });
    expect(classifyShellInput('\\jobs')).toMatchObject({ mode: 'shell', explicit: true, command: 'jobs' });
    expect(classifyShellInput('os:status')).toMatchObject({ mode: 'shell', explicit: true, command: 'status' });

    expect(await executeShellLine('\\jobs', state)).toBe(0);
    expect(await executeShellLine('! jobs', state)).toBe(0);
    expect(await executeShellLine('os:status', state)).toBe(0);
    expect((await fs.readFile(statusMarker, 'utf8')).trim()).toBe('NATIVE_STATUS_OK');
  });

  it('Scenario 14: enforces security invariants (rejects self-verification when validatorIdentity===executorIdentity and denies unbudgeted hosted spend)', async () => {
    const store = new MemoryStore();

    // 14a. VerificationService + evaluateGate reject self-verification directly
    const artifactRel = 'outputs/report.json';
    await fs.mkdir(path.join(workspaceRoot, 'outputs'), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, artifactRel), '{"ok":true}', 'utf8');

    const selfVerifyingService = createVerificationService({
      store,
      workspaceRoot,
      validatorIdentity: 'model:agent-same',
    });

    const target: GoalTarget = {
      id: 'S1',
      stage: 'verify',
      title: 'Security self-verification check',
      dependsOn: [],
      priority: 100,
      executor: 'task_worker',
      artifacts: [artifactRel],
      acceptance: ['Artifact exists and checks pass'],
    };
    const fakeRun: GoalRunLedger = {
      runId: 'run-sec-1',
      graphId: 'graph-sec-1',
      graphRevision: 1,
      graphDigest: 'sha256:00',
      status: 'running',
      ledgerRevision: 1,
      targets: {
        S1: { targetId: 'S1', status: 'verifying', attempts: 1, repairs: 0, evidenceIds: [], blockers: [], updatedAt: '2026-11-21T14:00:00.000Z' },
      },
      resource: { tasksStarted: 1, hostedSpendUsd: 0, startedAt: '2026-11-21T14:00:00.000Z', deadlineAt: '2026-11-21T15:00:00.000Z' },
      createdBy: 'user:local',
      createdAt: '2026-11-21T14:00:00.000Z',
      updatedAt: '2026-11-21T14:00:00.000Z',
    };
    const attempt: TargetAttempt = {
      id: 'run-sec-1:S1:1',
      runId: 'run-sec-1',
      targetId: 'S1',
      attempt: 1,
      phase: 'INDEPENDENT_VERIFY',
      startedAt: '2026-11-21T14:00:00.000Z',
    };

    const selfEvidence = await selfVerifyingService.verify({
      run: fakeRun,
      target,
      attempt,
      workspaceRoot,
      executorIdentity: 'model:agent-same',
    });
    expect(selfEvidence.some((e) => e.verdict === 'PASS')).toBe(false);
    expect(selfEvidence.some((e) => e.limitations.some((l) => l.includes('validator identity equals executor identity')))).toBe(true);

    // Even if a fabricated self-report PASS record is passed to evaluateGate, it is rejected
    const forgedPass: EvidenceRecord = {
      ...selfEvidence[0]!,
      id: 'ev-forged-self-pass',
      validationMethod: 'command',
      verdict: 'PASS',
      criterion: 'Artifact exists and checks pass',
      validatorIdentity: 'model:agent-same',
      executorIdentity: 'model:agent-same',
    };
    const gateDecision = evaluateGate({
      run: fakeRun,
      target,
      attempt,
      evidence: [...selfEvidence, forgedPass],
      executorIdentity: 'model:agent-same',
    });
    expect(gateDecision.decision).toBe('repair');
    expect(gateDecision.reasons.some((r) => r.includes('SELF_VERIFICATION_REJECTED'))).toBe(true);

    // 14b. Runtime end-to-end rejects self-verification when routed executor matches DEFAULT_VALIDATOR_IDENTITY
    const selfVerifyRuntime = createWorkflowRuntimeService({
      store: new MemoryStore(),
      workspaceRoot,
      defaultModel: DEFAULT_VALIDATOR_IDENTITY,
      defaultComputer: 'local',
    });
    const selfVerifyRun = await selfVerifyRuntime.executeToCompletion({
      prompt: 'Execute task with validator identity',
      overrideMode: 'single',
      maxRepairsPerTask: 1,
      maxSameActionNoProgress: 2,
      workspaceRoot,
    });
    await selfVerifyRuntime.shutdown();
    expect(selfVerifyRun.run.status).not.toBe('completed');
    expect(selfVerifyRun.run.targets['T1']?.status).toBe('blocked');

    // 14c. Unbudgeted hosted spend is denied by governance and blocked at runtime
    let hostedExecutions = 0;
    const hostedRuntime = createWorkflowRuntimeService({
      store: new MemoryStore(),
      workspaceRoot,
      defaultModel: 'claude-sonnet-4',
      targetHandler: async () => {
        hostedExecutions += 1;
        return { ok: true, summary: 'should be blocked' };
      },
    });
    const hostedRes = await hostedRuntime.executeToCompletion({
      prompt: 'Run hosted model with zero budget',
      overrideMode: 'single',
      maxBudgetUsd: 0,
      workspaceRoot,
    });
    await hostedRuntime.shutdown();

    expect(hostedExecutions).toBe(0);
    expect(hostedRes.run.targets['T1']?.status).toBe('blocked');
    expect(hostedRes.run.targets['T1']?.blockers.some((b) => b.includes('BUDGET_EXCEEDED'))).toBe(true);

    const governance = createGoalGovernance({ store, workspaceRoot });
    expect(governance.authorizeSpend(fakeRun, 0.01).effect).toBe('deny');
    expect(governance.assertHumanOrSystemPrincipal('model:agent-same', 'approve').effect).toBe('deny');
  });
});
