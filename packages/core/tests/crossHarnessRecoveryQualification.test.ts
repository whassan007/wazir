import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  ExecutionFailure,
  JsonFileStore,
  MemoryStore,
  classifyHttpFailure,
  faultInjector,
  injectFault,
  isProviderRetryable,
} from '@wazir/shared';
import {
  CheckpointService,
  ComputerRegistry,
  ExecutionEngine,
  HandoffService,
  JobManager,
  ModelRegistry,
  PolicyEngine,
  RecoveryManager,
  RuntimeRegistry,
  Scheduler,
  SchedulingError,
  WorktreeManager,
  hashToolArguments,
  inspectVerificationEvidence,
  planRecovery,
  reconstructExecutionState,
} from '../src/index.js';
import { reconcileLocalOutcomes } from '../src/services/executionRecovery.js';
import type {
  ExecutionRecord,
  FileMutationResult,
  Task,
  ToolCallRecord,
} from '../src/types/index.js';

export interface ScenarioQualificationOutcome {
  scenarioId: number;
  name: string;
  recoverable: boolean;
  recovered: boolean;
  failedClosed: boolean;
  recoveryLatencyMs: number;
  repeatedToolCalls: number;
  duplicateSideEffects: number;
  preCrashVerifiedFiles: number;
  preservedVerifiedFiles: number;
  budgetAccountingErrors: number;
  policyViolations: number;
  evidenceSummary: string;
}

export interface RecoveryQualificationMetrics {
  recovery_success_rate: number;
  recovery_latency: {
    p50: number;
    p95: number;
    mean: number;
  };
  repeated_tool_calls: number;
  duplicate_side_effects: number;
  verified_work_preserved: number;
  budget_accounting_errors: number;
  policy_violations: number;
  scenarios: ScenarioQualificationOutcome[];
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    type: 'coding',
    title: `Recovery qualification task ${id}`,
    input: `Implement and verify feature for ${id}`,
    requirements: {
      capabilities: ['coding'],
      toolCalling: true,
      minimumContext: 4096,
    },
    acceptanceContract: {
      requiredEvidence: ['TEST'],
    },
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
    ...overrides,
  };
}

function makeToolResult(
  callId: string,
  tool: string,
  input: unknown,
  ok = true,
  output = 'ok',
): ToolCallRecord {
  return {
    id: callId,
    callId,
    tool,
    input,
    output,
    ok,
    policyEffect: 'allow',
    policyRule: 'filesystem-project-allow',
    durationMs: 4,
    at: new Date(),
  };
}

async function applyConfirmedFileWrite(
  engine: ExecutionEngine,
  executionId: string,
  workspaceRoot: string,
  relPath: string,
  content: string,
  callId: string,
  lease?: { workerId?: string; leaseEpoch?: number; leaseToken?: string; now?: Date },
): Promise<FileMutationResult> {
  const fullPath = path.join(workspaceRoot, relPath);
  let existedBefore = false;
  let beforeHash = 'ABSENT';
  try {
    const existing = await fs.readFile(fullPath, 'utf8');
    existedBefore = true;
    beforeHash = sha256(existing);
  } catch {
    // file did not exist before
  }

  await engine.recordToolStart(
    executionId,
    'write',
    { path: relPath, content },
    { callId, sideEffectClass: 'IDEMPOTENT_WRITE', ...(lease ?? {}) },
  );

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
  const afterHash = sha256(content);

  const mutation: FileMutationResult = {
    path: relPath,
    attempted: true,
    succeeded: true,
    existedBefore,
    existsAfter: true,
    beforeHash,
    afterHash,
    changed: beforeHash !== afterHash,
  };

  await engine.recordToolCall(
    executionId,
    makeToolResult(callId, 'write', { path: relPath, content }, true, `wrote ${relPath}`),
    lease,
  );
  await engine.recordFileMutations(executionId, [mutation], afterHash, lease);
  return mutation;
}

function computePercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1),
  );
  return Number(sortedValues[idx].toFixed(3));
}

// ============================================================================
// 12 MANDATORY FAILURE-INJECTION SCENARIO RUNNERS
// ============================================================================

/**
 * Scenario 1: Kill a native agent during implementation.
 * Interrupts mid-turn after a verified file write, reconstructs state from durable
 * events, reconciles physical state, and resumes on a backup native agent without
 * repeating the confirmed write.
 */
export async function runScenario1KillNativeAgent(baseTmpDir: string): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's1-native-kill-'));
  const durableRecords = new Map<string, ExecutionRecord>();
  const store = new MemoryStore();

  const createEngine = (ownerPid: number, aliveCheck: (pid: number) => boolean) =>
    new ExecutionEngine({
      workspace: workspaceDir,
      owner: { pid: ownerPid, host: os.hostname() },
      isProcessAlive: aliveCheck,
      load: () => Array.from(durableRecords.values()).map((r) => structuredClone(r)),
      persist: (r) => {
        r.execution.owner = { pid: ownerPid, host: os.hostname() };
        durableRecords.set(r.execution.id, structuredClone(r));
      },
    });

  const primaryPid = 41001;
  const engine1 = createEngine(primaryPid, () => true);
  await engine1.ready;

  const worktreeManager = new WorktreeManager({
    worktreeRootDir: path.join(workspaceDir, '.wazir', 'worktrees'),
  });
  const checkpointService = new CheckpointService({
    store,
    executionEngine: engine1,
    worktreeManager,
    defaultWorkspaceRoot: workspaceDir,
  });
  await checkpointService.ready;

  const record = await engine1.create({
    task: makeTask('task-s1'),
    agentId: 'native-coder-primary',
    computerId: 'local-workstation',
    runtimeId: 'ollama-local',
    modelId: 'qwen2.5-coder:14b',
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine1.setStatus(execId, 'running');

  // Step 1: Confirmed write of src/moduleA.ts + passing build check + checkpoint
  const fileAContent = 'export function add(a: number, b: number): number { return a + b; }\n';
  await engine1.recordEvent(execId, 'generation.started', { turn: 1 });
  await applyConfirmedFileWrite(engine1, execId, workspaceDir, 'src/moduleA.ts', fileAContent, 'call-s1-write-a');
  await engine1.recordUsage(execId, { input: 120, output: 80, total: 200 });
  await engine1.recordCheck(execId, {
    name: 'build',
    command: 'tsc --noEmit',
    ok: true,
    output: 'build clean',
    durationMs: 12,
    workspaceRevision: 1,
  });
  const chk1 = await checkpointService.checkpoint(execId, { description: 'after-moduleA-verified' });
  expect(chk1.workspaceRevision).toBe(1);

  // Step 2: Native agent starts a second write, writes bytes to disk, and crashes (SIGKILL / exit 137)
  // before the tool completion is persisted.
  const fileBContent = 'export function multiply(a: number, b: number): number { return a * b; }\n';
  await engine1.recordEvent(execId, 'generation.started', { turn: 2 });
  await engine1.recordToolStart(
    execId,
    'write',
    { path: 'src/moduleB.ts', content: fileBContent },
    { callId: 'call-s1-write-b', sideEffectClass: 'IDEMPOTENT_WRITE' },
  );
  await fs.writeFile(path.join(workspaceDir, 'src/moduleB.ts'), fileBContent, 'utf8');

  faultInjector.register({
    point: 'AFTER_TOOL_EXECUTION_BEFORE_PERSIST',
    action: { type: 'kill_process', exitCode: 137 },
  });

  await expect(
    engine1.recordToolCall(execId, makeToolResult('call-s1-write-b', 'write', { path: 'src/moduleB.ts' })),
  ).rejects.toThrow('CRASH_SIMULATION: Process hard kill (exit 137) at AFTER_TOOL_EXECUTION_BEFORE_PERSIST');
  faultInjector.clear();

  // Measure recovery on backup controller/agent
  const recoveryStart = performance.now();
  const backupPid = 41002;
  const engine2 = createEngine(backupPid, (pid) => pid !== primaryPid);
  await engine2.ready;

  const handoffService = new HandoffService({
    store,
    executions: engine2,
    checkpoints: checkpointService,
    projectRoot: workspaceDir,
  });
  await handoffService.ready;

  // Startup recovery marked the crashed call as OUTCOME_UNKNOWN and execution as failed (OWNER_PROCESS_EXITED)
  const unknownBefore = engine2.findUnknownOutcomeToolCall(execId);
  expect(unknownBefore?.callId).toBe('call-s1-write-b');

  // Inspect physical disk for call-s1-write-b: fileBContent is physically present
  const diskB = await fs.readFile(path.join(workspaceDir, 'src/moduleB.ts'), 'utf8');
  expect(diskB).toBe(fileBContent);

  await engine2.reconcileToolCall(execId, 'call-s1-write-b', {
    outcome: 'APPLIED',
    evidence: 'Physical file src/moduleB.ts matches intended content sha256',
    inspectedBy: 'recovery-controller',
  });
  await engine2.recordFileMutations(
    execId,
    [
      {
        path: 'src/moduleB.ts',
        attempted: true,
        succeeded: true,
        existedBefore: false,
        existsAfter: true,
        beforeHash: 'ABSENT',
        afterHash: sha256(fileBContent),
        changed: true,
      },
    ],
    sha256(fileBContent),
  );

  // Create portable handoff to backup native agent
  const handoff = await handoffService.createAutomatic('native_agent_crash', execId, {
    sourceAgent: 'native-coder-primary',
    targetAgent: 'native-coder-backup',
  });
  expect(handoff.completed.files).toEqual(expect.arrayContaining(['src/moduleA.ts', 'src/moduleB.ts']));

  // Resume the SAME execution on backup agent
  await engine2.recordEvent(execId, 'execution.resumed', {
    handoffId: handoff.id,
    checkpointId: chk1.id,
    resumedByAgent: 'native-coder-backup',
  });
  await engine2.setStatus(execId, 'running');

  const { state, plan } = engine2.reconstruct(execId, { maxTokens: 2000, maxToolCalls: 10 });
  expect(plan.action).toBe('resume');
  expect(state.workspaceRevision).toBe(2);
  expect(state.unresolvedToolCalls).toHaveLength(0);

  // Run verification at revision 2 and complete without repeating moduleA or moduleB writes
  await engine2.recordUsage(execId, { input: 60, output: 40, total: 100 });
  await engine2.recordCheck(execId, {
    name: 'test',
    command: 'vitest run',
    ok: true,
    output: '2 passed',
    durationMs: 18,
    workspaceRevision: 2,
  });
  await engine2.setStatus(execId, 'completed', { targetRevision: 2 });
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine2.get(execId))!;
  const checkpoints = engine2.toolCheckpoints(execId);
  const writeACalls = checkpoints.filter((c) => (c.input as { path?: string })?.path === 'src/moduleA.ts');
  const writeBCalls = checkpoints.filter((c) => (c.input as { path?: string })?.path === 'src/moduleB.ts');

  const preservedA = (await fs.readFile(path.join(workspaceDir, 'src/moduleA.ts'), 'utf8')) === fileAContent;
  const preservedB = (await fs.readFile(path.join(workspaceDir, 'src/moduleB.ts'), 'utf8')) === fileBContent;

  const repeatedToolCalls = (writeACalls.length - 1) + (writeBCalls.length - 1);
  const duplicateSideEffects = (finalRecord.mutationHistory ?? []).filter((m) => m.path === 'src/moduleA.ts').length - 1;
  const budgetAccountingErrors = finalRecord.usage?.total === 300 ? 0 : 1;

  return {
    scenarioId: 1,
    name: 'Kill a native agent during implementation',
    recoverable: true,
    recovered: finalRecord.execution.status === 'completed' && preservedA && preservedB,
    failedClosed: false,
    recoveryLatencyMs,
    repeatedToolCalls,
    duplicateSideEffects,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preservedA ? 1 : 0,
    budgetAccountingErrors,
    policyViolations: 0,
    evidenceSummary: `Reconciled call-s1-write-b as APPLIED and completed on native-coder-backup at R${finalRecord.workspaceState?.revision}`,
  };
}

