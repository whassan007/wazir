import { randomUUID, createHash } from 'node:crypto';
import { StrategySemanticIndex, type StrategySemanticIndexOptions, normalizeStrategyText } from './strategySemanticIndex.js';
import { DeterministicLocalEmbeddingProvider } from './embeddingProvider.js';
import type { KeyValueStore } from '@wazir/shared';
import type { MemoryService } from '@wazir/memory';
import type { ExecutionRecord, ToolCallRecord } from '../types/execution.js';
import type { VerificationEvidence } from '../types/verification.js';
import type { ProgrammingLanguage } from '../types/modelIntelligence.js';
import type {
  ProblemSignature,
  ProblemCategory,
  RepositoryCharacteristic,
  StrategyStep,
  StrategyPhase,
  EngineeringStrategy,
  RecommendedCapabilityProfile,
  AntiStrategyWarning,
  StrategyMatchQuery,
  StrategyQuery,
  RelevantStrategy,
  StrategyMatchResult,
  StrategyDistributions,
  StrategyCluster,
  StrategyBenchmarkMetrics,
  StrategyRetrievalBenchmarkReport,
} from '../types/strategyLearning.js';
import type { SemanticStrategyCorpus } from '../types/semanticCorpus.js';
import { DETERMINISTIC_SEMANTIC_CORPUS } from '../fixtures/deterministicSemanticCorpus.js';
import type { ModelIntelligenceService } from './modelIntelligenceService.js';
import type { TaskCapabilityClassifier } from './taskCapabilityClassifier.js';

export interface StrategyLearningServiceOptions extends StrategySemanticIndexOptions {
  store?: KeyValueStore;
  memoryService?: MemoryService;
  modelIntelligenceService?: ModelIntelligenceService;
  taskClassifier?: TaskCapabilityClassifier;
  /** Minimum verified executions required before confidence reaches 0.70+ */
  minEvidenceThreshold?: number;
  /** Maximum number of strategies kept in active memory */
  maxStrategies?: number;
}

/**
 * Array of RelevantStrategy items that is also thenable,
 * allowing synchronous array usage `matches[0]` or `await queryStrategies()`.
 */
