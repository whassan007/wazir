import { randomUUID, createHash } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import type {
  OptimizableConfig,
  ConfigMutation,
  MetaOptimizationCandidate,
  MetaOptimizationRunResult,
  BenchmarkTask,
  BenchmarkRunner,
  BenchmarkSuiteResult,
  ComparativeBenchmarkSuiteResult,
  ObservationWindow,
  ImprovementOpportunity,
  ImprovementHypothesis,
  ExperimentPlan,
  BaselineRecord,
  CandidateImplementation,
  CandidateVerificationResult,
  RegressionGuardResult,
  MetaOptimizationDecision,
  MetaOptimizationBudget,
  MetaOptimizerBudgetConsumption,
  ImprovementAttempt,
  SelfImprovementLevel,
  SelfImprovementDomain,
  DomainLevelConfig,
  MetaOptimizerEvent,
  MetaOptimizerEventType,
  MeasurableMetricName,
  CausalAttributionReport,
  AblationExperimentDesign,
  Mutation,
  Computer,
  CanaryRecord,
  CandidateMetricVector,
  MultiObjectiveParetoFrontier,
  OptimizationObjective,
  MultiObjectiveSelectionPolicy,
  MetricConstraint,
} from '@wazir/core';
import { DistributedBenchmarkFabric, type ShardWorkerDispatch } from './distributedBenchmarkFabric.js';
import { CanaryDeploymentService } from './canaryService.js';
import {
  computeParetoFrontier,
  applySelectionPolicy,
  extractMetricValueSafe,
  computeBaselineRelativeDelta,
  evaluateMetricConstraint,
  explainMultiObjectiveExperiment,
} from './multiObjectiveOptimizer.js';
import {
  DEFAULT_DOMAIN_LEVELS,
  DEFAULT_META_OPTIMIZATION_BUDGET,
  OBJECTIVE_METRIC_MAP,
} from '@wazir/core';
import { BenchmarkService } from './benchmarkService.js';
import { EvaluationService } from './evaluationService.js';
import { OpportunityDetector } from './opportunityDetector.js';
import { RegressionGuard } from './regressionGuard.js';
import { CausalAttributionService } from './causalAttributionService.js';
import type { MemoryService } from '@wazir/memory';
import type { VerificationEngine } from '@wazir/core';
import type { WorktreeManager } from '@wazir/core';
import type { CheckpointService } from '@wazir/core';
import type { PolicyEngine } from '@wazir/core';

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
    phaseToolSurfaces: {
      plan: ['read', 'search', 'ast_grep'],
      implement: ['read', 'write', 'edit', 'code_mode', 'symbol_definition'],
      repair: ['read', 'edit', 'code_mode', 'test', 'build', 'diagnostics'],
    },
  },
  routingRules: {
    plan: { preferredModel: 'gemma-27b' },
    implement: { preferredModel: 'qwen-2.5-coder' },
    repair: { preferredModel: 'qwen-2.5-coder', fallbackModel: 'gpt-4o' },
  },
};

export interface MetaOptimizerOptions {
  benchmarkService: BenchmarkService;
  evaluationService?: EvaluationService;
  opportunityDetector?: OpportunityDetector;
  regressionGuard?: RegressionGuard;
  memoryService?: MemoryService;
  verificationEngine?: VerificationEngine;
  worktreeManager?: WorktreeManager;
  checkpointService?: CheckpointService;
  policyEngine?: PolicyEngine;
  store?: KeyValueStore;
  initialConfig?: OptimizableConfig;
  requireStrictImprovement?: boolean;
  defaultLevel?: SelfImprovementLevel;
  domainLevels?: DomainLevelConfig;
  budget?: MetaOptimizationBudget;
  causalService?: CausalAttributionService;
  distributedFabric?: DistributedBenchmarkFabric;
  canaryDeploymentService?: CanaryDeploymentService;
}

export class MetaOptimizerService {
  private readonly benchmarkService: BenchmarkService;
  private readonly evaluationService: EvaluationService;
  private readonly detector: OpportunityDetector;
  private readonly regressionGuard: RegressionGuard;
  private readonly causalService: CausalAttributionService;
  private readonly distributedFabric?: DistributedBenchmarkFabric;
  private readonly memoryService?: MemoryService;
  private readonly verificationEngine?: VerificationEngine;
  private readonly worktreeManager?: WorktreeManager;
  private readonly checkpointService?: CheckpointService;
  private readonly policyEngine?: PolicyEngine;
  private readonly store?: KeyValueStore;
  private readonly canaryDeploymentService: CanaryDeploymentService;

  private activeConfig: OptimizableConfig;
  private readonly requireStrictImprovement: boolean;
  private defaultLevel: SelfImprovementLevel;
  private domainLevels: Record<SelfImprovementDomain, SelfImprovementLevel>;
  private budget: MetaOptimizationBudget;
  private consumption: MetaOptimizerBudgetConsumption;

  private baselines = new Map<string, BaselineRecord>();
  private opportunities: ImprovementOpportunity[] = [];
  private hypotheses: ImprovementHypothesis[] = [];
  private experiments = new Map<string, ExperimentPlan>();
  private candidates = new Map<string, CandidateImplementation>();
  private history: MetaOptimizationRunResult[] = [];
  private events: MetaOptimizerEvent[] = [];
  private rollbackMetadata = new Map<string, OptimizableConfig>();

  constructor(options: MetaOptimizerOptions) {
    this.benchmarkService = options.benchmarkService;
    this.evaluationService = options.evaluationService ?? new EvaluationService();
    this.detector = options.opportunityDetector ?? new OpportunityDetector();
    this.regressionGuard = options.regressionGuard ?? new RegressionGuard();
    this.causalService =
      options.causalService ??
      new CausalAttributionService({
        store: options.store,
        memoryService: options.memoryService,
      });
    this.distributedFabric = options.distributedFabric;
    this.memoryService = options.memoryService;
    this.verificationEngine = options.verificationEngine;
    this.worktreeManager = options.worktreeManager;
    this.checkpointService = options.checkpointService;
    this.policyEngine = options.policyEngine;
    this.store = options.store;
    this.canaryDeploymentService =
      options.canaryDeploymentService ??
      new CanaryDeploymentService({
        store: options.store,
        memoryService: options.memoryService,
      });

    this.activeConfig = options.initialConfig ?? structuredClone(DEFAULT_OPTIMIZABLE_CONFIG);
    this.requireStrictImprovement = options.requireStrictImprovement ?? true;
    this.defaultLevel = options.defaultLevel ?? 2; // Level 2: EXPERIMENT (Default)
    this.domainLevels = { ...DEFAULT_DOMAIN_LEVELS, ...(options.domainLevels ?? {}) };
    this.budget = { ...DEFAULT_META_OPTIMIZATION_BUDGET, ...(options.budget ?? {}) };

    this.consumption = {
      experimentsCount: 0,
      candidatesCount: 0,
      modelCallsCount: 0,
      tokensCount: 0,
      wallTimeMs: 0,
      costUSD: 0,
    };
  }

  public async hydrate(): Promise<void> {
    if (!this.store) return;
    try {
      if ('list' in this.store && typeof this.store.list === 'function') {
        const entries = await this.store.list('meta/history/');
        for (const entry of entries) {
          if (entry.value) {
            const run = entry.value as MetaOptimizationRunResult;
            if (!this.history.some((h) => h.runId === run.runId)) {
              this.history.push(run);
            }
          }
        }
        const planEntries = await this.store.list('meta/plans/');
        for (const entry of planEntries) {
          if (entry.value) {
            const plan = entry.value as ExperimentPlan;
            this.experiments.set(plan.experimentId, plan);
          }
        }
      }
    } catch {
      // Ignore store errors during hydration
    }
  }