/**
 * Scenario 2: Terminate an ACP subprocess.
 * Spawns a real Node child process simulating an external ACP agent, kills it with SIGKILL
 * mid-turn, captures partial state, reconciles the unapplied in-flight tool call, and
 * recovers/completes on the native harness.
 */
export async function runScenario2TerminateAcpSubprocess(baseTmpDir: string): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's2-acp-sigkill-'));
  const store = new MemoryStore();
  const engine = new ExecutionEngine({ workspace: workspaceDir });
  const worktreeManager = new WorktreeManager({
    worktreeRootDir: path.join(workspaceDir, '.wazir', 'worktrees'),
  });
  const checkpointService = new CheckpointService({
    store,
    executionEngine: engine,
    worktreeManager,
    defaultWorkspaceRoot: workspaceDir,
  });
  const handoffService = new HandoffService({
    store,
    executions: engine,
    checkpoints: checkpointService,
    projectRoot: workspaceDir,
  });
  await Promise.all([engine.ready, checkpointService.ready, handoffService.ready]);

  const record = await engine.create({
    task: makeTask('task-s2'),
    agentId: 'acp-codex-external',
    computerId: 'local-workstation',
    runtimeId: 'acp-stdio',
    modelId: 'gpt-5.4-codex',
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine.setStatus(execId, 'running');

  // Spawn real Node child process simulating ACP stdio agent
  const acpScript = `
    const fs = require('node:fs');
    const path = require('node:path');
    const ws = process.argv[1];
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'acpFeature.ts'), 'export const acpReady = true;\\n', 'utf8');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'acp/tool_completed', params: { callId: 'call-acp-1', path: 'src/acpFeature.ts' } }) + '\\n');
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'acp/tool_started', params: { callId: 'call-acp-2', path: 'src/acpSecond.ts' } }) + '\\n');
      // Hang mid-turn before writing src/acpSecond.ts so controller can SIGKILL us
      setInterval(() => {}, 1000);
    }, 15);
  `;

  const child = spawn(process.execPath, ['-e', acpScript, workspaceDir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  let buffer = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for ACP subprocess events')), 5000);
    child.stdout.on('data', async (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method === 'acp/tool_completed') {
          const content = await fs.readFile(path.join(workspaceDir, 'src/acpFeature.ts'), 'utf8');
          await engine.recordToolStart(
            execId,
            'write',
            { path: 'src/acpFeature.ts', content },
            { callId: 'call-acp-1', sideEffectClass: 'IDEMPOTENT_WRITE' },
          );
          await engine.recordToolCall(
            execId,
            makeToolResult('call-acp-1', 'write', { path: 'src/acpFeature.ts', content }),
          );
          await engine.recordFileMutations(
            execId,
            [
              {
                path: 'src/acpFeature.ts',
                attempted: true,
                succeeded: true,
                existedBefore: false,
                existsAfter: true,
                beforeHash: 'ABSENT',
                afterHash: sha256(content),
                changed: true,
              },
            ],
            sha256(content),
          );
          await engine.recordUsage(execId, { input: 150, output: 90, total: 240 });
          await checkpointService.checkpoint(execId, { description: 'acp-step-1-verified' });
        } else if (msg.method === 'acp/tool_started') {
          await engine.recordToolStart(
            execId,
            'write',
            { path: 'src/acpSecond.ts', content: 'export const second = 2;\n' },
            { callId: 'call-acp-2', sideEffectClass: 'IDEMPOTENT_WRITE' },
          );
          clearTimeout(timeout);
          child.kill('SIGKILL');
          resolve();
        }
      }
    });
  });

  const exitStatus = await exitPromise;
  expect(exitStatus.signal === 'SIGKILL' || exitStatus.code !== 0).toBe(true);

  const recoveryStart = performance.now();
  await engine.recordError(execId, `ACP subprocess (pid ${child.pid}) terminated with signal ${exitStatus.signal ?? exitStatus.code}`);

  // Reconstruct state: call-acp-2 is STARTED (unconfirmed)
  const { state: preReconcileState, plan: preReconcilePlan } = engine.reconstruct(execId);
  expect(preReconcilePlan.action).toBe('reconcile');
  expect(preReconcileState.unresolvedToolCalls).toHaveLength(1);
  expect(preReconcileState.unresolvedToolCalls[0].callId).toBe('call-acp-2');

  // Inspect physical state: src/acpSecond.ts was never written before SIGKILL
  const secondExists = await fs
    .access(path.join(workspaceDir, 'src/acpSecond.ts'))
    .then(() => true)
    .catch(() => false);
  expect(secondExists).toBe(false);

  await engine.reconcileToolCall(execId, 'call-acp-2', {
    outcome: 'NOT_APPLIED',
    evidence: 'src/acpSecond.ts absent on disk after ACP subprocess SIGKILL',
    inspectedBy: 'recovery-controller',
  });

  // Handoff from ACP harness to native harness
  const handoff = await handoffService.createAutomatic('acp_subprocess_terminated', execId, {
    sourceAgent: 'acp-codex-external',
    targetAgent: 'native-harness-coder',
  });
  expect(handoff.completed.files).toEqual(['src/acpFeature.ts']);

  // Native harness resumes from R1, writes src/acpSecond.ts, verifies, and completes
  await applyConfirmedFileWrite(
    engine,
    execId,
    workspaceDir,
    'src/acpSecond.ts',
    'export const second = 2;\n',
    'call-native-resume-2',
  );
  await engine.recordUsage(execId, { input: 80, output: 50, total: 130 });
  await engine.recordCheck(execId, {
    name: 'test',
    command: 'vitest run',
    ok: true,
    output: 'all tests passed',
    durationMs: 15,
    workspaceRevision: 2,
  });
  await engine.setStatus(execId, 'completed', { targetRevision: 2 });
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine.get(execId))!;
  const preservedFirst =
    (await fs.readFile(path.join(workspaceDir, 'src/acpFeature.ts'), 'utf8')) === 'export const acpReady = true;\n';
  const preservedSecond =
    (await fs.readFile(path.join(workspaceDir, 'src/acpSecond.ts'), 'utf8')) === 'export const second = 2;\n';

  const firstFileMutations = (finalRecord.mutationHistory ?? []).filter((m) => m.path === 'src/acpFeature.ts');
  const secondFileMutations = (finalRecord.mutationHistory ?? []).filter((m) => m.path === 'src/acpSecond.ts');

  return {
    scenarioId: 2,
    name: 'Terminate an ACP subprocess',
    recoverable: true,
    recovered: finalRecord.execution.status === 'completed' && preservedFirst && preservedSecond,
    failedClosed: false,
    recoveryLatencyMs,
    repeatedToolCalls: firstFileMutations.length - 1,
    duplicateSideEffects: firstFileMutations.length - 1 + (secondFileMutations.length - 1),
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preservedFirst ? 1 : 0,
    budgetAccountingErrors: finalRecord.usage?.total === 370 ? 0 : 1,
    policyViolations: 0,
    evidenceSummary: `Killed ACP pid ${child.pid} with SIGKILL, reconciled call-acp-2 as NOT_APPLIED, resumed on native-harness-coder to R2`,
  };
}

/**
 * Scenario 3: Disconnect an eligible remote worker.
 * Simulates worker heartbeat expiration via RecoveryManager.sweep(), fences stale lease epoch,
 * transfers checkpoint to a healthy worker directory via materializeOnTarget, and resumes.
 */
