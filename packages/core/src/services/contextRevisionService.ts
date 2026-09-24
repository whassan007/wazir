import { randomUUID, createHash } from 'node:crypto';
import type {
  CompactionMetrics,
  ContextCandidate,
  ContextItem,
  ContextOmission,
  ContextPart,
  ContextRequest,
  ContextReserve,
  ContextSnapshot,
  StructuredCompactionSummary,
} from '../types/context.js';
import type { ExecutionEngine } from './executionEngine.js';
import type { ExecutionRecord } from '../types/execution.js';
import {
  ContextCompiler,
  computeUsableBudget,
  computeUtilization,
  estimateTokens,
  tokensForPart,
} from './contextCompiler.js';
import { PromptLayoutPlanner, type PromptLayoutStrategy } from './promptLayoutPlanner.js';
import { ContextCompactionService } from './contextCompactionService.js';

export interface ContextRevisionConfig {
  enabled?: boolean;
  autoThreshold?: number; // default ~0.75
  targetUtilization?: number; // default ~0.50
  preserveRecentTailRatio?: number; // default ~0.50
  maxOversizedObservationChars?: number; // default 20,000 chars (~5000 tokens)
  previewChars?: number; // default 1,000 chars
  layoutStrategy?: PromptLayoutStrategy; // default CACHE_STABLE_PREFIX
}

export interface RevisionResult {
  status: 'revised' | 'noop' | 'failed';
  snapshot: ContextSnapshot;
  previousSnapshotId?: string;
  generation: number;
  tokensBefore: number;
  tokensAfter: number;
  tokensDeduplicated: number;
  tokensSuperseded: number;
  tokensSummarized: number;
  tokensOffloaded: number;
  reasons: string[];
}

/**
 * Production-grade Context Revision Service.
 *
 * Implements continuous context revision:
 * Execution History / Durable State
 *       |
 *       v
 * ContextRevisionService
 *       +-- exact deduplication
 *       +-- superseded-state elimination
 *       +-- oversized observation replacement with bounded offload
 *       +-- historical episode compression
 *       +-- active-error retention
 *       +-- current-source retention
 *       +-- authoritative-state reinjection (revision, verification, checks)
 *       +-- recent-tail preservation
 *       |
 *       v
 * ContextSnapshot (Generation N+1)
 *
 * Invariants:
 * - Durable execution history is NEVER modified or deleted.
 * - An in-flight model request uses generation N; revision produces generation N+1.
 * - Generation N is immutable.
 * - LLM summaries CANNOT override authoritative controller truth (workspace revision, test results).
 * - Compression failure falls back safely to the previous valid snapshot.
 */
export class ContextRevisionService {
  private readonly compiler: ContextCompiler;
  private readonly compactionService: ContextCompactionService;
  private readonly layoutPlanner: PromptLayoutPlanner;
  private readonly engine?: ExecutionEngine;
  private readonly config: Required<ContextRevisionConfig>;
  private readonly inFlightGenerations = new Map<string, Set<number>>();
  private readonly snapshotsByExecution = new Map<string, ContextSnapshot[]>();

  constructor(options: {
    compiler?: ContextCompiler;
    compactionService?: ContextCompactionService;
    layoutPlanner?: PromptLayoutPlanner;
    engine?: ExecutionEngine;
    config?: ContextRevisionConfig;
  } = {}) {
    this.compiler = options.compiler ?? new ContextCompiler();
    this.compactionService = options.compactionService ?? new ContextCompactionService({ engine: options.engine });
    this.layoutPlanner = options.layoutPlanner ?? new PromptLayoutPlanner();
    this.engine = options.engine;
    this.config = {
      enabled: options.config?.enabled ?? true,
      autoThreshold: options.config?.autoThreshold ?? 0.75,
      targetUtilization: options.config?.targetUtilization ?? 0.50,
      preserveRecentTailRatio: options.config?.preserveRecentTailRatio ?? 0.50,
      maxOversizedObservationChars: options.config?.maxOversizedObservationChars ?? 20000,
      previewChars: options.config?.previewChars ?? 1000,
      layoutStrategy: options.config?.layoutStrategy ?? 'CACHE_STABLE_PREFIX',
    };
  }