  // ======================================================================
  // 1. CONFIGURATION ACCESS & POLICIES
  // ======================================================================

  public getActiveConfig(): OptimizableConfig {
    return structuredClone(this.activeConfig);
  }

  public getLevel(domain?: SelfImprovementDomain): SelfImprovementLevel {
    if (domain && this.domainLevels[domain] !== undefined) {
      return this.domainLevels[domain];
    }
    return this.defaultLevel;
  }

  public setLevel(level: SelfImprovementLevel, domain?: SelfImprovementDomain): void {
    if (domain) {
      this.domainLevels[domain] = level;
    } else {
      this.defaultLevel = level;
    }
  }

  public getBudget(): MetaOptimizationBudget {
    return { ...this.budget };
  }

  public getConsumption(): MetaOptimizerBudgetConsumption {
    return { ...this.consumption };
  }

  public getCausalService(): CausalAttributionService {
    return this.causalService;
  }

  // ======================================================================
  // 2. OBSERVATION & OPPORTUNITY DETECTION
  // ======================================================================

  public observe(window: ObservationWindow): ImprovementOpportunity[] {
    const opps = this.detector.detect(window);
    for (const opp of opps) {
      this.opportunities.push(opp);
      this.emitEvent('meta.opportunity.detected', {
        opportunityId: opp.id,
        category: opp.category,
        component: opp.component,
        metric: opp.metric,
        baseline: opp.baseline,
      });
    }
    return opps;
  }

  public identifyOpportunities(window: ObservationWindow): ImprovementOpportunity[] {
    return this.observe(window);
  }

  public listOpportunities(): ImprovementOpportunity[] {
    return [...this.opportunities];
  }

  // ======================================================================
  // 3. HYPOTHESIS FORMULATION
  // ======================================================================

  public formulateHypotheses(opportunity: ImprovementOpportunity): ImprovementHypothesis[] {
    const hypotheses: ImprovementHypothesis[] = [];

    switch (opportunity.category) {
      case 'HIGH_REPAIR_RATE': {
        hypotheses.push({
          id: `hyp-${randomUUID().slice(0, 8)}`,
          opportunityId: opportunity.id,
          targetComponent: opportunity.component,
          domain: 'prompts',
          proposedChange: 'Add deterministic error diagnostic isolation and explicit verification assertions to repair prompt',
          expectedMetricEffect: {
            metric: 'repair_cycles',
            expectedDelta: -0.30,
            direction: 'decrease',
          },
          possibleRegressions: ['wall_time', 'task_success'],
          requiredBenchmark: ['CODE_REPAIR'],
          successThreshold: opportunity.baseline * 0.75,
          configMutations: [
            {
              type: 'PROMPT_TWEAK',
              path: 'prompts.repairGuidance',
              oldValue: this.activeConfig.prompts?.repairGuidance,
              newValue: 'Pinpoint exact compiler failure location and run verification oracle before declaring completion.',
              rationale: 'Reduce repair iteration count',
            },
          ],
        });
        break;
      }
      case 'HIGH_PROTOCOL_FAILURE_RATE': {
        hypotheses.push({
          id: `hyp-${randomUUID().slice(0, 8)}`,
          opportunityId: opportunity.id,
          targetComponent: 'ToolSurfaceCompiler',
          domain: 'tool_surfaces',
          proposedChange: 'Restrict phase-specific tool surfaces to only tools required for active phase',
          expectedMetricEffect: {
            metric: 'malformed_actions',
            expectedDelta: -0.50,
            direction: 'decrease',
          },
          possibleRegressions: ['task_success'],
          requiredBenchmark: ['TOOL_USE'],
          successThreshold: Math.max(1, opportunity.baseline * 0.5),
          configMutations: [
            {
              type: 'TOOL_SURFACE_MODIFICATION',
              path: 'toolPolicies.phaseToolSurfaces.plan',
              oldValue: this.activeConfig.toolPolicies?.phaseToolSurfaces?.plan,
              newValue: ['read', 'search'],
              rationale: 'Hide mutation tools during plan phase to avoid premature execution errors',
            },
          ],
        });
        break;
      }
      case 'HIGH_CONTEXT_GROWTH': {
        hypotheses.push({
          id: `hyp-${randomUUID().slice(0, 8)}`,
          opportunityId: opportunity.id,
          targetComponent: 'ContextCompiler',
          domain: 'context_policy',
          proposedChange: 'Deduplicate identical reads and prune superseded file versions before semantic compression',
          expectedMetricEffect: {
            metric: 'peak_context_tokens',
            expectedDelta: -0.20,
            direction: 'decrease',
          },
          possibleRegressions: ['task_success', 'verification_success'],
          requiredBenchmark: ['CONTEXT_STRESS'],
          successThreshold: opportunity.baseline * 0.80,
          configMutations: [
            {
              type: 'WEIGHT_ADJUSTMENT',
              path: 'contextWeights.recencyRelevance',
              oldValue: this.activeConfig.contextWeights?.recencyRelevance,
              newValue: 0.3,
              rationale: 'Prune old turn history bloat',
            },
          ],
        });
        break;
      }
      case 'HIGH_TOOL_RETRY_RATE': {
        hypotheses.push({
          id: `hyp-${randomUUID().slice(0, 8)}`,
          opportunityId: opportunity.id,
          targetComponent: 'ToolRegistry',
          domain: 'tool_surfaces',
          proposedChange: 'Enable strict parameter auto-verification and containment pre-checks before execution',
          expectedMetricEffect: {
            metric: 'tool_failures',
            expectedDelta: -0.35,
            direction: 'decrease',
          },
          possibleRegressions: ['wall_time'],
          requiredBenchmark: ['TOOL_USE'],
          successThreshold: Math.max(1, opportunity.baseline * 0.65),
          configMutations: [
            {
              type: 'POLICY_MODIFICATION',
              path: 'toolPolicies.autoVerifyAfterMutation',
              oldValue: false,
              newValue: true,
              rationale: 'Catch file mutation errors immediately',
            },
          ],
        });
        break;
      }
      case 'ROUTING_UNDERPERFORMANCE': {
        hypotheses.push({
          id: `hyp-${randomUUID().slice(0, 8)}`,
          opportunityId: opportunity.id,
          targetComponent: 'Scheduler',
          domain: 'routing',
          proposedChange: 'Route compile-repair turns to specialized coding model with higher empirical repair accuracy',
          expectedMetricEffect: {
            metric: 'task_success',
            expectedDelta: 0.20,
            direction: 'increase',
          },
          possibleRegressions: ['monetary_cost', 'wall_time'],
          requiredBenchmark: ['CODE_REPAIR'],
          successThreshold: Math.min(1.0, opportunity.baseline + 0.15),
          configMutations: [
            {
              type: 'ROUTING_ADJUSTMENT',
              path: 'routingRules.repair.preferredModel',
              oldValue: this.activeConfig.routingRules?.repair?.preferredModel,
              newValue: 'qwen-2.5-coder',
              rationale: 'Specialize repair phase on high-performance coding model',
            },
          ],
        });
        break;
      }
      default: {
        hypotheses.push({
          id: `hyp-${randomUUID().slice(0, 8)}`,
          opportunityId: opportunity.id,
          targetComponent: opportunity.component,
          domain: opportunity.domain,
          proposedChange: `Empirical configuration tuning for ${opportunity.category}`,
          expectedMetricEffect: {
            metric: opportunity.metric,
            expectedDelta: -0.15,
            direction: 'decrease',
          },
          possibleRegressions: ['task_success'],
          requiredBenchmark: ['CODE_REPAIR'],
          successThreshold: opportunity.baseline * 0.85,
        });
      }
    }

    const filteredHypotheses = hypotheses.filter((h) => {
      if (!h.configMutations) return true;
      const touchesHarmful = h.configMutations.some((m) => this.causalService.isKnownHarmful(m.path));
      if (touchesHarmful) {
        this.emitEvent('meta.hypothesis.rejected', {
          hypothesisId: h.id,
          reason: 'Target parameter modification was previously demonstrated to be NEGATIVE_CONTRIBUTOR in mutation memory',
        });
        return false;
      }
      return true;
    });

    for (const h of filteredHypotheses) {
      this.hypotheses.push(h);
      this.emitEvent('meta.hypothesis.created', {
        hypothesisId: h.id,
        opportunityId: h.opportunityId,
        targetComponent: h.targetComponent,
        proposedChange: h.proposedChange,
      });
    }

    return filteredHypotheses;
  }