export async function runScenario3DisconnectRemoteWorker(baseTmpDir: string): Promise<ScenarioQualificationOutcome> {
  const worker1Dir = await fs.mkdtemp(path.join(baseTmpDir, 's3-worker1-'));
  const worker2Dir = await fs.mkdtemp(path.join(baseTmpDir, 's3-worker2-'));
  const store = new MemoryStore();

  const computers = new ComputerRegistry();
  computers.register({
    id: 'remote-worker-1',
    name: 'Remote Worker 1',
    type: 'remote',
    local: false,
    os: { platform: 'linux', architecture: 'x64', version: '6.8' },
    hardware: { cpu: 'epyc', cpuCores: 16, memoryGB: 64 },
    capabilities: ['remoteExecution'],
  });
  computers.register({
    id: 'remote-worker-2',
    name: 'Remote Worker 2',
    type: 'remote',
    local: false,
    os: { platform: 'linux', architecture: 'x64', version: '6.8' },
    hardware: { cpu: 'epyc', cpuCores: 16, memoryGB: 64 },
    capabilities: ['remoteExecution'],
  });

  const engine = new ExecutionEngine({ workspace: worker1Dir });
  const worktreeManager = new WorktreeManager({
    worktreeRootDir: path.join(worker1Dir, '.wazir', 'worktrees'),
  });
  const checkpointService = new CheckpointService({
    store,
    executionEngine: engine,
    worktreeManager,
    defaultWorkspaceRoot: worker1Dir,
  });
  const jobManager = new JobManager();
  await Promise.all([engine.ready, checkpointService.ready, jobManager.ready]);

  const record = await engine.create({
    task: makeTask('task-s3'),
    agentId: 'distributed-coder',
    computerId: 'remote-worker-1',
    runtimeId: 'vllm-remote-1',
    modelId: 'qwen2.5-coder:32b',
    workerId: 'remote-worker-1',
    workspaceRoot: worker1Dir,
  });
  const execId = record.execution.id;

  const t0 = new Date(Date.now() - 10_000);
  const lease1 = await engine.acquireLease(execId, 'remote-worker-1', { ttlMs: 2_000, now: t0 });
  expect(lease1.epoch).toBe(1);

  await engine.setStatus(execId, 'running', {
    workerId: 'remote-worker-1',
    leaseEpoch: lease1.epoch,
    now: new Date(t0.getTime() + 100),
  });

  // Worker 1 completes a verified file write and checkpoints before disconnecting
  const worker1FileContent = 'export const distributedStep1 = "verified-on-worker-1";\n';
  await applyConfirmedFileWrite(
    engine,
    execId,
    worker1Dir,
    'src/distributed.ts',
    worker1FileContent,
    'call-s3-w1',
    { workerId: 'remote-worker-1', leaseEpoch: lease1.epoch, now: new Date(t0.getTime() + 200) },
  );
  await engine.recordUsage(
    execId,
    { input: 200, output: 100, total: 300 },
    { workerId: 'remote-worker-1', leaseEpoch: lease1.epoch, now: new Date(t0.getTime() + 300) },
  );
  const checkpoint = await checkpointService.checkpoint(execId, { description: 'worker-1-r1' });
  const expectedDigest = checkpointService.computeDigest(checkpoint);

  // Simulate remote-worker-1 heartbeat expiration
  const comp1 = computers.get('remote-worker-1')!;
  comp1.lastHeartbeat = new Date(Date.now() - 60_000);

  const recoveryStart = performance.now();
  const recoveryManager = new RecoveryManager({
    computers,
    executions: engine,
    jobManager,
    offlineMs: 5_000,
    staleMs: 2_000,
  });

  const sweepResult = await recoveryManager.sweep();
  expect(sweepResult.offlineComputers).toContain('remote-worker-1');
  expect(sweepResult.orphanedExecutions).toContain(execId);

  // Resume execution and acquire lease on healthy remote-worker-2 (epoch 2)
  await engine.recordEvent(execId, 'execution.resumed', {
    fromWorkerId: 'remote-worker-1',
    toWorkerId: 'remote-worker-2',
    checkpointId: checkpoint.id,
  });
  const nowResume = new Date();
  const lease2 = await engine.acquireLease(execId, 'remote-worker-2', { ttlMs: 30_000, now: nowResume });
  expect(lease2.epoch).toBe(2);

  // Verify zombie remote-worker-1 is strictly fenced out by lease epoch 2
  await expect(
    engine.recordToolStart(
      execId,
      'write',
      { path: 'src/zombie.ts', content: 'bad' },
      { callId: 'call-zombie', workerId: 'remote-worker-1', leaseEpoch: lease1.epoch, now: nowResume },
    ),
  ).rejects.toThrow(/Stale lease epoch/);

  // Transfer and materialize checkpoint onto healthy remote-worker-2's directory
  const materialized = await checkpointService.materializeOnTarget(worker2Dir, checkpoint, expectedDigest);
  expect(materialized.materialized).toBe(true);
  expect(materialized.filesRestored).toContain('src/distributed.ts');

  // Update execution workspaceRoot to worker2Dir and finish task on worker 2
  engine.require(execId).execution.workspaceRoot = worker2Dir;
  engine.require(execId).execution.computerId = 'remote-worker-2';
  await engine.setStatus(execId, 'running', {
    workerId: 'remote-worker-2',
    leaseEpoch: lease2.epoch,
    now: nowResume,
  });

  await applyConfirmedFileWrite(
    engine,
    execId,
    worker2Dir,
    'src/distributedStep2.ts',
    'export const distributedStep2 = "completed-on-worker-2";\n',
    'call-s3-w2',
    { workerId: 'remote-worker-2', leaseEpoch: lease2.epoch, now: nowResume },
  );
  await engine.recordUsage(
    execId,
    { input: 100, output: 50, total: 150 },
    { workerId: 'remote-worker-2', leaseEpoch: lease2.epoch, now: nowResume },
  );
  await engine.recordCheck(
    execId,
    {
      name: 'test',
      command: 'vitest run',
      ok: true,
      output: 'distributed tests pass',
      durationMs: 20,
      workspaceRevision: 2,
    },
    { workerId: 'remote-worker-2', leaseEpoch: lease2.epoch, now: nowResume },
  );
  await engine.setStatus(execId, 'completed', {
    targetRevision: 2,
    workerId: 'remote-worker-2',
    leaseEpoch: lease2.epoch,
    now: nowResume,
  });
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine.get(execId))!;
  const preservedOnWorker2 =
    (await fs.readFile(path.join(worker2Dir, 'src/distributed.ts'), 'utf8')) === worker1FileContent;
  const step1Mutations = (finalRecord.mutationHistory ?? []).filter((m) => m.path === 'src/distributed.ts');

  return {
    scenarioId: 3,
    name: 'Disconnect an eligible remote worker',
    recoverable: true,
    recovered: finalRecord.execution.status === 'completed' && preservedOnWorker2,
    failedClosed: false,
    recoveryLatencyMs,
    repeatedToolCalls: step1Mutations.length - 1,
    duplicateSideEffects: step1Mutations.length - 1,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preservedOnWorker2 ? 1 : 0,
    budgetAccountingErrors: finalRecord.usage?.total === 450 ? 0 : 1,
    policyViolations: 0,
    evidenceSummary: `Swept offline remote-worker-1, fenced epoch 1, materialized checkpoint ${checkpoint.id} on remote-worker-2 (epoch 2)`,
  };
}

/**
 * Scenario 4: Simulate provider rate limiting (HTTP 429).
 * Injects HTTP 429 rate-limit failure, verifies classification and retry/fallback to an
 * eligible runtime while preserving execution ID, workspace revision, and consumed budget.
 */
export async function runScenario4ProviderRateLimiting(baseTmpDir: string): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's4-rate-limit-'));
  const engine = new ExecutionEngine({ workspace: workspaceDir });
  await engine.ready;

  const record = await engine.create({
    task: makeTask('task-s4'),
    agentId: 'native-coder',
    computerId: 'local-workstation',
    runtimeId: 'openai-hosted',
    modelId: 'gpt-5.4',
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine.setStatus(execId, 'running');

  // Step 1 succeeds before HTTP 429 hits on Step 2
  const content1 = 'export const rateLimitResilient = true;\n';
  await applyConfirmedFileWrite(engine, execId, workspaceDir, 'src/rateLimited.ts', content1, 'call-s4-1');
  await engine.recordUsage(execId, { input: 250, output: 150, total: 400 });

  // Simulate HTTP 429 rate limit from primary provider
  const recoveryStart = performance.now();
  const failureClass = classifyHttpFailure(429, '{"error":{"message":"Rate limit reached for requests"}}');
  expect(failureClass).toBe('RATE_LIMIT');
  expect(isProviderRetryable(failureClass)).toBe(true);

  await engine.recordProviderEvent(
    execId,
    {
      type: 'retry',
      failureClass: 'RATE_LIMIT',
      retryAttempt: 1,
      retryDelayMs: 25,
    } as any,
    { requestId: 'req-s4-turn2', model: 'gpt-5.4', provider: 'openai' },
  );

  // Primary provider exhausts retry window -> steer/fallback to local runtime without losing executionId or budget
  await engine.recordProviderEvent(
    execId,
    {
      type: 'error',
      failureClass: 'RATE_LIMIT',
      retryAttempt: 2,
      retryExhausted: true,
    } as any,
    { requestId: 'req-s4-turn2', model: 'gpt-5.4', provider: 'openai' },
  );

  const steerResult = await engine.steer(execId, {
    who: 'system',
    guidance: 'Fallback to local runtime after HTTP 429 rate limit on openai-hosted',
    changeModelRouting: {
      modelId: 'qwen2.5-coder:14b',
      runtimeId: 'ollama-local',
    },
  });
  expect(steerResult.whatChanged.modelRoutingChanged).toEqual({
    modelId: 'qwen2.5-coder:14b',
    runtimeId: 'ollama-local',
  });

  // Complete verification on fallback runtime with same executionId
  await engine.recordUsage(execId, { input: 100, output: 50, total: 150 });
  await engine.recordCheck(execId, {
    name: 'test',
    command: 'vitest run',
    ok: true,
    output: '1 passed',
    durationMs: 10,
    workspaceRevision: 1,
  });
  await engine.setStatus(execId, 'completed', { targetRevision: 1 });
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine.get(execId))!;
  const preserved = (await fs.readFile(path.join(workspaceDir, 'src/rateLimited.ts'), 'utf8')) === content1;
  const mutations = (finalRecord.mutationHistory ?? []).filter((m) => m.path === 'src/rateLimited.ts');

  return {
    scenarioId: 4,
    name: 'Simulate provider rate limiting (HTTP 429)',
    recoverable: true,
    recovered:
      finalRecord.execution.status === 'completed' &&
      finalRecord.execution.id === execId &&
      finalRecord.execution.runtimeId === 'ollama-local' &&
      preserved,
    failedClosed: false,
    recoveryLatencyMs,
    repeatedToolCalls: mutations.length - 1,
    duplicateSideEffects: mutations.length - 1,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preserved ? 1 : 0,
    budgetAccountingErrors: finalRecord.usage?.total === 550 ? 0 : 1,
    policyViolations: 0,
    evidenceSummary: `Classified HTTP 429 as RATE_LIMIT, recorded retry telemetry, and failed over to ollama-local preserving ${finalRecord.usage?.total} tokens`,
  };
}

