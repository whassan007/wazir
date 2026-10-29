import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type {
  ExecutionCheckpoint,
  CheckpointCreateOptions,
  ForkExecutionResult,
  RollbackResult,
  ExecutionRecord,
  ToolCallCheckpoint,
  PolicyRequirements,
} from '../types/index.js';
import {
  PORTABLE_CHECKPOINT_SCHEMA_VERSION,
  computeWorkspaceContentDigest,
  computePortableCheckpointDigest,
  validatePortableCheckpoint,
  classifyPortableResumability,
  redactPortableText,
  redactPortableValue,
  type PortableBudgetState,
  type PortableRemainingBudget,
  type PortableActionSummary,
  type PortableCheckpointEnvelope,
} from '../types/portableCheckpoint.js';
import { extractToolCheckpoints } from './executionRecovery.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { WorktreeManager, WorktreeMergeResult } from './worktreeManager.js';
import type { ProvenanceManager } from './provenanceManager.js';
import { injectFault, type KeyValueStore } from '@wazir/shared';

export interface ExportPortableCheckpointOptions {
  sourceHarnessId?: string;
  targetHarnessId?: string;
  pendingActions?: string[];
  budgetLimits?: PortableRemainingBudget;
}

export interface ImportPortableCheckpointOptions {
  targetWorkspaceRoot?: string;
}

const LOCAL_RUNTIME_IDS = new Set([
  'ollama',
  'lmstudio',
  'local',
  'vllm',
  'mlx',
  'llamacpp',
  'llama.cpp',
]);

function isLocalRuntimeId(runtimeId?: string, localOnlyPolicy?: boolean): boolean {
  if (localOnlyPolicy === true) return true;
  if (!runtimeId) return false;
  const normalized = runtimeId.toLowerCase();
  return (
    LOCAL_RUNTIME_IDS.has(normalized) ||
    normalized.startsWith('ollama') ||
    normalized.startsWith('lmstudio') ||
    normalized.startsWith('local')
  );
}

export interface CheckpointServiceOptions {
  /** Durable store owned by the host. Without it checkpoints are explicitly ephemeral. */
  store?: KeyValueStore;
  executionEngine: ExecutionEngine;
  worktreeManager: WorktreeManager;
  provenanceManager?: ProvenanceManager;
  defaultWorkspaceRoot?: string;
  lazy?: boolean;
}

export class CheckpointService {
  private _ready?: Promise<void>;
  private readonly store?: KeyValueStore;
  private readonly checkpoints = new Map<string, ExecutionCheckpoint>();
  private readonly executionEngine: ExecutionEngine;
  private readonly worktreeManager: WorktreeManager;
  private readonly provenanceManager?: ProvenanceManager;
  private readonly defaultWorkspaceRoot: string;

  get ready(): Promise<void> {
    this._ready ??= this.restore();
    return this._ready;
  }

  constructor(options: CheckpointServiceOptions) {
    this.store = options.store;
    this.executionEngine = options.executionEngine;
    this.worktreeManager = options.worktreeManager;
    this.provenanceManager = options.provenanceManager;
    this.defaultWorkspaceRoot = options.defaultWorkspaceRoot ?? process.cwd();
    if (!options.lazy) {
      void this.ready;
    }
  }

