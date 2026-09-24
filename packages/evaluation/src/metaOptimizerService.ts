import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type {
  OptimizableConfig,
  ConfigMutation,
  MetaOptimizationCandidate,
  MetaOptimizationRunResult,
  BenchmarkTask,
  BenchmarkRunner,
} from '@wazir/core';
import { BenchmarkService } from './benchmarkService.js';
import { EvaluationService } from './evaluationService.js';

export const DEFAULT_OPTIMIZABLE_CONFIG: OptimizableConfig = {
  id: 'cfg-default',
  version: 1,
  prompts: {
    systemPromptPrefix: 'You are Wazir, an autonomous software-engineering control plane.',
    repairGuidance: 'Formulate deterministic repairs with passing tests before completion.',
    verificationInstruction: 'Every mutation must be verified against build and test oracles.',
  },
  contextWeights: {
    definitionRelevance: 1.0,
    callersRelevance: 0.8,
    testsRelevance: 0.9,
    recencyRelevance: 0.5,
    errorSignalRelevance: 1.2,
  },
  governanceLimits: {
    maxTokens: 50_000,
    maxCostUSD: 1.0,
    maxToolCalls: 20,
    maxRepairCycles: 3,
  },
  toolPolicies: {
    codeModeThreshold: 3,
    batchExecutionAllowed: true,
    autoVerifyAfterMutation: true,
  },
};

export interface MetaOptimizerOptions {
  benchmarkService: BenchmarkService;
  evaluationService?: EvaluationService;
  store?: KeyValueStore;
  initialConfig?: OptimizableConfig;
  requireStrictImprovement?: boolean; // default true
}

export class MetaOptimizerService {
  private readonly benchmarkService: BenchmarkService;
  private readonly evaluationService: EvaluationService;
  private readonly store?: KeyValueStore;
  private activeConfig: OptimizableConfig;
  private readonly requireStrictImprovement: boolean;
  private history: MetaOptimizationRunResult[] = [];

  constructor(options: MetaOptimizerOptions) {
    this.benchmarkService = options.benchmarkService;
    this.evaluationService = options.evaluationService ?? new EvaluationService();
    this.store = options.store;
    this.activeConfig = options.initialConfig ?? structuredClone(DEFAULT_OPTIMIZABLE_CONFIG);
    this.requireStrictImprovement = options.requireStrictImprovement ?? true;
  }

  public getActiveConfig(): OptimizableConfig {
    return structuredClone(this.activeConfig);
  }

  public proposeCandidate(mutations: ConfigMutation[]): MetaOptimizationCandidate {
    let mutated = structuredClone(this.activeConfig);
    mutated.version += 1;
    mutated.id = `cfg-${randomUUID()}`;

    for (const m of mutations) {
      mutated = this.applyMutationToConfig(mutated, m);
    }

    return {
      candidateId: mutated.id,
      mutations,
      config: mutated,
    };
  }

