import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type {
  AgentContextCompressor,
  CompactionErrorCode,
  CompactionMetrics,
  CompactionRequest,
  CompactionResult,
  ContextCompactionConfig,
  ContextPart,
  ContextReserve,
  ContextSnapshot,
  OffloadedArtifact,
  StructuredCompactionSummary,
} from '../types/context.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { ExecutionRecord } from '../types/execution.js';
import {
  computeUsableBudget,
  computeUtilization,
  deduplicateContextParts,
  estimateTokens,
  tokensForPart,
} from './contextCompiler.js';

export const STRUCTURED_SUMMARY_SCHEMA = {
  type: 'object',
  required: [
    'objective',
    'requirements',
    'decisions',
    'files',
    'currentState',
    'workspaceRevision',
    'verification',
    'errors',
    'importantSymbols',
    'toolArtifacts',
    'remainingWork',
    'constraints',
    'provenance',
  ],
  properties: {
    objective: { type: 'string' },
    requirements: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    files: {
      type: 'object',
      required: ['read', 'modified', 'created'],
      properties: {
        read: { type: 'array', items: { type: 'string' } },
        modified: { type: 'array', items: { type: 'string' } },
        created: { type: 'array', items: { type: 'string' } },
      },
    },
    currentState: { type: 'string' },
    workspaceRevision: { type: 'number' },
    verification: {
      type: 'object',
      required: ['build', 'tests', 'revision'],
      properties: {
        build: { type: 'string' },
        tests: { type: 'string' },
        revision: { type: 'number' },
      },
    },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fingerprint', 'status', 'summary'],
        properties: {
          fingerprint: { type: 'string' },
          status: { type: 'string', enum: ['resolved', 'active'] },
          summary: { type: 'string' },
        },
      },
    },
    importantSymbols: { type: 'array', items: { type: 'string' } },
    toolArtifacts: { type: 'array', items: { type: 'string' } },
    remainingWork: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    provenance: {
      type: 'object',
      required: ['compactedRange', 'createdAt'],
      properties: {
        compactedRange: { type: 'string' },
        createdAt: { type: 'string' },
      },
    },
  },
  additionalProperties: true,
};

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateSummary = ajv.compile<StructuredCompactionSummary>(STRUCTURED_SUMMARY_SCHEMA);

export interface SummarizerFn {
  (
    historyToCompress: ContextPart[],
    authoritative: Partial<StructuredCompactionSummary>,
  ): Promise<StructuredCompactionSummary | string>;
}

export interface ContextCompactionServiceOptions {
  engine?: ExecutionEngine;
  summarizer?: SummarizerFn;
  config?: ContextCompactionConfig;
  defaultReserves?: ContextReserve;
}

/**
 * Production-grade Layer 2 Semantic Context Compressor.
 *
 * Implements AgentContextCompressor with:
 * - Immutable generation-based snapshots (prevents race conditions with active model requests)
 * - Strict JSON Schema validation for summaries (fail-safe: previous snapshot preserved)
 * - Separation of authoritatively-owned controller facts from model narrative
 * - Strict protection of PINNED context (system instructions, task requirements, policy)
 * - Tail preservation for recent interaction turns
 * - Reclaim threshold verification
 */
export class ContextCompactionService implements AgentContextCompressor {
  private readonly engine?: ExecutionEngine;
  private readonly summarizer?: SummarizerFn;
  private readonly config: Required<ContextCompactionConfig>;
  private readonly defaultReserves: ContextReserve;
  private readonly snapshotsByExecution = new Map<string, ContextSnapshot[]>();
  private readonly compactionLocks = new Set<string>();

  constructor(options: ContextCompactionServiceOptions = {}) {
    this.engine = options.engine;
    this.summarizer = options.summarizer;
    this.config = {
      enabled: options.config?.enabled ?? true,
      autoThreshold: options.config?.autoThreshold ?? 0.75,
      targetUtilization: options.config?.targetUtilization ?? 0.45,
      preserveRecentTailRatio: options.config?.preserveRecentTailRatio ?? 0.5,
      minimumTokensToReclaim: options.config?.minimumTokensToReclaim ?? 4000,
    };
    this.defaultReserves = options.defaultReserves ?? {
      outputTokens: 8000,
      toolSchemaTokens: 5000,
      safetyTokens: 5000,
    };
  }

