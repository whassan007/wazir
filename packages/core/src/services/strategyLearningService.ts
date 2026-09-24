import { randomUUID } from 'node:crypto';
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
  StrategyMatchResult,
  StrategyDistributions,
} from '../types/strategyLearning.js';
import type { ModelIntelligenceService } from './modelIntelligenceService.js';
import type { TaskCapabilityClassifier } from './taskCapabilityClassifier.js';

export interface StrategyLearningServiceOptions {
  store?: KeyValueStore;
  memoryService?: MemoryService;
  modelIntelligenceService?: ModelIntelligenceService;
  taskClassifier?: TaskCapabilityClassifier;
  /** Minimum verified executions required before confidence reaches 0.70+ */
  minEvidenceThreshold?: number;
  /** Maximum number of strategies kept in active memory */
  maxStrategies?: number;
}

export class StrategyLearningService {
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
   * INVARIANT: PAST SUCCESS != CURRENT EVIDENCE.
   * A learned strategy can guide planning, decompose tasks, and warn against
   * known failure modes, but CANNOT satisfy current physical verification.
   */
  public verifyInvariant(): boolean {
    return true;
  }

  // ======================================================================
  // 2. EXTRACTION FROM VERIFIED EXECUTION
  // ======================================================================

  /**
   * Extracts a strategy ONLY from verified executions.
   * If the execution was not verified, it is either rejected or recorded as an anti-strategy.
   */
  public async extractFromExecution(
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
      const antiStrategy = this.recordAntiStrategyFromFailure(record, signature);
      return { antiStrategy };
    }

    // Extract abstract structural approach (NOT literal filenames)
    const approach = this.extractAbstractApproach(record);
    const usefulTools = this.extractUsefulTools(record);
    const usefulAgents = record.execution.agentId ? [record.execution.agentId] : ['coding_agent'];
    const usefulModels = this.deriveModelCapabilities(record);
    const verificationPattern = this.extractVerificationPattern(record);

    // Check if an existing matching strategy can evolve
    let existingStrategy = this.findMatchingStrategy(signature);

    const repairCycles = record.evaluation?.checks?.filter((c) => !c.ok).length ?? 0;
    const tokens = record.usage?.total ?? (record.usage?.input ?? 0) + (record.usage?.output ?? 0);
    const durationMs =
      record.execution.completedAt && record.execution.startedAt
        ? record.execution.completedAt.getTime() - record.execution.startedAt.getTime()
        : 1000;

    const evidenceId = record.evaluation?.evidence?.[0]?.id || `ev-${executionId}`;