/**
 * Scenario 5: Simulate model unavailability.
 * Primary model goes UNAVAILABLE mid-task; verifies Scheduler + ExecutionEngine perform
 * controlled escalation/handoff to backup model and complete without repeating verified work.
 */
export async function runScenario5ModelUnavailability(baseTmpDir: string): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's5-model-unavail-'));
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();
  const policy = new PolicyEngine({ projectRoot: workspaceDir });

  computers.register({
    id: 'local-gpu',
    name: 'Local GPU Node',
    type: 'workstation',
    local: true,
    os: { platform: 'darwin', architecture: 'arm64', version: '24.0' },
    hardware: { cpu: 'M3 Max', cpuCores: 16, memoryGB: 64, gpu: { vendor: 'apple', model: 'M3 Max', memoryGB: 48, unifiedMemory: true } },
    capabilities: ['localExecution', 'gpuInference'],
  });
  runtimes.register({
    id: 'ollama',
    type: 'ollama',
    name: 'Ollama',
    version: '0.5',
    computerId: 'local-gpu',
    capabilities: {
      chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: false,
      embeddings: false, reasoning: true, modelLoad: true, modelUnload: true, modelDownload: false,
      statefulChat: false, mcp: false,
    },
  });

  models.register({
    id: 'primary-coder-7b',
    name: 'primary-coder-7b',
    provider: 'ollama',
    family: 'qwen',
    contextMax: 32768,
    capabilities: ['coding', 'generalChat'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: ['ollama'],
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'inst-primary',
    modelId: 'primary-coder-7b',
    computerId: 'local-gpu',
    runtimeId: 'ollama',
    runtimeModelId: 'primary-coder-7b',
    loaded: true,
    state: 'READY',
    health: 'healthy',
    contextTokens: 32768,
  });

  models.register({
    id: 'backup-coder-14b',
    name: 'backup-coder-14b',
    provider: 'ollama',
    family: 'qwen',
    contextMax: 32768,
    capabilities: ['coding', 'generalChat'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: ['ollama'],
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'inst-backup',
    modelId: 'backup-coder-14b',
    computerId: 'local-gpu',
    runtimeId: 'ollama',
    runtimeModelId: 'backup-coder-14b',
    loaded: true,
    state: 'LOADED',
    health: 'healthy',
    contextTokens: 32768,
  });

  const scheduler = new Scheduler({ computers, runtimes, models, policy });
  const task = makeTask('task-s5');
  const initialDecision = scheduler.plan({ task });
  expect(initialDecision.modelId).toBe('primary-coder-7b');

  const engine = new ExecutionEngine({ workspace: workspaceDir });
  await engine.ready;
  const record = await engine.create({
    task,
    agentId: 'native-coder',
    computerId: initialDecision.computerId!,
    runtimeId: initialDecision.runtimeId,
    modelId: initialDecision.modelId,
    scheduling: initialDecision,
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine.setStatus(execId, 'running');

  const step1Content = 'export const modelStep1 = "done-on-primary";\n';
  await applyConfirmedFileWrite(engine, execId, workspaceDir, 'src/modelStep1.ts', step1Content, 'call-s5-1');
  await engine.recordUsage(execId, { input: 180, output: 120, total: 300 });

  // Mid-task: primary model becomes UNAVAILABLE
  const recoveryStart = performance.now();
  models.setInstanceState('inst-primary', 'UNAVAILABLE', {
    loaded: false,
    health: 'unavailable',
    error: 'MODEL_UNAVAILABLE: primary model crashed',
  });
  expect(models.getModelState('primary-coder-7b')).toBe('UNAVAILABLE');

  // Re-plan through Scheduler: automatically routes to backup-coder-14b and excludes unavailable primary
  const fallbackDecision = scheduler.plan({ task });
  expect(fallbackDecision.modelId).toBe('backup-coder-14b');

  await engine.steer(execId, {
    who: 'system',
    guidance: 'Escalating to backup-coder-14b after primary-coder-7b became UNAVAILABLE',
    changeModelRouting: {
      modelId: fallbackDecision.modelId,
      runtimeId: fallbackDecision.runtimeId,
    },
  });

  await applyConfirmedFileWrite(
    engine,
    execId,
    workspaceDir,
    'src/modelStep2.ts',
    'export const modelStep2 = "done-on-backup";\n',
    'call-s5-2',
  );
  await engine.recordUsage(execId, { input: 140, output: 60, total: 200 });
  await engine.recordCheck(execId, {
    name: 'test',
    command: 'vitest run',
    ok: true,
    output: '2 passed',
    durationMs: 14,
    workspaceRevision: 2,
  });
  await engine.setStatus(execId, 'completed', { targetRevision: 2 });
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine.get(execId))!;
  const preservedStep1 = (await fs.readFile(path.join(workspaceDir, 'src/modelStep1.ts'), 'utf8')) === step1Content;
  const step1Mutations = (finalRecord.mutationHistory ?? []).filter((m) => m.path === 'src/modelStep1.ts');

  return {
    scenarioId: 5,
    name: 'Simulate model unavailability',
    recoverable: true,
    recovered:
      finalRecord.execution.status === 'completed' &&
      finalRecord.execution.modelId === 'backup-coder-14b' &&
      preservedStep1,
    failedClosed: false,
    recoveryLatencyMs,
    repeatedToolCalls: step1Mutations.length - 1,
    duplicateSideEffects: step1Mutations.length - 1,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preservedStep1 ? 1 : 0,
    budgetAccountingErrors: finalRecord.usage?.total === 500 ? 0 : 1,
    policyViolations: 0,
    evidenceSummary: `Primary model primary-coder-7b marked UNAVAILABLE; Scheduler routed to ${fallbackDecision.modelId} and completed at R2`,
  };
}

/**
 * Scenario 6: Interrupt a stream after partial output.
 * Stream aborts mid-generation before tool call dispatch; verifies clean retry from last
 * confirmed workspace revision with zero duplicate side effects.
 */
export async function runScenario6InterruptStreamPartialOutput(baseTmpDir: string): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's6-stream-interrupt-'));
  const engine = new ExecutionEngine({ workspace: workspaceDir });
  await engine.ready;

  const record = await engine.create({
    task: makeTask('task-s6'),
    agentId: 'native-coder',
    computerId: 'local-workstation',
    runtimeId: 'ollama-local',
    modelId: 'qwen2.5-coder:14b',
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine.setStatus(execId, 'running');

  // Turn 1: confirmed write at R1
  const baseContent = 'export const streamBase = 1;\n';
  await engine.recordEvent(execId, 'generation.started', { turn: 1 });
  await applyConfirmedFileWrite(engine, execId, workspaceDir, 'src/streamBase.ts', baseContent, 'call-s6-1');
  await engine.recordUsage(execId, { input: 100, output: 50, total: 150 });

  // Turn 2: stream starts, emits partial tokens, then aborts BEFORE any tool call is dispatched
  await engine.recordEvent(execId, 'generation.started', { turn: 2 });
  await engine.recordEvent(execId, 'generation.token', { text: 'I will now write src/streamNext.ts...' });

  faultInjector.register({
    point: 'DURING_MODEL_STREAM',
    action: { type: 'throw', error: 'STREAM_ABORTED_MID_GENERATION: ECONNRESET' },
  });

  await expect(injectFault('DURING_MODEL_STREAM', { executionId: execId })).rejects.toThrow(
    'STREAM_ABORTED_MID_GENERATION',
  );
  faultInjector.clear();
  await engine.recordUsage(execId, { input: 80, output: 12, total: 92 });

  const recoveryStart = performance.now();
  const { state, plan } = engine.reconstruct(execId, { maxTokens: 2000, maxToolCalls: 10, maxModelRequests: 5 });
  expect(state.workspaceRevision).toBe(1);
  expect(state.unresolvedToolCalls).toHaveLength(0);
  expect(state.consumed.modelRequests).toBe(2);
  expect(plan.action).toBe('resume');

  // Retry Turn 2 cleanly from R1
  await engine.recordEvent(execId, 'generation.started', { turn: 2, retry: 1 });
  await applyConfirmedFileWrite(
    engine,
    execId,
    workspaceDir,
    'src/streamNext.ts',
    'export const streamNext = 2;\n',
    'call-s6-2',
  );
  await engine.recordUsage(execId, { input: 100, output: 60, total: 160 });
  await engine.recordCheck(execId, {
    name: 'test',
    command: 'vitest run',
    ok: true,
    output: 'stream tests ok',
    durationMs: 11,
    workspaceRevision: 2,
  });
  await engine.setStatus(execId, 'completed', { targetRevision: 2 });
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine.get(execId))!;
  const preservedBase = (await fs.readFile(path.join(workspaceDir, 'src/streamBase.ts'), 'utf8')) === baseContent;
  const baseMutations = (finalRecord.mutationHistory ?? []).filter((m) => m.path === 'src/streamBase.ts');

  return {
    scenarioId: 6,
    name: 'Interrupt a stream after partial output',
    recoverable: true,
    recovered: finalRecord.execution.status === 'completed' && preservedBase,
    failedClosed: false,
    recoveryLatencyMs,
    repeatedToolCalls: baseMutations.length - 1,
    duplicateSideEffects: baseMutations.length - 1,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preservedBase ? 1 : 0,
    budgetAccountingErrors: finalRecord.usage?.total === 402 ? 0 : 1,
    policyViolations: 0,
    evidenceSummary: `Stream aborted mid-generation at R1 with 0 unresolved tool calls; cleanly retried turn and completed at R2`,
  };
}