  private async restore(): Promise<void> {
    if (!this.store) return;
    for (const { key, value } of await this.store.list('checkpoint/')) {
      const envelope = value as { version: number; digest: string; checkpoint: ExecutionCheckpoint };
      const checkpoint = envelope?.checkpoint;
      if (envelope?.version !== 1 || !checkpoint || key !== `checkpoint/${checkpoint.id}` ||
          typeof checkpoint.executionId !== 'string' || !Number.isSafeInteger(checkpoint.workspaceRevision) ||
          !checkpoint.worktreeState?.filesSnapshot || !Number.isFinite(new Date(checkpoint.createdAt).getTime())) {
        throw new Error(`INVALID_CHECKPOINT: ${key}`);
      }
      if (this.computeDigest(checkpoint) !== envelope.digest) throw new Error(`CHECKPOINT_DIGEST_MISMATCH: ${key}`);
      checkpoint.createdAt = new Date(checkpoint.createdAt);
      this.checkpoints.set(checkpoint.id, checkpoint);
    }
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
    await this.ready;
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

    await injectFault('DURING_CHECKPOINT', { executionId, checkpointId, workspaceRevision: currentRevision });

    // A successful return means the snapshot is committed, not merely cached.
    await this.store?.put(`checkpoint/${checkpointId}`, {
      version: 1, digest: this.computeDigest(checkpoint), checkpoint,
    });
    this.checkpoints.set(checkpointId, structuredClone(checkpoint));

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
    const checkpoint = this.checkpoints.get(checkpointId);
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  /**
   * Lists checkpoints for an execution.
   */
  public listCheckpoints(executionId?: string): ExecutionCheckpoint[] {
    const all = structuredClone(Array.from(this.checkpoints.values()));
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
    await this.ready;
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

    await injectFault('DURING_FORK', { checkpointId, parentExecutionId: parentRecord.execution.id, forkedExecutionId: forkedRecord.execution.id, worktreeDir: worktreeInfo.worktreeDir });

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
    await this.ready;
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

    await injectFault('DURING_ROLLBACK', { executionId, checkpointId, restoredRevision: checkpoint.workspaceRevision });

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
          entry.name === '.wazir' ||
          entry.name === '.env' ||
          (entry.name.startsWith('.env.') && entry.name !== '.env.example')
        ) {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
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
    // Validate the entire snapshot before deleting or replacing any file. A remote
    // digest verifies content integrity, not authority to write outside the workspace.
    for (const [relative, content] of Object.entries(snapshot)) {
      const parts = relative.split('/');
      if (typeof content !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') ||
          path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
          parts.some(p => !p || p === '.' || p === '..' || ['.git', '.wazir', 'node_modules'].includes(p))) {
        throw new Error(`UNSAFE_CHECKPOINT_PATH: ${relative}`);
      }
      let candidate = path.resolve(dir);
      for (const part of parts) {
        candidate = path.join(candidate, part);
        try {
          if ((await fs.lstat(candidate)).isSymbolicLink()) throw new Error(`UNSAFE_CHECKPOINT_PATH: symlink ${relative}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
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

  /**
   * Computes deterministic SHA-256 digest of a checkpoint's filesSnapshot and revision.
   */
  public computeDigest(checkpoint: ExecutionCheckpoint): string {
    const hash = createHash('sha256');
    const sortedEntries = Object.entries(checkpoint.worktreeState.filesSnapshot ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [filePath, content] of sortedEntries) {
      hash.update(JSON.stringify([filePath, content]));
    }
    hash.update(`rev:${checkpoint.workspaceRevision}\n`);
    return hash.digest('hex');
  }

  /**
   * Materializes an immutable checkpoint onto a remote worker directory,
   * verifying content-addressed digest integrity before allowing execution.
   */
  public async materializeOnTarget(
    targetDir: string,
    checkpoint: ExecutionCheckpoint,
    expectedDigest?: string,
  ): Promise<{ materialized: boolean; digest: string; filesRestored: string[] }> {
    const currentDigest = this.computeDigest(checkpoint);
    if (expectedDigest && currentDigest !== expectedDigest) {
      throw new Error(
        `CHECKPOINT_MATERIALIZATION_FAILED: Digest mismatch. Expected '${expectedDigest}', got '${currentDigest}'`,
      );
    }

    const filesRestored = await this.restoreSnapshotToDirectory(
      targetDir,
      checkpoint.worktreeState.filesSnapshot ?? {},
    );

    return {
      materialized: true,
      digest: currentDigest,
      filesRestored,
    };
  }

  /**
   * Exports a checkpoint as a cryptographically bound `PortableCheckpointEnvelope`
   * suitable for cross-harness handoff, remote worker transport, or crash recovery.
   */
  public async exportPortableCheckpoint(
    checkpointId: string,
    options: ExportPortableCheckpointOptions = {},
  ): Promise<PortableCheckpointEnvelope> {
    await this.ready;
    const checkpoint = this.getCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint '${checkpointId}' not found`);
    }

    const record = await this.executionEngine.get(checkpoint.executionId);
    const portableMeta = (checkpoint.metadata?.portableEnvelope ?? {}) as Partial<PortableCheckpointEnvelope>;

    let allToolCheckpoints: ToolCallCheckpoint[] = [];
    if (record) {
      try {
        allToolCheckpoints = this.executionEngine.toolCheckpoints
          ? this.executionEngine.toolCheckpoints(checkpoint.executionId)
          : extractToolCheckpoints(record);
      } catch {
        allToolCheckpoints = extractToolCheckpoints(record);
      }
    }

    const completedActions: PortableActionSummary[] = [];
    const seenActionIds = new Set<string>();

    if (record) {
      for (const tc of record.toolCalls ?? []) {
        const rev =
          typeof tc.provenance?.workspaceRevision === 'number'
            ? tc.provenance.workspaceRevision
            : checkpoint.workspaceRevision;
        if (rev <= checkpoint.workspaceRevision) {
          const actionId = tc.callId ?? tc.id;
          seenActionIds.add(actionId);
          completedActions.push({
            actionId,
            kind: 'tool_call',
            summary: redactPortableText(
              `Tool '${tc.tool}' (${tc.ok ? 'completed' : 'failed'})${tc.output ? `: ${String(tc.output).slice(0, 200)}` : ''}`,
            ),
            toolName: tc.tool,
            workspaceRevision: rev,
            confirmed: Boolean(tc.ok && tc.failureClass !== 'TOOL_OUTCOME_UNKNOWN'),
            at: (tc.at instanceof Date ? tc.at : new Date(tc.at)).toISOString(),
          });
        }
      }

      for (const mut of record.mutationHistory ?? []) {
        if (mut.revision <= checkpoint.workspaceRevision) {
          const actionId = `mutation-${mut.revision}-${mut.path}`;
          if (!seenActionIds.has(actionId)) {
            seenActionIds.add(actionId);
            completedActions.push({
              actionId,
              kind: 'file_mutation',
              summary: redactPortableText(`File '${mut.path}' mutated at revision ${mut.revision}`),
              targetPath: mut.path,
              workspaceRevision: mut.revision,
              confirmed: true,
              at: (mut.at instanceof Date ? mut.at : new Date(mut.at)).toISOString(),
            });
          }
        }
      }

      for (const chk of record.checks ?? []) {
        const chkRev = chk.workspaceRevision ?? 0;
        if (chkRev <= checkpoint.workspaceRevision) {
          const actionId = `check-${chk.name}-${chkRev}`;
          if (!seenActionIds.has(actionId)) {
            seenActionIds.add(actionId);
            completedActions.push({
              actionId,
              kind: 'verification_check',
              summary: redactPortableText(
                `Verification check '${chk.name}' (${chk.ok ? 'PASS' : 'FAIL'}): ${chk.command}`,
              ),
              workspaceRevision: chkRev,
              confirmed: Boolean(chk.ok),
              at: checkpoint.createdAt.toISOString(),
            });
          }
        }
      }
    }

    const extraActions = (checkpoint.metadata?.completedActions ??
      portableMeta.completedActions ??
      []) as PortableActionSummary[];
    for (const act of extraActions) {
      if (act && typeof act.actionId === 'string' && !seenActionIds.has(act.actionId)) {
        seenActionIds.add(act.actionId);
        completedActions.push({
          ...act,
          summary: redactPortableText(act.summary ?? ''),
        });
      }
    }

    const rawUnresolved = [
      ...allToolCheckpoints.filter(
        (c) =>
          (c.state === 'STARTED' || c.state === 'OUTCOME_UNKNOWN') &&
          (c.workspaceRevision ?? 0) <= checkpoint.workspaceRevision,
      ),
      ...(((checkpoint.metadata?.unresolvedSideEffects ??
        portableMeta.unresolvedSideEffects ??
        []) as ToolCallCheckpoint[])),
    ];
    const seenUnresolvedCallIds = new Set<string>();
    const unresolvedSideEffects: ToolCallCheckpoint[] = [];
    for (const call of rawUnresolved) {
      if (!call || seenUnresolvedCallIds.has(call.callId)) continue;
      seenUnresolvedCallIds.add(call.callId);
      unresolvedSideEffects.push({
        ...call,
        startedAt: call.startedAt instanceof Date ? call.startedAt : new Date(call.startedAt),
        ...(call.finishedAt !== undefined
          ? { finishedAt: call.finishedAt instanceof Date ? call.finishedAt : new Date(call.finishedAt) }
          : {}),
        input: redactPortableValue(call.input),
      });
    }

    const metaConsumed = (checkpoint.metadata?.consumedBudget ??
      portableMeta.consumedBudget) as Partial<PortableBudgetState> | undefined;

    const tokensUsed =
      metaConsumed?.tokensUsed ??
      (record?.usage
        ? record.usage.total ?? (record.usage.input ?? 0) + (record.usage.output ?? 0)
        : checkpoint.contextSnapshot?.tokenCount ?? 0);

    const toolCallsUsed =
      metaConsumed?.toolCallsUsed ??
      (record ? Math.max(record.toolCalls.length, allToolCheckpoints.length) : 0);

    const modelCallsUsed =
      metaConsumed?.modelCallsUsed ??
      (record
        ? record.totalModelCalls ??
          record.events.filter(
            (e) =>
              (e.eventType ?? e.type) === 'generation.started' ||
              (e.eventType ?? e.type) === 'model.attempt.started',
          ).length
        : 0);

    let costUSD = 0;
    let costStatus: PortableBudgetState['costStatus'] = 'UNKNOWN';
    if (metaConsumed?.costStatus !== undefined) {
      costStatus = metaConsumed.costStatus;
      costUSD = metaConsumed.costUSD ?? 0;
    } else if (typeof checkpoint.metadata?.costUSD === 'number') {
      costUSD = checkpoint.metadata.costUSD;
      costStatus =
        (checkpoint.metadata?.costStatus as PortableBudgetState['costStatus'] | undefined) ??
        'ACTUAL';
    } else if (isLocalRuntimeId(record?.execution.runtimeId, record?.task?.policy?.localOnly)) {
      costUSD = 0;
      costStatus = 'ACTUAL';
    }

    let durationMs = metaConsumed?.durationMs ?? 0;
    if (metaConsumed?.durationMs === undefined && record) {
      const start = record.execution.startedAt ?? record.execution.createdAt;
      const end = record.execution.completedAt ?? checkpoint.createdAt;
      if (start) {
        durationMs = Math.max(0, new Date(end).getTime() - new Date(start).getTime());
      }
    }

    const consumedBudget: PortableBudgetState = {
      tokensUsed,
      toolCallsUsed,
      modelCallsUsed,
      costUSD,
      costStatus,
      durationMs,
    };

    const metaRemaining = (checkpoint.metadata?.remainingBudget ??
      portableMeta.remainingBudget) as PortableRemainingBudget | undefined;

    const computeRemaining = (
      limit: number | null | undefined,
      consumed: number,
      fallback: number | null | undefined,
    ): number | null => {
      if (limit !== undefined) {
        return limit === null ? null : Math.max(0, Number((limit - consumed).toFixed(6)));
      }
      if (fallback !== undefined && fallback !== null) {
        return Math.max(0, fallback);
      }
      return null;
    };

    const limits = options.budgetLimits;
    const defaultMaxModelCalls =
      limits?.maxModelCalls !== undefined
        ? limits.maxModelCalls
        : metaRemaining?.maxModelCalls === undefined && record?.task?.maxTurns !== undefined
          ? record.task.maxTurns
          : undefined;
    const defaultMaxDurationMs =
      limits?.maxDurationMs !== undefined
        ? limits.maxDurationMs
        : metaRemaining?.maxDurationMs === undefined &&
            record?.task?.policy?.maxExecutionTimeSeconds !== undefined
          ? record.task.policy.maxExecutionTimeSeconds * 1000
          : undefined;

    const remainingBudget: PortableRemainingBudget = {
      maxTokens: computeRemaining(
        limits?.maxTokens,
        consumedBudget.tokensUsed,
        metaRemaining?.maxTokens,
      ),
      maxToolCalls: computeRemaining(
        limits?.maxToolCalls,
        consumedBudget.toolCallsUsed,
        metaRemaining?.maxToolCalls,
      ),
      maxModelCalls: computeRemaining(
        defaultMaxModelCalls,
        consumedBudget.modelCallsUsed,
        metaRemaining?.maxModelCalls,
      ),
      maxCostUSD: computeRemaining(
        limits?.maxCostUSD,
        consumedBudget.costUSD,
        metaRemaining?.maxCostUSD,
      ),
      maxDurationMs: computeRemaining(
        defaultMaxDurationMs,
        consumedBudget.durationMs,
        metaRemaining?.maxDurationMs,
      ),
    };

    const policyContext: PolicyRequirements = redactPortableValue(
      structuredClone(
        record?.task?.policy ??
          (checkpoint.metadata?.policyContext as PolicyRequirements | undefined) ??
          portableMeta.policyContext ??
          {},
      ),
    );

    const status =
      record?.execution.status ??
      checkpoint.planState?.status ??
      (checkpoint.metadata?.status as string | undefined);

    const resumability = classifyPortableResumability({
      status,
      unresolvedSideEffects,
      remainingBudget,
    });

    const rawMetadata: Record<string, unknown> | undefined = checkpoint.metadata
      ? (() => {
          const copy = { ...checkpoint.metadata };
          delete copy.portableEnvelope;
          return Object.keys(copy).length > 0 ? redactPortableValue(copy) : undefined;
        })()
      : undefined;

    const workspaceContentDigest = computeWorkspaceContentDigest(
      checkpoint.worktreeState.filesSnapshot ?? {},
      checkpoint.workspaceRevision,
    );

    const pendingActions = (
      options.pendingActions ??
      (checkpoint.metadata?.pendingActions as string[] | undefined) ??
      portableMeta.pendingActions ??
      []
    ).map((a) => redactPortableText(String(a)));

    const filesChanged =
      record?.filesChanged && record.filesChanged.length > 0
        ? [...record.filesChanged]
        : portableMeta.filesChanged && portableMeta.filesChanged.length > 0
          ? [...portableMeta.filesChanged]
          : Object.keys(checkpoint.worktreeState.filesSnapshot ?? {}).sort();

    const jobId = record?.execution.jobId ?? checkpoint.planState?.jobId ?? portableMeta.jobId;
    const targetHarnessId =
      options.targetHarnessId ??
      (checkpoint.metadata?.targetHarnessId as string | undefined) ??
      portableMeta.targetHarnessId;
    const sourceModelId =
      record?.execution.modelId ??
      (checkpoint.metadata?.sourceModelId as string | undefined) ??
      portableMeta.sourceModelId;
    const sourceRuntimeId =
      record?.execution.runtimeId ??
      (checkpoint.metadata?.sourceRuntimeId as string | undefined) ??
      portableMeta.sourceRuntimeId;
    const sourceWorkerId =
      record?.execution.workerId ??
      (checkpoint.metadata?.sourceWorkerId as string | undefined) ??
      portableMeta.sourceWorkerId;

    const envelopeWithoutDigest: Omit<PortableCheckpointEnvelope, 'integrityDigest'> = {
      schemaVersion: PORTABLE_CHECKPOINT_SCHEMA_VERSION,
      executionId: checkpoint.executionId,
      taskId:
        record?.task?.id ??
        record?.execution.taskId ??
        (checkpoint.metadata?.taskId as string | undefined) ??
        portableMeta.taskId ??
        checkpoint.executionId,
      ...(jobId !== undefined ? { jobId } : {}),
      sourceHarnessId:
        options.sourceHarnessId ??
        (checkpoint.metadata?.sourceHarnessId as string | undefined) ??
        portableMeta.sourceHarnessId ??
        record?.execution.agentId ??
        'native',
      ...(targetHarnessId !== undefined ? { targetHarnessId } : {}),
      ...(sourceModelId !== undefined ? { sourceModelId } : {}),
      ...(sourceRuntimeId !== undefined ? { sourceRuntimeId } : {}),
      ...(sourceWorkerId !== undefined ? { sourceWorkerId } : {}),
      workspaceRevision: String(checkpoint.workspaceRevision),
      workspaceContentDigest,
      checkpointId: checkpoint.id,
      objective: redactPortableText(
        record?.task?.input ??
          (checkpoint.metadata?.objective as string | undefined) ??
          portableMeta.objective ??
          checkpoint.description ??
          '',
      ),
      completedActions,
      pendingActions,
      filesChanged,
      unresolvedSideEffects,
      verificationEvidenceIds: [...(checkpoint.verificationState?.evidenceIds ?? [])],
      consumedBudget,
      remainingBudget,
      policyContext,
      resumable: resumability.resumable,
      ...(resumability.nonResumableReason !== undefined
        ? { nonResumableReason: resumability.nonResumableReason }
        : {}),
      createdAt: checkpoint.createdAt.toISOString(),
      worktreeState: structuredClone(checkpoint.worktreeState),
      verificationState: structuredClone(checkpoint.verificationState),
      ...(checkpoint.contextSnapshot !== undefined
        ? { contextSnapshot: redactPortableValue(checkpoint.contextSnapshot) }
        : {}),
      ...(checkpoint.planState !== undefined
        ? { planState: redactPortableValue(checkpoint.planState) }
        : {}),
      ...(checkpoint.provenanceCursor !== undefined
        ? { provenanceCursor: checkpoint.provenanceCursor }
        : {}),
      ...(checkpoint.evidenceReferences !== undefined
        ? { evidenceReferences: structuredClone(checkpoint.evidenceReferences) }
        : {}),
      ...(checkpoint.parentCheckpointId !== undefined
        ? { parentCheckpointId: checkpoint.parentCheckpointId }
        : {}),
      ...(checkpoint.workspaceRoot !== undefined
        ? { workspaceRoot: checkpoint.workspaceRoot }
        : {}),
      ...(checkpoint.description !== undefined
        ? { description: redactPortableText(checkpoint.description) }
        : {}),
      ...(rawMetadata !== undefined ? { metadata: rawMetadata } : {}),
    };

    const integrityDigest = computePortableCheckpointDigest(envelopeWithoutDigest);

    return {
      ...envelopeWithoutDigest,
      integrityDigest,
    };
  }

  /**
   * Validates and imports a `PortableCheckpointEnvelope` into `CheckpointService`,
   * verifying schema version, `workspaceContentDigest`, and `integrityDigest`,
   * persisting to durable storage, and optionally materializing onto `targetWorkspaceRoot`.
   */
  public async importPortableCheckpoint(
    envelope: unknown,
    options: ImportPortableCheckpointOptions = {},
  ): Promise<ExecutionCheckpoint> {
    await this.ready;

    const validation = validatePortableCheckpoint(envelope);
    if (!validation.valid || !validation.envelope) {
      throw new Error(`INVALID_PORTABLE_CHECKPOINT: ${validation.errors.join('; ')}`);
    }

    const env = validation.envelope;
    if (!env.worktreeState || !env.worktreeState.filesSnapshot) {
      throw new Error(
        `INVALID_PORTABLE_CHECKPOINT: worktreeState.filesSnapshot is required to import a checkpoint`,
      );
    }

    const parsedRevision =
      typeof env.workspaceRevision === 'number'
        ? env.workspaceRevision
        : Number.parseInt(String(env.workspaceRevision), 10);
    if (!Number.isSafeInteger(parsedRevision) || parsedRevision < 0) {
      throw new Error(
        `INVALID_PORTABLE_CHECKPOINT: invalid workspaceRevision '${env.workspaceRevision}'`,
      );
    }

    const workspaceRoot =
      options.targetWorkspaceRoot ?? env.workspaceRoot ?? this.defaultWorkspaceRoot;

    const checkpoint: ExecutionCheckpoint = {
      id: env.checkpointId,
      executionId: env.executionId,
      ...(env.parentCheckpointId !== undefined
        ? { parentCheckpointId: env.parentCheckpointId }
        : {}),
      createdAt: new Date(env.createdAt),
      workspaceRevision: parsedRevision,
      workspaceRoot,
      worktreeState: structuredClone(env.worktreeState),
      contextSnapshot: env.contextSnapshot
        ? structuredClone(env.contextSnapshot)
        : { itemUris: [...env.filesChanged] },
      planState: env.planState
        ? structuredClone(env.planState)
        : { ...(env.jobId !== undefined ? { jobId: env.jobId } : {}) },
      verificationState: env.verificationState
        ? structuredClone(env.verificationState)
        : {
            revision: parsedRevision,
            evidenceIds: [...env.verificationEvidenceIds],
            checksPass: env.verificationEvidenceIds.length > 0,
          },
      ...(env.provenanceCursor !== undefined ? { provenanceCursor: env.provenanceCursor } : {}),
      ...(env.evidenceReferences !== undefined
        ? { evidenceReferences: structuredClone(env.evidenceReferences) }
        : {}),
      ...(env.description !== undefined ? { description: env.description } : {}),
      metadata: {
        ...(env.metadata ? structuredClone(env.metadata) : {}),
        portableEnvelope: {
          taskId: env.taskId,
          ...(env.jobId !== undefined ? { jobId: env.jobId } : {}),
          sourceHarnessId: env.sourceHarnessId,
          ...(env.targetHarnessId !== undefined ? { targetHarnessId: env.targetHarnessId } : {}),
          ...(env.sourceModelId !== undefined ? { sourceModelId: env.sourceModelId } : {}),
          ...(env.sourceRuntimeId !== undefined ? { sourceRuntimeId: env.sourceRuntimeId } : {}),
          ...(env.sourceWorkerId !== undefined ? { sourceWorkerId: env.sourceWorkerId } : {}),
          objective: env.objective,
          completedActions: structuredClone(env.completedActions),
          pendingActions: [...env.pendingActions],
          filesChanged: [...env.filesChanged],
          unresolvedSideEffects: structuredClone(env.unresolvedSideEffects),
          consumedBudget: structuredClone(env.consumedBudget),
          remainingBudget: structuredClone(env.remainingBudget),
          policyContext: structuredClone(env.policyContext),
          resumable: env.resumable,
          ...(env.nonResumableReason !== undefined
            ? { nonResumableReason: env.nonResumableReason }
            : {}),
          workspaceContentDigest: env.workspaceContentDigest,
          integrityDigest: env.integrityDigest,
        },
      },
    };

    const computedDigest = this.computeDigest(checkpoint);
    if (computedDigest !== env.workspaceContentDigest) {
      throw new Error(
        `INVALID_PORTABLE_CHECKPOINT: workspaceContentDigest mismatch. Expected '${env.workspaceContentDigest}', got '${computedDigest}'`,
      );
    }

    if (options.targetWorkspaceRoot) {
      await this.materializeOnTarget(
        options.targetWorkspaceRoot,
        checkpoint,
        env.workspaceContentDigest,
      );
    }

    await this.store?.put(`checkpoint/${checkpoint.id}`, {
      version: 1,
      digest: computedDigest,
      checkpoint,
    });
    this.checkpoints.set(checkpoint.id, structuredClone(checkpoint));

    return structuredClone(checkpoint);
  }
}
