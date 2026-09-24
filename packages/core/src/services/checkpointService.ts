import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ExecutionCheckpoint,
  CheckpointCreateOptions,
  ForkExecutionResult,
  RollbackResult,
  ExecutionRecord,
} from '../types/index.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { WorktreeManager, WorktreeMergeResult } from './worktreeManager.js';
import type { ProvenanceManager } from './provenanceManager.js';

export interface CheckpointServiceOptions {
  executionEngine: ExecutionEngine;
  worktreeManager: WorktreeManager;
  provenanceManager?: ProvenanceManager;
  defaultWorkspaceRoot?: string;
}

export class CheckpointService {
  private readonly checkpoints = new Map<string, ExecutionCheckpoint>();
  private readonly executionEngine: ExecutionEngine;
  private readonly worktreeManager: WorktreeManager;
  private readonly provenanceManager?: ProvenanceManager;
  private readonly defaultWorkspaceRoot: string;

  constructor(options: CheckpointServiceOptions) {
    this.executionEngine = options.executionEngine;
    this.worktreeManager = options.worktreeManager;
    this.provenanceManager = options.provenanceManager;
    this.defaultWorkspaceRoot = options.defaultWorkspaceRoot ?? process.cwd();
  }

  /**
   * Captures an ExecutionCheckpoint referencing:
   * - executionId
   * - workspaceRevision
   * - worktree / git state and physical byte snapshot
   * - context snapshot
   * - job / plan state
   * - verification state
   */
  public async checkpoint(
    executionId: string,
    options: CheckpointCreateOptions = {},
  ): Promise<ExecutionCheckpoint> {
    const record = await this.executionEngine.get(executionId);
    if (!record) {
      throw new Error(`Execution '${executionId}' not found`);
    }

    const workspaceRoot = record.execution.workspaceRoot ?? this.defaultWorkspaceRoot;
    const isGit = await this.worktreeManager.isGitRepo(workspaceRoot);
    const branch = isGit ? await this.worktreeManager.getCurrentBranch(workspaceRoot) : undefined;

    // Snapshot physical workspace files
    const filesSnapshot = await this.snapshotWorkspaceFiles(workspaceRoot);

    const currentRevision = record.workspaceState?.revision ?? 0;

    // Verification state
    const currentEvidence = (record.evidence ?? []).filter((e) => e.revision <= currentRevision);
    const evidenceIds = currentEvidence.map((e) => e.id);
    const currentChecks = (record.checks ?? []).filter((c) => (c.workspaceRevision ?? 0) <= currentRevision);
    const checksPass = currentChecks.length > 0 && currentChecks.every((c) => c.ok);

    const checkpointId = `chk-${randomUUID()}`;
    const evidenceReferences = currentEvidence.map((e) => ({
      id: e.id,
      type: e.type ?? e.oracle ?? 'TEST',
      revision: e.revision ?? e.workspaceRevision ?? 0,
      status: e.status,
    }));
    const provenanceCursor = record.events ? record.events.length : 0;

    const checkpoint: ExecutionCheckpoint = {
      id: checkpointId,
      executionId,
      createdAt: new Date(),
      workspaceRevision: currentRevision,
      workspaceRoot,
      worktreeState: {
        branch,
        isGit,
        filesSnapshot,
      },
      contextSnapshot: options.contextSnapshot ?? {
        itemUris: record.filesChanged ? [...record.filesChanged] : [],
      },
      planState: options.planState ?? {
        jobId: record.execution.jobId,
        status: record.execution.status,
      },
      verificationState: {
        revision: currentRevision,
        evidenceIds,
        checksPass,
      },
      provenanceCursor,
      evidenceReferences,
      description: options.description,
      metadata: options.metadata,
    };

    this.checkpoints.set(checkpointId, checkpoint);

    // Record audit / provenance event on ExecutionEngine
    (this.executionEngine as any).pushEvent?.(record, 'execution.checkpoint.created', {
      checkpointId,
      workspaceRevision: currentRevision,
      provenanceCursor,
      filesCount: Object.keys(filesSnapshot).length,
      description: options.description,
    });

    return checkpoint;
  }

  /**
   * Retrieves a checkpoint by ID.
   */
  public getCheckpoint(checkpointId: string): ExecutionCheckpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  /**
   * Lists checkpoints for an execution.
   */
  public listCheckpoints(executionId?: string): ExecutionCheckpoint[] {
    const all = Array.from(this.checkpoints.values());
    if (!executionId) return all;
    return all.filter((c) => c.executionId === executionId);
  }