/**
 * Scenario 7: Restart the orchestrator after checkpoint persistence.
 * Persists execution, checkpoint, and handoff to a durable JsonFileStore on disk,
 * tears down all in-memory services, instantiates fresh ExecutionEngine + CheckpointService +
 * HandoffService from disk, restores state, and finishes the task.
 */
export async function runScenario7RestartOrchestratorAfterCheckpoint(
  baseTmpDir: string,
): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's7-orchestrator-restart-'));
  const storeFile = path.join(workspaceDir, '.wazir', 'state', 'orchestrator-store.json');

  // --- Orchestrator Instance 1 (Pre-Crash) ---
  const store1 = new JsonFileStore(storeFile);
  const pid1 = 71001;
  const engine1 = new ExecutionEngine({
    workspace: workspaceDir,
    owner: { pid: pid1, host: os.hostname() },
    isProcessAlive: () => true,
    load: async () => {
      const entries = await store1.list('execution/');
      return entries.map((e) => e.value as ExecutionRecord);
    },
    persist: async (r) => {
      r.execution.owner = { pid: pid1, host: os.hostname() };
      await store1.put(`execution/${r.execution.id}`, structuredClone(r));
    },
  });
  const worktreeManager1 = new WorktreeManager({
    worktreeRootDir: path.join(workspaceDir, '.wazir', 'worktrees'),
  });
  const checkpointService1 = new CheckpointService({
    store: store1,
    executionEngine: engine1,
    worktreeManager: worktreeManager1,
    defaultWorkspaceRoot: workspaceDir,
  });
  const handoffService1 = new HandoffService({
    store: store1,
    executions: engine1,
    checkpoints: checkpointService1,
    projectRoot: workspaceDir,
  });
  await Promise.all([engine1.ready, checkpointService1.ready, handoffService1.ready]);

  const record1 = await engine1.create({
    task: makeTask('task-s7'),
    agentId: 'orchestrator-agent-1',
    computerId: 'local-workstation',
    runtimeId: 'ollama-local',
    modelId: 'qwen2.5-coder:14b',
    workspaceRoot: workspaceDir,
  });
  const execId = record1.execution.id;
  await engine1.setStatus(execId, 'running');

  const persistedContent1 = 'export const persistedBeforeRestart = "v1";\n';
  await applyConfirmedFileWrite(
    engine1,
    execId,
    workspaceDir,
    'src/persisted1.ts',
    persistedContent1,
    'call-s7-1',
  );
  await engine1.recordUsage(execId, { input: 300, output: 150, total: 450 });
  const chk = await checkpointService1.checkpoint(execId, { description: 'pre-restart-checkpoint' });
  const handoff = await handoffService1.createAutomatic('orchestrator_shutdown', execId, {
    sourceAgent: 'orchestrator-agent-1',
    targetAgent: 'orchestrator-agent-2',
  });

  // --- Orchestrator Instance 2 (Fresh Process Restart from JsonFileStore) ---
  const recoveryStart = performance.now();
  const store2 = new JsonFileStore(storeFile);
  const pid2 = 71002;
  const engine2 = new ExecutionEngine({
    workspace: workspaceDir,
    owner: { pid: pid2, host: os.hostname() },
    isProcessAlive: (pid) => pid !== pid1,
    load: async () => {
      const entries = await store2.list('execution/');
      return entries.map((e) => e.value as ExecutionRecord);
    },
    persist: async (r) => {
      r.execution.owner = { pid: pid2, host: os.hostname() };
      await store2.put(`execution/${r.execution.id}`, structuredClone(r));
    },
  });
  const worktreeManager2 = new WorktreeManager({
    worktreeRootDir: path.join(workspaceDir, '.wazir', 'worktrees'),
  });
  const checkpointService2 = new CheckpointService({
    store: store2,
    executionEngine: engine2,
    worktreeManager: worktreeManager2,
    defaultWorkspaceRoot: workspaceDir,
  });
  const handoffService2 = new HandoffService({
    store: store2,
    executions: engine2,
    checkpoints: checkpointService2,
    projectRoot: workspaceDir,
  });
  await Promise.all([engine2.ready, checkpointService2.ready, handoffService2.ready]);

  // Verify checkpoint and handoff survived process restart with verified digests
  const restoredChk = checkpointService2.getCheckpoint(chk.id);
  expect(restoredChk).toBeDefined();
  expect(restoredChk?.workspaceRevision).toBe(1);
  expect(restoredChk?.worktreeState.filesSnapshot['src/persisted1.ts']).toBe(persistedContent1);

  const restoredHandoff = await handoffService2.resume(handoff.id);
  expect(restoredHandoff.executionId).toBe(execId);
  expect(restoredHandoff.environment.checkpointIds).toContain(chk.id);

  const reloadedRecord = (await engine2.get(execId))!;
  expect(reloadedRecord.execution.status).toBe('failed');
  expect(
    reloadedRecord.events.some(
      (e) =>
        (e.eventType ?? e.type) === 'execution.failed' &&
        (e.data as { reason?: string } | undefined)?.reason === 'OWNER_PROCESS_EXITED',
    ),
  ).toBe(true);

  // Resume execution on Orchestrator 2 and complete the task
  await engine2.recordEvent(execId, 'execution.resumed', {
    checkpointId: chk.id,
    handoffId: handoff.id,
  });
  await engine2.setStatus(execId, 'running');

  await applyConfirmedFileWrite(
    engine2,
    execId,
    workspaceDir,
    'src/persisted2.ts',
    'export const persistedAfterRestart = "v2";\n',
    'call-s7-2',
  );
  await engine2.recordUsage(execId, { input: 100, output: 50, total: 150 });
  await engine2.recordCheck(execId, {
    name: 'test',
    command: 'vitest run',
    ok: true,
    output: 'persisted tests pass',
    durationMs: 12,
    workspaceRevision: 2,
  });
  await engine2.setStatus(execId, 'completed', { targetRevision: 2 });
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine2.get(execId))!;
  const preservedFile1 =
    (await fs.readFile(path.join(workspaceDir, 'src/persisted1.ts'), 'utf8')) === persistedContent1;
  const file1Mutations = (finalRecord.mutationHistory ?? []).filter((m) => m.path === 'src/persisted1.ts');

  return {
    scenarioId: 7,
    name: 'Restart the orchestrator after checkpoint persistence',
    recoverable: true,
    recovered: finalRecord.execution.status === 'completed' && preservedFile1,
    failedClosed: false,
    recoveryLatencyMs,
    repeatedToolCalls: file1Mutations.length - 1,
    duplicateSideEffects: file1Mutations.length - 1,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preservedFile1 ? 1 : 0,
    budgetAccountingErrors: finalRecord.usage?.total === 600 ? 0 : 1,
    policyViolations: 0,
    evidenceSummary: `Restored ExecutionEngine, CheckpointService (${chk.id}), and HandoffService (${handoff.id}) from JsonFileStore and completed at R2`,
  };
}

/**
 * Scenario 8: Attempt duplicate tool delivery.
 * Delivers the same mutating tool call (same callId and arguments hash at revision) twice
 * during recovery; verifies the second dispatch is suppressed/rejected with zero duplicate side effects.
 */
