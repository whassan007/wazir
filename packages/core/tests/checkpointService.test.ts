import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  ExecutionEngine,
  WorktreeManager,
  CheckpointService,
} from '../src/index.js';

describe('Gate 5: Execution Checkpoints / Fork / Rollback', () => {
  let tempDir: string;
  let executionEngine: ExecutionEngine;
  let worktreeManager: WorktreeManager;
  let checkpointService: CheckpointService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-chk-test-'));
    executionEngine = new ExecutionEngine({ workspace: tempDir });
    worktreeManager = new WorktreeManager({ worktreeRootDir: path.join(tempDir, '.wazir', 'worktrees') });
    checkpointService = new CheckpointService({
      executionEngine,
      worktreeManager,
      defaultWorkspaceRoot: tempDir,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('creates an execution checkpoint capturing revision, files snapshot, and verification state', async () => {
    // Setup initial files
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'main.ts'), 'export const hello = "world";\n', 'utf8');

    const record = await executionEngine.create({
      task: {
        id: 'task-1',
        type: 'coding',
        input: 'init',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt',
      modelId: 'model',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(record.execution.id, {
      description: 'base-state',
      contextSnapshot: { itemUris: ['src/main.ts'], tokenCount: 20 },
    });

    expect(checkpoint.id).toMatch(/^chk-/);
    expect(checkpoint.executionId).toBe(record.execution.id);
    expect(checkpoint.workspaceRevision).toBe(0);
    expect(checkpoint.worktreeState.filesSnapshot['src/main.ts']).toBe('export const hello = "world";\n');
    expect(checkpoint.contextSnapshot?.itemUris).toContain('src/main.ts');
    expect(checkpoint.verificationState.revision).toBe(0);

    // Verify audit / provenance event emitted
    const events = record.events.filter((e) => (e.eventType ?? e.type) === 'execution.checkpoint.created');
    expect(events.length).toBe(1);
    expect((events[0].data as any).checkpointId).toBe(checkpoint.id);
  });

  it('restores physical bytes and workspace revision on rollback after mutations', async () => {
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    const mainFile = path.join(srcDir, 'main.ts');
    await fs.writeFile(mainFile, 'original content\n', 'utf8');

    const record = await executionEngine.create({
      task: {
        id: 'task-rollback',
        type: 'coding',
        input: 'rollback test',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt',
      modelId: 'model',
      workspaceRoot: tempDir,
    });

    // Record initial mutation to R1
    await executionEngine.recordFilesChanged(record.execution.id, ['src/main.ts']);
    expect(record.workspaceState?.revision).toBe(1);

    // Take checkpoint at R1
    const checkpoint = await checkpointService.checkpoint(record.execution.id, {
      description: 'checkpoint-at-r1',
    });
    expect(checkpoint.workspaceRevision).toBe(1);

    // Now mutate workspace: modify main.ts and add new unwanted file
    await fs.writeFile(mainFile, 'MUTATED BAD CONTENT\n', 'utf8');
    const badFile = path.join(srcDir, 'bad.ts');
    await fs.writeFile(badFile, 'should be deleted on rollback\n', 'utf8');

    // Advance to R2
    await executionEngine.recordFilesChanged(record.execution.id, ['src/main.ts', 'src/bad.ts']);
    expect(record.workspaceState?.revision).toBe(2);

    // Add some evidence bound to R2
    await executionEngine.recordEvidence(record.execution.id, {
      id: 'ev-r2',
      type: 'TEST',
      revision: 2,
      exitCode: 1,
      durationMs: 100,
    });
    expect(record.evidence?.length).toBe(1);

    // Execute Rollback to R1 checkpoint
    const rollbackResult = await checkpointService.rollback(record.execution.id, checkpoint.id);

    expect(rollbackResult.success).toBe(true);
    expect(rollbackResult.restoredRevision).toBe(1);

    // Verify physical bytes restored
    const restoredContent = await fs.readFile(mainFile, 'utf8');
    expect(restoredContent).toBe('original content\n');

    // Verify un-checkpointed file was removed
    const badExists = await fs.access(badFile).then(() => true).catch(() => false);
    expect(badExists).toBe(false);

    // Verify workspace revision restored
    expect(record.workspaceState?.revision).toBe(1);

    // Verify stale R2 evidence was invalidated/removed
    expect(record.evidence?.some((e) => e.revision > 1)).toBe(false);

    // Verify rollback event was emitted
    const rollbackEvents = record.events.filter(
      (e) => (e.eventType ?? e.type) === 'execution.rollback.completed',
    );
    expect(rollbackEvents.length).toBe(1);
    expect((rollbackEvents[0].data as any).restoredRevision).toBe(1);
  });

  it('rejects invalid rollback target and emits audit event', async () => {
    const record = await executionEngine.create({
      task: {
        id: 'task-invalid-rb',
        type: 'coding',
        input: 'invalid',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt',
      modelId: 'model',
      workspaceRoot: tempDir,
    });

    // 1. Rollback to non-existent checkpoint
    await expect(
      checkpointService.rollback(record.execution.id, 'chk-non-existent'),
    ).rejects.toThrow(/not found/);

    let rejectedEvents = record.events.filter(
      (e) => (e.eventType ?? e.type) === 'execution.rollback.rejected',
    );
    expect(rejectedEvents.length).toBe(1);

    // 2. Rollback to a checkpoint belonging to another execution
    const record2 = await executionEngine.create({
      task: {
        id: 'task-other',
        type: 'coding',
        input: 'other',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt',
      modelId: 'model',
      workspaceRoot: tempDir,
    });

    const otherCheckpoint = await checkpointService.checkpoint(record2.execution.id);

    await expect(
      checkpointService.rollback(record.execution.id, otherCheckpoint.id),
    ).rejects.toThrow(/does not belong to execution/);

    rejectedEvents = record.events.filter(
      (e) => (e.eventType ?? e.type) === 'execution.rollback.rejected',
    );
    expect(rejectedEvents.length).toBe(2);
  });

  it('forks an execution into an isolated branch and worktree', async () => {
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'feature.ts'), 'export const v1 = 1;\n', 'utf8');

    const parentRecord = await executionEngine.create({
      task: {
        id: 'task-parent',
        type: 'coding',
        input: 'parent',
        requirements: {},
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'rt',
      modelId: 'model',
      workspaceRoot: tempDir,
    });

    const checkpoint = await checkpointService.checkpoint(parentRecord.execution.id, {
      description: 'before-speculation',
    });

    // Fork execution
    const forkResult = await checkpointService.fork(checkpoint.id, 'test-speculation');

    expect(forkResult.checkpointId).toBe(checkpoint.id);
    expect(forkResult.parentExecutionId).toBe(parentRecord.execution.id);
    expect(forkResult.forkedWorktreePath).not.toBe(tempDir);
    expect(forkResult.forkedWorktreePath).toContain('test-speculation');

    // Verify files copied to isolated fork
    const forkedFeature = path.join(forkResult.forkedWorktreePath, 'src/feature.ts');
    const forkedContent = await fs.readFile(forkedFeature, 'utf8');
    expect(forkedContent).toBe('export const v1 = 1;\n');

    // Verify events emitted
    const parentForkEvents = parentRecord.events.filter(
      (e) => (e.eventType ?? e.type) === 'execution.forked',
    );
    expect(parentForkEvents.length).toBe(1);

    // MUTATE FORK: verify mutating fork does NOT alter parent branch/workspace!
    await fs.writeFile(forkedFeature, 'export const v2_speculative = 2;\n', 'utf8');
    await fs.writeFile(
      path.join(forkResult.forkedWorktreePath, 'src/experimental.ts'),
      'export const exp = true;\n',
      'utf8',
    );

    // Check parent workspace: must be completely untouched!
    const parentContent = await fs.readFile(path.join(srcDir, 'feature.ts'), 'utf8');
    expect(parentContent).toBe('export const v1 = 1;\n');
    const parentExpExists = await fs.access(path.join(srcDir, 'experimental.ts')).then(() => true).catch(() => false);
    expect(parentExpExists).toBe(false);

    // Merging successful fork back
    const mergeResult = await checkpointService.mergeFork(forkResult);
    expect(mergeResult.success).toBe(true);

    // Now parent should have the merged changes
    const mergedParentContent = await fs.readFile(path.join(srcDir, 'feature.ts'), 'utf8');
    expect(mergedParentContent).toBe('export const v2_speculative = 2;\n');
    const mergedExpContent = await fs.readFile(path.join(srcDir, 'experimental.ts'), 'utf8');
    expect(mergedExpContent).toBe('export const exp = true;\n');
  });
});