  /**
   * Creates an isolated branch of execution from a checkpoint.
   * Uses WorktreeManager to ensure isolation without disturbing the parent branch.
   */
  public async fork(
    checkpointId: string,
    forkedExecutionId?: string,
  ): Promise<ForkExecutionResult> {
    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint '${checkpointId}' not found`);
    }

    const parentRecord = await this.executionEngine.get(checkpoint.executionId);
    if (!parentRecord) {
      throw new Error(`Parent execution '${checkpoint.executionId}' not found`);
    }

    const forkId = forkedExecutionId ?? `fork-${randomUUID().slice(0, 8)}`;
    const forkJobId = `job-${forkId}`;

    // Create an isolated worktree
    const worktreeInfo = await this.worktreeManager.createWorktree(
      checkpoint.workspaceRoot,
      forkJobId,
      forkId,
    );

    // Restore exact snapshot files into forked worktree directory
    await this.restoreSnapshotToDirectory(
      worktreeInfo.worktreeDir,
      checkpoint.worktreeState.filesSnapshot,
    );

    // Create forked execution record in ExecutionEngine
    const forkedRecord = await this.executionEngine.create({
      task: {
        ...parentRecord.task,
        id: `task-${forkId}`,
      },
      jobId: forkJobId,
      parentExecutionId: parentRecord.execution.id,
      computerId: parentRecord.execution.computerId ?? 'default',
      runtimeId: parentRecord.execution.runtimeId,
      modelId: parentRecord.execution.modelId,
      workspaceRoot: worktreeInfo.worktreeDir,
    });

    // Advance workspace state revision to match checkpoint
    if (forkedRecord.workspaceState) {
      forkedRecord.workspaceState.revision = checkpoint.workspaceRevision;
    }

    // Emit execution.forked event on parent and forked executions
    (this.executionEngine as any).pushEvent?.(parentRecord, 'execution.forked', {
      checkpointId,
      parentExecutionId: parentRecord.execution.id,
      forkedExecutionId: forkedRecord.execution.id,
      branch: worktreeInfo.branch,
      worktreeDir: worktreeInfo.worktreeDir,
    });

    (this.executionEngine as any).pushEvent?.(forkedRecord, 'execution.forked', {
      checkpointId,
      parentExecutionId: parentRecord.execution.id,
      forkedExecutionId: forkedRecord.execution.id,
      branch: worktreeInfo.branch,
      worktreeDir: worktreeInfo.worktreeDir,
    });

    return {
      forkedExecutionId: forkedRecord.execution.id,
      parentExecutionId: parentRecord.execution.id,
      checkpointId,
      forkedWorktreePath: worktreeInfo.worktreeDir,
      branch: worktreeInfo.branch,
      workspaceRevision: checkpoint.workspaceRevision,
    };
  }

  /**
   * Rolls back an execution's workspace and state to a specific checkpoint.
   * Restores:
   * - physical byte state of files
   * - workspace revision
   * - context compiler base state
   * - verification expectation state
   * Rejects invalid rollback targets.
   */
  public async rollback(
    executionId: string,
    checkpointId: string,
  ): Promise<RollbackResult> {
    const record = await this.executionEngine.get(executionId);
    if (!record) {
      throw new Error(`Execution '${executionId}' not found`);
    }

    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) {
      // Record rejected event
      (this.executionEngine as any).pushEvent?.(record, 'execution.rollback.rejected', {
        executionId,
        checkpointId,
        reason: `Checkpoint '${checkpointId}' not found`,
      });
      throw new Error(`Checkpoint '${checkpointId}' not found`);
    }

    // Verify checkpoint belongs to this execution or its ancestor
    if (checkpoint.executionId !== executionId && record.execution.parentExecutionId !== checkpoint.executionId) {
      (this.executionEngine as any).pushEvent?.(record, 'execution.rollback.rejected', {
        executionId,
        checkpointId,
        reason: `Checkpoint '${checkpointId}' belongs to execution '${checkpoint.executionId}', not '${executionId}'`,
      });
      throw new Error(
        `Invalid rollback target: checkpoint '${checkpointId}' does not belong to execution '${executionId}'`,
      );
    }

    const workspaceRoot = record.execution.workspaceRoot ?? this.defaultWorkspaceRoot;

    // Restore physical files
    const filesRestored = await this.restoreSnapshotToDirectory(
      workspaceRoot,
      checkpoint.worktreeState.filesSnapshot,
    );

    // Restore workspace revision
    if (!record.workspaceState) {
      record.workspaceState = {
        workspaceId: executionId,
        revision: checkpoint.workspaceRevision,
        updatedAt: new Date(),
      };
    } else {
      record.workspaceState.revision = checkpoint.workspaceRevision;
      record.workspaceState.updatedAt = new Date();
    }

    // Invalidate / restore verification evidence
    if (record.evidence) {
      record.evidence = record.evidence.filter(
        (e) => e.revision <= checkpoint.workspaceRevision,
      );
    }

    // Restore mutation history
    if (record.mutationHistory) {
      record.mutationHistory = record.mutationHistory.filter(
        (m) => m.revision <= checkpoint.workspaceRevision,
      );
    }

    // Detect irreversible side effects that occurred after the checkpoint
    const irreversibleSideEffects: import('../types/index.js').IrreversibleSideEffectReport[] = [];
    const checkpointTimestamp = checkpoint.createdAt.getTime();
    for (const toolCall of record.toolCalls ?? []) {
      const toolTime = toolCall.at instanceof Date ? toolCall.at.getTime() : new Date(toolCall.at).getTime();
      if (toolTime >= checkpointTimestamp) {
        const isIrreversible =
          toolCall.tool === 'shell' ||
          toolCall.tool === 'terminal_send' ||
          toolCall.tool === 'web_search' ||
          toolCall.tool === 'web_fetch' ||
          (toolCall.provenance?.sideEffectClass === 'NON_IDEMPOTENT_WRITE');

        if (isIrreversible) {
          irreversibleSideEffects.push({
            tool: toolCall.tool,
            callId: toolCall.callId ?? toolCall.id,
            sideEffectClass: (toolCall.provenance?.sideEffectClass as string) ?? 'NON_IDEMPOTENT_SIDE_EFFECT',
            description: `Tool '${toolCall.tool}' executed with potentially irreversible external side effect`,
            at: toolCall.at instanceof Date ? toolCall.at : new Date(toolCall.at),
          });
        }
      }
    }

    // Emit rollback event
    (this.executionEngine as any).pushEvent?.(record, 'execution.rollback.completed', {
      executionId,
      checkpointId,
      restoredRevision: checkpoint.workspaceRevision,
      filesRestored,
      irreversibleSideEffectsCount: irreversibleSideEffects.length,
      irreversibleSideEffects,
    });

    return {
      executionId,
      checkpointId,
      restoredRevision: checkpoint.workspaceRevision,
      filesRestored,
      irreversibleSideEffects: irreversibleSideEffects.length > 0 ? irreversibleSideEffects : undefined,
      success: true,
    };
  }

  /**
   * Merges an isolated fork branch back into the parent project root.
   */
  public async mergeFork(
    forkResult: ForkExecutionResult,
    targetBranch?: string,
  ): Promise<WorktreeMergeResult> {
    const parentRecord = await this.executionEngine.get(forkResult.parentExecutionId);
    const parentWorkspace = parentRecord?.execution.workspaceRoot ?? this.defaultWorkspaceRoot;

    const isGit = await this.worktreeManager.isGitRepo(parentWorkspace);
    if (isGit) {
      return this.worktreeManager.mergeBranch(
        parentWorkspace,
        forkResult.branch,
        targetBranch,
      );
    }

    // Non-git fallback: copy modified files from forked worktree to parent workspace
    const forkedSnapshot = await this.snapshotWorkspaceFiles(forkResult.forkedWorktreePath);
    for (const [relPath, content] of Object.entries(forkedSnapshot)) {
      const destPath = path.join(parentWorkspace, relPath);
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      await fs.writeFile(destPath, content, 'utf8');
    }

    return {
      success: true,
      mergedBranch: forkResult.branch,
      targetBranch: 'main',
    };
  }

  // --- Snapshot Helpers ---

  private async snapshotWorkspaceFiles(workspaceRoot: string): Promise<Record<string, string>> {
    const snapshot: Record<string, string> = {};
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (
          entry.name === '.git' ||
          entry.name === 'node_modules' ||
          entry.name === '.wazir'
        ) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const relPath = path.relative(workspaceRoot, fullPath);
          try {
            const content = await fs.readFile(fullPath, 'utf8');
            snapshot[relPath] = content;
          } catch {
            // ignore binary or unreadable files
          }
        }
      }
    };

    await walk(workspaceRoot);
    return snapshot;
  }

  private async restoreSnapshotToDirectory(
    dir: string,
    snapshot: Record<string, string>,
  ): Promise<string[]> {
    // 1. Remove files currently in dir that are not in snapshot
    const currentFiles = await this.snapshotWorkspaceFiles(dir);
    for (const currentRelPath of Object.keys(currentFiles)) {
      if (!(currentRelPath in snapshot)) {
        const fullPath = path.join(dir, currentRelPath);
        await fs.rm(fullPath, { force: true }).catch(() => {});
      }
    }

    // 2. Restore/write all files in snapshot
    const restored: string[] = [];
    for (const [relPath, content] of Object.entries(snapshot)) {
      const fullPath = path.join(dir, relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf8');
      restored.push(relPath);
    }

    return restored;
  }
}
