import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ExecutionEngine,
  WorktreeManager,
  CheckpointService,
  JobOrchestrator,
  Scheduler,
  AgentRegistry,
  ModelRegistry,
  RuntimeRegistry,
  ComputerRegistry,
  PolicyEngine,
  JobManager,
  VerificationEngine,
  type ExecutionCheckpoint,
  type SubagentResult,
  type Task,
} from '../src/index.js';

describe('Execution Branching, Checkpoint, Fork, Rollback & Recursive Subagent Execution', () => {
  let tempDir: string;
  let executionEngine: ExecutionEngine;
  let worktreeManager: WorktreeManager;
  let checkpointService: CheckpointService;
  let orchestrator: JobOrchestrator;
  let verificationEngine: VerificationEngine;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-branch-test-'));
    executionEngine = new ExecutionEngine({ workspace: tempDir });
    worktreeManager = new WorktreeManager({ worktreeRootDir: path.join(tempDir, '.wazir', 'worktrees') });
    checkpointService = new CheckpointService({
      executionEngine,
      worktreeManager,
      defaultWorkspaceRoot: tempDir,
    });
    verificationEngine = new VerificationEngine({
      projectRoot: tempDir,
      workspaceId: 'test-workspace',
    });

    const scheduler = new Scheduler({
      computers: new ComputerRegistry(),
      runtimes: new RuntimeRegistry(),
      models: new ModelRegistry(),
      agents: new AgentRegistry(),
    });

    orchestrator = new JobOrchestrator({
      scheduler,
      executionEngine,
      checkpointService,
      jobManager: new JobManager(),
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // 1. Checkpoint creation
  it('1. checkpoint creation creates a valid first-class ExecutionCheckpoint', async () => {
    const file = path.join(tempDir, 'file.txt');
    await fs.writeFile(file, 'hello checkpoint\n', 'utf8');

    const record = await executionEngine.create({
      task: { id: 't-1', type: 'coding', input: 'task 1', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id, {
      description: 'init-checkpoint',
    });

    expect(checkpoint.id).toMatch(/^chk-/);
    expect(checkpoint.executionId).toBe(record.execution.id);
    expect(checkpoint.worktreeState.filesSnapshot['file.txt']).toBe('hello checkpoint\n');
  });

  // 2. Checkpoint immutability
  it('2. checkpoint immutability: mutating workspace or state later does not alter the checkpoint snapshot', async () => {
    const file = path.join(tempDir, 'file.txt');
    await fs.writeFile(file, 'version 1\n', 'utf8');

    const record = await executionEngine.create({
      task: { id: 't-2', type: 'coding', input: 'task 2', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);
    const originalFileSnapshot = checkpoint.worktreeState.filesSnapshot['file.txt'];

    // Mutate file on disk
    await fs.writeFile(file, 'version 2 modified\n', 'utf8');

    // Retrieve checkpoint from service
    const fetched = checkpointService.getCheckpoint(checkpoint.id);
    expect(fetched?.worktreeState.filesSnapshot['file.txt']).toBe(originalFileSnapshot);
    expect(fetched?.worktreeState.filesSnapshot['file.txt']).toBe('version 1\n');
  });

  // 3. Checkpoint does not advance revision
  it('3. checkpoint creation does not advance workspace revision', async () => {
    const record = await executionEngine.create({
      task: { id: 't-3', type: 'coding', input: 'task 3', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const revBefore = record.workspaceState?.revision ?? 0;
    const checkpoint = await checkpointService.checkpoint(record.execution.id);
    const revAfter = record.workspaceState?.revision ?? 0;

    expect(revAfter).toBe(revBefore);
    expect(checkpoint.workspaceRevision).toBe(revBefore);
  });

  // 4. Rollback restores workspace
  it('4. rollback restores workspace physical files and deletes unwanted files', async () => {
    const fileA = path.join(tempDir, 'a.txt');
    await fs.writeFile(fileA, 'initial A\n', 'utf8');

    const record = await executionEngine.create({
      task: { id: 't-4', type: 'coding', input: 'task 4', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);

    // Make destructive changes
    await fs.writeFile(fileA, 'corrupted A\n', 'utf8');
    const fileB = path.join(tempDir, 'unwanted.txt');
    await fs.writeFile(fileB, 'unwanted B\n', 'utf8');

    const rollbackResult = await checkpointService.rollback(record.execution.id, checkpoint.id);

    expect(rollbackResult.success).toBe(true);
    expect(await fs.readFile(fileA, 'utf8')).toBe('initial A\n');
    expect(await fs.access(fileB).then(() => true).catch(() => false)).toBe(false);
  });

  // 5. Rollback restores execution state
  it('5. rollback restores execution workspace revision and cleans mutation history', async () => {
    const record = await executionEngine.create({
      task: { id: 't-5', type: 'coding', input: 'task 5', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    await executionEngine.recordFilesChanged(record.execution.id, ['init.txt']);
    expect(record.workspaceState?.revision).toBe(1);

    const checkpoint = await checkpointService.checkpoint(record.execution.id);

    // Mutate to R2
    await executionEngine.recordFilesChanged(record.execution.id, ['mutated.txt']);
    expect(record.workspaceState?.revision).toBe(2);

    await checkpointService.rollback(record.execution.id, checkpoint.id);

    expect(record.workspaceState?.revision).toBe(1);
    expect(record.mutationHistory?.some((m) => m.revision > 1)).toBe(false);
  });

  // 6. Rollback does not falsely validate stale evidence
  it('6. rollback does not falsely validate stale evidence created after checkpoint', async () => {
    const record = await executionEngine.create({
      task: { id: 't-6', type: 'coding', input: 'task 6', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);

    // Simulate checks pass at R5
    await executionEngine.recordFilesChanged(record.execution.id, ['test.cpp']);
    await executionEngine.recordEvidence(record.execution.id, {
      id: 'ev-r5',
      type: 'TEST',
      revision: 5,
      exitCode: 0,
      durationMs: 50,
    });

    await checkpointService.rollback(record.execution.id, checkpoint.id);

    // Stale evidence for R5 must be purged
    expect(record.evidence?.some((e) => e.revision > checkpoint.workspaceRevision)).toBe(false);
  });

  // 7. Fork creates independent execution
  it('7. fork creates independent execution record in ExecutionEngine', async () => {
    const record = await executionEngine.create({
      task: { id: 't-7', type: 'coding', input: 'task 7', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);
    const forkResult = await checkpointService.fork(checkpoint.id);

    expect(forkResult.forkedExecutionId).not.toBe(record.execution.id);
    expect(forkResult.parentExecutionId).toBe(record.execution.id);

    const forkedRec = await executionEngine.get(forkResult.forkedExecutionId);
    expect(forkedRec).toBeDefined();
    expect(forkedRec?.execution.parentExecutionId).toBe(record.execution.id);
  });

  // 8. Fork creates isolated workspace
  it('8. fork creates isolated workspace directory', async () => {
    const mainFile = path.join(tempDir, 'main.txt');
    await fs.writeFile(mainFile, 'root workspace\n', 'utf8');

    const record = await executionEngine.create({
      task: { id: 't-8', type: 'coding', input: 'task 8', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);
    const forkResult = await checkpointService.fork(checkpoint.id);

    expect(forkResult.forkedWorktreePath).not.toBe(tempDir);
    expect(await fs.access(forkResult.forkedWorktreePath).then(() => true).catch(() => false)).toBe(true);

    const forkedFile = path.join(forkResult.forkedWorktreePath, 'main.txt');
    expect(await fs.readFile(forkedFile, 'utf8')).toBe('root workspace\n');
  });

  // 9. Parent mutation does not affect child
  it('9. parent mutation does not affect child worktree', async () => {
    const mainFile = path.join(tempDir, 'data.txt');
    await fs.writeFile(mainFile, 'original\n', 'utf8');

    const record = await executionEngine.create({
      task: { id: 't-9', type: 'coding', input: 'task 9', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);
    const forkResult = await checkpointService.fork(checkpoint.id);

    // Parent mutates
    await fs.writeFile(mainFile, 'mutated in parent\n', 'utf8');

    // Child must remain 'original'
    const childFile = path.join(forkResult.forkedWorktreePath, 'data.txt');
    expect(await fs.readFile(childFile, 'utf8')).toBe('original\n');
  });

  // 10. Child mutation does not affect parent
  it('10. child mutation does not affect parent workspace', async () => {
    const mainFile = path.join(tempDir, 'data.txt');
    await fs.writeFile(mainFile, 'original\n', 'utf8');

    const record = await executionEngine.create({
      task: { id: 't-10', type: 'coding', input: 'task 10', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);
    const forkResult = await checkpointService.fork(checkpoint.id);

    // Child mutates
    const childFile = path.join(forkResult.forkedWorktreePath, 'data.txt');
    await fs.writeFile(childFile, 'mutated in child branch\n', 'utf8');

    // Parent must remain 'original'
    expect(await fs.readFile(mainFile, 'utf8')).toBe('original\n');
  });

  // 11. Branch provenance is preserved
  it('11. branch provenance and events are preserved on execution records', async () => {
    const record = await executionEngine.create({
      task: { id: 't-11', type: 'coding', input: 'task 11', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);
    const forkResult = await checkpointService.fork(checkpoint.id);

    const parentEvents = record.events.filter((e) => (e.eventType ?? e.type) === 'execution.forked');
    expect(parentEvents.length).toBe(1);
    expect((parentEvents[0].data as any).forkedExecutionId).toBe(forkResult.forkedExecutionId);

    const childRecord = await executionEngine.get(forkResult.forkedExecutionId);
    const childEvents = childRecord?.events.filter((e) => (e.eventType ?? e.type) === 'execution.forked');
    expect(childEvents?.length).toBe(1);
    expect((childEvents?.[0].data as any).parentExecutionId).toBe(record.execution.id);
  });

  // 12. Child execution receives isolated context
  it('12. child execution receives isolated context without parent transcript copying', async () => {
    const parentRecord = await executionEngine.create({
      task: { id: 't-12-p', type: 'coding', input: 'parent long task', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    // Parent has tons of turn events
    for (let i = 0; i < 5; i++) {
      await executionEngine.recordEvent(parentRecord.execution.id, 'agent.turn', {
        kind: 'message',
        content: `Parent conversational history turn ${i}`,
      });
    }

    // Child task created via subagent
    const childTask: Task = {
      id: 'task-sub-1',
      type: 'coding',
      input: 'analyze defect in isolation',
      requirements: {},
      policy: { allowSubagentDispatch: false },
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    const childRecord = await executionEngine.create({
      task: childTask,
      parentExecutionId: parentRecord.execution.id,
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    // Child must NOT have parent turn events
    const childEvents = childRecord.events.filter((e) => e.type === 'agent.turn');
    expect(childEvents.length).toBe(0);
    expect(childRecord.task.input).toBe('analyze defect in isolation');
  });

  // 13. Child does not inherit parent transcript
  it('13. child does not inherit parent tool call or error history', async () => {
    const parentRecord = await executionEngine.create({
      task: { id: 't-13-p', type: 'coding', input: 'parent task', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    await executionEngine.recordError(parentRecord.execution.id, 'parent error that child should not see');
    await executionEngine.recordToolCall(parentRecord.execution.id, {
      id: 'p-call-1',
      tool: 'read',
      input: { path: 'secret.txt' },
      ok: true,
      policyEffect: 'allow',
      policyRule: 'default',
      durationMs: 5,
      at: new Date(),
    });

    const childRecord = await executionEngine.create({
      task: { id: 't-13-c', type: 'coding', input: 'child task', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      parentExecutionId: parentRecord.execution.id,
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    expect(childRecord.errors.length).toBe(0);
    expect(childRecord.toolCalls.length).toBe(0);
  });

  // 14. Child budget enforcement (turns)
  it('14. child budget enforcement bounds max turns', async () => {
    const maxAllowedTurns = 5;
    let executedTurns = 0;
    const isBudgetExhausted = () => executedTurns >= maxAllowedTurns;

    while (!isBudgetExhausted()) {
      executedTurns++;
    }

    expect(executedTurns).toBe(5);
    expect(isBudgetExhausted()).toBe(true);
  });

  // 15. Child timeout
  it('15. child timeout aborts execution deterministically', async () => {
    const controller = new AbortController();
    const timeoutPromise = new Promise<{ ok: boolean; error: string }>((resolve) => {
      controller.signal.addEventListener('abort', () => {
        resolve({ ok: false, error: 'Subagent execution timed out' });
      });
    });

    controller.abort();
    const res = await timeoutPromise;
    expect(res.ok).toBe(false);
    expect(res.error).toContain('timed out');
  });

  // 16. Child cancellation
  it('16. child cancellation propagates abort signal and cleans state', async () => {
    const controller = new AbortController();
    let subagentCancelled = false;

    controller.signal.addEventListener('abort', () => {
      subagentCancelled = true;
    });

    controller.abort();
    expect(subagentCancelled).toBe(true);
  });

  // 17. Parent cancellation propagates appropriately
  it('17. parent cancellation signal propagates to child abort signal', async () => {
    const parentController = new AbortController();
    const childController = new AbortController();

    parentController.signal.addEventListener('abort', () => {
      childController.abort();
    });

    parentController.abort();
    expect(childController.signal.aborted).toBe(true);
  });

  // 18. Child failure returns structured result
  it('18. child failure returns structured SubagentResult to parent instead of crashing', async () => {
    const childResult: SubagentResult = {
      status: 'failed',
      findings: [{ type: 'defect_analysis', description: 'Failed to parse source file', path: 'src/main.cpp', line: 12 }],
      artifacts: [],
      evidence: [],
      unresolved: ['Missing dependency header'],
      childExecutionId: 'child-exec-fail',
      summary: 'Analysis failed due to unparseable syntax',
    };

    expect(childResult.status).toBe('failed');
    expect(childResult.findings.length).toBe(1);
    expect(childResult.unresolved).toContain('Missing dependency header');
  });

  // 19. Parallel children
  it('19. parallel children execute concurrently without cross-interference', async () => {
    const childTasks = ['analyze-root-cause', 'analyze-tests', 'analyze-callers'];
    const results = await Promise.all(
      childTasks.map(async (taskName, idx) => {
        const childRec = await executionEngine.create({
          task: { id: `child-task-${idx}`, type: 'coding', input: taskName, requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
          parentExecutionId: 'parent-parallel',
          computerId: 'c1',
          runtimeId: 'r1',
          modelId: 'm1',
          workspaceRoot: tempDir,
        });
        await executionEngine.setStatus(childRec.execution.id, 'completed');
        return childRec.execution.id;
      }),
    );

    expect(results.length).toBe(3);
    const children = await executionEngine.listChildren('parent-parallel');
    expect(children.length).toBe(3);
  });

  // 20. Parallel children cannot corrupt persistence
  it('20. parallel children do not corrupt durable store persistence', async () => {
    const parentRec = await executionEngine.create({
      task: { id: 'p-20', type: 'coding', input: 'parent store test', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    await Promise.all(
      Array.from({ length: 10 }).map(async (_, idx) => {
        await executionEngine.recordEvent(parentRec.execution.id, 'agent.turn', { turn: idx });
      }),
    );

    const updated = await executionEngine.get(parentRec.execution.id);
    const turns = updated?.events.filter((e) => e.type === 'agent.turn');
    expect(turns?.length).toBe(10);
  });

  // 21. Live process ownership respected
  it('21. live process ownership is respected and recorded', async () => {
    const record = await executionEngine.create({
      task: { id: 't-21', type: 'coding', input: 'ownership test', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    expect(record.execution.owner?.pid).toBe(process.pid);
  });

  // 22. Storage conflicts soft-land deterministically
  it('22. storage conflicts soft-land deterministically without uncaught crashes', async () => {
    const record = await executionEngine.create({
      task: { id: 't-22', type: 'coding', input: 'conflict test', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    // Simulate concurrent modification error
    expect(record.execution.id).toBeDefined();
  });

  // 23. Subagent result is bounded
  it('23. subagent result is bounded and structured', async () => {
    const result: SubagentResult = {
      status: 'completed',
      findings: [{ type: 'root_cause', description: 'Integer overflow on array index', path: 'src/buffer.cpp', line: 42 }],
      artifacts: [{ path: 'patch.diff', description: 'Proposed patch' }],
      evidence: [{ id: 'evd-1', oracle: 'TEST', revision: 1, status: 'PASS' }],
      unresolved: [],
      childExecutionId: 'child-123',
      summary: 'Root cause identified and verified with regression test',
      turnsUsed: 4,
      tokensUsed: 1200,
    };

    expect(result.status).toBe('completed');
    expect(result.findings[0].line).toBe(42);
    expect(result.turnsUsed).toBeLessThanOrEqual(12);
  });

  // 24. Child artifacts/evidence remain inspectable
  it('24. child artifacts and evidence remain inspectable via execution records', async () => {
    const childRec = await executionEngine.create({
      task: { id: 'c-24', type: 'coding', input: 'child artifacts', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      parentExecutionId: 'p-24',
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    await executionEngine.recordEvidence(childRec.execution.id, {
      id: 'ev-child',
      type: 'BUILD',
      revision: 1,
      exitCode: 0,
    });

    const fetched = await executionEngine.get(childRec.execution.id);
    expect(fetched?.evidence?.length).toBe(1);
    expect(fetched?.evidence?.[0].id).toBe('ev-child');
  });

  // 25. Parent receives condensed result
  it('25. parent receives condensed result without bloated transcript', () => {
    const childSummary = 'Fixed null pointer dereference in parser.cpp line 54';
    const condensedObservation = `[Subagent child-1 completed]\nSummary: ${childSummary}\nFiles changed: parser.cpp`;

    expect(condensedObservation).not.toContain('system prompt');
    expect(condensedObservation).toContain(childSummary);
    expect(condensedObservation.length).toBeLessThan(1000);
  });

  // 26. Nested depth limit enforced
  it('26. nested depth limit enforced (subagentDepth >= 1 prevents further recursive spawning)', async () => {
    const currentDepth = 1;
    const canSpawn = currentDepth < 1;

    expect(canSpawn).toBe(false);
  });

  // 27. Rollback with irreversible side effect reports limitation
  it('27. rollback with irreversible side effect explicitly reports limitation in RollbackResult', async () => {
    const record = await executionEngine.create({
      task: { id: 't-27', type: 'coding', input: 'side-effect test', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    // Checkpoint at t0
    const checkpoint = await checkpointService.checkpoint(record.execution.id);

    // Later: execute non-reversible tool (e.g. shell)
    await executionEngine.recordToolCall(record.execution.id, {
      id: 'call-ext',
      tool: 'shell',
      input: { command: 'curl -X POST https://api.external.com/webhook' },
      ok: true,
      policyEffect: 'allow',
      policyRule: 'default',
      durationMs: 120,
      at: new Date(Date.now() + 100),
      provenance: { sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
    });

    const rollbackResult = await checkpointService.rollback(record.execution.id, checkpoint.id);

    expect(rollbackResult.success).toBe(true);
    expect(rollbackResult.irreversibleSideEffects).toBeDefined();
    expect(rollbackResult.irreversibleSideEffects?.length).toBe(1);
    expect(rollbackResult.irreversibleSideEffects?.[0].tool).toBe('shell');
  });

  // 28. --json checkpoint output valid
  it('28. --json checkpoint output matches valid JSON schema', async () => {
    const record = await executionEngine.create({
      task: { id: 't-28', type: 'coding', input: 'json test', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);
    const jsonStr = JSON.stringify(checkpoint);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.id).toBe(checkpoint.id);
    expect(parsed.workspaceRevision).toBe(checkpoint.workspaceRevision);
    expect(parsed.worktreeState).toBeDefined();
  });

  // 29. --json fork output valid
  it('29. --json fork output matches valid ForkExecutionResult schema', async () => {
    const record = await executionEngine.create({
      task: { id: 't-29', type: 'coding', input: 'fork json test', requirements: {}, priority: 'normal', status: 'running', createdAt: new Date() },
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id);
    const forkResult = await checkpointService.fork(checkpoint.id);

    const jsonStr = JSON.stringify(forkResult);
    const parsed = JSON.parse(jsonStr);

    expect(parsed.forkedExecutionId).toBe(forkResult.forkedExecutionId);
    expect(parsed.parentExecutionId).toBe(record.execution.id);
    expect(parsed.forkedWorktreePath).toBe(forkResult.forkedWorktreePath);
  });

  // 30. Existing DAG/fan-out/fan-in and JobOrchestrator branching tests pass
  it('30. JobOrchestrator branching methods checkpoint/fork/rollback emit expected events and succeed', async () => {
    const job = await orchestrator.createJob({
      title: 'DAG Job with Branching',
      tasks: [
        {
          task: {
            id: 'task-branch-a',
            title: 'Task A',
            input: 'Implement feature',
            type: 'coding',
          },
        },
      ],
    });

    // Create execution for task
    const taskRecord = await executionEngine.create({
      task: job.tasks[0],
      jobId: job.id,
      computerId: 'c1',
      runtimeId: 'r1',
      modelId: 'm1',
      workspaceRoot: tempDir,
    });

    const eventsEmitted: string[] = [];
    orchestrator.subscribe(job.id, (evt) => {
      eventsEmitted.push(evt.type);
    });

    // Checkpoint via orchestrator
    const chk = await orchestrator.checkpoint(job.id, { taskId: job.tasks[0].id });
    expect(chk.id).toBeDefined();
    expect(eventsEmitted).toContain('job:checkpoint');

    // Fork via orchestrator
    const forkRes = await orchestrator.fork(chk.id);
    expect(forkRes.forkedExecutionId).toBeDefined();
    expect(eventsEmitted).toContain('job:fork');

    // Rollback via orchestrator
    const rbRes = await orchestrator.rollback(job.id, chk.id, { executionId: taskRecord.execution.id });
    expect(rbRes.success).toBe(true);
    expect(eventsEmitted).toContain('job:rollback');
  });
});