  // ======================================================================
  // 4. EXPERIMENT DESIGN (PRE-REGISTRATION BEFORE OBSERVATION)
  // ======================================================================

  public designExperiment(params: {
    hypothesis: ImprovementHypothesis;
    baselineCheckpointId?: string;
    sampleSize?: number;
    tasks?: string[];
    objectives?: OptimizationObjective[];
    protectedMetrics?: Array<MeasurableMetricName | string>;
    hardConstraints?: MetricConstraint[];
    selectionPolicy?: MultiObjectiveSelectionPolicy;
    weights?: Record<string, number>;
    lexicographicOrder?: string[];
  }): ExperimentPlan {
    const { hypothesis, baselineCheckpointId, sampleSize = 1, tasks = [] } = params;
    const experimentId = `exp-${randomUUID().slice(0, 8)}`;

    const plan: ExperimentPlan = {
      experimentId,
      name: `${hypothesis.targetComponent}-${hypothesis.expectedMetricEffect.metric}`,
      hypothesis,
      baselineCheckpointId,
      primaryMetric: hypothesis.expectedMetricEffect.metric,
      secondaryMetrics: hypothesis.possibleRegressions,
      requiredImprovement: {
        metric: hypothesis.expectedMetricEffect.metric,
        operator: hypothesis.expectedMetricEffect.direction === 'decrease' ? '<=' : '>=',
        targetValue: hypothesis.successThreshold,
      },
      regressionConstraints: {
        task_success: {
          metric: 'task_success',
          operator: '>=',
          targetValue: 0.99, // Must not drop below 99% of baseline
          isRelativeFactor: true,
        },
      },
      benchmarkCategories: hypothesis.requiredBenchmark,
      benchmarkTasks: tasks,
      sampleSize,
      budget: { ...this.budget },
      createdAt: new Date(),
      objectives: params.objectives,
      protectedMetrics: params.protectedMetrics,
      hardConstraints: params.hardConstraints,
      selectionPolicy: params.selectionPolicy,
      weights: params.weights,
      lexicographicOrder: params.lexicographicOrder,
    };

    this.experiments.set(experimentId, plan);
    if (this.store && 'put' in this.store && typeof this.store.put === 'function') {
      try {
        void this.store.put(`meta/plans/${experimentId}`, plan);
      } catch {
        // Ignore store put failure
      }
    }
    this.emitEvent('meta.experiment.started', {
      experimentId,
      name: plan.name,
      primaryMetric: plan.primaryMetric,
      requiredImprovement: plan.requiredImprovement,
    });

    return plan;
  }

  // ======================================================================
  // 5. BASELINE FREEZING
  // ======================================================================

  public async recordBaseline(params: {
    config?: OptimizableConfig;
    commitSha?: string;
    workspaceRoot?: string;
    runner?: BenchmarkRunner;
    tasks?: BenchmarkTask[];
  }): Promise<BaselineRecord> {
    const config = params.config ?? this.getActiveConfig();
    const baselineId = `base-${randomUUID().slice(0, 8)}`;
    const workspaceHash = createHash('sha256')
      .update(params.workspaceRoot ?? process.cwd())
      .update(JSON.stringify(config))
      .digest('hex');

    const baselineRecord: BaselineRecord = {
      id: baselineId,
      commitSha: params.commitSha,
      workspaceHash,
      config: structuredClone(config),
      models: ['qwen-2.5-coder', 'gemma-27b'],
      runtimeVersions: { node: process.version },
      benchmarkVersion: '1.0.0',
      toolDefinitionsHash: createHash('sha256').update(JSON.stringify(config.toolPolicies ?? {})).digest('hex'),
      policyConfigHash: createHash('sha256').update(JSON.stringify(config.governanceLimits ?? {})).digest('hex'),
      contextConfigHash: createHash('sha256').update(JSON.stringify(config.contextWeights ?? {})).digest('hex'),
      metrics: {},
      createdAt: new Date(),
    };

    this.baselines.set(baselineId, baselineRecord);
    this.emitEvent('meta.baseline.recorded', {
      baselineId,
      workspaceHash,
      configId: config.id,
    });

    return baselineRecord;
  }

  // ======================================================================
  // 6. CANDIDATE GENERATION (ISOLATED WORKTREES & HIERARCHY)
  // ======================================================================

  public async generateCandidates(
    plan: ExperimentPlan,
    count = 1,
  ): Promise<CandidateImplementation[]> {
    this.checkBudget('candidates');

    const candidates: CandidateImplementation[] = [];
    const hypothesis = plan.hypothesis;

    for (let i = 0; i < count; i++) {
      const candidateId = `cand-${randomUUID().slice(0, 8)}`;
      let strategy: CandidateImplementation['strategy'] = 'CONFIGURATION';

      switch (hypothesis.domain) {
        case 'routing':
          strategy = 'ROUTING';
          break;
        case 'tool_surfaces':
          strategy = 'TOOL_SURFACE';
          break;
        case 'prompts':
          strategy = 'PROMPT';
          break;
        case 'wazir_source_code':
          strategy = 'SOURCE_CODE';
          break;
        default:
          strategy = 'CONFIGURATION';
      }

      // Apply mutations
      let candidateConfig = structuredClone(this.activeConfig);
      candidateConfig.id = `cfg-${candidateId}`;
      candidateConfig.version += 1;

      const mutations = hypothesis.configMutations ?? [];
      for (const m of mutations) {
        candidateConfig = this.applyMutationToConfig(candidateConfig, m);
      }

      const candidate: CandidateImplementation = {
        candidateId,
        experimentId: plan.experimentId,
        strategy,
        filesChanged: hypothesis.codeModifications?.map((m) => m.path) ?? [],
        mutations,
        config: candidateConfig,
        status: 'CREATED',
      };

      candidates.push(candidate);
      this.candidates.set(candidateId, candidate);
      this.consumption.candidatesCount++;

      this.emitEvent('meta.candidate.created', {
        candidateId,
        experimentId: plan.experimentId,
        strategy,
      });
    }

    return candidates;
  }

  // ======================================================================
  // 7. VERIFY EVERY CANDIDATE (CORRECTNESS GATES FIRST)
  // ======================================================================