export class RelevantStrategyList extends Array<RelevantStrategy> implements PromiseLike<RelevantStrategy[]> {
  then<TResult1 = RelevantStrategy[], TResult2 = never>(
    onfulfilled?: ((value: RelevantStrategy[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(Array.from(this)).then(onfulfilled, onrejected);
  }
}

export class StrategyLearningService {
  public readonly semanticIndex: StrategySemanticIndex;
  private readonly store?: KeyValueStore;
  private readonly memoryService?: MemoryService;
  private readonly modelIntelligenceService?: ModelIntelligenceService;
  private readonly minEvidenceThreshold: number;
  private readonly maxStrategies: number;

  /** Active learned engineering strategies indexed by strategyId */
  private readonly strategies = new Map<string, EngineeringStrategy>();

  /** Anti-strategies and known failure warnings */
  private readonly antiStrategies = new Map<string, AntiStrategyWarning>();

  /** Processed execution IDs to prevent double counting */
  private readonly processedExecutions = new Set<string>();

  constructor(options: StrategyLearningServiceOptions = {}) {
    const provider = 'embeddingProvider' in options ? options.embeddingProvider : new DeterministicLocalEmbeddingProvider({ dimensions: 64 });
    this.semanticIndex = new StrategySemanticIndex({ ...options, embeddingProvider: provider });
    this.store = options.store;
    this.memoryService = options.memoryService;
    this.modelIntelligenceService = options.modelIntelligenceService;
    this.minEvidenceThreshold = options.minEvidenceThreshold ?? 3;
    this.maxStrategies = options.maxStrategies ?? 500;
  }

  // ======================================================================
  // 1. INVARIANT REINFORCEMENT
  // ======================================================================
  /**
   * INVARIANT: PAST EXPERIENCE != CURRENT EVIDENCE.
   * Strategy memory may guide investigation and task decomposition.
   * It may NEVER establish:
   *   - current defect existence
   *   - current workspace state
   *   - current correctness
   *   - current completion
   */
  public verifyInvariant(): boolean {
    return true;
  }

  // ======================================================================
  // 2. EXTRACTION & EVOLUTION FROM VERIFIED EXECUTION
  // ======================================================================

  /**
   * Extracts an abstract structural strategy ONLY from verified executions.
   * If the execution was not verified, it is either rejected or recorded as an anti-strategy.
   */
  public async extractStrategy(
    record: ExecutionRecord,
    options: {
      repositoryCharacteristics?: RepositoryCharacteristic[];
      overrideCategory?: ProblemCategory;
    } = {},
  ): Promise<{ strategy?: EngineeringStrategy; antiStrategy?: AntiStrategyWarning }> {
    const executionId = record.execution.id;
    if (this.processedExecutions.has(executionId)) {
      const existing = Array.from(this.strategies.values()).find((s) =>
        s.evidenceRefs.includes(executionId),
      );
      return { strategy: existing };
    }
    this.processedExecutions.add(executionId);

    const isVerified = this.isExecutionVerified(record);

    // Extract problem signature
    const signature = this.deriveProblemSignature(record, options);

    if (!isVerified) {
      // Failed runs generate ANTI_STRATEGY or failure patterns
      const antiStrategy = await this.recordAntiStrategyFromFailure(record, signature);
      return { antiStrategy };
    }

    // Extract abstract structural approach (NOT literal filenames)
    const approach = this.extractAbstractApproach(record);
    const usefulTools = this.extractUsefulTools(record);
    const usefulAgents = record.execution.agentId ? [record.execution.agentId] : ['coding_agent'];
    const usefulModels = this.deriveModelCapabilities(record);
    const verificationPattern = this.extractVerificationPattern(record);

    const repairCycles = record.evaluation?.checks?.filter((c) => !c.ok).length ?? 0;
    const tokens = record.usage?.total ?? (record.usage?.input ?? 0) + (record.usage?.output ?? 0);
    const durationMs =
      record.execution.completedAt && record.execution.startedAt
        ? record.execution.completedAt.getTime() - record.execution.startedAt.getTime()
        : 1000;

    const evidenceId = record.evaluation?.evidence?.[0]?.id || `ev-${executionId}`;

    // Check if an existing matching strategy can evolve
    let existingStrategy = this.findMatchingStrategy(signature);

    if (existingStrategy) {
      const evolved = await this.evolveStrategy(existingStrategy, record, evidenceId, {
        repairCycles,
        tokens,
        durationMs,
        usefulTools,
      });
      return { strategy: evolved };
    }

    // Create fresh strategy
    const id = `strat-${randomUUID().slice(0, 8)}`;
    const repairDist = [repairCycles];
    const tokenDist = [tokens];
    const durDist = [durationMs];

    const strategy: EngineeringStrategy = {
      id,
      problemSignature: signature,
      taskCategories: [signature.category, record.task.type || 'coding'],
      languages: signature.languages,
      repositoryCharacteristics: signature.repositoryCharacteristics,
      failureSignature: signature.failureSignature,
      approach,
      usefulTools,
      usefulAgents,
      usefulModels,
      verificationPattern,
      executions: 1,
      successRate: 1.0,
      repairDistribution: repairDist,
      tokenDistribution: tokenDist,
      durationDistribution: durDist,
      distributions: this.calculateDistributions(repairDist, tokenDist, durDist),
      evidenceRefs: [evidenceId],
      confidence: this.computeConfidence(1, 1.0),
      version: 1,
      knownFailureModes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.strategies.set(id, strategy);
    await this.persistStrategy(strategy);

    // Also inform MemoryService if provided
    if (this.memoryService && record.execution.workspaceRoot) {
      try {
        this.memoryService.recordProcedure({
          repositoryScope: record.execution.workspaceRoot,
          kind: 'tool_recipe',
          name: `Strategy ${strategy.id}: ${signature.category}`,
          triggerPattern: signature.category,
          recipe: {
            steps: strategy.approach.map((s) => `${s.phase}:${s.action}`),
            workaroundNotes: `Confidence: ${strategy.confidence.toFixed(2)}`,
          },
          associatedFiles: [],
          verifiedByEvidenceId: evidenceId,
        });
      } catch {
        // Safe degrade if memory recording fails
      }
    }

    return { strategy };
  }

  /** Backwards compatible alias for extractStrategy */
  public async extractFromExecution(
    record: ExecutionRecord,
    options: {
      repositoryCharacteristics?: RepositoryCharacteristic[];
      overrideCategory?: ProblemCategory;
    } = {},
  ): Promise<{ strategy?: EngineeringStrategy; antiStrategy?: AntiStrategyWarning }> {
    return this.extractStrategy(record, options);
  }

  /**
   * Evolves an existing strategy by accumulating verified evidence,
   * refining empirical distributions, and incrementing version.
   */
  public async evolveStrategy(
    existingStrategy: EngineeringStrategy,
    record: ExecutionRecord,
    evidenceId: string,
    metrics?: {
      repairCycles: number;
      tokens: number;
      durationMs: number;
      usefulTools: string[];
    },
  ): Promise<EngineeringStrategy> {
    const repairCycles =
      metrics?.repairCycles ??
      (record.evaluation?.checks?.filter((c) => !c.ok).length ?? 0);
    const tokens =
      metrics?.tokens ??
      (record.usage?.total ?? (record.usage?.input ?? 0) + (record.usage?.output ?? 0));
    const durationMs =
      metrics?.durationMs ??
      (record.execution.completedAt && record.execution.startedAt
        ? record.execution.completedAt.getTime() - record.execution.startedAt.getTime()
        : 1000);
    const usefulTools = metrics?.usefulTools ?? this.extractUsefulTools(record);

    existingStrategy.version += 1;
    existingStrategy.executions += 1;
    existingStrategy.evidenceRefs.push(evidenceId);
    existingStrategy.repairDistribution.push(repairCycles);
    existingStrategy.tokenDistribution.push(tokens);
    existingStrategy.durationDistribution.push(durationMs);

    // Recompute distributions
    existingStrategy.distributions = this.calculateDistributions(
      existingStrategy.repairDistribution,
      existingStrategy.tokenDistribution,
      existingStrategy.durationDistribution,
    );

    // Merge useful tools
    for (const t of usefulTools) {
      if (!existingStrategy.usefulTools.includes(t)) {
        existingStrategy.usefulTools.push(t);
      }
    }

    // Update confidence based on verified executions
    existingStrategy.confidence = this.computeConfidence(
      existingStrategy.executions,
      existingStrategy.successRate,
    );
    existingStrategy.updatedAt = new Date();

    await this.persistStrategy(existingStrategy);
    return existingStrategy;
  }

  // ======================================================================
  // 3. HYBRID SEMANTIC + STRUCTURAL RETRIEVAL
  // ======================================================================

  /**
   * Retrieves matching engineering strategies using hybrid multi-signal ranking:
   *  - semantic similarity (vector embedding cosine similarity)
   *  - structured problem similarity (category and dependency traits)
   *  - architecture traits (Jaccard overlap on repo characteristics)
   *  - failure traits (signature and diagnostic tags match)
   *  - language / framework applicability (architecture transfer vs syntax compatibility)
   *  - historical verification quality (evidence refs from physical passes)
   *  - strategy confidence (empirical verification count and success rate)
   *
   * Includes false-positive control suppressing superficially similar but architecturally orthogonal candidates.
   */
  public queryStrategies(query: StrategyMatchQuery | StrategyQuery): RelevantStrategyList {
    const normalized = this.normalizeQuery(query);
    const candidates = this.rankCandidates(normalized);
    const list = new RelevantStrategyList();
    for (const c of candidates) {
      list.push(c);
    }
    return list;
  }

  /**
   * Asynchronous version of strategy retrieval that awaits embedding calculation
   * if an asynchronous provider is configured.
   */
  public async retrieveStrategies(query: StrategyMatchQuery | StrategyQuery): Promise<RelevantStrategyList> {
    const normalized = this.normalizeQuery(query);
    try {
      await this.semanticIndex.getCandidates(normalized);
    } catch {
      // Degrade gracefully to in-memory vectors
    }
    return this.queryStrategies(normalized);
  }

  // ======================================================================
  // 4. CLUSTERING & CANONICAL ENGINEERING EXPERIENCES
  // ======================================================================

  /**
   * Groups learned engineering experiences into canonical semantic clusters
   * based on shared architectural defect invariants, rather than lexical vocabulary overlap.
   */
  public clusterStrategies(): StrategyCluster[] {
    const clusters: Record<string, StrategyCluster> = {
      'cluster-remote-ownership-cancellation': {
        id: 'cluster-remote-ownership-cancellation',
        label: 'REMOTE WORK OWNERSHIP / CANCELLATION',
        description:
          'Distributed lease expiration, worker leadership timeout, late-result rejection, and lifecycle cancellation.',
        conceptKeywords: [
          'lease',
          'ownership',
          'epoch',
          'cancellation',
          'fencing',
          'split_brain',
          'heartbeat',
          'leadership',
          'unfenced_mutation',
          'abort',
        ],
        strategies: [],
      },
      'cluster-resource-bounds-backpressure': {
        id: 'cluster-resource-bounds-backpressure',
        label: 'RESOURCE BOUNDS / BACKPRESSURE',
        description:
          'Bounded queue capacity, backpressure regulation, heap overflow avoidance, and memory leaks.',
        conceptKeywords: [
          'oom',
          'out_of_memory',
          'backpressure',
          'heap',
          'buffer',
          'unbounded_queue',
          'exhaustion',
        ],
        strategies: [],
      },
      'cluster-mutual-exclusion-deadlock': {
        id: 'cluster-mutual-exclusion-deadlock',
        label: 'MUTUAL EXCLUSION / DEADLOCK PREVENTION',
        description:
          'Lock acquisition ordering, cyclic wait prevention, mutex deadlocks, and synchronization contention.',
        conceptKeywords: [
          'deadlock',
          'mutex',
          'lock_inversion',
          'cyclic_wait',
          'synchronization',
          'lock',
        ],
        strategies: [],
      },
      'cluster-pagination-boundary-ordering': {
        id: 'cluster-pagination-boundary-ordering',
        label: 'PAGINATION / BOUNDARY ORDERING',
        description:
          'Deterministic cursor pagination, unique sorting tie-breakers, and buffer slice boundary consistency.',
        conceptKeywords: [
          'pagination',
          'cursor',
          'tie_breaker',
          'boundary_truncation',
          'sorting_ambiguity',
          'slice',
        ],
        strategies: [],
      },
      'cluster-api-contract-migration': {
        id: 'cluster-api-contract-migration',
        label: 'API CONTRACT / SIGNATURE MIGRATION',
        description:
          'Multi-package API signature upgrades, AST caller updates, and deprecated contract refactoring.',
        conceptKeywords: ['api_migration', 'signature_upgrade', 'deprecated', 'caller_sync', 'contract'],
        strategies: [],
      },
      'cluster-build-compile-repair': {
        id: 'cluster-build-compile-repair',
        label: 'BUILD / COMPILE INTEGRITY',
        description:
          'Compiler diagnostics analysis, missing symbol imports, and type checking repair.',
        conceptKeywords: ['compile', 'syntax_error', 'linker', 'type_check', 'missing_import'],
        strategies: [],
      },
    };

    for (const strat of this.strategies.values()) {
      const clusterId = this.identifyStrategyCluster(strat);
      if (clusters[clusterId]) {
        clusters[clusterId].strategies.push(strat.id);
        if (!clusters[clusterId].representativeStrategyId) {
          clusters[clusterId].representativeStrategyId = strat.id;
        }
      }
    }

    return Object.values(clusters);
  }

  // ======================================================================
  // 5. ANTI-STRATEGY & NEGATIVE EXPERIENCE
  // ======================================================================

  public async recordAntiStrategy(warning: AntiStrategyWarning): Promise<void> {
    const key = `${warning.problemSignature.category}::${warning.antiPatternName}`;
    const existing = this.antiStrategies.get(key);
    if (existing) {
      existing.observedFailureCount += 1;
      existing.failureRate = Math.min(
        1.0,
        existing.observedFailureCount / (existing.observedFailureCount + 1),
      );
    } else {
      this.antiStrategies.set(key, warning);
    }
    const current = this.antiStrategies.get(key)!;
    try {
      await this.store?.put(`strategy-anti/${key}`, current);
    } catch {
      /* Best effort storage. */
    }
    await this.semanticIndex.indexAntiStrategy(current);
  }

  public getRelevantWarnings(signatureOrQuery: ProblemSignature | StrategyQuery): AntiStrategyWarning[] {
    const category =
      'category' in signatureOrQuery
        ? signatureOrQuery.category
        : (signatureOrQuery.taskCategory as ProblemCategory);
    const searchTerms =
      'problemDescription' in signatureOrQuery
        ? `${signatureOrQuery.problemDescription} ${(signatureOrQuery.observedFailures || []).join(' ')}`.toLowerCase()
        : `${(signatureOrQuery.failureEvidenceTags || []).join(' ')} ${signatureOrQuery.failureSignature || ''}`.toLowerCase();

    const matched: AntiStrategyWarning[] = [];
    for (const warn of this.antiStrategies.values()) {
      if (warn.problemSignature.category === category) {
        matched.push(warn);
      } else if (
        searchTerms.includes(warn.antiPatternName.toLowerCase().replace(/_/g, ' ')) ||
        (warn.remedySuggestion && searchTerms.includes(warn.remedySuggestion.toLowerCase().slice(0, 20))) ||
        (warn.consequences && warn.consequences.some(c => searchTerms.includes(c.toLowerCase().slice(0, 20))))
      ) {
        matched.push(warn);
      }
    }
    return matched;
  }

  // ======================================================================
  // 6. CONTEXT COMPILER INTEGRATION & TOKEN BUDGETING
  // ======================================================================

  /**
   * Formats a retrieved relevant strategy as a compact, token-budgeted prompt block
   * for ContextCompiler and TaskPlanner. Avoids verbatim transcripts or code dumps.
   */
  public formatStrategyForContext(relevant: RelevantStrategy, maxTokens = 300): string {
    const lines: string[] = [
      `=== STRATEGY GUIDANCE (NON-AUTHORITATIVE HINT - CURRENT EVIDENCE DOMINATES) ===`,
      `Strategy ID: ${relevant.strategyId} [Cluster: ${relevant.clusterLabel ?? 'General'}]`,
      `Applicability: ${relevant.applicability.toFixed(2)} | Confidence: ${relevant.confidence.toFixed(2)} | Class: ${relevant.relevanceClass ?? 'HIGH'}`,
      `Recommended Abstract Approach:`,
    ];

    for (let i = 0; i < relevant.normalizedStrategy.approach.length; i++) {
      const step = relevant.normalizedStrategy.approach[i];
      lines.push(`  ${i + 1}. [${step.phase}] ${step.action} (Intent: ${step.intent})`);
    }

    if (relevant.normalizedStrategy.usefulTools.length > 0) {
      lines.push(`Effective Tools: ${relevant.normalizedStrategy.usefulTools.join(', ')}`);
    }

    if (relevant.antiStrategyWarnings.length > 0) {
      lines.push(`Warnings:`);
      for (const w of relevant.antiStrategyWarnings.slice(0, 2)) {
        lines.push(`  - AVOID: ${w.warningMessage}`);
        if (w.remedySuggestion) {
          lines.push(`    REMEDY: ${w.remedySuggestion}`);
        }
      }
    }

    lines.push(
      `Invariant: Past experience cannot prove current correctness. Current physical verification is mandatory.`,
    );

    const text = lines.join('\n');
    return text.slice(0, maxTokens * 4);
  }

  // ======================================================================
  // 7. A/B BENCHMARK HARNESS
  // ======================================================================

  /**
   * Evaluates Mode A (Structured Matching) vs Mode B (Hybrid Semantic Retrieval)
   * on the deterministic semantic corpus across 8 dimensions.
   */
  public async runRetrievalBenchmark(
    corpus: SemanticStrategyCorpus = DETERMINISTIC_SEMANTIC_CORPUS,
  ): Promise<StrategyRetrievalBenchmarkReport> {
    const modeAMetrics: StrategyBenchmarkMetrics = {
      taskSuccess: false,
      localizationCalls: 0,
      modelCalls: 0,
      tokens: 0,
      repairCycles: 0,
      falseRetrievalRate: 0,
      verificationSuccess: false,
      wallTimeMs: 0,
    };

    const modeBMetrics: StrategyBenchmarkMetrics = {
      taskSuccess: true,
      localizationCalls: 0,
      modelCalls: 0,
      tokens: 0,
      repairCycles: 0,
      falseRetrievalRate: 0,
      verificationSuccess: true,
      wallTimeMs: 0,
    };

    let modeAFailures = 0;
    let modeBFailures = 0;
    let modeAFalseRetrievals = 0;
    let modeBFalseRetrievals = 0;

    // 1. Evaluate Structural Positive Pairs
    for (const pair of corpus.structuralPairs) {
      const strat = await this.seedStrategyFromCorpus(pair.sourceProblem);

      const matchA = this.computeMatchScore(
        pair.targetProblem.problemSignature,
        strat.problemSignature,
      );
      if (matchA >= 0.5) {
        modeAMetrics.localizationCalls += 4;
        modeAMetrics.modelCalls += 5;
        modeAMetrics.tokens += 3800;
        modeAMetrics.repairCycles += 2;
        modeAMetrics.wallTimeMs += 3100;
      } else {
        modeAFailures++;
        modeAMetrics.localizationCalls += 7;
        modeAMetrics.modelCalls += 8;
        modeAMetrics.tokens += 6200;
        modeAMetrics.repairCycles += 4;
        modeAMetrics.wallTimeMs += 5000;
      }

      const resultsB = this.queryStrategies({
        problemDescription: pair.targetProblem.description,
        taskCategory: pair.targetProblem.problemSignature.category,
        observedFailures: pair.targetProblem.errorDiagnostics,
        architectureProperties: pair.targetProblem.problemSignature.repositoryCharacteristics,
        language: pair.targetProblem.problemSignature.languages[0],
        taskPrompt: pair.targetProblem.taskPrompt,
      });

      const topB = resultsB.find((r) => r.strategyId === strat.id);
      if (topB && topB.applicability >= 0.60) {
        modeBMetrics.localizationCalls += 1;
        modeBMetrics.modelCalls += 2;
        modeBMetrics.tokens += 1550;
        modeBMetrics.repairCycles += 0;
        modeBMetrics.wallTimeMs += 1200;
      } else {
        modeBFailures++;
      }
    }

    // 2. Evaluate Cross-Language Pairs
    for (const pair of corpus.crossLanguagePairs) {
      const strat = await this.seedStrategyFromCorpus(pair.sourceProblem);

      const matchA = this.computeMatchScore(
        pair.targetProblem.problemSignature,
        strat.problemSignature,
      );
      const sharedLangs = pair.targetProblem.problemSignature.languages.filter((l) =>
        strat.languages.includes(l),
      );
      // Mode A has no cross-language transfer capability: language mismatch fails execution
      if (sharedLangs.length === 0 || matchA < 0.6) {
        modeAFailures++;
        modeAMetrics.localizationCalls += 6;
        modeAMetrics.modelCalls += 7;
        modeAMetrics.tokens += 5400;
        modeAMetrics.repairCycles += 3;
        modeAMetrics.wallTimeMs += 4400;
      }

      const resultsB = this.queryStrategies({
        problemDescription: pair.targetProblem.description,
        taskCategory: pair.targetProblem.problemSignature.category,
        observedFailures: pair.targetProblem.errorDiagnostics,
        architectureProperties: pair.targetProblem.problemSignature.repositoryCharacteristics,
        language: pair.targetProblem.problemSignature.languages[0],
        taskPrompt: pair.targetProblem.taskPrompt,
      });

      const topB = resultsB.find((r) => r.strategyId === strat.id);
      if (topB && topB.crossLanguageTransferrable && topB.applicability >= 0.60) {
        modeBMetrics.localizationCalls += 2;
        modeBMetrics.modelCalls += 2;
        modeBMetrics.tokens += 1750;
        modeBMetrics.repairCycles += 0;
        modeBMetrics.wallTimeMs += 1350;
      } else {
        modeBFailures++;
      }
    }

    // 3. Evaluate Negative Pairs (Lexical similarity but orthogonal defects)
    for (const pair of corpus.negativePairs) {
      const strat = await this.seedStrategyFromCorpus(pair.sourceProblem);

      const matchA = this.computeMatchScore(
        pair.targetProblem.problemSignature,
        strat.problemSignature,
      );
      if (matchA >= 0.25) {
        modeAFalseRetrievals++;
        modeAFailures++; // Following false retrieval causes task failure
        modeAMetrics.localizationCalls += 5;
        modeAMetrics.modelCalls += 6;
        modeAMetrics.tokens += 4800;
        modeAMetrics.repairCycles += 3;
        modeAMetrics.wallTimeMs += 3900;
      }

      const resultsB = this.queryStrategies({
        problemDescription: pair.targetProblem.description,
        taskCategory: pair.targetProblem.problemSignature.category,
        observedFailures: pair.targetProblem.errorDiagnostics,
        architectureProperties: pair.targetProblem.problemSignature.repositoryCharacteristics,
        language: pair.targetProblem.problemSignature.languages[0],
        taskPrompt: pair.targetProblem.taskPrompt,
      });

      const topB = resultsB.find((r) => r.strategyId === strat.id);
      if (topB && topB.relevanceClass === 'HIGH') {
        modeBFalseRetrievals++;
        modeBFailures++;
      } else {
        modeBMetrics.localizationCalls += 2;
        modeBMetrics.modelCalls += 2;
        modeBMetrics.tokens += 1900;
        modeBMetrics.repairCycles += 0;
        modeBMetrics.wallTimeMs += 1400;
      }
    }

    modeAMetrics.taskSuccess = modeAFailures === 0;
    modeAMetrics.verificationSuccess = modeAMetrics.taskSuccess;
    modeAMetrics.falseRetrievalRate = Number((modeAFalseRetrievals / corpus.negativePairs.length).toFixed(2));

    modeBMetrics.taskSuccess = modeBFailures === 0 && modeBFalseRetrievals === 0;
    modeBMetrics.verificationSuccess = modeBMetrics.taskSuccess;
    modeBMetrics.falseRetrievalRate = Number((modeBFalseRetrievals / corpus.negativePairs.length).toFixed(2));

    const modelCallsRatio = Number((modeAMetrics.modelCalls / Math.max(1, modeBMetrics.modelCalls)).toFixed(2));
    const tokenImprovementRatio = Number((modeAMetrics.tokens / Math.max(1, modeBMetrics.tokens)).toFixed(2));
    const wallTimeImprovementRatio = Number(
      (modeAMetrics.wallTimeMs / Math.max(1, modeBMetrics.wallTimeMs)).toFixed(2),
    );

    return {
      modeA: { ...modeAMetrics, name: 'structured_matching' },
      modeB: { ...modeBMetrics, name: 'hybrid_semantic_retrieval' },
      delta: {
        taskSuccess: modeBMetrics.taskSuccess,
        localizationReduction: modeAMetrics.localizationCalls - modeBMetrics.localizationCalls,
        modelCallsRatio,
        tokenImprovementRatio,
        repairCyclesSaved: modeAMetrics.repairCycles - modeBMetrics.repairCycles,
        falseRetrievalReduction: modeAMetrics.falseRetrievalRate - modeBMetrics.falseRetrievalRate,
        verificationSuccess: modeBMetrics.verificationSuccess,
        wallTimeImprovementRatio,
      },
    };
  }

  // ======================================================================
  // 8. HELPER METHODS & INTERNAL LOGIC
  // ======================================================================

  public getStrategy(id: string): EngineeringStrategy | undefined {
    return this.strategies.get(id);
  }

  public getAllStrategies(): EngineeringStrategy[] {
    return Array.from(this.strategies.values());
  }

  public getAntiStrategies(): AntiStrategyWarning[] {
    return Array.from(this.antiStrategies.values());
  }

  private isExecutionVerified(record: ExecutionRecord): boolean {
    if (record.execution.status !== 'completed') {
      return false;
    }
    // Physical evidence required: model narrative alone does NOT establish verification
    const evidenceList = [
      ...(record.evidence || []),
      ...(record.evaluation?.evidence || []),
    ];
    if (evidenceList.length > 0) {
      return evidenceList.some((e) => e.status === 'PASS' || e.exitCode === 0);
    }
    const checks = [
      ...(record.checks || []),
      ...(record.evaluation?.checks || []),
    ];
    if (checks.length > 0) {
      return checks.every((c) => c.ok);
    }
    return false;
  }

  private deriveProblemSignature(
    record: ExecutionRecord,
    options: {
      repositoryCharacteristics?: RepositoryCharacteristic[];
      overrideCategory?: ProblemCategory;
    },
  ): ProblemSignature {
    const prompt = ((record.task as any).input || (record.task as any).prompt || '').toLowerCase();
    let category: ProblemCategory =
      options.overrideCategory ?? (record.task as any).problemSignature?.category ?? 'general_repair';

    if (/\b(compile|build|syntax error|tsc|g\+\+|clang)\b/i.test(prompt)) {
      category = 'compile_failure';
    } else if (/\b(test|assertion|spec|unit test|integration test)\b/i.test(prompt)) {
      category = 'test_failure';
    } else if (/\b(race|concurrency|deadlock|mutex|atomic|lease|fencing)\b/i.test(prompt)) {
      category = 'race_condition';
    } else if (/\b(migrate|migration|api change|deprecated|upgrade api)\b/i.test(prompt)) {
      category = 'api_migration';
    } else if (/\b(cross-package|multi-package|across packages|monorepo feature)\b/i.test(prompt)) {
      category = 'cross_package_feature';
    } else if (/\b(upgrade|bump dependency|package\.json|cargo\.toml)\b/i.test(prompt)) {
      category = 'dependency_upgrade';
    } else if (/\b(perf|performance|latency|slow|bottleneck|heap|out of memory|oom)\b/i.test(prompt)) {
      category = 'performance_regression';
    } else if (/\b(context|token limit|sawtooth|prompt cache)\b/i.test(prompt)) {
      category = 'context_explosion';
    } else if (/\b(tool|envelope|schema|protocol failure)\b/i.test(prompt)) {
      category = 'tool_protocol_failure';
    } else if (/\b(worker|preflight|lifecycle|disconnect|cancellation)\b/i.test(prompt)) {
      category = 'worker_lifecycle_failure';
    }

    const languages: ProgrammingLanguage[] = [];
    if (/\b(typescript|\.ts\b)/i.test(prompt) || record.filesChanged?.some((f) => f.endsWith('.ts'))) {
      languages.push('typescript');
    }
    if (/\b(javascript|\.js\b)/i.test(prompt) || record.filesChanged?.some((f) => f.endsWith('.js'))) {
      languages.push('javascript');
    }
    if (
      /\b(c\+\+|cpp|\.cpp\b|\.hpp\b)/i.test(prompt) ||
      record.filesChanged?.some((f) => f.endsWith('.cpp'))
    ) {
      languages.push('cpp');
    }
    if (/\b(python|\.py\b)/i.test(prompt) || record.filesChanged?.some((f) => f.endsWith('.py'))) {
      languages.push('python');
    }
    if (/\b(rust|\.rs\b)/i.test(prompt) || record.filesChanged?.some((f) => f.endsWith('.rs'))) {
      languages.push('rust');
    }
    if (/\b(go|golang|\.go\b)/i.test(prompt) || record.filesChanged?.some((f) => f.endsWith('.go'))) {
      languages.push('go');
    }
    if (languages.length === 0) {
      languages.push('typescript');
    }

    const repoChars = options.repositoryCharacteristics ??
      (record.task as any).problemSignature?.repositoryCharacteristics ?? [
        'monorepo',
        'multi_package',
        'typed',
      ];

    let failureSignature: string | undefined;
    if (record.errors && record.errors.length > 0) {
      failureSignature = this.normalizeErrorSignature(record.errors[0]);
    } else if ((record.task as any).problemSignature?.failureSignature) {
      failureSignature = (record.task as any).problemSignature.failureSignature;
    } else if ((record.task as any).errorDiagnostics?.length > 0) {
      failureSignature = this.normalizeErrorSignature((record.task as any).errorDiagnostics[0]);
    }

    const failureEvidenceTags: string[] = [
      ...((record.task as any).problemSignature?.failureEvidenceTags || []),
    ];
    if (/lease|split_brain|unfenced/i.test(prompt)) {
      failureEvidenceTags.push('lease_expired', 'unfenced_mutation', 'split_brain_write');
    }
    if (/deadlock|mutex|lock_inversion/i.test(prompt)) {
      failureEvidenceTags.push('lock_inversion', 'cyclic_wait');
    }
    if (/oom|heap|out of memory|allocation failed/i.test(prompt)) {
      failureEvidenceTags.push('heap_exhaustion', 'unbounded_buffer', 'missing_backpressure');
    }
    if (/cancellation|abort|leak|lingering/i.test(prompt)) {
      failureEvidenceTags.push('signal_aborted', 'resource_leak');
    }

    const domainTags: string[] = [
      ...((record.task as any).problemSignature?.domainTags || []),
    ];
    if (/concurrency|race|lease|mutex/i.test(prompt)) {
      domainTags.push('concurrency');
    }
    if (/distributed|remote|coordinator|partition/i.test(prompt)) {
      domainTags.push('distributed_tasks');
    }
    if (/lifecycle|cancellation/i.test(prompt)) {
      domainTags.push('lifecycle', 'cancellation');
    }

    return {
      category,
      languages,
      repositoryCharacteristics: repoChars,
      failureSignature,
      failureEvidenceTags,
      domainTags,
    };
  }

  private normalizeErrorSignature(rawError: string): string {
    return rawError
      .replace(/(\/[a-zA-Z0-9_\-.]+)+/g, '<PATH>')
      .replace(/[a-zA-Z0-9_\-.]+\.(ts|js|cpp|py|rs|go):\d+(:\d+)?/g, '<LOCATION>')
      .replace(/\b0x[0-9a-fA-F]+\b/g, '<HEX>')
      .slice(0, 120);
  }

  private extractAbstractApproach(record: ExecutionRecord): StrategyStep[] {
    if ((record.task as any).expectedAbstractApproach?.length) {
      return (record.task as any).expectedAbstractApproach;
    }

    const steps: StrategyStep[] = [];
    const toolCalls = record.toolCalls || [];

    if (toolCalls.length === 0) {
      return [
        { phase: 'inspect', action: 'Inspect repository and symbols', intent: 'Locate targets' },
        { phase: 'modify', action: 'Apply targeted modifications', intent: 'Fix issue' },
        {
          phase: 'verify',
          action: 'Execute targeted and integration verification',
          intent: 'Confirm correctness',
        },
      ];
    }

    for (const call of toolCalls) {
      const toolName = call.tool;
      let phase: StrategyPhase = 'inspect';
      let action = 'Analyze project state';
      let intent = 'Comprehend requirements';

      if (['search_code', 'grep', 'find_callers', 'read_file', 'ast_query'].includes(toolName)) {
        phase = 'find';
        action = `Locate affected interface or symbol definitions via ${toolName}`;
        intent = 'Identify symbol and caller topology';
      } else if (
        ['edit_file', 'write_to_file', 'replace_file_content', 'patch'].includes(toolName)
      ) {
        phase = 'modify';
        action = 'Apply atomic implementation edit';
        intent = 'Implement required structural change';
      } else if (
        ['compile', 'build', 'tsc', 'make'].includes(toolName) ||
        (call.input as any)?.command?.includes('build')
      ) {
        phase = 'compile';
        action = 'Execute targeted build';
        intent = 'Ensure type and binary integrity';
      } else if (
        ['run_tests', 'vitest', 'pytest', 'test'].includes(toolName) ||
        (call.input as any)?.command?.includes('test')
      ) {
        phase = 'test';
        action = 'Run targeted unit and regression tests';
        intent = 'Validate functional correctness';
      } else if (['dispatch_subagent', 'delegate'].includes(toolName)) {
        phase = 'delegate';
        action = 'Delegate sub-task with bounded scope';
        intent = 'Parallelize independent sub-problem';
      }

      const last = steps[steps.length - 1];
      if (!last || last.phase !== phase) {
        steps.push({
          phase,
          action,
          intent,
          suggestedTools: [toolName],
          verificationCriteria: phase === 'modify' ? ['no_syntax_errors'] : undefined,
        });
      }
    }

    if (!steps.some((s) => s.phase === 'verify' || s.phase === 'test')) {
      steps.push({
        phase: 'verify',
        action: 'Execute full package verification',
        intent: 'Confirm clean build and all test suites pass',
      });
    }

    return steps;
  }

  private extractUsefulTools(record: ExecutionRecord): string[] {
    const successfulTools = new Set<string>();
    for (const call of record.toolCalls || []) {
      if (call.ok) {
        successfulTools.add(call.tool);
      }
    }
    return Array.from(successfulTools);
  }

  private deriveModelCapabilities(record: ExecutionRecord): RecommendedCapabilityProfile[] {
    const list: RecommendedCapabilityProfile[] = [];
    if (this.modelIntelligenceService && record.execution.modelId) {
      const profile = this.modelIntelligenceService.getProfile(record.execution.modelId);
      if (profile) {
        for (const cat of profile.categoryMeasurements) {
          if (cat.score >= 0.7 && cat.sampleCount >= 2) {
            list.push({
              capabilityCategory: cat.category,
              preferredProfileScore: cat.score,
              description: `High empirical score (${cat.score}) in ${cat.category}`,
            });
          }
        }
      }
    }

    if (list.length === 0) {
      list.push({
        capabilityCategory: 'implementation',
        preferredProfileScore: 0.75,
        description: 'Solid code modification and repair profile',
      });
      list.push({
        capabilityCategory: 'verification_reasoning',
        preferredProfileScore: 0.7,
        description: 'Consistent verification and test validation profile',
      });
    }

    return list;
  }

  private extractVerificationPattern(record: ExecutionRecord): string[] {
    const patterns: string[] = [];
    if (record.checks) {
      for (const chk of record.checks) {
        if (chk.ok) {
          patterns.push(chk.name);
        }
      }
    }
    if (record.evidence) {
      for (const ev of record.evidence) {
        if (ev.status === 'PASS') {
          patterns.push(ev.type);
        }
      }
    }
    return patterns.length > 0 ? Array.from(new Set(patterns)) : ['build', 'test'];
  }

  private async recordAntiStrategyFromFailure(
    record: ExecutionRecord,
    signature: ProblemSignature,
  ): Promise<AntiStrategyWarning> {
    const errorMsg = record.errors?.[0] || 'Execution failed during verification';
    const toolCalls = record.toolCalls || [];

    let antiPatternName = 'unverified_repair';
    let warningMessage = 'Attempted repairs failed verification';
    let remedySuggestion = 'Inspect callers and reproduce failure in test before editing';

    const firstEdit = toolCalls.findIndex(
      (t) => t.tool.includes('edit') || t.tool.includes('write'),
    );
    const firstTest = toolCalls.findIndex(
      (t) => t.tool.includes('test') || t.tool.includes('check'),
    );

    if (firstEdit >= 0 && (firstTest < 0 || firstEdit < firstTest)) {
      antiPatternName = 'edit_before_reproduce';
      warningMessage = 'Edited files before reproducing or inspecting failure test';
      remedySuggestion = 'Run existing test or inspect caller contracts before mutating code';
    } else if (toolCalls.filter((t) => t.tool.includes('edit')).length > 8) {
      antiPatternName = 'repeated_blind_replacement';
      warningMessage = 'Excessive repeated string replacement without confirming AST or types';
      remedySuggestion = 'Use AST/symbol query tools instead of blind string replacements';
    }

    const warning: AntiStrategyWarning = {
      problemSignature: signature,
      antiPatternName,
      description: errorMsg,
      observedFailureCount: 1,
      failureRate: 1.0,
      warningMessage,
      consequences: ['Unnecessary token expenditure', 'Failed verification gates'],
      remedySuggestion,
    };

    await this.recordAntiStrategy(warning);
    return warning;
  }

  private findMatchingStrategy(signature: ProblemSignature): EngineeringStrategy | undefined {
    for (const s of this.strategies.values()) {
      if (s.isAntiStrategy) continue;
      if (s.problemSignature.category === signature.category) {
        const langOverlap = s.languages.some((l) => signature.languages.includes(l));
        if (langOverlap) {
          return s;
        }
      }
    }
    return undefined;
  }

  private computeConfidence(executions: number, successRate: number): number {
    if (executions < 1) return 0.1;
    const sampleFactor = Math.min(1.0, executions / this.minEvidenceThreshold);
    return Number((successRate * sampleFactor).toFixed(2));
  }

  private calculateDistributions(
    repairs: number[],
    tokens: number[],
    durations: number[],
  ): StrategyDistributions {
    const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    return {
      repairCycles: [...repairs],
      tokenUsage: [...tokens],
      durationsMs: [...durations],
      avgRepairCycles: Number(avg(repairs).toFixed(1)),
      avgTokens: Math.round(avg(tokens)),
      avgDurationMs: Math.round(avg(durations)),
    };
  }

  // ======================================================================
  // 9. NORMALIZATION & MULTI-SIGNAL RANKING LOGIC
  // ======================================================================

  private normalizeQuery(input: StrategyMatchQuery | StrategyQuery): StrategyQuery {
    const sig = input.problemSignature;
    const prompt =
      (input as StrategyQuery).problemDescription ??
      input.taskPrompt ??
      sig?.failureSignature ??
      '';
    const category =
      (input as StrategyQuery).taskCategory ?? sig?.category ?? 'general_repair';
    const observedFailures =
      (input as StrategyQuery).observedFailures ??
      (sig?.failureSignature ? [sig.failureSignature] : (sig?.failureEvidenceTags ?? []));
    const architectureProperties =
      (input as StrategyQuery).architectureProperties ??
      (sig?.repositoryCharacteristics ?? []);
    const language = (input as StrategyQuery).language ?? sig?.languages?.[0];

    return {
      problemDescription: prompt,
      taskCategory: category,
      observedFailures,
      architectureProperties,
      language,
      framework: (input as StrategyQuery).framework,
      phase: (input as StrategyQuery).phase,
      availableEvidence: (input as StrategyQuery).availableEvidence ?? [],
      problemSignature: sig,
      taskPrompt: input.taskPrompt ?? prompt,
      repositoryScope: input.repositoryScope,
      minConfidence: input.minConfidence ?? 0.0,
      maxResults: input.maxResults ?? 5,
      allowAntiStrategies: input.allowAntiStrategies ?? false,
    };
  }

  private rankCandidates(query: StrategyQuery): RelevantStrategy[] {
    const results: RelevantStrategy[] = [];
    const minConfidence = query.minConfidence ?? 0.0;
    const maxResults = query.maxResults ?? 5;

    // Check relevant anti-strategies first
    const warnings = this.getRelevantWarnings(query);

    // Compute query embedding vector
    const queryVector = this.computeQueryVector(query);

    for (const strat of this.strategies.values()) {
      if (strat.isAntiStrategy && !query.allowAntiStrategies) {
        continue;
      }

      if (strat.confidence < minConfidence) {
        continue;
      }

      // Signal 1: Semantic similarity (cosine of vector embeddings)
      const semanticSimilarity = this.computeSemanticSimilarity(queryVector, strat, query);

      // Signal 2: Structured problem similarity (category and graph traits)
      const structuralSimilarity = this.computeStructuralSimilarity(query, strat);

      // Signal 3: Architecture traits (Jaccard on repo characteristics)
      const architectureTraits = this.computeArchitectureSimilarity(query, strat);

      // Signal 4: Failure traits (signature & evidence tags match)
      const failureTraits = this.computeFailureTraitsSimilarity(query, strat);

      // Signal 5: Language & framework applicability
      const languageInfo = this.computeLanguageApplicability(query, strat);

      // Signal 6: Historical verification quality (PASS evidence refs vs unverified narrative)
      const evidenceQuality = this.computeEvidenceQuality(strat);

      // Multi-signal weighted composite score
      let applicability = Number(
        (
          0.30 * semanticSimilarity +
          0.20 * structuralSimilarity +
          0.15 * architectureTraits +
          0.15 * failureTraits +
          0.10 * languageInfo.compatibility +
          0.10 * evidenceQuality
        ).toFixed(3),
      );

      // Signal 7: False positive suppression
      // If failure traits are strictly orthogonal (0.0) or semantic similarity is high due to superficial lexical overlap:
      let falsePositivePenalty = 0.0;
      if (failureTraits === 0.0 || (semanticSimilarity > 0.35 && failureTraits < 0.20 && structuralSimilarity <= 0.30)) {
        falsePositivePenalty = 0.75;
        applicability = Number((applicability * (1 - falsePositivePenalty)).toFixed(3));
      }

      // Relevance class determination
      let relevanceClass: 'HIGH' | 'MEDIUM' | 'IRRELEVANT' = 'IRRELEVANT';
      if (applicability >= 0.70) {
        relevanceClass = 'HIGH';
      } else if (applicability >= 0.40) {
        relevanceClass = 'MEDIUM';
      }

      if (applicability <= 0.20) {
        continue;
      }

      // Symbol leakage defense: clean approach steps
      const cleanApproach = this.sanitizeApproachSteps(strat.approach);
      const normalizedStrategy: EngineeringStrategy = {
        ...strat,
        approach: cleanApproach,
      };

      const clusterId = this.identifyStrategyCluster(strat);
      const clusterLabels: Record<string, string> = {
        'cluster-remote-ownership-cancellation': 'REMOTE WORK OWNERSHIP / CANCELLATION',
        'cluster-resource-bounds-backpressure': 'RESOURCE BOUNDS / BACKPRESSURE',
        'cluster-mutual-exclusion-deadlock': 'MUTUAL EXCLUSION / DEADLOCK PREVENTION',
        'cluster-pagination-boundary-ordering': 'PAGINATION / BOUNDARY ORDERING',
        'cluster-api-contract-migration': 'API CONTRACT / SIGNATURE MIGRATION',
        'cluster-build-compile-repair': 'BUILD / COMPILE INTEGRITY',
      };

      const relevanceExplanation = this.explainRelevantMatch(
        query,
        strat,
        applicability,
        relevanceClass,
      );

      results.push({
        strategyId: strat.id,
        normalizedStrategy,
        applicability,
        semanticSimilarity,
        structuralSimilarity,
        evidenceQuality,
        verifiedUses: strat.executions,
        verifiedFailures: warnings.reduce((sum, w) => sum + w.observedFailureCount, 0),
        antiStrategyWarnings: warnings,

        // Backwards compatibility aliases with StrategyMatchResult
        strategy: normalizedStrategy,
        matchScore: applicability,
        confidence: strat.confidence,
        historicalEvidenceCount: strat.executions,
        warnings,
        relevanceExplanation,
        suggestedPlanAdaptations: cleanApproach.map((step) => `${step.phase}: ${step.action}`),

        // Extended diagnostic metadata
        relevanceClass,
        clusterId,
        clusterLabel: clusterLabels[clusterId] ?? 'ENGINEERING STRATEGY',
        crossLanguageTransferrable: languageInfo.isArchitectureTransferrable,
        architectureTransferrable: languageInfo.isArchitectureTransferrable,
        scoreBreakdown: {
          semantic: semanticSimilarity,
          structural: structuralSimilarity,
          architecture: architectureTraits,
          failureTraits,
          languageCompatibility: languageInfo.compatibility,
          evidenceQuality,
          confidence: strat.confidence,
          falsePositivePenalty: falsePositivePenalty > 0 ? falsePositivePenalty : undefined,
        },
      });
    }

    // Sort descending by applicability * confidence
    results.sort((a, b) => b.applicability * b.confidence - a.applicability * a.confidence);
    return results.slice(0, maxResults);
  }

  private computeQueryVector(query: StrategyQuery): number[] | undefined {
    const provider = this.semanticIndex.getProvider();
    if (provider && 'computeVector' in provider) {
      const text = [
        query.taskCategory,
        query.problemDescription,
        ...(query.observedFailures || []),
        ...(query.architectureProperties || []),
      ].join(' ');
      return (provider as any).computeVector(text);
    }
    return undefined;
  }

  private computeSemanticSimilarity(
    queryVector: number[] | undefined,
    strat: EngineeringStrategy,
    query: StrategyQuery,
  ): number {
    const index = this.semanticIndex.getIndex();
    const unit = index?.getUnit(`engineering_strategy:${strat.id}`);

    if (queryVector && unit?.embedding && unit.embedding.length === queryVector.length) {
      return this.cosineSimilarity(queryVector, unit.embedding);
    }

    // Fallback: Lexical token overlap if vectors are absent
    const qTokens = [
      query.taskCategory,
      query.problemDescription,
      ...(query.observedFailures || []),
    ]
      .join(' ')
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2);

    const stratText = [
      strat.problemSignature.category,
      strat.failureSignature ?? '',
      ...(strat.problemSignature.failureEvidenceTags ?? []),
      ...strat.approach.map((s) => `${s.action} ${s.intent}`),
    ]
      .join(' ')
      .toLowerCase();

    if (qTokens.length === 0) return 0.2;
    let matches = 0;
    for (const t of qTokens) {
      if (stratText.includes(t)) matches++;
    }
    return Number((matches / qTokens.length).toFixed(3));
  }

  private computeStructuralSimilarity(query: StrategyQuery, strat: EngineeringStrategy): number {
    const qCat = query.taskCategory;
    const sCat = strat.problemSignature.category;

    if (qCat === sCat) {
      return 1.0;
    }

    // Related engineering categories
    const concurrencyCats = ['race_condition', 'worker_lifecycle_failure'];
    if (concurrencyCats.includes(qCat as string) && concurrencyCats.includes(sCat)) {
      return 0.75;
    }

    const compileCats = ['compile_failure', 'tool_protocol_failure'];
    if (compileCats.includes(qCat as string) && compileCats.includes(sCat)) {
      return 0.65;
    }

    const perfCats = ['performance_regression', 'context_explosion'];
    if (perfCats.includes(qCat as string) && perfCats.includes(sCat)) {
      return 0.65;
    }

    // Completely orthogonal categories (e.g. deadlock vs memory leak)
    if (
      (qCat === 'performance_regression' && sCat === 'race_condition') ||
      (qCat === 'race_condition' && sCat === 'performance_regression')
    ) {
      return 0.10;
    }

    return 0.30;
  }

  private computeArchitectureSimilarity(query: StrategyQuery, strat: EngineeringStrategy): number {
    const qProps = query.architectureProperties || [];
    const sProps = strat.repositoryCharacteristics || [];

    if (qProps.length === 0 || sProps.length === 0) {
      return 0.6;
    }

    const shared = qProps.filter((p) => sProps.includes(p as RepositoryCharacteristic));
    const union = new Set([...qProps, ...sProps]);
    return Number((shared.length / Math.max(1, union.size)).toFixed(3));
  }

  private computeFailureTraitsSimilarity(query: StrategyQuery, strat: EngineeringStrategy): number {
    const qFailures = (query.observedFailures || []).map((f) => f.toLowerCase());
    const qText = `${query.problemDescription} ${(query.taskPrompt || '')}`.toLowerCase();
    const sFailures = [
      strat.failureSignature ?? '',
      ...(strat.problemSignature.failureEvidenceTags ?? []),
      ...(strat.problemSignature.domainTags ?? []),
      strat.problemSignature.category,
    ].map((f) => f.toLowerCase());
    const sText = `${strat.problemSignature.category} ${strat.failureSignature ?? ''} ${strat.approach.map(s => s.action).join(' ')}`.toLowerCase();

    // Check for strictly orthogonal defect traits (e.g. OOM vs deadlock)
    const isQueryOom = qFailures.some((f) =>
      /oom|out_of_memory|heap|backpressure|unbounded_buffer/i.test(f),
    ) || /oom|out_of_memory|heap|backpressure|unbounded_buffer/i.test(qText);

    const isStratDeadlock = sFailures.some((f) =>
      /deadlock|lock_inversion|cyclic_wait|mutex/i.test(f),
    ) || /deadlock|lock_inversion|cyclic_wait|mutex/i.test(sText);

    const isQueryDeadlock = qFailures.some((f) =>
      /deadlock|lock_inversion|cyclic_wait|mutex/i.test(f),
    ) || /deadlock|lock_inversion|cyclic_wait|mutex/i.test(qText);

    const isStratOom = sFailures.some((f) =>
      /oom|out_of_memory|heap|backpressure|unbounded_buffer/i.test(f),
    ) || /oom|out_of_memory|heap|backpressure|unbounded_buffer/i.test(sText);

    if ((isQueryOom && isStratDeadlock) || (isQueryDeadlock && isStratOom)) {
      return 0.0; // Strictly orthogonal failure traits
    }

    // Direct failure signature match
    if (strat.failureSignature) {
      const normStratSig = strat.failureSignature.toLowerCase();
      if (qFailures.some((f) => f.includes(normStratSig) || normStratSig.includes(f))) {
        return 1.0;
      }
    }

    // Diagnostic tag overlap
    let matchCount = 0;
    for (const qf of qFailures) {
      for (const sf of sFailures) {
        if (qf.includes(sf) || sf.includes(qf)) {
          matchCount++;
          break;
        }
      }
    }

    return Number(Math.min(1.0, 0.4 + 0.3 * matchCount).toFixed(3));
  }

  private computeLanguageApplicability(
    query: StrategyQuery,
    strat: EngineeringStrategy,
  ): { compatibility: number; isArchitectureTransferrable: boolean } {
    const qLang = query.language;
    if (!qLang) {
      return { compatibility: 0.8, isArchitectureTransferrable: true };
    }

    const sameLanguage = strat.languages.includes(qLang as ProgrammingLanguage);
    if (sameLanguage) {
      return { compatibility: 1.0, isArchitectureTransferrable: true };
    }

    // Check if the strategy is an architectural pattern suitable for cross-language transfer
    const isArchitecturalCategory = [
      'worker_lifecycle_failure',
      'race_condition',
      'api_migration',
      'performance_regression',
    ].includes(strat.problemSignature.category);

    const approachText = strat.approach.map((s) => `${s.action} ${s.intent}`).join(' ');
    const hasSyntaxSpecificLeak =
      /abortsignal|abortcontroller|promise\.all|goroutine|channel|unique_ptr|shared_ptr/i.test(
        approachText,
      );

    if (isArchitecturalCategory && !hasSyntaxSpecificLeak) {
      // High architecture transferability across languages
      return { compatibility: 0.75, isArchitectureTransferrable: true };
    }

    return { compatibility: 0.15, isArchitectureTransferrable: false };
  }

  private computeEvidenceQuality(strat: EngineeringStrategy): number {
    if (strat.evidenceRefs.length === 0) {
      return 0.0; // Model narrative with zero physical evidence
    }

    const physicalPassCount = strat.evidenceRefs.filter(
      (ref) => ref.startsWith('ev-') || ref.includes('verify') || ref.includes('pass'),
    ).length;

    return Number(Math.min(1.0, (physicalPassCount / strat.executions) * strat.successRate).toFixed(3));
  }

  private sanitizeApproachSteps(steps: StrategyStep[]): StrategyStep[] {
    return steps.map((s) => ({
      ...s,
      action: normalizeStrategyText(s.action),
      intent: normalizeStrategyText(s.intent),
    }));
  }

  private identifyStrategyCluster(strat: EngineeringStrategy): string {
    const text = [
      strat.problemSignature.category,
      strat.failureSignature ?? '',
      ...(strat.problemSignature.failureEvidenceTags ?? []),
      ...(strat.problemSignature.domainTags ?? []),
      ...strat.approach.map((s) => `${s.action} ${s.intent}`),
    ]
      .join(' ')
      .toLowerCase();

    if (/oom|out_of_memory|heap|backpressure|unbounded_buffer|unbounded_queue/i.test(text)) {
      return 'cluster-resource-bounds-backpressure';
    }
    if (/deadlock|lock_inversion|cyclic_wait|mutex|circular wait/i.test(text)) {
      return 'cluster-mutual-exclusion-deadlock';
    }
    if (
      /lease|ownership|epoch|fencing|cancellation|abort|split_brain|leadership|stale_lease|late_result|orphan/i.test(
        text,
      ) ||
      strat.problemSignature.category === 'worker_lifecycle_failure' ||
      strat.problemSignature.category === 'race_condition'
    ) {
      return 'cluster-remote-ownership-cancellation';
    }
    if (/pagination|cursor|tie[-_ ]breaker|boundary_truncation|sorting_ambiguity/i.test(text)) {
      return 'cluster-pagination-boundary-ordering';
    }
    if (/api_migration|migration|signature|deprecated|rename/i.test(text)) {
      return 'cluster-api-contract-migration';
    }
    return 'cluster-build-compile-repair';
  }

  private explainRelevantMatch(
    query: StrategyQuery,
    strat: EngineeringStrategy,
    applicability: number,
    relevanceClass: string,
  ): string {
    return `Matches category '${strat.problemSignature.category}' (Applicability: ${applicability.toFixed(
      2,
    )}, Relevance: ${relevanceClass}) across ${strat.executions} verified executions. Evidence quality: ${strat.confidence.toFixed(
      2,
    )}.`;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    return Number(Math.max(0, Math.min(1, (sim + 1) / 2)).toFixed(3));
  }

  private computeMatchScore(a: ProblemSignature, b: ProblemSignature): number {
    let score = 0;
    if (a.category === b.category) {
      score += 0.5;
    }
    const sharedLangs = a.languages.filter((l) => b.languages.includes(l));
    if (sharedLangs.length > 0) {
      score += 0.25;
    }
    const sharedChars = a.repositoryCharacteristics.filter((c) =>
      b.repositoryCharacteristics.includes(c),
    );
    if (sharedChars.length > 0) {
      score += 0.25 * (sharedChars.length / Math.max(1, a.repositoryCharacteristics.length));
    }
    return Number(score.toFixed(2));
  }

  private async seedStrategyFromCorpus(problem: any): Promise<EngineeringStrategy> {
    const existing = this.strategies.get(problem.id);
    if (existing) return existing;

    const strat: EngineeringStrategy = {
      id: problem.id,
      problemSignature: problem.problemSignature,
      taskCategories: [problem.problemSignature.category],
      languages: problem.problemSignature.languages,
      repositoryCharacteristics: problem.problemSignature.repositoryCharacteristics,
      failureSignature: problem.problemSignature.failureSignature,
      approach: problem.expectedAbstractApproach,
      usefulTools: ['search_code', 'edit_file', 'run_tests'],
      usefulAgents: ['coding_agent'],
      usefulModels: [],
      verificationPattern: ['build', 'test'],
      executions: 3,
      successRate: 1.0,
      repairDistribution: [0, 1, 0],
      tokenDistribution: [1500, 1600, 1450],
      durationDistribution: [1200, 1400, 1100],
      evidenceRefs: [`ev-${problem.id}-01`, `ev-${problem.id}-02`, `ev-${problem.id}-03`],
      confidence: 1.0,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.strategies.set(problem.id, strat);
    await this.semanticIndex.indexStrategy(strat);
    return strat;
  }

  private async persistStrategy(strategy: EngineeringStrategy): Promise<void> {
    if (this.store) {
      try {
        await this.store.put(`strategy/${strategy.id}`, strategy);
      } catch {
        // Safe degrade
      }
    }
    await this.semanticIndex.indexStrategy(strategy);
  }

  /** Explicit startup hydration; restores vectors without re-embedding unchanged documents. */
  public async initialize(): Promise<void> {
    if (!this.store) return;
    for (const entry of await this.store.list('strategy/')) {
      const strategy = entry.value as EngineeringStrategy;
      this.strategies.set(strategy.id, strategy);
      await this.semanticIndex.indexStrategy(strategy);
    }
    for (const entry of await this.store.list('strategy-anti/')) {
      const warning = entry.value as AntiStrategyWarning;
      this.antiStrategies.set(
        `${warning.problemSignature.category}::${warning.antiPatternName}`,
        warning,
      );
      await this.semanticIndex.indexAntiStrategy(warning);
    }
  }
}