export async function runScenario8DuplicateToolDelivery(baseTmpDir: string): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's8-dup-tool-'));
  const engine = new ExecutionEngine({ workspace: workspaceDir });
  await engine.ready;

  const record = await engine.create({
    task: makeTask('task-s8'),
    agentId: 'native-coder',
    computerId: 'local-workstation',
    runtimeId: 'ollama-local',
    modelId: 'qwen2.5-coder:14b',
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine.setStatus(execId, 'running');

  const targetFile = path.join(workspaceDir, 'src/ledgerEntry.txt');
  let physicalWriteExecutionCount = 0;

  const toolInput = { path: 'src/ledgerEntry.txt', line: 'entry-1\n' };
  const argsHash = hashToolArguments(toolInput);

  // First delivery of mutating tool call 'call-s8-mut-1'
  await engine.recordToolStart(execId, 'write', toolInput, {
    callId: 'call-s8-mut-1',
    sideEffectClass: 'NON_IDEMPOTENT_WRITE',
    argumentsHash: argsHash,
  });
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.appendFile(targetFile, toolInput.line, 'utf8');
  physicalWriteExecutionCount += 1;

  const contentAfterFirst = await fs.readFile(targetFile, 'utf8');
  const firstToolRecord = makeToolResult('call-s8-mut-1', 'write', toolInput, true, 'appended entry-1');
  await engine.recordToolCall(execId, firstToolRecord);
  await engine.recordFileMutations(
    execId,
    [
      {
        path: 'src/ledgerEntry.txt',
        attempted: true,
        succeeded: true,
        existedBefore: false,
        existsAfter: true,
        beforeHash: 'ABSENT',
        afterHash: sha256(contentAfterFirst),
        changed: true,
      },
    ],
    sha256(contentAfterFirst),
  );
  await engine.recordUsage(execId, { input: 100, output: 50, total: 150 });

  // Recovery attempts duplicate delivery of the already-dispatched mutating callId
  const recoveryStart = performance.now();
  let duplicateRejected = false;
  try {
    await engine.recordToolStart(execId, 'write', toolInput, {
      callId: 'call-s8-mut-1',
      sideEffectClass: 'NON_IDEMPOTENT_WRITE',
      argumentsHash: argsHash,
    });
    // Only reached if ExecutionEngine failed to block duplicate callId
    await fs.appendFile(targetFile, toolInput.line, 'utf8');
    physicalWriteExecutionCount += 1;
  } catch (err) {
    duplicateRejected = (err as Error).message.includes('TOOL_ALREADY_DISPATCHED');
  }
  expect(duplicateRejected).toBe(true);

  // Idempotent replay of identical ToolCallRecord is a safe no-op, while conflicting result is rejected
  await engine.recordToolCall(execId, firstToolRecord);
  await expect(
    engine.recordToolCall(execId, { ...firstToolRecord, output: 'conflicting-output' }),
  ).rejects.toThrow(/Conflicting tool result/);

  // Complete verification and finalize
  await engine.recordCheck(execId, {
    name: 'test',
    command: 'vitest run',
    ok: true,
    output: 'idempotency verified',
    durationMs: 8,
    workspaceRevision: 1,
  });
  await engine.setStatus(execId, 'completed', { targetRevision: 1 });
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalDiskContent = await fs.readFile(targetFile, 'utf8');
  const finalRecord = (await engine.get(execId))!;

  return {
    scenarioId: 8,
    name: 'Attempt duplicate tool delivery',
    recoverable: true,
    recovered: finalRecord.execution.status === 'completed' && duplicateRejected && finalDiskContent === 'entry-1\n',
    failedClosed: false,
    recoveryLatencyMs,
    repeatedToolCalls: physicalWriteExecutionCount - 1,
    duplicateSideEffects: finalDiskContent === 'entry-1\n' ? 0 : 1,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: finalDiskContent === 'entry-1\n' ? 1 : 0,
    budgetAccountingErrors: finalRecord.usage?.total === 150 ? 0 : 1,
    policyViolations: 0,
    evidenceSummary: `Duplicate dispatch of call-s8-mut-1 rejected with TOOL_ALREADY_DISPATCHED; physical file written exactly once`,
  };
}

/**
 * Scenario 9: Restore a corrupted checkpoint (UNSAFE -> Must Fail Closed).
 * Tampers with a file or digest inside a persisted checkpoint; verifies CheckpointService
 * rejects restoration fail-closed (CHECKPOINT_DIGEST_MISMATCH / CHECKPOINT_MATERIALIZATION_FAILED).
 */
export async function runScenario9RestoreCorruptedCheckpoint(
  baseTmpDir: string,
): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's9-corrupt-chk-'));
  const targetRestoreDir = await fs.mkdtemp(path.join(baseTmpDir, 's9-restore-target-'));
  const store = new MemoryStore();

  const engine = new ExecutionEngine({ workspace: workspaceDir });
  const worktreeManager = new WorktreeManager({
    worktreeRootDir: path.join(workspaceDir, '.wazir', 'worktrees'),
  });
  const checkpointService = new CheckpointService({
    store,
    executionEngine: engine,
    worktreeManager,
    defaultWorkspaceRoot: workspaceDir,
  });
  await Promise.all([engine.ready, checkpointService.ready]);

  const record = await engine.create({
    task: makeTask('task-s9'),
    agentId: 'native-coder',
    computerId: 'local-workstation',
    runtimeId: 'ollama-local',
    modelId: 'qwen2.5-coder:14b',
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine.setStatus(execId, 'running');

  const safeContent = 'export const safeCode = true;\n';
  await applyConfirmedFileWrite(engine, execId, workspaceDir, 'src/safe.ts', safeContent, 'call-s9-1');
  const checkpoint = await checkpointService.checkpoint(execId, { description: 'clean-checkpoint' });
  const validDigest = checkpointService.computeDigest(checkpoint);

  const recoveryStart = performance.now();
  let policyViolations = 0;

  // Tamper 1: Corrupt file content in checkpoint payload during materialization
  const corruptedPayload = structuredClone(checkpoint);
  corruptedPayload.worktreeState.filesSnapshot['src/safe.ts'] = 'export const backdoor = "injected";\n';

  let materializationRejected = false;
  try {
    await checkpointService.materializeOnTarget(targetRestoreDir, corruptedPayload, validDigest);
    policyViolations += 1;
  } catch (err) {
    materializationRejected = (err as Error).message.includes('CHECKPOINT_MATERIALIZATION_FAILED');
  }
  expect(materializationRejected).toBe(true);

  // Tamper 2: Corrupt persisted store envelope and verify CheckpointService.ready fails closed
  const storedEnvelope = await store.get<{ version: number; digest: string; checkpoint: typeof checkpoint }>(
    `checkpoint/${checkpoint.id}`,
  );
  expect(storedEnvelope).toBeDefined();
  storedEnvelope!.checkpoint.worktreeState.filesSnapshot['src/safe.ts'] = 'corrupted-on-disk';
  await store.put(`checkpoint/${checkpoint.id}`, storedEnvelope);

  let storeRestoreRejected = false;
  try {
    const reloadedCheckpoints = new CheckpointService({
      store,
      executionEngine: engine,
      worktreeManager,
      defaultWorkspaceRoot: workspaceDir,
    });
    await reloadedCheckpoints.ready;
    policyViolations += 1;
  } catch (err) {
    storeRestoreRejected = (err as Error).message.includes('CHECKPOINT_DIGEST_MISMATCH');
  }
  expect(storeRestoreRejected).toBe(true);
  const recoveryLatencyMs = performance.now() - recoveryStart;

  // Verify targetRestoreDir never received tampered file
  const targetTamperedExists = await fs
    .access(path.join(targetRestoreDir, 'src/safe.ts'))
    .then(() => true)
    .catch(() => false);
  expect(targetTamperedExists).toBe(false);

  const originalPreserved = (await fs.readFile(path.join(workspaceDir, 'src/safe.ts'), 'utf8')) === safeContent;

  return {
    scenarioId: 9,
    name: 'Restore a corrupted checkpoint',
    recoverable: false,
    recovered: false,
    failedClosed: materializationRejected && storeRestoreRejected && !targetTamperedExists,
    recoveryLatencyMs,
    repeatedToolCalls: 0,
    duplicateSideEffects: 0,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: originalPreserved ? 1 : 0,
    budgetAccountingErrors: 0,
    policyViolations,
    evidenceSummary:
      'Rejected tampered checkpoint fail-closed via CHECKPOINT_MATERIALIZATION_FAILED and CHECKPOINT_DIGEST_MISMATCH',
  };
}

/**
 * Scenario 10: Resume after a workspace revision change.
 * Mutates workspace after checkpoint and verification at R1; verifies prior verification
 * evidence is marked stale (verification.staleChecks > 0), completion at stale revision is
 * rejected, and fresh independent verification at R2 is required before completion.
 */
export async function runScenario10WorkspaceRevisionChangeAfterCheckpoint(
  baseTmpDir: string,
): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's10-rev-drift-'));
  const engine = new ExecutionEngine({ workspace: workspaceDir });
  const worktreeManager = new WorktreeManager({
    worktreeRootDir: path.join(workspaceDir, '.wazir', 'worktrees'),
  });
  const checkpointService = new CheckpointService({
    executionEngine: engine,
    worktreeManager,
    defaultWorkspaceRoot: workspaceDir,
  });
  await Promise.all([engine.ready, checkpointService.ready]);

  const record = await engine.create({
    task: makeTask('task-s10', {
      acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] },
    }),
    agentId: 'native-coder',
    computerId: 'local-workstation',
    runtimeId: 'ollama-local',
    modelId: 'qwen2.5-coder:14b',
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine.setStatus(execId, 'running');

  // Write src/core.ts at R1, pass BUILD and TEST at R1, and create checkpoint
  const rev1Content = 'export const version = 1;\n';
  await applyConfirmedFileWrite(engine, execId, workspaceDir, 'src/core.ts', rev1Content, 'call-s10-1');
  await engine.recordCheck(execId, {
    name: 'build',
    command: 'tsc --noEmit',
    ok: true,
    output: 'build pass R1',
    durationMs: 10,
    workspaceRevision: 1,
  });
  await engine.recordCheck(execId, {
    name: 'test',
    command: 'vitest run',
    ok: true,
    output: 'test pass R1',
    durationMs: 15,
    workspaceRevision: 1,
  });
  await engine.recordUsage(execId, { input: 150, output: 100, total: 250 });
  const chkR1 = await checkpointService.checkpoint(execId, { description: 'verified-at-r1' });
  expect(chkR1.workspaceRevision).toBe(1);
  expect(chkR1.verificationState.checksPass).toBe(true);

  // Mutate workspace after checkpoint (advances revision to R2 and invalidates R1 evidence)
  const rev2PatchContent = 'export const patch = "post-checkpoint-edit";\n';
  await applyConfirmedFileWrite(engine, execId, workspaceDir, 'src/patch.ts', rev2PatchContent, 'call-s10-2');

  const recoveryStart = performance.now();
  const { state, plan } = engine.reconstruct(execId);
  expect(state.workspaceRevision).toBe(2);
  expect(state.verification.staleChecks).toBeGreaterThan(0);
  expect(state.verification.currentPassing).toEqual([]);
  expect(plan.action).toBe('resume');
  expect(plan.reasons.join(' ')).toContain('older revisions and must be re-run');

  // Inspect verification evidence: BUILD and TEST slots must be marked STALE
  const inspection = inspectVerificationEvidence(engine.require(execId));
  expect(inspection.completion.eligible).toBe(false);
  expect(inspection.slots.find((s) => s.oracle === 'BUILD')?.status).toBe('STALE');
  expect(inspection.slots.find((s) => s.oracle === 'TEST')?.status).toBe('STALE');

  // Attempting to complete without fresh R2 verification MUST be rejected
  await expect(engine.setStatus(execId, 'completed', { targetRevision: 1 })).rejects.toThrow(
    'STALE_WORKSPACE_REVISION',
  );
  await expect(engine.setStatus(execId, 'completed', { targetRevision: 2 })).rejects.toThrow(
    'Completion requires current verification for workspace revision 2',
  );

  // Run fresh independent verification at R2 and complete
  await engine.recordCheck(execId, {
    name: 'build',
    command: 'tsc --noEmit',
    ok: true,
    output: 'build pass R2',
    durationMs: 11,
    workspaceRevision: 2,
  });
  await engine.recordCheck(execId, {
    name: 'test',
    command: 'vitest run',
    ok: true,
    output: 'test pass R2',
    durationMs: 16,
    workspaceRevision: 2,
  });
  await engine.recordUsage(execId, { input: 80, output: 40, total: 120 });
  await engine.setStatus(execId, 'completed', { targetRevision: 2 });
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine.get(execId))!;
  const preservedR1 = (await fs.readFile(path.join(workspaceDir, 'src/core.ts'), 'utf8')) === rev1Content;
  const r1Mutations = (finalRecord.mutationHistory ?? []).filter((m) => m.path === 'src/core.ts');

  return {
    scenarioId: 10,
    name: 'Resume after a workspace revision change',
    recoverable: true,
    recovered: finalRecord.execution.status === 'completed' && preservedR1,
    failedClosed: false,
    recoveryLatencyMs,
    repeatedToolCalls: r1Mutations.length - 1,
    duplicateSideEffects: r1Mutations.length - 1,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preservedR1 ? 1 : 0,
    budgetAccountingErrors: finalRecord.usage?.total === 370 ? 0 : 1,
    policyViolations: 0,
    evidenceSummary: `Detected ${state.verification.staleChecks} stale checks after R1->R2 mutation, blocked stale completion, and required fresh R2 BUILD+TEST verification`,
  };
}