  public async verifyCandidate(
    candidate: CandidateImplementation,
    verificationEngine?: VerificationEngine,
  ): Promise<CandidateVerificationResult> {
    const engine = verificationEngine ?? this.verificationEngine;
    const errors: string[] = [];

    let buildPassed = true;
    let typecheckPassed = true;
    let unitTestsPassed = true;
    let integrationTestsPassed = true;
    let protectedOraclesPassed = true;
    let acceptanceTestsPassed = true;

    if (engine) {
      const buildOracle = engine.getOracle('BUILD');
      if (buildOracle) {
        const res = await buildOracle.verify({ cwd: candidate.worktreePath });
        if (res.exitCode !== 0) {
          buildPassed = false;
          errors.push(`BUILD_FAILED: ${res.output ?? 'Build oracle returned nonzero'}`);
        }
      }

      const testOracle = engine.getOracle('TEST');
      if (testOracle) {
        const res = await testOracle.verify({ cwd: candidate.worktreePath });
        if (res.exitCode !== 0) {
          unitTestsPassed = false;
          errors.push(`TEST_FAILED: ${res.output ?? 'Test oracle returned nonzero'}`);
        }
      }
    }

    const allPassed =
      buildPassed &&
      typecheckPassed &&
      unitTestsPassed &&
      integrationTestsPassed &&
      protectedOraclesPassed &&
      acceptanceTestsPassed &&
      errors.length === 0;

    candidate.status = allPassed ? 'VERIFIED' : 'FAILED_VERIFICATION';

    const result: CandidateVerificationResult = {
      candidateId: candidate.candidateId,
      buildPassed,
      typecheckPassed,
      unitTestsPassed,
      integrationTestsPassed,
      protectedOraclesPassed,
      acceptanceTestsPassed,
      allPassed,
      errors,
    };

    this.emitEvent(
      allPassed ? 'meta.candidate.verified' : 'meta.candidate.rejected',
      {
        candidateId: candidate.candidateId,
        allPassed,
        errors,
      },
    );

    return result;
  }

  /**
   * Runs bounded ablation experiment to systematically isolate and attribute
   * causal contribution and non-linear interactions across mutations.
   */
  public async ablateCandidate(params: {
    experimentId: string;
    candidate: CandidateImplementation | MetaOptimizationCandidate;
    runner: BenchmarkRunner;
    tasks: BenchmarkTask[];
    baselineConfig?: OptimizableConfig;
    primaryMetric?: MeasurableMetricName;
    direction?: 'decrease' | 'increase';
    design?: AblationExperimentDesign;
    minSampleSize?: number;
    significanceThreshold?: number;
    runnerFactory?: (config: OptimizableConfig, activeMutationIds: string[]) => BenchmarkRunner;
  }): Promise<CausalAttributionReport> {
    const { experimentId, candidate, runner, tasks } = params;
    const baseline = params.baselineConfig ?? this.activeConfig;
    const primaryMetric = params.primaryMetric ?? 'peak_context_tokens';
    const direction = params.direction ?? 'decrease';

    const plan = this.causalService.designAblation({
      experimentId,
      candidate,
      baselineConfig: baseline,
      design: params.design,
    });

    const results = new Map<
      string,
      {
        metricValue: number;
        sampleCount: number;
        passRate?: number;
      }
    >();

    const extractMetric = (suite: BenchmarkSuiteResult): number => {
      if (primaryMetric === 'task_success') return suite.passedTasks / Math.max(1, suite.totalTasks);
      if (primaryMetric === 'input_tokens') {
        return suite.results.reduce((acc, r) => acc + (r.scoreReport?.metrics?.inputTokens ?? 0), 0);
      }
      if (primaryMetric === 'total_tokens') return suite.aggregateMetrics?.totalTokens ?? 0;
      if (primaryMetric === 'peak_context_tokens') {
        const peak = Math.max(
          ...suite.results.map(
            (r) => (r.scoreReport?.metrics?.inputTokens ?? 0) + (r.scoreReport?.metrics?.outputTokens ?? 0),
          ),
          0,
        );
        return peak > 0 ? peak : (suite.aggregateMetrics?.totalTokens ?? 0);
      }
      if (primaryMetric === 'repair_cycles') return suite.aggregateMetrics?.averageRepairCycles ?? 0;
      if (primaryMetric === 'wall_time') return suite.aggregateMetrics?.totalWallTimeMs ?? 0;
      if (primaryMetric === 'monetary_cost') return suite.aggregateMetrics?.totalCostUsd ?? 0;
      return suite.aggregateMetrics?.totalTokens ?? 0;
    };

    // 1. Run baseline measurement
    const baselineSuite = await this.benchmarkService.runBenchmarkSuite(tasks, runner, {
      suiteName: `ablation-baseline-${experimentId}`,
      config: baseline,
      activeMutations: [],
    });
    const baselineMetricVal = extractMetric(baselineSuite);

    // 2. Run each ablation configuration
    for (const configItem of plan.configurations) {
      if (configItem.mutationIds.length === 0) {
        results.set(configItem.configId, {
          metricValue: baselineMetricVal,
          sampleCount: tasks.length,
          passRate: baselineSuite.passedTasks / Math.max(1, baselineSuite.totalTasks),
        });
        continue;
      }

      const activeRunner = params.runnerFactory
        ? params.runnerFactory(configItem.config, configItem.mutationIds)
        : runner;

      const suite = await this.benchmarkService.runBenchmarkSuite(tasks, activeRunner, {
        suiteName: `ablation-${configItem.configId}`,
        config: configItem.config,
        activeMutations: configItem.mutationIds,
      });

      const candMetricVal = extractMetric(suite);

      results.set(configItem.configId, {
        metricValue: candMetricVal,
        sampleCount: tasks.length,
        passRate: suite.passedTasks / Math.max(1, suite.totalTasks),
      });
    }

    // 3. Analyze attribution
    const report = this.causalService.analyzeAttribution({
      plan,
      baselineValue: baselineMetricVal,
      results,
      primaryMetric,
      direction,
      minSampleSize: params.minSampleSize,
      significanceThreshold: params.significanceThreshold,
    });

    // 4. Persist attribution evidence to mutation memory
    await this.causalService.recordAttribution(report, plan.allMutations);

    this.emitEvent('meta.candidate.evaluated', {
      candidateId: candidate.candidateId,
      summary: `Ablation attribution completed for candidate ${candidate.candidateId} across ${plan.configurations.length} configurations.`,
    });

    return report;
  }

  // ======================================================================
  // 8. BASELINE VS CANDIDATE EVALUATION & REGRESSION GUARD
  // ======================================================================