  private applyMutationToConfig(config: OptimizableConfig, mutation: ConfigMutation): OptimizableConfig {
    const clone = structuredClone(config);
    const parts = mutation.path.split('.');
    let curr: any = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      curr[parts[i]] = curr[parts[i]] ?? {};
      curr = curr[parts[i]];
    }
    curr[parts[parts.length - 1]] = mutation.newValue;
    return clone;
  }

  /**
   * Empirically evaluates candidate mutations against a benchmark suite.
   * Enforces WAZIR INVARIANTS:
   * - MODEL CLAIM != EXECUTION EVIDENCE: Decisions are based purely on physical execution
   *   and benchmark scores, never hypothetical or unverified claims.
   * - ZERO REGRESSION TOLERANCE: Any regression on previously passing benchmark tasks results in immediate rejection.
   * - STRICT EMPIRICAL IMPROVEMENT: Candidates are only accepted if pass rate increases,
   *   or pass rate is preserved while reducing cost, tokens, or latency.
   */
  public async evaluateCandidate(
    candidate: MetaOptimizationCandidate,
    runner: BenchmarkRunner,
    tasks?: BenchmarkTask[],
  ): Promise<MetaOptimizationRunResult> {
    const benchmarkTasks = tasks ?? this.benchmarkService.listTasks();
    if (benchmarkTasks.length === 0) {
      throw new Error('No benchmark tasks available to evaluate candidate configuration.');
    }

    const runId = `opt-run-${randomUUID()}`;
    const baselineConfig = this.getActiveConfig();

    // 1. Run baseline benchmark
    const baselineBenchmark = await this.benchmarkService.runBenchmarkSuite(
      benchmarkTasks,
      runner,
      { suiteName: `baseline-${baselineConfig.id}` },
    );

    // 2. Run candidate benchmark
    const candidateBenchmark = await this.benchmarkService.runBenchmarkSuite(
      benchmarkTasks,
      runner,
      { suiteName: `candidate-${candidate.config.id}` },
    );

    // 3. Compare suites
    const comparison = this.benchmarkService.compareSuites(baselineBenchmark, candidateBenchmark);

    // 4. Invariant checks and decision logic
    const reasons: string[] = [];
    let decision: 'ACCEPTED' | 'REJECTED' = 'REJECTED';

    if (comparison.regressionDetected) {
      decision = 'REJECTED';
      reasons.push(
        `REGRESSION_DETECTED: Candidate broke ${comparison.regressedTasks.length} previously passing task(s): ${comparison.regressedTasks.join(', ')}`,
      );
    } else if (comparison.passRateDelta < 0) {
      decision = 'REJECTED';
      reasons.push(
        `PASS_RATE_REGRESSION: Candidate pass rate decreased by ${(Math.abs(comparison.passRateDelta) * 100).toFixed(1)}%`,
      );
    } else if (comparison.passRateDelta > 0) {
      decision = 'ACCEPTED';
      reasons.push(
        `PASS_RATE_IMPROVEMENT: Candidate strictly improved pass rate by ${(comparison.passRateDelta * 100).toFixed(1)}%`,
      );
    } else {
      // Pass rate is identical. Check resource efficiency gains
      const costReduced = comparison.costDelta < -0.0001;
      const tokensReduced = comparison.tokenUsageDelta < -10;
      const latencyReduced = comparison.durationDelta < -50;

      if (costReduced || tokensReduced || latencyReduced) {
        decision = 'ACCEPTED';
        reasons.push(
          `EFFICIENCY_IMPROVEMENT: Maintained ${(comparison.candidatePassRate * 100).toFixed(1)}% pass rate with improved resource efficiency (cost delta: ${comparison.costDelta.toFixed(4)}, tokens delta: ${comparison.tokenUsageDelta}, latency delta: ${comparison.durationDelta.toFixed(0)}ms)`,
        );
      } else {
        decision = 'REJECTED';
        reasons.push(
          'NO_EMPIRICAL_ADVANTAGE: Candidate showed neither pass rate improvement nor significant resource reduction.',
        );
      }
    }

    const runResult: MetaOptimizationRunResult = {
      runId,
      baselineConfig,
      candidateConfig: candidate.config,
      mutations: candidate.mutations,
      baselineBenchmark,
      candidateBenchmark,
      comparison,
      decision,
      reasons,
      evaluatedAt: new Date(),
    };

    // 5. If accepted, promote candidate to active configuration
    if (decision === 'ACCEPTED') {
      this.activeConfig = candidate.config;
      if (this.store) {
        await this.store.put('meta_optimizer/active_config', this.activeConfig);
      }
    }

    // 6. Record run history
    this.history.push(runResult);
    if (this.store) {
      await this.store.put(`meta_optimizer/runs/${runId}`, runResult);
    }

    return runResult;
  }

  /**
   * Runs an optimization loop for N iterations, evaluating generated mutations.
   */
  public async optimizeLoop(
    runner: BenchmarkRunner,
    mutationGenerator: (iteration: number, currentConfig: OptimizableConfig) => ConfigMutation[],
    iterations: number,
    tasks?: BenchmarkTask[],
  ): Promise<MetaOptimizationRunResult[]> {
    const results: MetaOptimizationRunResult[] = [];

    for (let i = 0; i < iterations; i++) {
      const mutations = mutationGenerator(i, this.getActiveConfig());
      if (mutations.length === 0) continue;

      const candidate = this.proposeCandidate(mutations);
      const result = await this.evaluateCandidate(candidate, runner, tasks);
      results.push(result);
    }

    return results;
  }

  /**
   * Rolls back the active configuration to a previous run's baseline or to default.
   */
  public async rollback(runId?: string): Promise<OptimizableConfig> {
    if (runId) {
      const found = this.history.find((r) => r.runId === runId);
      if (found) {
        this.activeConfig = found.baselineConfig;
      }
    } else if (this.history.length > 0) {
      const last = this.history[this.history.length - 1];
      this.activeConfig = last.baselineConfig;
    } else {
      this.activeConfig = structuredClone(DEFAULT_OPTIMIZABLE_CONFIG);
    }

    if (this.store) {
      await this.store.put('meta_optimizer/active_config', this.activeConfig);
    }

    return this.getActiveConfig();
  }

  public getHistory(): MetaOptimizationRunResult[] {
    return [...this.history];
  }
}