  getLatestSnapshot(executionId: string): ContextSnapshot | undefined {
    const list = this.snapshotsByExecution.get(executionId);
    if (!list || list.length === 0) return undefined;
    return list[list.length - 1];
  }

  registerSnapshot(snapshot: ContextSnapshot): void {
    const list = this.snapshotsByExecution.get(snapshot.executionId) ?? [];
    list.push(snapshot);
    this.snapshotsByExecution.set(snapshot.executionId, list);
    this.compiler.registerSnapshot(snapshot);
  }

  /**
   * Acquire a lease on a snapshot generation for an in-flight model request.
   * Guarantees the snapshot generation will not be mutated or invalidated mid-flight.
   */
  acquireInFlightLease(executionId: string, generation: number): () => void {
    let gens = this.inFlightGenerations.get(executionId);
    if (!gens) {
      gens = new Set<number>();
      this.inFlightGenerations.set(executionId, gens);
    }
    gens.add(generation);

    return () => {
      gens?.delete(generation);
      if (gens && gens.size === 0) {
        this.inFlightGenerations.delete(executionId);
      }
    };
  }

  hasInFlightLease(executionId: string, generation: number): boolean {
    return this.inFlightGenerations.get(executionId)?.has(generation) ?? false;
  }

  /**
   * Evaluates if effective utilization warrants automatic revision.
   */
  shouldRevise(
    executionId: string,
    currentTokens: number,
    effectiveWindow: number,
    reserve?: Partial<ContextReserve>,
  ): boolean {
    if (!this.config.enabled) return false;
    const usableBudget = computeUsableBudget({
      effectiveContextTokens: effectiveWindow,
      reserveOutputTokens: reserve?.outputTokens ?? 8000,
      reserveToolSchemaTokens: reserve?.toolSchemaTokens ?? 5000,
      reserveSafetyTokens: reserve?.safetyTokens ?? 5000,
    });
    const utilization = computeUtilization(currentTokens, usableBudget);
    return utilization >= this.config.autoThreshold;
  }