/**
 * Scenario 11: Attempt replay with insufficient remaining budget (UNSAFE -> Must Fail Closed).
 * Consumes all token and tool-call budget before interruption; verifies planRecovery returns
 * action: 'terminate' and refuses replay without resetting consumed budget.
 */
export async function runScenario11InsufficientRemainingBudget(
  baseTmpDir: string,
): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's11-budget-exhausted-'));
  const engine = new ExecutionEngine({ workspace: workspaceDir });
  await engine.ready;

  const budgetLimits = {
    maxTokens: 500,
    maxToolCalls: 2,
    maxModelRequests: 2,
  };

  const record = await engine.create({
    task: makeTask('task-s11'),
    agentId: 'native-coder',
    computerId: 'local-workstation',
    runtimeId: 'ollama-local',
    modelId: 'qwen2.5-coder:14b',
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine.setStatus(execId, 'running');

  // Consume both model requests, both tool calls, and all 500 tokens
  await engine.recordEvent(execId, 'generation.started', { turn: 1 });
  const content1 = 'export const part1 = 1;\n';
  await applyConfirmedFileWrite(engine, execId, workspaceDir, 'src/part1.ts', content1, 'call-s11-1');
  await engine.recordUsage(execId, { input: 200, output: 100, total: 300 });

  await engine.recordEvent(execId, 'generation.started', { turn: 2 });
  await engine.recordToolStart(execId, 'read', { path: 'src/part1.ts' }, { callId: 'call-s11-2', sideEffectClass: 'READ_ONLY' });
  await engine.recordToolCall(execId, makeToolResult('call-s11-2', 'read', { path: 'src/part1.ts' }));
  await engine.recordUsage(execId, { input: 150, output: 100, total: 250 });

  // Interruption occurs after budget is fully consumed (550 >= 500 tokens, 2/2 tool calls, 2/2 model requests)
  const recoveryStart = performance.now();
  const { state, plan } = engine.reconstruct(execId, budgetLimits);

  expect(state.consumed.tokens).toBe(550);
  expect(state.consumed.toolCalls).toBe(2);
  expect(state.consumed.modelRequests).toBe(2);
  expect(state.remaining.tokens).toBe(0);
  expect(state.remaining.toolCalls).toBe(0);
  expect(state.remaining.modelRequests).toBe(0);
  expect(plan.action).toBe('terminate');
  expect(plan.reasons[0]).toContain('budget exhausted before recovery');

  // Controller honors plan.action === 'terminate' and marks execution failed without replaying
  await engine.recordError(execId, `RECOVERY_REFUSED_BUDGET_EXHAUSTED: ${plan.reasons.join('; ')}`);
  await engine.setStatus(execId, 'failed');
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine.get(execId))!;
  const preserved = (await fs.readFile(path.join(workspaceDir, 'src/part1.ts'), 'utf8')) === content1;

  return {
    scenarioId: 11,
    name: 'Attempt replay with insufficient remaining budget',
    recoverable: false,
    recovered: false,
    failedClosed: plan.action === 'terminate' && finalRecord.execution.status === 'failed',
    recoveryLatencyMs,
    repeatedToolCalls: 0,
    duplicateSideEffects: 0,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preserved ? 1 : 0,
    budgetAccountingErrors: state.consumed.tokens === 550 && state.remaining.tokens === 0 ? 0 : 1,
    policyViolations: 0,
    evidenceSummary: `planRecovery returned action='terminate' (${plan.reasons[0]}); replay refused fail-closed`,
  };
}

/**
 * Scenario 12: Attempt recovery that would violate existing policy (UNSAFE -> Must Fail Closed).
 * Attempts to resume a localOnly/sensitive execution on a hosted provider, dispatch a forbidden
 * subagent, and escalate tool permissions outside the workspace; verifies all three fail closed
 * with 0 policy violations allowed through.
 */