  /**
   * Returns the latest snapshot for an execution, or undefined.
   */
  getLatestSnapshot(executionId: string): ContextSnapshot | undefined {
    const list = this.snapshotsByExecution.get(executionId);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  /**
   * Registers a snapshot for an execution.
   */
  registerSnapshot(snapshot: ContextSnapshot): void {
    const list = this.snapshotsByExecution.get(snapshot.executionId) ?? [];
    list.push(snapshot);
    this.snapshotsByExecution.set(snapshot.executionId, list);
  }

  /**
   * Creates and registers an initial ContextSnapshot (generation 1) for a new task.
   */
  createInitialSnapshot(params: {
    executionId: string;
    modelId: string;
    effectiveContextWindow: number;
    parts: ContextPart[];
    artifactReferences?: OffloadedArtifact[];
  }): ContextSnapshot {
    const pinned: ContextPart[] = [];
    const active: ContextPart[] = [];
    const compressible: ContextPart[] = [];

    for (const part of params.parts) {
      if (part.category === 'PINNED' || part.kind === 'system' || part.kind === 'task') {
        pinned.push({ ...part, category: 'PINNED' });
      } else if (part.category === 'ACTIVE' || part.priority === 'critical') {
        active.push({ ...part, category: 'ACTIVE' });
      } else {
        compressible.push({ ...part, category: part.category ?? 'COMPRESSIBLE' });
      }
    }

    const { deduplicated } = deduplicateContextParts([...pinned, ...active, ...compressible]);
    const estimatedTokens = deduplicated.reduce((sum, p) => sum + tokensForPart(p), 0);

    const snapshot: ContextSnapshot = {
      id: `snap-${randomUUID().slice(0, 8)}`,
      executionId: params.executionId,
      generation: 1,
      modelId: params.modelId,
      effectiveContextWindow: params.effectiveContextWindow,
      estimatedTokens,
      createdAt: new Date(),
      pinned,
      active,
      compressible,
      tail: [],
      artifactReferences: params.artifactReferences ?? [],
    };

    this.registerSnapshot(snapshot);
    return snapshot;
  }

  /**
   * Evaluates whether an execution has crossed the automatic compaction threshold.
   */
  shouldAutoCompact(
    executionId: string,
    reserveOverride?: Partial<ContextReserve>,
  ): { shouldCompact: boolean; utilization: number; estimatedTokens: number; usableBudget: number } {
    const snapshot = this.getLatestSnapshot(executionId);
    if (!snapshot || !this.config.enabled) {
      return { shouldCompact: false, utilization: 0, estimatedTokens: 0, usableBudget: 0 };
    }

    const reserves: ContextReserve = {
      outputTokens: reserveOverride?.outputTokens ?? this.defaultReserves.outputTokens,
      toolSchemaTokens: reserveOverride?.toolSchemaTokens ?? this.defaultReserves.toolSchemaTokens,
      safetyTokens: reserveOverride?.safetyTokens ?? this.defaultReserves.safetyTokens,
    };

    const usableBudget = computeUsableBudget({
      effectiveContextTokens: snapshot.effectiveContextWindow,
      reserveOutputTokens: reserves.outputTokens,
      reserveToolSchemaTokens: reserves.toolSchemaTokens,
      reserveSafetyTokens: reserves.safetyTokens,
    });

    const utilization = computeUtilization(snapshot.estimatedTokens, usableBudget);
    const shouldCompact = utilization >= this.config.autoThreshold;

    return {
      shouldCompact,
      utilization,
      estimatedTokens: snapshot.estimatedTokens,
      usableBudget,
    };
  }

  /**
   * Executes a compaction request.
   *
   * Invariant: Does NOT modify durable execution history.
   * Produces a new immutable ContextSnapshot on success.
   * On any failure, preserves previous valid snapshot untouched.
   */
  async compact(request: CompactionRequest): Promise<CompactionResult> {
    const executionId = request.executionId;
    const currentSnapshot = this.getLatestSnapshot(executionId);

    if (!currentSnapshot) {
      return {
        status: 'failed',
        error: `No context snapshot found for execution: ${executionId}`,
        errorCode: 'CONTEXT_COMPACTION_FAILED',
      };
    }

    // Concurrency lock per execution to prevent conflicting parallel compactions
    if (this.compactionLocks.has(executionId)) {
      return {
        status: 'failed',
        error: `Compaction already in progress for execution: ${executionId}`,
        errorCode: 'CONTEXT_GENERATION_CONFLICT',
      };
    }
    this.compactionLocks.add(executionId);

    const startTime = Date.now();

    try {
      // 1. Deduplicate model context first
      const { deduplicated, removedCount } = deduplicateContextParts([
        ...currentSnapshot.pinned,
        ...currentSnapshot.active,
        ...currentSnapshot.compressible,
        ...currentSnapshot.tail,
      ]);

      const beforeTokens = deduplicated.reduce((sum, p) => sum + tokensForPart(p), 0);

      // 2. Select compressible items vs preserved tail
      const compressibleItems = currentSnapshot.compressible.filter(p => p.category !== 'PINNED');
      if (compressibleItems.length === 0 && !request.force) {
        return {
          status: 'skipped',
          snapshotId: currentSnapshot.id,
          metrics: {
            trigger: request.trigger,
            reason: request.reason,
            beforeTokens,
            afterTokens: beforeTokens,
            tokensSaved: 0,
            messagesBefore: deduplicated.length,
            messagesAfter: deduplicated.length,
            offloadedArtifacts: currentSnapshot.artifactReferences.length,
            offloadedBytes: currentSnapshot.artifactReferences.reduce((s, a) => s + a.originalBytes, 0),
            compressionDurationMs: Date.now() - startTime,
            deduplicatedCount: removedCount,
          },
        };
      }

      // Preserve recent conversation tail based on preserveRecentTailRatio
      const tailCount = Math.max(1, Math.ceil(compressibleItems.length * this.config.preserveRecentTailRatio));
      const itemsToCompress = compressibleItems.slice(0, compressibleItems.length - tailCount);
      const preservedTail = [
        ...compressibleItems.slice(compressibleItems.length - tailCount),
        ...currentSnapshot.tail,
      ];

      // If nothing eligible to compress and not forced, skip
      if (itemsToCompress.length === 0 && !request.force) {
        return {
          status: 'skipped',
          snapshotId: currentSnapshot.id,
          metrics: {
            trigger: request.trigger,
            reason: request.reason,
            beforeTokens,
            afterTokens: beforeTokens,
            tokensSaved: 0,
            messagesBefore: deduplicated.length,
            messagesAfter: deduplicated.length,
            offloadedArtifacts: currentSnapshot.artifactReferences.length,
            offloadedBytes: currentSnapshot.artifactReferences.reduce((s, a) => s + a.originalBytes, 0),
            compressionDurationMs: Date.now() - startTime,
            deduplicatedCount: removedCount,
          },
        };
      }

      // 3. Extract authoritative facts from execution record (controller is source of truth)
      const record = this.engine ? this.safeGetRecord(executionId) : undefined;
      const authoritative = this.extractAuthoritativeState(record, itemsToCompress);

      // 4. Run summarization (pluggable or deterministic fallback)
      let summaryObj: StructuredCompactionSummary;
      try {
        if (this.summarizer) {
          const raw = await this.summarizer(itemsToCompress, authoritative);
          if (typeof raw === 'string') {
            summaryObj = JSON.parse(raw);
          } else {
            summaryObj = raw;
          }
        } else {
          summaryObj = this.deterministicStructuredSummary(itemsToCompress, authoritative);
        }
      } catch (err) {
        return {
          status: 'failed',
          error: `Summarizer execution failed: ${err instanceof Error ? err.message : String(err)}`,
          errorCode: 'CONTEXT_COMPACTION_FAILED',
        };
      }

      // Merge controller authoritative facts (controller always overrides LLM hallucinations)
      summaryObj.workspaceRevision = authoritative.workspaceRevision ?? summaryObj.workspaceRevision;
      summaryObj.verification = authoritative.verification ?? summaryObj.verification;
      summaryObj.files = {
        read: Array.from(new Set([...(authoritative.files?.read ?? []), ...(summaryObj.files?.read ?? [])])),
        modified: Array.from(new Set([...(authoritative.files?.modified ?? []), ...(summaryObj.files?.modified ?? [])])),
        created: Array.from(new Set([...(authoritative.files?.created ?? []), ...(summaryObj.files?.created ?? [])])),
      };

      // 5. Validate summary against JSON Schema
      const isValid = validateSummary(summaryObj);
      if (!isValid) {
        const errors = validateSummary.errors?.map(e => `${e.instancePath} ${e.message}`).join(', ');
        return {
          status: 'failed',
          error: `Structured summary failed schema validation: ${errors}`,
          errorCode: 'CONTEXT_SUMMARY_INVALID',
        };
      }

      // 6. Format compressed summary as a model-visible ContextPart
      const summaryText = this.formatStructuredSummary(summaryObj);
      const summaryPart: ContextPart = {
        kind: 'memory',
        label: 'Historical Context Summary',
        content: summaryText,
        priority: 'important',
        category: 'COMPRESSIBLE',
        tokens: estimateTokens(summaryText),
      };

      // 7. Assemble parts for new snapshot
      const newPinned = [...currentSnapshot.pinned];
      const newActive = [...currentSnapshot.active];
      const newCompressible = [summaryPart];
      const newTail = preservedTail;

      const finalModelParts = [...newPinned, ...newActive, ...newCompressible, ...newTail];
      const afterTokens = finalModelParts.reduce((sum, p) => sum + tokensForPart(p), 0);
      const tokensSaved = Math.max(0, beforeTokens - afterTokens);

      // Check minimumTokensToReclaim unless forced
      if (!request.force && tokensSaved < this.config.minimumTokensToReclaim) {
        return {
          status: 'skipped',
          snapshotId: currentSnapshot.id,
          metrics: {
            trigger: request.trigger,
            reason: `Reclaimed ${tokensSaved} tokens which is below threshold of ${this.config.minimumTokensToReclaim}`,
            beforeTokens,
            afterTokens,
            tokensSaved,
            messagesBefore: deduplicated.length,
            messagesAfter: finalModelParts.length,
            offloadedArtifacts: currentSnapshot.artifactReferences.length,
            offloadedBytes: currentSnapshot.artifactReferences.reduce((s, a) => s + a.originalBytes, 0),
            compressionDurationMs: Date.now() - startTime,
            deduplicatedCount: removedCount,
          },
        };
      }

      // 8. Create new immutable ContextSnapshot
      const newSnapshot: ContextSnapshot = {
        id: `snap-${randomUUID().slice(0, 8)}`,
        executionId,
        generation: currentSnapshot.generation + 1,
        modelId: currentSnapshot.modelId,
        effectiveContextWindow: currentSnapshot.effectiveContextWindow,
        estimatedTokens: afterTokens,
        createdAt: new Date(),
        pinned: newPinned,
        active: newActive,
        compressible: newCompressible,
        compressed: [summaryPart],
        tail: newTail,
        artifactReferences: [...currentSnapshot.artifactReferences],
        compactionMetrics: {
          trigger: request.trigger,
          reason: request.reason,
          beforeTokens,
          afterTokens,
          tokensSaved,
          messagesBefore: deduplicated.length,
          messagesAfter: finalModelParts.length,
          offloadedArtifacts: currentSnapshot.artifactReferences.length,
          offloadedBytes: currentSnapshot.artifactReferences.reduce((s, a) => s + a.originalBytes, 0),
          compressionDurationMs: Date.now() - startTime,
          deduplicatedCount: removedCount,
        },
      };

      this.registerSnapshot(newSnapshot);

      return {
        status: 'compacted',
        snapshotId: newSnapshot.id,
        metrics: newSnapshot.compactionMetrics,
      };
    } finally {
      this.compactionLocks.delete(executionId);
    }
  }

  private safeGetRecord(executionId: string): ExecutionRecord | undefined {
    try {
      return this.engine?.require(executionId);
    } catch {
      return undefined;
    }
  }

  private extractAuthoritativeState(
    record: ExecutionRecord | undefined,
    parts: ContextPart[],
  ): Partial<StructuredCompactionSummary> {
    const workspaceRevision = record?.workspaceState?.revision ?? 0;

    const modified = new Set<string>(record?.filesChanged ?? []);
    const read = new Set<string>();
    const created = new Set<string>();

    for (const part of parts) {
      if (part.label.includes('read') || part.content.includes('read_file')) {
        const matches = part.content.match(/(?:path|file|reading)\s*[:=]?\s*["']?([^\s"'\n]+)/gi);
        if (matches) {
          for (const m of matches) {
            const clean = m.replace(/^(?:path|file|reading)\s*[:=]?\s*["']?/i, '').replace(/["']?$/, '');
            if (clean && !clean.includes(' ')) read.add(clean);
          }
        }
      }
    }

    const verification = {
      build: (record?.checks?.find(c => c.name === 'build')?.ok ? 'passed' : record?.checks?.find(c => c.name === 'build') ? 'failed' : 'unknown') as 'passed' | 'failed' | 'unknown',
      tests: (record?.checks?.find(c => c.name === 'test')?.ok ? 'passed' : record?.checks?.find(c => c.name === 'test') ? 'failed' : 'unknown') as 'passed' | 'failed' | 'unknown',
      revision: workspaceRevision,
    };

    const errors: Array<{ fingerprint: string; status: 'resolved' | 'active'; summary: string }> = [];
    if (record?.errors) {
      for (let i = 0; i < record.errors.length; i++) {
        const err = record.errors[i];
        errors.push({
          fingerprint: `err-${i + 1}`,
          status: 'resolved',
          summary: err.slice(0, 100),
        });
      }
    }

    const taskDesc = record?.task?.title || record?.task?.input || 'Complete task';
    return {
      objective: taskDesc,
      requirements: taskDesc ? [taskDesc] : [],
      workspaceRevision,
      verification,
      files: {
        read: Array.from(read),
        modified: Array.from(modified),
        created: Array.from(created),
      },
      errors,
    };
  }

  private deterministicStructuredSummary(
    items: ContextPart[],
    authoritative: Partial<StructuredCompactionSummary>,
  ): StructuredCompactionSummary {
    const decisions: string[] = [];
    const importantSymbols: string[] = [];
    const toolArtifacts: string[] = [];
    const remainingWork: string[] = [];
    const constraints: string[] = [];

    for (const item of items) {
      if (item.content.includes('[Tool output compacted]')) {
        const artMatch = item.content.match(/Artifact:\s*([^\s\n]+)/);
        if (artMatch) toolArtifacts.push(artMatch[1]);
      }
      if (item.label) decisions.push(`Step: ${item.label}`);
    }

    return {
      objective: authoritative.objective ?? 'Complete task',
      requirements: authoritative.requirements ?? ['Fulfill user request'],
      decisions: decisions.slice(0, 10),
      files: authoritative.files ?? { read: [], modified: [], created: [] },
      currentState: `Compacted ${items.length} historical turns at workspace revision ${authoritative.workspaceRevision ?? 0}`,
      workspaceRevision: authoritative.workspaceRevision ?? 0,
      verification: authoritative.verification ?? {
        build: 'unknown',
        tests: 'unknown',
        revision: authoritative.workspaceRevision ?? 0,
      },
      errors: authoritative.errors ?? [],
      importantSymbols,
      toolArtifacts,
      remainingWork,
      constraints,
      provenance: {
        compactedRange: `turns 1-${items.length}`,
        createdAt: new Date().toISOString(),
      },
    };
  }

  private formatStructuredSummary(summary: StructuredCompactionSummary): string {
    return [
      '### Context Compaction Summary',
      `**Objective**: ${summary.objective}`,
      `**Current State**: ${summary.currentState}`,
      `**Workspace Revision**: ${summary.workspaceRevision}`,
      `**Verification**: Build: ${summary.verification.build}, Tests: ${summary.verification.tests}`,
      `**Files Touched**: Modified: [${summary.files.modified.join(', ')}], Read: [${summary.files.read.join(', ')}]`,
      summary.errors.length > 0
        ? `**Errors**: ${summary.errors.map(e => `[${e.status}] ${e.summary}`).join('; ')}`
        : '**Errors**: None active',
      summary.toolArtifacts.length > 0
        ? `**Offloaded Artifacts**: ${summary.toolArtifacts.join(', ')}`
        : '',
      `**Compacted Range**: ${summary.provenance.compactedRange} (${summary.provenance.createdAt})`,
    ]
      .filter(Boolean)
      .join('\n');
  }
}