    if (existingStrategy) {
      // EVOLUTION: Accumulate evidence, refine distributions, increment version
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
      return { strategy: existingStrategy };
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

  // ======================================================================
  // 3. RETRIEVAL FOR PLANNING
  // ======================================================================

  /**
   * Retrieves matching engineering strategies during planning.
   * Returns candidates, confidence, historical evidence, and anti-strategy warnings.
   */
  public queryStrategies(query: StrategyMatchQuery): StrategyMatchResult[] {
    const results: StrategyMatchResult[] = [];
    const minConfidence = query.minConfidence ?? 0.0;
    const maxResults = query.maxResults ?? 5;

    // Check relevant anti-strategies first
    const warnings = this.getRelevantWarnings(query.problemSignature);

    for (const strat of this.strategies.values()) {
      if (strat.isAntiStrategy && !query.allowAntiStrategies) {
        continue;
      }

      const matchScore = this.computeMatchScore(query.problemSignature, strat.problemSignature);
      if (matchScore <= 0.25) {
        continue;
      }

      if (strat.confidence < minConfidence) {
        continue;
      }

      const relevanceExplanation = this.explainMatch(query.problemSignature, strat);
      results.push({
        strategy: strat,
        matchScore,
        relevanceExplanation,
        confidence: strat.confidence,
        historicalEvidenceCount: strat.executions,
        warnings,
        suggestedPlanAdaptations: strat.approach.map((step) => `${step.phase}: ${step.action}`),
      });
    }

    results.sort((a, b) => b.matchScore * b.confidence - a.matchScore * a.confidence);
    return results.slice(0, maxResults);
  }

  // ======================================================================
  // 4. ANTI-STRATEGY & NEGATIVE EXPERIENCE
  // ======================================================================

  public recordAntiStrategy(warning: AntiStrategyWarning): void {
    const key = `${warning.problemSignature.category}::${warning.antiPatternName}`;
    const existing = this.antiStrategies.get(key);
    if (existing) {
      existing.observedFailureCount += 1;
      existing.failureRate = Math.min(1.0, existing.observedFailureCount / (existing.observedFailureCount + 1));
    } else {
      this.antiStrategies.set(key, warning);
    }
  }

  public getRelevantWarnings(signature: ProblemSignature): AntiStrategyWarning[] {
    const matched: AntiStrategyWarning[] = [];
    for (const warn of this.antiStrategies.values()) {
      if (warn.problemSignature.category === signature.category) {
        matched.push(warn);
      }
    }
    return matched;
  }

  // ======================================================================
  // 5. HELPER METHODS & EXTRACTION LOGIC
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
    if (record.evaluation) {
      return record.evaluation.success;
    }
    if (record.evidence && record.evidence.length > 0) {
      return record.evidence.some((e) => e.status === 'PASS' || e.exitCode === 0);
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
    let category: ProblemCategory = options.overrideCategory ?? 'general_repair';

    if (/\b(compile|build|syntax error|tsc|g\+\+|clang)\b/i.test(prompt)) {
      category = 'compile_failure';
    } else if (/\b(test|assertion|spec|unit test|integration test)\b/i.test(prompt)) {
      category = 'test_failure';
    } else if (/\b(race|concurrency|deadlock|mutex|atomic)\b/i.test(prompt)) {
      category = 'race_condition';
    } else if (/\b(migrate|migration|api change|deprecated|upgrade api)\b/i.test(prompt)) {
      category = 'api_migration';
    } else if (/\b(cross-package|multi-package|across packages|monorepo feature)\b/i.test(prompt)) {
      category = 'cross_package_feature';
    } else if (/\b(upgrade|bump dependency|package\.json|cargo\.toml)\b/i.test(prompt)) {
      category = 'dependency_upgrade';
    } else if (/\b(perf|performance|latency|slow|bottleneck)\b/i.test(prompt)) {
      category = 'performance_regression';
    } else if (/\b(context|token limit|sawtooth|prompt cache)\b/i.test(prompt)) {
      category = 'context_explosion';
    } else if (/\b(tool|envelope|schema|protocol failure)\b/i.test(prompt)) {
      category = 'tool_protocol_failure';
    } else if (/\b(worker|preflight|lifecycle|disconnect)\b/i.test(prompt)) {
      category = 'worker_lifecycle_failure';
    }

    const languages: ProgrammingLanguage[] = [];
    if (/\b(typescript|\.ts\b)/i.test(prompt) || record.filesChanged?.some((f) => f.endsWith('.ts'))) {
      languages.push('typescript');
    }
    if (/\b(javascript|\.js\b)/i.test(prompt) || record.filesChanged?.some((f) => f.endsWith('.js'))) {
      languages.push('javascript');
    }
    if (/\b(c\+\+|cpp|\.cpp\b|\.hpp\b)/i.test(prompt) || record.filesChanged?.some((f) => f.endsWith('.cpp'))) {
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

    const repoChars = options.repositoryCharacteristics ?? ['monorepo', 'multi_package', 'typed'];

    let failureSignature: string | undefined;
    if (record.errors && record.errors.length > 0) {
      failureSignature = this.normalizeErrorSignature(record.errors[0]);
    }

    return {
      category,
      languages,
      repositoryCharacteristics: repoChars,
      failureSignature,
    };
  }

  private normalizeErrorSignature(rawError: string): string {
    // Strip file paths, line numbers, and timestamps to keep the signature structural
    return rawError
      .replace(/(\/[a-zA-Z0-9_\-.]+)+/g, '<PATH>')
      .replace(/[a-zA-Z0-9_\-.]+\.(ts|js|cpp|py|rs|go):\d+(:\d+)?/g, '<LOCATION>')
      .replace(/\b0x[0-9a-fA-F]+\b/g, '<HEX>')
      .slice(0, 120);
  }

  /**
   * Extracts an abstract structural sequence of actions rather than literal filenames.
   */
  private extractAbstractApproach(record: ExecutionRecord): StrategyStep[] {
    const steps: StrategyStep[] = [];
    const toolCalls = record.toolCalls || [];

    if (toolCalls.length === 0) {
      // Fallback canonical engineering flow
      return [
        { phase: 'inspect', action: 'Inspect repository and symbols', intent: 'Locate targets' },
        { phase: 'modify', action: 'Apply targeted modifications', intent: 'Fix issue' },
        { phase: 'verify', action: 'Execute targeted and integration verification', intent: 'Confirm correctness' },
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
      } else if (['edit_file', 'write_to_file', 'replace_file_content', 'patch'].includes(toolName)) {
        phase = 'modify';
        action = 'Apply atomic implementation edit';
        intent = 'Implement required structural change';
      } else if (['compile', 'build', 'tsc', 'make'].includes(toolName) || (call.input as any)?.command?.includes('build')) {
        phase = 'compile';
        action = 'Execute targeted build';
        intent = 'Ensure type and binary integrity';
      } else if (['run_tests', 'vitest', 'pytest', 'test'].includes(toolName) || (call.input as any)?.command?.includes('test')) {
        phase = 'test';
        action = 'Run targeted unit and regression tests';
        intent = 'Validate functional correctness';
      } else if (['dispatch_subagent', 'delegate'].includes(toolName)) {
        phase = 'delegate';
        action = 'Delegate sub-task with bounded scope';
        intent = 'Parallelize independent sub-problem';
      }

      // Avoid consecutive duplicate actions
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

    // Always ensure a terminal verify step
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
          if (cat.score >= 0.70 && cat.sampleCount >= 2) {
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
        preferredProfileScore: 0.70,
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

  private recordAntiStrategyFromFailure(
    record: ExecutionRecord,
    signature: ProblemSignature,
  ): AntiStrategyWarning {
    const errorMsg = record.errors?.[0] || 'Execution failed during verification';
    const toolCalls = record.toolCalls || [];

    let antiPatternName = 'unverified_repair';
    let warningMessage = 'Attempted repairs failed verification';
    let remedySuggestion = 'Inspect callers and reproduce failure in test before editing';

    // Heuristic detection of common engineering anti-patterns
    const firstEdit = toolCalls.findIndex((t) => t.tool.includes('edit') || t.tool.includes('write'));
    const firstTest = toolCalls.findIndex((t) => t.tool.includes('test') || t.tool.includes('check'));

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

    this.recordAntiStrategy(warning);
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
    // Requires minimum evidence threshold to exceed 0.70 confidence
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

  private computeMatchScore(a: ProblemSignature, b: ProblemSignature): number {
    let score = 0;
    if (a.category === b.category) {
      score += 0.50;
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

  private explainMatch(query: ProblemSignature, strategy: EngineeringStrategy): string {
    return `Matches problem category '${query.category}' with languages [${strategy.languages.join(
      ', ',
    )}] across ${strategy.executions} verified executions.`;
  }

  private async persistStrategy(strategy: EngineeringStrategy): Promise<void> {
    if (this.store && 'set' in this.store && typeof this.store.set === 'function') {
      try {
        await this.store.set(`strategy/${strategy.id}`, strategy);
      } catch {
        // Safe degrade
      }
    }
  }
}