export async function runScenario12PolicyViolatingRecovery(
  baseTmpDir: string,
): Promise<ScenarioQualificationOutcome> {
  const workspaceDir = await fs.mkdtemp(path.join(baseTmpDir, 's12-policy-gate-'));
  const policyEngine = new PolicyEngine({ projectRoot: workspaceDir });
  const computers = new ComputerRegistry();
  const runtimes = new RuntimeRegistry();
  const models = new ModelRegistry();

  // Only register a hosted runtime/model to test fail-closed scheduling when local worker is down
  runtimes.register({
    id: 'openai',
    type: 'openai',
    runtimeKind: 'hosted',
    name: 'OpenAI Hosted',
    version: '1.0',
    capabilities: {
      chat: true, streaming: true, toolCalling: true, structuredOutput: true, vision: true,
      embeddings: false, reasoning: true, modelLoad: false, modelUnload: false, modelDownload: false,
      statefulChat: false, mcp: false,
    },
  });
  models.register({
    id: 'gpt-5.4-hosted',
    name: 'gpt-5.4-hosted',
    provider: 'openai',
    family: 'gpt',
    contextMax: 128000,
    capabilities: ['coding', 'generalChat'],
    toolCalling: true,
    structuredOutput: true,
    vision: true,
    audio: false,
    embedding: false,
    reasoning: true,
    runtimeCompatibility: ['openai'],
    local: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  models.upsertInstance({
    id: 'inst-hosted-gpt',
    modelId: 'gpt-5.4-hosted',
    runtimeId: 'openai',
    runtimeModelId: 'gpt-5.4-hosted',
    loaded: true,
    state: 'READY',
    health: 'healthy',
    contextTokens: 128000,
  });

  const scheduler = new Scheduler({ computers, runtimes, models, policy: policyEngine });
  const engine = new ExecutionEngine({ workspace: workspaceDir });
  await engine.ready;

  const sensitiveTask = makeTask('task-s12', {
    policy: {
      localOnly: true,
      dataClassification: 'sensitive',
      allowHostedProviders: false,
      allowSubagentDispatch: false,
      projectRoot: workspaceDir,
    },
  });

  const record = await engine.create({
    task: sensitiveTask,
    agentId: 'local-secure-agent',
    computerId: 'local-workstation',
    runtimeId: 'ollama-local',
    modelId: 'qwen2.5-coder:14b',
    workspaceRoot: workspaceDir,
  });
  const execId = record.execution.id;
  await engine.setStatus(execId, 'running');

  const confidentialContent = 'export const internalSecretKeyId = "local-only-identifier";\n';
  await applyConfirmedFileWrite(
    engine,
    execId,
    workspaceDir,
    'src/confidential.ts',
    confidentialContent,
    'call-s12-1',
  );
  await engine.recordUsage(execId, { input: 100, output: 50, total: 150 });

  const recoveryStart = performance.now();
  let policyViolations = 0;

  // Violation Attempt 1: Resume localOnly + sensitive execution on hosted provider via Scheduler & PolicyEngine
  const hostedGate = policyEngine.checkHostedEligibility(record.task.policy, 'openai');
  if (hostedGate.allowed) policyViolations += 1;
  expect(hostedGate.allowed).toBe(false);
  expect(hostedGate.reason).toContain('local-only policy forbids hosted provider');

  let schedulerRejectedHosted = false;
  try {
    scheduler.plan({ task: sensitiveTask });
    policyViolations += 1;
  } catch (err) {
    schedulerRejectedHosted = err instanceof SchedulingError;
  }
  expect(schedulerRejectedHosted).toBe(true);

  // Violation Attempt 2: Attempt subagent dispatch during recovery of sensitive task
  const subagentGate = policyEngine.checkSubagentEligibility(record.task.policy);
  if (subagentGate.allowed) policyViolations += 1;
  expect(subagentGate.allowed).toBe(false);
  expect(subagentGate.reason).toContain("dataClassification 'sensitive' forbids subagent dispatch");

  // Violation Attempt 3: Attempt permission escalation (writing outside workspace root & destructive shell)
  const outsideWriteDecision = await policyEngine.authorize({
    executionId: execId,
    tool: 'write',
    input: { path: '/etc/wazir-escaped.conf', content: 'escaped' },
    projectRoot: workspaceDir,
  });
  await engine.recordPolicy(execId, outsideWriteDecision);
  if (outsideWriteDecision.decision !== 'deny') policyViolations += 1;
  expect(outsideWriteDecision.decision).toBe('deny');

  const sudoShellDecision = await policyEngine.authorize({
    executionId: execId,
    tool: 'shell',
    input: { command: 'sudo rm -rf /' },
    projectRoot: workspaceDir,
  });
  await engine.recordPolicy(execId, sudoShellDecision);
  if (sudoShellDecision.decision !== 'deny') policyViolations += 1;
  expect(sudoShellDecision.decision).toBe('deny');

  // Terminate execution fail-closed since no policy-compliant local runtime is available
  await engine.recordError(execId, 'POLICY_VIOLATION_BLOCKED: Refused hosted fallback and permission escalation');
  await engine.setStatus(execId, 'failed');
  const recoveryLatencyMs = performance.now() - recoveryStart;

  const finalRecord = (await engine.get(execId))!;
  const preserved =
    (await fs.readFile(path.join(workspaceDir, 'src/confidential.ts'), 'utf8')) === confidentialContent;

  return {
    scenarioId: 12,
    name: 'Attempt recovery that would violate existing policy',
    recoverable: false,
    recovered: false,
    failedClosed:
      !hostedGate.allowed &&
      schedulerRejectedHosted &&
      !subagentGate.allowed &&
      outsideWriteDecision.decision === 'deny' &&
      sudoShellDecision.decision === 'deny' &&
      finalRecord.execution.status === 'failed',
    recoveryLatencyMs,
    repeatedToolCalls: 0,
    duplicateSideEffects: 0,
    preCrashVerifiedFiles: 1,
    preservedVerifiedFiles: preserved ? 1 : 0,
    budgetAccountingErrors: finalRecord.usage?.total === 150 ? 0 : 1,
    policyViolations,
    evidenceSummary:
      'Blocked hosted fallback for localOnly/sensitive task, subagent dispatch, outside-root file write, and sudo shell command fail-closed',
  };
}

/**
 * Runs all 12 mandatory failure-injection scenarios and computes the 7 qualification metrics.
 */
export async function runRecoveryQualificationSuite(): Promise<RecoveryQualificationMetrics> {
  const suiteTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-c5-qualification-'));
  try {
    faultInjector.clear();
    const outcomes: ScenarioQualificationOutcome[] = [
      await runScenario1KillNativeAgent(suiteTmpDir),
      await runScenario2TerminateAcpSubprocess(suiteTmpDir),
      await runScenario3DisconnectRemoteWorker(suiteTmpDir),
      await runScenario4ProviderRateLimiting(suiteTmpDir),
      await runScenario5ModelUnavailability(suiteTmpDir),
      await runScenario6InterruptStreamPartialOutput(suiteTmpDir),
      await runScenario7RestartOrchestratorAfterCheckpoint(suiteTmpDir),
      await runScenario8DuplicateToolDelivery(suiteTmpDir),
      await runScenario9RestoreCorruptedCheckpoint(suiteTmpDir),
      await runScenario10WorkspaceRevisionChangeAfterCheckpoint(suiteTmpDir),
      await runScenario11InsufficientRemainingBudget(suiteTmpDir),
      await runScenario12PolicyViolatingRecovery(suiteTmpDir),
    ];

    const recoverableScenarios = outcomes.filter((o) => o.recoverable);
    const recoveredCount = recoverableScenarios.filter((o) => o.recovered).length;
    const recovery_success_rate =
      recoverableScenarios.length > 0 ? recoveredCount / recoverableScenarios.length : 0;

    const latencies = outcomes.map((o) => o.recoveryLatencyMs).sort((a, b) => a - b);
    const meanLatency =
      latencies.length > 0
        ? Number((latencies.reduce((acc, v) => acc + v, 0) / latencies.length).toFixed(3))
        : 0;

    const repeated_tool_calls = outcomes.reduce((acc, o) => acc + o.repeatedToolCalls, 0);
    const duplicate_side_effects = outcomes.reduce((acc, o) => acc + o.duplicateSideEffects, 0);

    const totalPreCrashFiles = outcomes.reduce((acc, o) => acc + o.preCrashVerifiedFiles, 0);
    const totalPreservedFiles = outcomes.reduce((acc, o) => acc + o.preservedVerifiedFiles, 0);
    const verified_work_preserved =
      totalPreCrashFiles > 0 ? totalPreservedFiles / totalPreCrashFiles : 1;

    const budget_accounting_errors = outcomes.reduce((acc, o) => acc + o.budgetAccountingErrors, 0);
    const policy_violations = outcomes.reduce((acc, o) => acc + o.policyViolations, 0);

    return {
      recovery_success_rate,
      recovery_latency: {
        p50: computePercentile(latencies, 50),
        p95: computePercentile(latencies, 95),
        mean: meanLatency,
      },
      repeated_tool_calls,
      duplicate_side_effects,
      verified_work_preserved,
      budget_accounting_errors,
      policy_violations,
      scenarios: outcomes,
    };
  } finally {
    faultInjector.clear();
    await fs.rm(suiteTmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================================
// VITEST QUALIFICATION TEST SUITE
// ============================================================================

describe('Agent C5: Cross-Harness Failure Injection and Recovery Qualification', () => {
  let tmpDir: string;

  beforeEach(async () => {
    faultInjector.clear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-c5-test-'));
  });

  afterEach(async () => {
    faultInjector.clear();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('Scenario 1: kills a native agent during implementation, reconciles state, and resumes on backup agent without repeating confirmed writes', async () => {
    const outcome = await runScenario1KillNativeAgent(tmpDir);
    expect(outcome.recovered).toBe(true);
    expect(outcome.repeatedToolCalls).toBe(0);
    expect(outcome.duplicateSideEffects).toBe(0);
    expect(outcome.preservedVerifiedFiles).toBe(outcome.preCrashVerifiedFiles);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('Scenario 2: terminates a real ACP subprocess with SIGKILL mid-turn and recovers on native harness', async () => {
    const outcome = await runScenario2TerminateAcpSubprocess(tmpDir);
    expect(outcome.recovered).toBe(true);
    expect(outcome.repeatedToolCalls).toBe(0);
    expect(outcome.duplicateSideEffects).toBe(0);
    expect(outcome.preservedVerifiedFiles).toBe(outcome.preCrashVerifiedFiles);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('Scenario 3: disconnects a remote worker via heartbeat expiry, fences stale epoch, transfers checkpoint, and resumes on healthy worker', async () => {
    const outcome = await runScenario3DisconnectRemoteWorker(tmpDir);
    expect(outcome.recovered).toBe(true);
    expect(outcome.repeatedToolCalls).toBe(0);
    expect(outcome.duplicateSideEffects).toBe(0);
    expect(outcome.preservedVerifiedFiles).toBe(outcome.preCrashVerifiedFiles);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('Scenario 4: simulates provider HTTP 429 rate limiting and falls back to eligible runtime preserving execution ID and budget', async () => {
    const outcome = await runScenario4ProviderRateLimiting(tmpDir);
    expect(outcome.recovered).toBe(true);
    expect(outcome.repeatedToolCalls).toBe(0);
    expect(outcome.duplicateSideEffects).toBe(0);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('Scenario 5: simulates primary model unavailability mid-task and escalates to backup model', async () => {
    const outcome = await runScenario5ModelUnavailability(tmpDir);
    expect(outcome.recovered).toBe(true);
    expect(outcome.repeatedToolCalls).toBe(0);
    expect(outcome.duplicateSideEffects).toBe(0);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('Scenario 6: interrupts a model stream after partial output before tool dispatch and retries cleanly with zero duplicate side effects', async () => {
    const outcome = await runScenario6InterruptStreamPartialOutput(tmpDir);
    expect(outcome.recovered).toBe(true);
    expect(outcome.repeatedToolCalls).toBe(0);
    expect(outcome.duplicateSideEffects).toBe(0);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('Scenario 7: restarts the orchestrator from durable JsonFileStore after checkpoint persistence and finishes the task', async () => {
    const outcome = await runScenario7RestartOrchestratorAfterCheckpoint(tmpDir);
    expect(outcome.recovered).toBe(true);
    expect(outcome.repeatedToolCalls).toBe(0);
    expect(outcome.duplicateSideEffects).toBe(0);
    expect(outcome.preservedVerifiedFiles).toBe(outcome.preCrashVerifiedFiles);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('Scenario 8: suppresses duplicate mutating tool delivery during recovery with zero duplicate side effects', async () => {
    const outcome = await runScenario8DuplicateToolDelivery(tmpDir);
    expect(outcome.recovered).toBe(true);
    expect(outcome.repeatedToolCalls).toBe(0);
    expect(outcome.duplicateSideEffects).toBe(0);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('Scenario 9: rejects restoration of a corrupted checkpoint fail-closed (CHECKPOINT_DIGEST_MISMATCH / CHECKPOINT_MATERIALIZATION_FAILED)', async () => {
    const outcome = await runScenario9RestoreCorruptedCheckpoint(tmpDir);
    expect(outcome.recoverable).toBe(false);
    expect(outcome.failedClosed).toBe(true);
    expect(outcome.policyViolations).toBe(0);
    expect(outcome.preservedVerifiedFiles).toBe(outcome.preCrashVerifiedFiles);
  });

  it('Scenario 10: marks prior verification evidence stale after workspace revision change and requires fresh verification before completion', async () => {
    const outcome = await runScenario10WorkspaceRevisionChangeAfterCheckpoint(tmpDir);
    expect(outcome.recovered).toBe(true);
    expect(outcome.repeatedToolCalls).toBe(0);
    expect(outcome.duplicateSideEffects).toBe(0);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('Scenario 11: refuses replay and returns action=terminate when remaining token/tool-call budget is exhausted', async () => {
    const outcome = await runScenario11InsufficientRemainingBudget(tmpDir);
    expect(outcome.recoverable).toBe(false);
    expect(outcome.failedClosed).toBe(true);
    expect(outcome.budgetAccountingErrors).toBe(0);
    expect(outcome.policyViolations).toBe(0);
  });

  it('Scenario 12: rejects recovery actions that would violate localOnly/sensitive policy or escalate tool permissions fail-closed', async () => {
    const outcome = await runScenario12PolicyViolatingRecovery(tmpDir);
    expect(outcome.recoverable).toBe(false);
    expect(outcome.failedClosed).toBe(true);
    expect(outcome.policyViolations).toBe(0);
    expect(outcome.budgetAccountingErrors).toBe(0);
  });

  it('computes and satisfies all 7 qualification metrics across all 12 scenarios via runRecoveryQualificationSuite()', async () => {
    const metrics = await runRecoveryQualificationSuite();

    expect(metrics.scenarios).toHaveLength(12);
    expect(metrics.recovery_success_rate).toBe(1);
    expect(metrics.recovery_latency.p50).toBeGreaterThan(0);
    expect(metrics.recovery_latency.p95).toBeGreaterThanOrEqual(metrics.recovery_latency.p50);
    expect(metrics.recovery_latency.mean).toBeGreaterThan(0);
    expect(metrics.repeated_tool_calls).toBe(0);
    expect(metrics.duplicate_side_effects).toBe(0);
    expect(metrics.verified_work_preserved).toBe(1);
    expect(metrics.budget_accounting_errors).toBe(0);
    expect(metrics.policy_violations).toBe(0);

    // Every non-recoverable scenario (9, 11, 12) must fail closed
    const nonRecoverable = metrics.scenarios.filter((s) => !s.recoverable);
    expect(nonRecoverable.map((s) => s.scenarioId)).toEqual([9, 11, 12]);
    expect(nonRecoverable.every((s) => s.failedClosed)).toBe(true);
  });
});