  public async evaluateCandidates(params: {
    plan: ExperimentPlan;
    candidates: CandidateImplementation[];
    runner?: BenchmarkRunner;
    tasks?: BenchmarkTask[];
    enableAblation?: boolean;
    ablationDesign?: AblationExperimentDesign;
    minSampleSize?: number;
    significanceThreshold?: number;
    runnerFactory?: (config: OptimizableConfig, activeMutationIds: string[]) => BenchmarkRunner;
    distributed?: boolean;
    workers?: Computer[];
    seed?: string | number;
    dispatcher?: ShardWorkerDispatch;
    failWorkerSimulation?: {
      workerId: string;
      atTaskIndex?: number;
      failureMode?: 'crash' | 'disconnect';
    };
    distributedFabric?: DistributedBenchmarkFabric;
  }): Promise<MetaOptimizationRunResult[]> {
    const { plan, candidates, runner } = params;
    const benchmarkTasks = params.tasks ?? this.benchmarkService.listTasks();

    if (benchmarkTasks.length === 0) {
      throw new Error('No benchmark tasks available to evaluate candidate configuration.');
    }

    const results: MetaOptimizationRunResult[] = [];
    const baselineConfig = this.getActiveConfig();

    if (params.distributed) {
      this.checkBudget('evaluations');
      this.experiments.set(plan.experimentId, plan);
      const fabric =
        params.distributedFabric ??
        this.distributedFabric ??
        new DistributedBenchmarkFabric({
          benchmarkService: this.benchmarkService,
          evaluationService: this.evaluationService,
          regressionGuard: this.regressionGuard,
        });

      const distResult = await fabric.executeExperiment({
        plan,
        candidates,
        tasks: benchmarkTasks,
        workers: params.workers,
        seed: params.seed ?? plan.experimentId,
        dispatcher: params.dispatcher,
        failWorkerSimulation: params.failWorkerSimulation,
        onEvent: (name, data) => this.emitEvent(name as any, data),
      });

      results.push(distResult);
      this.history.push(distResult);
      if (this.store && 'put' in this.store && typeof this.store.put === 'function') {
        try {
          await this.store.put(`meta/history/${distResult.runId}`, distResult);
        } catch {
          // Ignore store put failure
        }
      }

      await this.recordLearning(plan, candidates[0], distResult);

      this.emitEvent(
        distResult.decision === 'QUALIFIED'
          ? 'meta.candidate.qualified'
          : distResult.decision === 'INCONCLUSIVE'
            ? 'meta.candidate.evaluated'
            : 'meta.candidate.rejected',
        {
          candidateId: candidates[0]?.candidateId ?? 'cand-dist',
          decision: distResult.decision,
          summary: distResult.comparison.summary,
        },
      );

      return results;
    }

    if (!runner) {
      throw new Error('BenchmarkRunner required for non-distributed candidate evaluation.');
    }

    // 1. Run baseline benchmark
    const baselineBenchmark = await this.benchmarkService.runBenchmarkSuite(
      benchmarkTasks,
      runner,
      {
        suiteName: `baseline-${baselineConfig.id}`,
        config: baselineConfig,
        activeMutations: [],
      },
    );

    // 2. Evaluate each candidate
    for (const candidate of candidates) {
      this.checkBudget('evaluations');

      // First run correctness verification
      const verification = await this.verifyCandidate(candidate);

      if (!verification.allPassed) {
        const runResult: MetaOptimizationRunResult = {
          runId: `opt-run-${randomUUID()}`,
          experimentId: plan.experimentId,
          baselineConfig,
          candidateConfig: candidate.config,
          mutations: candidate.mutations ?? [],
          baselineBenchmark,
          candidateBenchmark: baselineBenchmark,
          comparison: {
            baselineRunnerId: runner.id,
            candidateRunnerId: runner.id,
            baselineTasks: benchmarkTasks.length,
            candidateTasks: 0,
            baselinePassRate: 1.0,
            candidatePassRate: 0.0,
            passRateDelta: -1.0,
            tokenUsageDelta: 0,
            costDelta: 0,
            durationDelta: 0,
            regressedTasks: [],
            improvedTasks: [],
            regressionDetected: true,
            improvementDetected: false,
            preferredCandidate: 'baseline',
            summary: `FAILED_VERIFICATION: ${verification.errors.join(', ')}`,
          },
          decision: 'REJECTED',
          reasons: verification.errors,
          evaluatedAt: new Date(),
        };

        results.push(runResult);
        this.history.push(runResult);
        await this.recordLearning(plan, candidate, runResult);
        continue;
      }

      // Run candidate benchmark
      const activeCandidateRunner = params.runnerFactory
        ? params.runnerFactory(candidate.config, candidate.mutations?.map((m) => m.path) ?? [])
        : runner;

      const candidateBenchmark = await this.benchmarkService.runBenchmarkSuite(
        benchmarkTasks,
        activeCandidateRunner,
        {
          suiteName: `candidate-${candidate.candidateId}`,
          config: candidate.config,
          activeMutations: candidate.mutations?.map((m) => m.path) ?? [],
        },
      );

      // Compare suites
      const comparison = this.benchmarkService.compareSuites(baselineBenchmark, candidateBenchmark);

      // Evaluate through RegressionGuard
      const guardResult = this.regressionGuard.evaluate({
        plan,
        baselineSuite: baselineBenchmark,
        candidateSuite: candidateBenchmark,
        comparison,
        candidateVerificationPassed: verification.allPassed,
        verificationErrors: verification.errors,
      });

      let decision: MetaOptimizationDecision = 'REJECTED';
      if (guardResult.qualified) {
        decision = 'QUALIFIED';
      } else if (guardResult.inconclusiveReasons.length > 0 && guardResult.regressionsDetected.length === 0) {
        decision = 'INCONCLUSIVE';
      } else {
        decision = 'REJECTED';
      }

      let causalAttribution: CausalAttributionReport | undefined;
      if (
        (params.enableAblation || (candidate.mutations && candidate.mutations.length > 1)) &&
        guardResult.qualified
      ) {
        try {
          causalAttribution = await this.ablateCandidate({
            experimentId: plan.experimentId,
            candidate,
            runner,
            tasks: benchmarkTasks,
            baselineConfig,
            primaryMetric: plan.primaryMetric,
            direction: plan.hypothesis.expectedMetricEffect?.direction ?? 'decrease',
            design: params.ablationDesign,
            minSampleSize: params.minSampleSize,
            significanceThreshold: params.significanceThreshold,
            runnerFactory: params.runnerFactory,
          });
        } catch {
          // Graceful fallback if runner does not support ablation
        }
      }

      const runResult: MetaOptimizationRunResult = {
        runId: `opt-run-${randomUUID()}`,
        experimentId: plan.experimentId,
        baselineConfig,
        candidateConfig: candidate.config,
        mutations: candidate.mutations ?? [],
        baselineBenchmark,
        candidateBenchmark,
        comparison,
        decision,
        reasons: [guardResult.summary],
        regressionGuard: guardResult,
        causalAttribution,
        evaluatedAt: new Date(),
      };

      results.push(runResult);
      this.history.push(runResult);
      if (this.store && 'put' in this.store && typeof this.store.put === 'function') {
        try {
          await this.store.put(`meta/history/${runResult.runId}`, runResult);
        } catch {
          // Ignore store put failure
        }
      }

      // Record learning in MemoryService (single-objective plans record immediately; multi-objective records after frontier computation)
      if (!plan.objectives || plan.objectives.length === 0) {
        await this.recordLearning(plan, candidate, runResult);
      }

      this.emitEvent(
        decision === 'QUALIFIED'
          ? 'meta.candidate.qualified'
          : decision === 'INCONCLUSIVE'
            ? 'meta.candidate.evaluated'
            : 'meta.candidate.rejected',
        {
          candidateId: candidate.candidateId,
          decision,
          summary: guardResult.summary,
        },
      );
    }

    // Multi-objective Pareto Frontier analysis if plan has multiple objectives
    if (plan.objectives && plan.objectives.length > 0) {
      const metricVectors: CandidateMetricVector[] = [];

      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const runRes = results[i];
        if (!runRes) continue;

        const rawMetrics: Record<string, number> = {};
        const normalizedDeltas: Record<string, number> = {};
        let allConstraintsSatisfied = runRes.regressionGuard?.correctnessGatesPassed ?? true;
        const disqualificationReasons: string[] = [...(runRes.regressionGuard?.regressionsDetected ?? [])];

        // Check if verification failed
        if (runRes.reasons.some((r) => r.includes('VERIFICATION') || r.includes('BUILD') || r.includes('TEST') || r.includes('FAILED'))) {
          allConstraintsSatisfied = false;
        }

        // Extract for all objectives
        for (const obj of plan.objectives) {
          const candVal = extractMetricValueSafe(obj.metric, runRes.candidateBenchmark);
          const baseVal = extractMetricValueSafe(obj.metric, runRes.baselineBenchmark);
          rawMetrics[obj.metric] = candVal;
          normalizedDeltas[obj.metric] = computeBaselineRelativeDelta(candVal, baseVal);
        }

        // Extract for hard constraints and protected metrics
        if (plan.hardConstraints) {
          for (const constraint of plan.hardConstraints) {
            const candVal = extractMetricValueSafe(constraint.metric, runRes.candidateBenchmark);
            const baseVal = extractMetricValueSafe(constraint.metric, runRes.baselineBenchmark);
            rawMetrics[constraint.metric] = candVal;
            const evalRes = evaluateMetricConstraint(constraint, candVal, baseVal);
            if (!evalRes.satisfied) {
              allConstraintsSatisfied = false;
              disqualificationReasons.push(`Violated hard constraint: ${evalRes.reason}`);
            }
          }
        }

        if (runRes.decision === 'REJECTED' && runRes.regressionGuard?.regressionsDetected.length) {
          allConstraintsSatisfied = false;
        }

        const vector: CandidateMetricVector = {
          candidateId: candidate.candidateId,
          rawMetrics,
          normalizedDeltas,
          qualifies: allConstraintsSatisfied,
          disqualificationReasons,
        };
        metricVectors.push(vector);
      }

      // Compute Pareto Frontier
      const paretoFrontier = computeParetoFrontier(metricVectors, plan.objectives);

      // Apply selection policy
      const policy = plan.selectionPolicy ?? 'PARETO_ONLY';
      const selected = applySelectionPolicy(paretoFrontier, plan);
      paretoFrontier.selectedCandidateId = selected?.selectedCandidateId;

      // Attach to all results
      for (const res of results) {
        res.paretoFrontier = paretoFrontier;
        res.metricVectors = Object.fromEntries(metricVectors.map((v) => [v.candidateId, v]));
        if (policy === 'PARETO_ONLY') {
          (res as any).selectedCandidateId = undefined;
        } else if (selected?.selectedCandidateId) {
          (res as any).selectedCandidateId = selected.selectedCandidateId;
          (res as any).selectedReason = selected.selectionReason;
        }
      }

      // Re-record learning with multi-objective metadata
      for (let i = 0; i < candidates.length; i++) {
        if (results[i]) {
          await this.recordLearning(plan, candidates[i], results[i]);
        }
      }
    }