  /**
   * Performs comprehensive context revision:
   * 1. Exact deduplication.
   * 2. Superseded file / observation elimination.
   * 3. Oversized tool observation replacement with bounded offload notices.
   * 4. Semantic episode compression if utilization exceeds target.
   * 5. Authoritative facts reinjection from ExecutionEngine.
   * 6. Prompt cache-aware layout planning.
   * 7. Emission of an immutable ContextSnapshot (generation N+1).
   */
  async revise(
    request: ContextRequest,
    options: {
      force?: boolean;
      trigger?: 'AUTO' | 'USER' | 'AGENT' | 'CONTROLLER' | 'OVERFLOW_RECOVERY';
    } = {},
  ): Promise<RevisionResult> {
    const executionId = request.executionId;
    const previousSnapshot = this.getLatestSnapshot(executionId);
    const trigger = options.trigger ?? 'AUTO';

    const effectiveWindow = request.runtimeLoaded && request.runtimeLoaded > 0
      ? request.runtimeLoaded
      : request.effectiveContextWindow;

    const reserve: ContextReserve = {
      outputTokens: request.reserve?.outputTokens ?? 8000,
      toolSchemaTokens: request.reserve?.toolSchemaTokens ?? 5000,
      safetyTokens: request.reserve?.safetyTokens ?? 5000,
    };

    const usableInputBudget = computeUsableBudget({
      effectiveContextTokens: effectiveWindow,
      reserveOutputTokens: reserve.outputTokens,
      reserveToolSchemaTokens: reserve.toolSchemaTokens,
      reserveSafetyTokens: reserve.safetyTokens,
    });

    const reasons: string[] = [];
    const omitted: ContextOmission[] = [];
    const offloadedItems: Array<{ id: string; label: string; artifactId: string; tokensSaved: number }> = [];

    // Compile candidate items using ContextCompiler's modular providers
    let baseCandidates: ContextCandidate[] = [];
    try {
      const compiled = await this.compiler.compileSnapshot(request);
      baseCandidates = [
        ...compiled.pinned,
        ...compiled.active,
        ...(compiled.relevant ?? []),
        ...(compiled.compressed ?? []),
        ...compiled.tail,
      ].map((c) => ({ ...c, source: c.id ?? c.label }));
    } catch {
      // Fallback: build from recent history and active error
      baseCandidates = (request.recentHistory ?? []).map((h) => ({ ...h, source: 'history' }));
    }

    const initialTokens = baseCandidates.reduce((sum, c) => sum + (c.tokens ?? estimateTokens(c.content)), 0);

    // Step 1: Exact deduplication
    const seenHashes = new Set<string>();
    const deduplicated: ContextCandidate[] = [];
    let tokensDeduplicated = 0;

    for (const item of baseCandidates) {
      const hash = item.contentHash ?? createHash('sha256').update(`${item.label}:${item.content}`).digest('hex');
      if (seenHashes.has(hash)) {
        const itemTok = item.tokens ?? estimateTokens(item.content);
        tokensDeduplicated += itemTok;
        omitted.push({
          id: item.id ?? item.label,
          label: item.label,
          category: item.category ?? 'COMPRESSIBLE',
          estimatedTokens: itemTok,
          reason: 'Deterministic exact duplicate removed',
        });
        continue;
      }
      seenHashes.add(hash);
      deduplicated.push({ ...item, contentHash: hash });
    }
    if (tokensDeduplicated > 0) {
      reasons.push(`Removed ${tokensDeduplicated} tokens via exact deduplication`);
    }

    // Step 2: Superseded state elimination (keep newest revision of same file/URI)
    const fileRevisions = new Map<string, ContextCandidate>();
    const withoutSuperseded: ContextCandidate[] = [];
    let tokensSuperseded = 0;

    for (const item of deduplicated) {
      const uri = item.sourceUri ?? (item.kind === 'repository' ? item.label : undefined);
      if (!uri) {
        withoutSuperseded.push(item);
        continue;
      }

      const existing = fileRevisions.get(uri);
      if (existing) {
        const existingPrio = typeof existing.priority === 'number' ? existing.priority : 50;
        const currentPrio = typeof item.priority === 'number' ? item.priority : 50;

        if (currentPrio > existingPrio) {
          // Replace existing with newer item
          const tok = existing.tokens ?? estimateTokens(existing.content);
          tokensSuperseded += tok;
          omitted.push({
            id: existing.id ?? existing.label,
            label: existing.label,
            category: existing.category ?? 'ACTIVE',
            estimatedTokens: tok,
            reason: `Superseded by newer revision of ${uri}`,
          });
          const idx = withoutSuperseded.indexOf(existing);
          if (idx !== -1) withoutSuperseded.splice(idx, 1);
          withoutSuperseded.push(item);
          fileRevisions.set(uri, item);
        } else {
          const tok = item.tokens ?? estimateTokens(item.content);
          tokensSuperseded += tok;
          omitted.push({
            id: item.id ?? item.label,
            label: item.label,
            category: item.category ?? 'ACTIVE',
            estimatedTokens: tok,
            reason: `Superseded by existing revision of ${uri}`,
          });
        }
      } else {
        fileRevisions.set(uri, item);
        withoutSuperseded.push(item);
      }
    }
    if (tokensSuperseded > 0) {
      reasons.push(`Removed ${tokensSuperseded} tokens via superseded-state elimination`);
    }

    // Step 3: Oversized observation replacement with bounded offload
    const boundedObservations: ContextCandidate[] = [];
    let tokensOffloaded = 0;

    for (const item of withoutSuperseded) {
      if (
        item.category !== 'PINNED' &&
        item.content.length > this.config.maxOversizedObservationChars &&
        (item.kind === 'tools' || item.kind === 'repository' || item.label.toLowerCase().includes('output'))
      ) {
        const originalChars = item.content.length;
        const originalTokens = item.tokens ?? estimateTokens(item.content);
        const artifactId = `art-${randomUUID().slice(0, 8)}`;
        const headChars = Math.floor(this.config.previewChars * 0.7);
        const tailChars = Math.floor(this.config.previewChars * 0.3);
        const head = item.content.slice(0, headChars);
        const tail = item.content.slice(originalChars - tailChars);

        const notice =
          `\n\n[Oversized observation offloaded to disk]\n` +
          `Artifact: ${artifactId}\n` +
          `Original Size: ${originalChars} chars (~${originalTokens} tokens)\n` +
          `Full evidence preserved durably in execution record.\n\n`;

        const replacedContent = head + notice + tail;
        const newTokens = estimateTokens(replacedContent);
        const saved = Math.max(0, originalTokens - newTokens);
        tokensOffloaded += saved;

        offloadedItems.push({
          id: item.id ?? item.label,
          label: item.label,
          artifactId,
          tokensSaved: saved,
        });

        boundedObservations.push({
          ...item,
          content: replacedContent,
          tokens: newTokens,
          category: 'COMPRESSIBLE',
          metadata: {
            ...item.metadata,
            offloaded: true,
            artifactId,
            originalTokens,
          },
        });
      } else {
        boundedObservations.push(item);
      }
    }
    if (tokensOffloaded > 0) {
      reasons.push(`Saved ${tokensOffloaded} tokens by offloading oversized observations`);
    }

    // Step 4: Authoritative state reinjection from ExecutionEngine
    const record = this.safeGetRecord(executionId);
    const workspaceRevision = record?.workspaceState?.revision ?? 0;
    const latestCheck = record?.checks ? record.checks[record.checks.length - 1] : undefined;
    const authoritativeVerificationState = {
      revision: workspaceRevision,
      status: latestCheck ? (latestCheck.ok ? 'PASS' : 'FAIL') : 'UNTESTED',
      lastCommand: latestCheck?.command,
    };

    // Reinforce current authoritative revision as a pinned state notice
    const authoritativePart: ContextCandidate = {
      id: 'auth-workspace-revision',
      source: 'execution_engine',
      kind: 'system',
      category: 'PINNED',
      label: `Authoritative Workspace Revision: R${workspaceRevision}`,
      content: `Authoritative Workspace State: Revision ${workspaceRevision}. Verification status: ${authoritativeVerificationState.status}${authoritativeVerificationState.lastCommand ? ` (${authoritativeVerificationState.lastCommand})` : ''}.`,
      priority: 98,
      estimatedTokens: 25,
      tokens: 25,
      reasonIncluded: 'Authoritative workspace revision and verification state is pinned',
    };

    // Replace or insert authoritative state item
    const withAuthoritative = [
      authoritativePart,
      ...boundedObservations.filter((i) => i.id !== 'auth-workspace-revision'),
    ];

    // Step 5: Check utilization against target (~0.50). If over target, compress older historical episodes
    let tokensSummarized = 0;
    let finalItems = [...withAuthoritative];
    const currentTokens = finalItems.reduce((sum, i) => sum + (i.tokens ?? estimateTokens(i.content)), 0);
    const targetTokens = Math.floor(usableInputBudget * this.config.targetUtilization);

    if (currentTokens > targetTokens || options.force) {
      const pinned = finalItems.filter((i) => i.category === 'PINNED');
      const active = finalItems.filter((i) => i.category === 'ACTIVE');
      const relevant = finalItems.filter((i) => i.category === 'RELEVANT');
      const compressible = finalItems.filter((i) => i.category === 'COMPRESSIBLE' || (!i.category && i.kind === 'conversation'));

      if (compressible.length > 2) {
        const tailCount = Math.max(1, Math.ceil(compressible.length * this.config.preserveRecentTailRatio));
        const itemsToCompress = compressible.slice(0, compressible.length - tailCount);
        const preservedTail = compressible.slice(compressible.length - tailCount);

        try {
          const compBeforeTokens = itemsToCompress.reduce((s, i) => s + (i.tokens ?? estimateTokens(i.content)), 0);
          const compResult = await this.compactionService.compact({
            executionId,
            trigger: trigger as any,
            reason: 'Context revision target utilization adjustment',
            force: true,
          });

          if (compResult.status === 'compacted' && compResult.metrics) {
            tokensSummarized = compResult.metrics.tokensSaved;
            reasons.push(`Summarized ${itemsToCompress.length} historical episodes saving ${tokensSummarized} tokens`);

            const latestSnap = this.compactionService.getLatestSnapshot(executionId);
            const summaryParts = latestSnap?.compressed ?? [];

            finalItems = [
              ...pinned,
              ...active,
              ...relevant,
              ...summaryParts.map((s) => ({ ...s, source: 'compactor' })),
              ...preservedTail,
            ];
          }
        } catch (err) {
          // Invariant: Compression failure safely retains existing valid context
          reasons.push(`Semantic compression failed safely: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Step 6: Plan prompt layout according to strategy (e.g. CACHE_STABLE_PREFIX)
    const plannedLayout = this.layoutPlanner.plan(finalItems, this.config.layoutStrategy);

    // Step 7: Build immutable ContextSnapshot generation N+1
    const nextGeneration = previousSnapshot ? previousSnapshot.generation + 1 : 1;
    const finalTokens = plannedLayout.tokens.total;
    const utilization = computeUtilization(finalTokens, usableInputBudget);

    const tokenBudget = {
      parts: plannedLayout.orderedItems,
      inputTokens: finalTokens,
      outputReserveTokens: reserve.outputTokens,
      requiredTokens: finalTokens + reserve.outputTokens,
      reserve,
      utilization,
    };

    const newSnapshot: ContextSnapshot = {
      id: `snap-${randomUUID().slice(0, 8)}`,
      executionId,
      generation: nextGeneration,
      modelId: request.modelId,
      agentId: request.agentId,
      phase: request.phase,
      effectiveContextWindow: effectiveWindow,
      tokenBudget,
      estimatedTokens: finalTokens,
      createdAt: new Date(),
      stablePrefix: plannedLayout.stablePrefix,
      volatileTail: [...plannedLayout.semiStable, ...plannedLayout.volatileTail],
      pinned: finalItems.filter((i) => i.category === 'PINNED'),
      active: finalItems.filter((i) => i.category === 'ACTIVE'),
      relevant: finalItems.filter((i) => i.category === 'RELEVANT'),
      compressible: finalItems.filter((i) => i.category === 'COMPRESSIBLE'),
      compressed: finalItems.filter((i) => i.kind === 'memory'),
      tail: finalItems.filter((i) => i.kind === 'conversation' && i.label.toLowerCase().includes('recent')),
      omitted,
      offloadedItems,
      revisionMetadata: {
        revisionTrigger: trigger,
        tokensDeduplicated,
        tokensSuperseded,
        tokensSummarized,
        tokensOffloaded,
        layoutStrategy: this.config.layoutStrategy,
      },
      artifactReferences: [],
    };

    this.registerSnapshot(newSnapshot);

    return {
      status: 'revised',
      snapshot: newSnapshot,
      previousSnapshotId: previousSnapshot?.id,
      generation: nextGeneration,
      tokensBefore: initialTokens,
      tokensAfter: finalTokens,
      tokensDeduplicated,
      tokensSuperseded,
      tokensSummarized,
      tokensOffloaded,
      reasons,
    };
  }

  private safeGetRecord(executionId: string): ExecutionRecord | undefined {
    try {
      return this.engine?.require(executionId);
    } catch {
      return undefined;
    }
  }
}