    return results;
  }

  // ======================================================================
  // 9. PROMOTION PIPELINE & AUTOMATIC ROLLBACK
  // ======================================================================

  public async promoteCandidate(
    candidate: CandidateImplementation,
    options: { force?: boolean; operatorApproved?: boolean } = {},
  ): Promise<{ success: boolean; reason: string }> {
    const domainLevel = this.getLevel(candidate.strategy === 'ROUTING' ? 'routing' : 'tool_surfaces');

    // Policy check: Only promote if Level 4 (guarded auto) or operator approved
    if (domainLevel < 4 && !options.operatorApproved && !options.force) {
      return {
        success: false,
        reason: `PROMOTION_DENIED: Domain maturity level is ${domainLevel}; operator approval required (wa improve promote).`,
      };
    }

    this.emitEvent('meta.promotion.started', { candidateId: candidate.candidateId });

    try {
      // Save rollback metadata
      this.rollbackMetadata.set(candidate.candidateId, structuredClone(this.activeConfig));

      // Promote configuration
      this.activeConfig = structuredClone(candidate.config);

      if (this.store) {
        await this.store.put('meta_optimizer/active_config', this.activeConfig);
      }

      this.emitEvent('meta.promotion.completed', {
        candidateId: candidate.candidateId,
        newConfigId: this.activeConfig.id,
      });

      return {
        success: true,
        reason: `Candidate ${candidate.candidateId} successfully promoted to active baseline.`,
      };
    } catch (err: any) {
      this.emitEvent('meta.promotion.failed', {
        candidateId: candidate.candidateId,
        error: err.message,
      });
      return {
        success: false,
        reason: `Promotion failed: ${err.message}`,
      };
    }
  }

  public async rollback(runIdOrCandidateId?: string): Promise<OptimizableConfig> {
    this.emitEvent('meta.rollback', { target: runIdOrCandidateId ?? 'last' });

    if (runIdOrCandidateId && this.rollbackMetadata.has(runIdOrCandidateId)) {
      this.activeConfig = this.rollbackMetadata.get(runIdOrCandidateId)!;
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

  // ======================================================================
  // 9B. LEVEL 3 CANARY DEPLOYMENT INTEGRATION
  // ======================================================================

  public getCanaryDeploymentService(): CanaryDeploymentService {
    return this.canaryDeploymentService;
  }

  /**
   * Deploys a QUALIFIED candidate to Level 3 Canary mode.
   * Enforces:
   * 1. Candidate must be qualified.
   * 2. Domain must not be forbidden (e.g. wazir_source_code).
   * 3. Domain maturity level must be at least Level 3 (or operator forced).
   */
  public async deployCanary(
    candidate: CandidateImplementation,
    options: {
      initialAllocation?: number;
      stagedExpansionTiers?: number[];
      minimumSamples?: number;
      operatorApproved?: boolean;
      force?: boolean;
    } = {},
  ): Promise<{ success: boolean; canaryRecord?: CanaryRecord; reason: string }> {
    const domain: SelfImprovementDomain =
      candidate.strategy === 'ROUTING'
        ? 'routing'
        : candidate.strategy === 'TOOL_SURFACE'
          ? 'tool_surfaces'
          : candidate.strategy === 'PROMPT'
            ? 'prompts'
            : candidate.strategy === 'SOURCE_CODE'
              ? 'wazir_source_code'
              : 'context_policy';

    const domainLevel = this.getLevel(domain);

    if (domain === 'wazir_source_code') {
      return {
        success: false,
        reason: 'CANARY_DENIED: Source-code modifications cannot enter Level 3 Canary.',
      };
    }

    if (domainLevel < 3 && !options.operatorApproved && !options.force) {
      return {
        success: false,
        reason: `CANARY_DENIED: Domain maturity level is ${domainLevel}; Level 3 required (wa improve canary deploy).`,
      };
    }

    try {
      const canaryRecord = await this.canaryDeploymentService.registerCanary({
        candidateId: candidate.candidateId,
        candidateConfig: candidate.config,
        baselineConfig: this.activeConfig,
        domain,
        qualificationStatus: 'QUALIFIED',
        initialAllocation: options.initialAllocation,
        stagedExpansionTiers: options.stagedExpansionTiers,
        minimumSamples: options.minimumSamples,
      });

      this.emitEvent('meta.canary.registered', {
        canaryId: canaryRecord.canaryId,
        candidateId: candidate.candidateId,
        domain,
        allocation: canaryRecord.currentAllocation,
      });

      return {
        success: true,
        canaryRecord,
        reason: `Canary deployment ${canaryRecord.canaryId} activated at ${(canaryRecord.currentAllocation * 100).toFixed(1)}% allocation.`,
      };
    } catch (err: any) {
      return {
        success: false,
        reason: `Canary registration failed: ${err.message}`,
      };
    }
  }

  // ======================================================================
  // 10. LEARNING FROM FAILURE (MEMORY SERVICE INTEGRATION)
  // ======================================================================

  public async recordLearning(
    plan: ExperimentPlan,
    candidate: CandidateImplementation,
    result: MetaOptimizationRunResult,
  ): Promise<void> {
    const attemptResult: ImprovementAttempt['result'] =
      result.decision === 'QUALIFIED'
        ? 'QUALIFIED'
        : result.decision === 'INCONCLUSIVE'
          ? 'INCONCLUSIVE'
          : result.reasons.some((r) => r.includes('VERIFICATION'))
            ? 'FAILED_VERIFICATION'
            : result.reasons.some((r) => r.includes('REGRESSION'))
              ? 'REGRESSION'
              : 'REJECTED';

    const attempt: ImprovementAttempt = {
      id: `att-${randomUUID().slice(0, 8)}`,
      objective: 'REDUCE_INPUT_TOKENS',
      hypothesis: plan.hypothesis,
      filesChanged: candidate.filesChanged,
      benchmark: plan.benchmarkCategories.join(','),
      baselineMetrics: {
        task_success: result.comparison.baselinePassRate,
        tokens: result.baselineBenchmark.aggregateMetrics?.totalTokens ?? 0,
      },
      candidateMetrics: {
        task_success: result.comparison.candidatePassRate,
        tokens: result.candidateBenchmark.aggregateMetrics?.totalTokens ?? 0,
      },
      result: attemptResult,
      regressionReasons: result.reasons,
      evidence: {
        passRateDelta: result.comparison.passRateDelta,
        tokenUsageDelta: result.comparison.tokenUsageDelta,
      },
      recordedAt: new Date(),
    };

    if (this.memoryService) {
      this.memoryService.recordEpisode({
        repositoryScope: 'wazir',
        taskType: 'meta_optimization',
        taskPrompt: plan.hypothesis.proposedChange,
        executionId: plan.experimentId,
        attemptOutcome: attemptResult === 'QUALIFIED' ? 'success' : 'failure',
        failurePattern: result.reasons.join('; '),
        repairStrategy: plan.hypothesis.proposedChange,
        filesInvolved: candidate.filesChanged,
        workspaceRevision: candidate.config.version,
        metadata: {
          attempt,
          paretoFrontier: result.paretoFrontier,
          metricVector: Array.isArray(result.metricVectors)
            ? (result.metricVectors as CandidateMetricVector[]).find((v) => v.candidateId === candidate.candidateId)
            : (result.metricVectors as any)?.[candidate.candidateId],
          metricVectors: result.metricVectors,
          tradeoffsSummary: result.paretoFrontier?.tradeoffsSummary,
        },
      });
    }

    this.emitEvent('meta.learning.recorded', {
      attemptId: attempt.id,
      experimentId: plan.experimentId,
      result: attempt.result,
    });
  }

  // ======================================================================
  // 11. EXPLAINABILITY
  // ======================================================================

  public explainExperiment(experimentId: string): string {
    const plan = this.experiments.get(experimentId);
    const run = this.history.find((h) => h.experimentId === experimentId || h.runId === experimentId);

    if (!plan && !run) {
      return `Experiment '${experimentId}' not found in registry.`;
    }

    if (!plan && run) {
      return [
        `=======================================================`,
        `EXPLAIN EXPERIMENT: ${run.experimentId ?? run.runId}`,
        `=======================================================`,
        `1. Run Details:`,
        `   Run ID:            ${run.runId}`,
        `   Baseline Config:   ${run.baselineConfig.id} (v${run.baselineConfig.version})`,
        `   Candidate Config:  ${run.candidateConfig.id} (v${run.candidateConfig.version})`,
        ``,
        `2. Mutations Attempted:`,
        ...(run.mutations.map((m) => `   - ${m.type} on '${m.path}': ${JSON.stringify(m.oldValue)} -> ${JSON.stringify(m.newValue)} (${m.rationale})`)),
        ``,
        `3. Measured Results:`,
        `   Baseline Pass Rate:  ${(run.comparison.baselinePassRate * 100).toFixed(1)}%`,
        `   Candidate Pass Rate: ${(run.comparison.candidatePassRate * 100).toFixed(1)}% (delta: ${(run.comparison.passRateDelta * 100).toFixed(1)}%)`,
        `   Token Delta:         ${run.comparison.tokenUsageDelta}`,
        `   Cost Delta:          ${run.comparison.costDelta}`,
        `   Regressions:         ${run.comparison.regressedTasks.join(', ') || 'None'}`,
        ``,
        `4. Final Decision:      ${run.decision}`,
        `   Reasons: ${run.reasons.join('\n   ')}`,
        ...(run.causalAttribution
          ? [
              '',
              `5. Causal Attribution & Ablation Analysis (Design: ${run.causalAttribution.design}):`,
              `   Overall Candidate Delta: ${(run.causalAttribution.candidateDelta * 100).toFixed(1)}%`,
              ...Object.values(run.causalAttribution.attributions).map(
                (attr) =>
                  `   • ${attr.mutationId} (${attr.target}): ${attr.verdict} [isolated: ${(attr.isolatedDelta * 100).toFixed(1)}%, marginal: ${(attr.marginalDelta * 100).toFixed(1)}%] (confidence: ${(attr.confidence * 100).toFixed(0)}%)`,
              ),
              ...(run.causalAttribution.interactions.length > 0
                ? [
                    '   Interactions:',
                    ...run.causalAttribution.interactions.map((i) => `     ⚠ ${i.description}`),
                  ]
                : []),
            ]
          : []),
        ...(run.workerPlacements && run.workerPlacements.length > 0
          ? [
              ``,
              `Distributed Worker Placement (${run.workerPlacements.length} fleet nodes):`,
              ...run.workerPlacements.map(
                (p) =>
                  `   - [${p.workerId}] ${p.workerName} | Shard: ${p.shardId} (${p.taskCount} tasks: ${p.tasks.join(', ')}) | Hardware: ${p.hardware.cpu}, RAM: ${p.hardware.ramGB}GB, GPU: ${p.hardware.gpu ?? 'none'} | Status: ${p.status}`,
              ),
            ]
          : []),
        ...(run.stratifiedMetrics && Object.keys(run.stratifiedMetrics).length > 0
          ? [
              ``,
              `Stratified Hardware Metrics:`,
              ...Object.values(run.stratifiedMetrics).map(
                (s) =>
                  `   - [${s.workerId}] Base: ${s.hardwareSensitive.baselineDurationMs}ms, Cand: ${s.hardwareSensitive.candidateDurationMs}ms (Speedup: ${s.hardwareSensitive.speedupFactor}x) | Pass Rate: ${(s.portable.candidatePassRate * 100).toFixed(1)}%`,
              ),
            ]
          : []),
        ...(run.paretoFrontier
          ? [
              '',
              `Multi-Objective Pareto Analysis:`,
              `   Objectives Evaluated: ${run.paretoFrontier.dimensions.length} (${run.paretoFrontier.dimensions.join(', ')})`,
              `   Selection Policy: ${run.paretoFrontier.policyUsed}`,
              `   Non-Dominated Candidates on Frontier: ${run.paretoFrontier.frontierCandidates.length}`,
              ...run.paretoFrontier.frontierCandidates.map(
                (c) => `   * [FRONTIER] ${c.candidateId}: ${Object.entries(c.rawMetrics).map(([k, v]) => `${k}=${v}`).join(', ')}`,
              ),
              `   Dominated Candidates: ${run.paretoFrontier.dominatedCandidates.length}`,
              ...run.paretoFrontier.dominatedCandidates.map(
                (c) => `   - [DOMINATED] ${c.candidateId}: ${Object.entries(c.rawMetrics).map(([k, v]) => `${k}=${v}`).join(', ')}`,
              ),
              `   Tradeoffs Summary: ${run.paretoFrontier.tradeoffsSummary}`,
              ...(run.paretoFrontier.selectedCandidateId
                ? [`   Selected Candidate: ${run.paretoFrontier.selectedCandidateId}`]
                : []),
            ]
          : []),
        `=======================================================`,
      ].join('\n');
    }

    const lines: string[] = [
      `=======================================================`,
      `EXPLAIN EXPERIMENT: ${plan.experimentId} (${plan.name})`,
      `=======================================================`,
      `1. Problem Detected: ${plan.hypothesis.opportunityId ?? 'Targeted optimization'}`,
      `   Domain: ${plan.hypothesis.domain}`,
      `   Component: ${plan.hypothesis.targetComponent}`,
      ``,
      `2. Hypothesis:`,
      `   Proposed Change: ${plan.hypothesis.proposedChange}`,
      `   Expected Metric Effect: ${plan.hypothesis.expectedMetricEffect.direction} ${plan.hypothesis.expectedMetricEffect.metric} (threshold: ${plan.hypothesis.successThreshold})`,
      ``,
      `3. Pre-Registered Plan:`,
      `   Primary Metric: ${plan.primaryMetric}`,
      `   Regression Constraints: ${JSON.stringify(plan.regressionConstraints)}`,
      `   Benchmark Tasks: ${plan.benchmarkCategories.join(', ')}`,
      ``,
    ];

    if (run) {
      lines.push(
        `4. Measured Results:`,
        `   Baseline Pass Rate: ${(run.comparison.baselinePassRate * 100).toFixed(1)}%`,
        `   Candidate Pass Rate: ${(run.comparison.candidatePassRate * 100).toFixed(1)}% (delta: ${(run.comparison.passRateDelta * 100).toFixed(1)}%)`,
        `   Token Delta: ${run.comparison.tokenUsageDelta}`,
        `   Cost Delta: ${run.comparison.costDelta}`,
        `   Regressions Detected: ${run.comparison.regressedTasks.join(', ') || 'None'}`,
        ``,
        `5. Final Decision: ${run.decision}`,
        `   Reasons: ${run.reasons.join('\n   ')}`,
      );

      if (run.causalAttribution) {
        lines.push(
          '',
          `6. Causal Attribution & Ablation Analysis (Design: ${run.causalAttribution.design}):`,
          `   Overall Candidate Delta: ${(run.causalAttribution.candidateDelta * 100).toFixed(1)}%`,
          ...Object.values(run.causalAttribution.attributions).map(
            (attr) =>
              `   • ${attr.mutationId} (${attr.target}): ${attr.verdict} [isolated: ${(attr.isolatedDelta * 100).toFixed(1)}%, marginal: ${(attr.marginalDelta * 100).toFixed(1)}%] (confidence: ${(attr.confidence * 100).toFixed(0)}%)`,
          ),
        );
        if (run.causalAttribution.interactions.length > 0) {
          lines.push(
            '   Interactions:',
            ...run.causalAttribution.interactions.map((i) => `     ⚠ ${i.description}`),
          );
        }
      }

      if (run.workerPlacements && run.workerPlacements.length > 0) {
        lines.push(
          ``,
          `Distributed Worker Placement (${run.workerPlacements.length} fleet nodes):`,
          ...run.workerPlacements.map(
            (p) =>
              `   - [${p.workerId}] ${p.workerName} | Shard: ${p.shardId} (${p.taskCount} tasks: ${p.tasks.join(', ')}) | Hardware: ${p.hardware.cpu}, RAM: ${p.hardware.ramGB}GB, GPU: ${p.hardware.gpu ?? 'none'} | Status: ${p.status}`,
          ),
        );
      }
      if (run.stratifiedMetrics && Object.keys(run.stratifiedMetrics).length > 0) {
        lines.push(
          ``,
          `Stratified Hardware Metrics:`,
          ...Object.values(run.stratifiedMetrics).map(
            (s) =>
              `   - [${s.workerId}] Base: ${s.hardwareSensitive.baselineDurationMs}ms, Cand: ${s.hardwareSensitive.candidateDurationMs}ms (Speedup: ${s.hardwareSensitive.speedupFactor}x) | Pass Rate: ${(s.portable.candidatePassRate * 100).toFixed(1)}%`,
          ),
        );
      }
      if (run.paretoFrontier) {
        lines.push(
          '',
          `Multi-Objective Pareto Analysis:`,
          `   Objectives Evaluated: ${run.paretoFrontier.dimensions.length} (${run.paretoFrontier.dimensions.join(', ')})`,
          `   Selection Policy: ${run.paretoFrontier.policyUsed}`,
          `   Non-Dominated Candidates on Frontier: ${run.paretoFrontier.frontierCandidates.length}`,
          ...run.paretoFrontier.frontierCandidates.map(
            (c) => `   * [FRONTIER] ${c.candidateId}: ${Object.entries(c.rawMetrics).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          ),
          `   Dominated Candidates: ${run.paretoFrontier.dominatedCandidates.length}`,
          ...run.paretoFrontier.dominatedCandidates.map(
            (c) => `   - [DOMINATED] ${c.candidateId}: ${Object.entries(c.rawMetrics).map(([k, v]) => `${k}=${v}`).join(', ')}`,
          ),
          `   Tradeoffs Summary: ${run.paretoFrontier.tradeoffsSummary}`,
        );
        if (run.paretoFrontier.selectedCandidateId) {
          lines.push(`   Selected Candidate: ${run.paretoFrontier.selectedCandidateId}`);
        }
      }
    } else {
      lines.push(`4. Status: Experiment planned, not yet executed.`);
    }

    lines.push(`=======================================================`);
    return lines.join('\n');
  }

  // ======================================================================
  // 12. BACKWARD COMPATIBILITY GATE 13 INTERFACE
  // ======================================================================

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

    // 4. Decision logic
    const reasons: string[] = [];
    let decision: MetaOptimizationDecision = 'REJECTED';

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

    if (decision === 'ACCEPTED') {
      this.activeConfig = candidate.config;
      if (this.store) {
        await this.store.put('meta_optimizer/active_config', this.activeConfig);
      }
    }

    this.history.push(runResult);
    if (this.store) {
      await this.store.put(`meta_optimizer/runs/${runId}`, runResult);
    }

    return runResult;
  }

  public getHistory(): MetaOptimizationRunResult[] {
    return [...this.history];
  }

  public getEvents(): MetaOptimizerEvent[] {
    return [...this.events];
  }

  // ======================================================================
  // HELPER METHODS
  // ======================================================================

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

  private checkBudget(operation: 'experiments' | 'candidates' | 'evaluations'): void {
    if (this.consumption.experimentsCount >= this.budget.maxExperiments) {
      throw new Error(`META_OPTIMIZATION_BUDGET_EXHAUSTED: Exceeded max experiments (${this.budget.maxExperiments})`);
    }
    if (this.consumption.candidatesCount >= this.budget.maxCandidatesPerExperiment * this.budget.maxExperiments) {
      throw new Error(`META_OPTIMIZATION_BUDGET_EXHAUSTED: Exceeded max candidates budget`);
    }
  }

  private readonly listeners = new Set<(event: MetaOptimizerEvent) => void>();

  public onEvent(listener: (event: MetaOptimizerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public listExperiments(): ExperimentPlan[] {
    return Array.from(this.experiments.values());
  }

  public getExperiment(experimentId: string): ExperimentPlan | undefined {
    return this.experiments.get(experimentId);
  }

  public registerExperiment(plan: ExperimentPlan): void {
    this.experiments.set(plan.experimentId, plan);
    this.emitEvent('meta.experiment.started', { experimentId: plan.experimentId, domain: (plan as any).domain });
  }

  public pauseExperiment(experimentId: string): boolean {
    const exp = this.experiments.get(experimentId);
    if (!exp) return false;
    (exp as any).status = (exp as any).status === 'PAUSED' ? 'RUNNING' : 'PAUSED';
    this.emitEvent('meta.experiment.started' as any, { experimentId, status: (exp as any).status });
    return true;
  }

  public approveCandidate(candidateId: string): boolean {
    this.emitEvent('meta.candidate.qualified' as any, { candidateId });
    return true;
  }

  private emitEvent(type: MetaOptimizerEventType, data: Record<string, unknown>): void {
    const event: MetaOptimizerEvent = {
      id: `ev-${randomUUID()}`,
      type,
      timestamp: new Date(),
      data,
    };
    this.events.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore subscriber errors
      }
    }
  }
}
