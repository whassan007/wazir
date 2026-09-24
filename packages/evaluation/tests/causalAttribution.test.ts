import { describe, it, expect, beforeEach } from 'vitest';
import type {
  BenchmarkRunner,
  BenchmarkTask,
  OptimizableConfig,
  CandidateImplementation,
  ExperimentPlan,
  Mutation,
  ConfigMutation,
} from '@wazir/core';
import {
  CausalAttributionService,
  normalizeMutation,
  applyMutation,
} from '../src/causalAttributionService.js';
import { MetaOptimizerService, DEFAULT_OPTIMIZABLE_CONFIG } from '../src/metaOptimizerService.js';
import { BenchmarkService } from '../src/benchmarkService.js';
import { OpportunityDetector } from '../src/opportunityDetector.js';

describe('Causal Experiment Discipline & MetaOptimizer Ablation', () => {
  let causalService: CausalAttributionService;
  let baseConfig: OptimizableConfig;

  beforeEach(() => {
    causalService = new CausalAttributionService({ minSampleSize: 2, significanceThreshold: 0.05 });
    baseConfig = structuredClone(DEFAULT_OPTIMIZABLE_CONFIG);
  });

  // ====================================================================
  // 1. MUTATION MODEL & BOUNDED EXPERIMENTAL DESIGNS
  // ====================================================================
  describe('Mutation Model & Bounded Experiment Design', () => {
    it('normalizes mutations and applies dot-path overrides deterministically', () => {
      const rawMutation: ConfigMutation = {
        type: 'WEIGHT_ADJUSTMENT',
        path: 'contextWeights.errorSignalRelevance',
        oldValue: 1.2,
        newValue: 2.0,
        rationale: 'Prioritize error signals during repair phase',
      };

      const normalized = normalizeMutation(rawMutation, 'context_policy', 'mut-error-weight');
      expect(normalized.id).toBe('mut-error-weight');
      expect(normalized.domain).toBe('context_policy');
      expect(normalized.target).toBe('contextWeights.errorSignalRelevance');
      expect(normalized.before).toBe(1.2);
      expect(normalized.after).toBe(2.0);

      const mutated = applyMutation(baseConfig, normalized);
      expect(mutated.contextWeights?.errorSignalRelevance).toBe(2.0);
      expect(baseConfig.contextWeights?.errorSignalRelevance).toBe(1.2); // Original unmodified
    });

    it('generates full factorial design for small mutation sets (K <= 3)', () => {
      const mutations: ConfigMutation[] = [
        { type: 'WEIGHT_ADJUSTMENT', path: 'contextWeights.recencyRelevance', oldValue: 0.5, newValue: 0.8, rationale: 'R1' },
        { type: 'POLICY_MODIFICATION', path: 'toolPolicies.codeModeThreshold', oldValue: 3, newValue: 5, rationale: 'R2' },
        { type: 'ROUTING_ADJUSTMENT', path: 'routingRules.plan.preferredModel', oldValue: 'gemma-27b', newValue: 'qwen-2.5-coder', rationale: 'R3' },
      ];

      const candidate: CandidateImplementation = {
        candidateId: 'cand-k3',
        experimentId: 'exp-k3',
        strategy: 'CONFIGURATION',
        filesChanged: [],
        mutations,
        config: baseConfig,
        status: 'VERIFIED',
      };

      const plan = causalService.designAblation({
        experimentId: 'exp-k3',
        candidate,
        baselineConfig: baseConfig,
      });

      expect(plan.design).toBe('FULL_FACTORIAL');
      expect(plan.allMutations).toHaveLength(3);
      // 2^3 = 8 configurations
      expect(plan.configurations).toHaveLength(8);

      const baselineConfig = plan.configurations.find((c) => c.mutationIds.length === 0);
      expect(baselineConfig).toBeDefined();
      expect(baselineConfig?.label).toBe('Baseline (∅)');

      const fullConfig = plan.configurations.find((c) => c.mutationIds.length === 3);
      expect(fullConfig).toBeDefined();
      expect(fullConfig?.label).toBe('Full Candidate');
    });

    it('generates bounded fractional factorial design for larger mutation sets (K > 3)', () => {
      const mutations: ConfigMutation[] = [
        { type: 'WEIGHT_ADJUSTMENT', path: 'contextWeights.definitionRelevance', oldValue: 1.0, newValue: 1.5, rationale: 'R1' },
        { type: 'WEIGHT_ADJUSTMENT', path: 'contextWeights.callersRelevance', oldValue: 0.8, newValue: 1.2, rationale: 'R2' },
        { type: 'POLICY_MODIFICATION', path: 'toolPolicies.autoVerifyAfterMutation', oldValue: false, newValue: true, rationale: 'R3' },
        { type: 'GOVERNANCE_TUNING', path: 'governanceLimits.maxRepairCycles', oldValue: 3, newValue: 5, rationale: 'R4' },
      ];

      const candidate: CandidateImplementation = {
        candidateId: 'cand-k4',
        experimentId: 'exp-k4',
        strategy: 'CONFIGURATION',
        filesChanged: [],
        mutations,
        config: baseConfig,
        status: 'VERIFIED',
      };

      const plan = causalService.designAblation({
        experimentId: 'exp-k4',
        candidate,
        baselineConfig: baseConfig,
      });

      expect(plan.design).toBe('FRACTIONAL_FACTORIAL');
      expect(plan.allMutations).toHaveLength(4);
      // Bounded 2K + 1 design = 1 (Baseline) + 4 (OFAT) + 4 (LOO) + 1 (Full) = 10 configurations (instead of 2^4 = 16)
      expect(plan.configurations.length).toBeLessThanOrEqual(10);
      expect(plan.configurations.some((c) => c.label.startsWith('OFAT:'))).toBe(true);
      expect(plan.configurations.some((c) => c.label.startsWith('LOO:'))).toBe(true);
    });
  });

  // ====================================================================
  // 2. G49 ABLATION: BENEFICIAL, NEUTRAL, AND HARMFUL ATTRIBUTION
  // ====================================================================
  describe('G49 ABLATION Gate', () => {
    it('accurately differentiates one beneficial, one neutral, and one harmful mutation', () => {
      const mutations: Mutation[] = [
        {
          id: 'mut-beneficial',
          domain: 'context_policy',
          target: 'contextWeights.errorSignalRelevance',
          before: 1.0,
          after: 2.0,
          rationale: 'Focus on compile error lines',
        },
        {
          id: 'mut-neutral',
          domain: 'tool_surfaces',
          target: 'toolPolicies.codeModeThreshold',
          before: 3,
          after: 4,
          rationale: 'Slight threshold adjustment',
        },
        {
          id: 'mut-harmful',
          domain: 'governanceLimits',
          target: 'governanceLimits.maxRepairCycles',
          before: 3,
          after: 1,
          rationale: 'Overly restrictive repair cycles limit',
        } as any,
      ];

      const candidate: CandidateImplementation = {
        candidateId: 'cand-g49',
        experimentId: 'exp-g49',
        strategy: 'CONFIGURATION',
        filesChanged: [],
        mutations: mutations as any,
        config: baseConfig,
        status: 'VERIFIED',
      };

      const plan = causalService.designAblation({
        experimentId: 'exp-g49',
        candidate,
        baselineConfig: baseConfig,
        design: 'FULL_FACTORIAL',
      });

      const baselineValue = 10_000; // baseline tokens
      const results = new Map<string, { metricValue: number; sampleCount: number; passRate?: number }>();

      // Mock results: lower tokens is favorable ('decrease')
      for (const config of plan.configurations) {
        const ids = config.mutationIds;
        let tokens = baselineValue;

        if (ids.includes('mut-beneficial')) {
          tokens -= 2000; // -20% tokens (beneficial)
        }
        if (ids.includes('mut-neutral')) {
          tokens += 50; // negligible +0.5% (neutral)
        }
        if (ids.includes('mut-harmful')) {
          tokens += 2500; // +25% tokens (harmful regression)
        }

        results.set(config.configId, {
          metricValue: tokens,
          sampleCount: 3,
          passRate: 1.0,
        });
      }

      const report = causalService.analyzeAttribution({
        plan,
        baselineValue,
        results,
        primaryMetric: 'peak_context_tokens',
        direction: 'decrease',
      });

      expect(report.attributions['mut-beneficial'].verdict).toBe('SUPPORTED_CONTRIBUTOR');
      expect(report.attributions['mut-beneficial'].isolatedDelta).toBeGreaterThan(0.15);

      expect(report.attributions['mut-neutral'].verdict).toBe('NO_MEASURABLE_EFFECT');
      expect(Math.abs(report.attributions['mut-neutral'].isolatedDelta)).toBeLessThan(0.05);

      expect(report.attributions['mut-harmful'].verdict).toBe('NEGATIVE_CONTRIBUTOR');
      expect(report.attributions['mut-harmful'].isolatedDelta).toBeLessThan(-0.15);
    });
  });

  // ====================================================================
  // 3. G50 INTERACTION: SYNERGY & NON-LINEAR EFFECTS
  // ====================================================================
  describe('G50 INTERACTION Gate', () => {
    it('detects interaction when improvement appears strictly jointly and avoids false attribution', () => {
      const mutations: Mutation[] = [
        {
          id: 'mut-A',
          domain: 'routing',
          target: 'routingRules.plan.preferredModel',
          before: 'gemma-27b',
          after: 'qwen-2.5-coder',
          rationale: 'Model adjustment A',
        },
        {
          id: 'mut-B',
          domain: 'tool_surfaces',
          target: 'toolPolicies.phaseToolSurfaces.plan',
          before: ['read'],
          after: ['read', 'ast_grep'],
          rationale: 'Tool surface adjustment B',
        },
      ];

      const candidate: CandidateImplementation = {
        candidateId: 'cand-g50',
        experimentId: 'exp-g50',
        strategy: 'CONFIGURATION',
        filesChanged: [],
        mutations: mutations as any,
        config: baseConfig,
        status: 'VERIFIED',
      };

      const plan = causalService.designAblation({
        experimentId: 'exp-g50',
        candidate,
        baselineConfig: baseConfig,
        design: 'FULL_FACTORIAL',
      });

      const baselineTokens = 20_000;
      const results = new Map<string, { metricValue: number; sampleCount: number; passRate?: number }>();

      for (const config of plan.configurations) {
        const ids = config.mutationIds;
        let tokens = baselineTokens;

        const hasA = ids.includes('mut-A');
        const hasB = ids.includes('mut-B');

        if (hasA && !hasB) {
          tokens = baselineTokens - 100; // -0.5% (no isolated effect)
        } else if (hasB && !hasA) {
          tokens = baselineTokens + 100; // +0.5% (no isolated effect)
        } else if (hasA && hasB) {
          tokens = baselineTokens - 7_000; // -35% (massive joint synergy!)
        }

        results.set(config.configId, {
          metricValue: tokens,
          sampleCount: 3,
          passRate: 1.0,
        });
      }

      const report = causalService.analyzeAttribution({
        plan,
        baselineValue: baselineTokens,
        results,
        primaryMetric: 'peak_context_tokens',
        direction: 'decrease',
      });

      // Assert interaction detected
      const interaction = report.interactions.find(
        (i) => i.mutationIds.includes('mut-A') && i.mutationIds.includes('mut-B'),
      );
      expect(interaction).toBeDefined();
      expect(interaction?.verdict).toBe('INTERACTION_DETECTED');

      // Conservative claim: neither A nor B falsely claimed as independent supported contributor
      expect(report.attributions['mut-A'].verdict).toBe('INTERACTION_DETECTED');
      expect(report.attributions['mut-B'].verdict).toBe('INTERACTION_DETECTED');
      expect(report.attributions['mut-A'].interactionPartners).toContain('mut-B');
      expect(report.attributions['mut-B'].interactionPartners).toContain('mut-A');
    });
  });

  // ====================================================================
  // 4. G51 CAUSAL_UNCERTAINTY: STATISTICAL PRUDENCE
  // ====================================================================
  describe('G51 CAUSAL_UNCERTAINTY Gate', () => {
    it('strictly outputs INSUFFICIENT_EVIDENCE when sample size is below threshold', () => {
      const strictService = new CausalAttributionService({ minSampleSize: 3 });

      const mutations: Mutation[] = [
        {
          id: 'mut-sparse',
          domain: 'prompts',
          target: 'prompts.repairGuidance',
          before: 'Old',
          after: 'New',
          rationale: 'Prompt tweak with sparse data',
        },
      ];

      const candidate: CandidateImplementation = {
        candidateId: 'cand-g51',
        experimentId: 'exp-g51',
        strategy: 'PROMPT',
        filesChanged: [],
        mutations: mutations as any,
        config: baseConfig,
        status: 'VERIFIED',
      };

      const plan = strictService.designAblation({
        experimentId: 'exp-g51',
        candidate,
        baselineConfig: baseConfig,
      });

      const results = new Map<string, { metricValue: number; sampleCount: number; passRate?: number }>();
      // Only 1 execution sampled, while minSampleSize = 3
      for (const config of plan.configurations) {
        results.set(config.configId, {
          metricValue: 5000,
          sampleCount: 1, // Insufficient sample!
          passRate: 1.0,
        });
      }

      const report = strictService.analyzeAttribution({
        plan,
        baselineValue: 10_000,
        results,
        primaryMetric: 'peak_context_tokens',
        direction: 'decrease',
      });

      expect(report.attributions['mut-sparse'].verdict).toBe('INSUFFICIENT_EVIDENCE');
      expect(report.attributions['mut-sparse'].confidence).toBeLessThan(0.7);
    });
  });

  // ====================================================================
  // 5. MUTATION MEMORY PERSISTENCE & FUTURE OPPORTUNITY GUIDANCE
  // ====================================================================
  describe('Mutation Memory Persistence & Future Opportunity Guidance', () => {
    it('persists attribution evidence and prevents repeating known harmful adjustments', async () => {
      const memoryService = new CausalAttributionService({ minSampleSize: 2 });
      const targetPath = 'governanceLimits.maxRepairCycles';

      const mutations: Mutation[] = [
        {
          id: 'mut-bad-limit',
          domain: 'orchestration',
          target: targetPath,
          before: 3,
          after: 1,
          rationale: 'Harmful parameter clamp',
        },
      ];

      const candidate: CandidateImplementation = {
        candidateId: 'cand-mem',
        experimentId: 'exp-mem',
        strategy: 'CONFIGURATION',
        filesChanged: [],
        mutations: mutations as any,
        config: baseConfig,
        status: 'VERIFIED',
      };

      const plan = memoryService.designAblation({
        experimentId: 'exp-mem',
        candidate,
        baselineConfig: baseConfig,
      });

      const results = new Map<string, { metricValue: number; sampleCount: number; passRate?: number }>();
      results.set(plan.configurations[0].configId, { metricValue: 10_000, sampleCount: 3 });
      results.set(plan.configurations[1].configId, { metricValue: 15_000, sampleCount: 3 }); // Regression

      const report = memoryService.analyzeAttribution({
        plan,
        baselineValue: 10_000,
        results,
        primaryMetric: 'peak_context_tokens',
        direction: 'decrease',
      });

      await memoryService.recordAttribution(report, plan.allMutations);

      // Verify memory queries
      expect(memoryService.isKnownHarmful(targetPath)).toBe(true);
      const record = memoryService.getMutationRecord(targetPath);
      expect(record?.lastObservedVerdict).toBe('NEGATIVE_CONTRIBUTOR');
      expect(record?.history).toHaveLength(1);

      // Verify OpportunityDetector consumes memory
      const detector = new OpportunityDetector({ causalService: memoryService });
      expect(detector.isKnownHarmful(targetPath)).toBe(true);
      expect(detector.getHarmfulMutations()).toHaveLength(1);
    });
  });

  // ====================================================================
  // 6. END-TO-END META-OPTIMIZER INTEGRATION
  // ====================================================================
  describe('End-to-End MetaOptimizer Service Integration', () => {
    it('executes ablateCandidate and annotates runResult with causal attribution', async () => {
      const benchmarkService = new BenchmarkService();
      const optimizer = new MetaOptimizerService({
        benchmarkService,
        causalService,
      });

      const task: BenchmarkTask = {
        id: 'bench-causal-1',
        name: 'Causal Benchmark 1',
        category: 'TOOL_USE',
        prompt: 'Benchmark task',
      };
      benchmarkService.register(task);

      // Mock runner that returns different metrics based on active configuration
      const runner: BenchmarkRunner = {
        id: 'mock-causal-runner',
        name: 'Mock Causal Runner',
        async run(t, context) {
          const cfg = context.config;
          const isMutated = (cfg?.contextWeights?.definitionRelevance ?? 1.0) > 1.2;
          const tokens = isMutated ? 5000 : 10000;

          return {
            execution: {
              id: `exec-${t.id}-${Date.now()}`,
              taskId: t.id,
              runtimeId: 'r',
              modelId: 'm',
              status: 'completed',
              createdAt: new Date(),
            },
            task: {
              id: t.id,
              type: 'benchmark',
              title: t.name,
              input: t.prompt,
              requirements: {},
              priority: 'normal',
              status: 'completed',
              createdAt: new Date(),
            },
            policyDecisions: [],
            toolCalls: [],
            filesChanged: ['packages/core/src/index.ts'],
            checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 50 }],
            errors: [],
            events: [],
            usage: { input: tokens, output: 500 },
          };
        },
      };

      const candidateMutations: ConfigMutation[] = [
        {
          type: 'WEIGHT_ADJUSTMENT',
          path: 'contextWeights.definitionRelevance',
          oldValue: 1.0,
          newValue: 2.0,
          rationale: 'Improve token compression',
        },
        {
          type: 'POLICY_MODIFICATION',
          path: 'toolPolicies.autoVerifyAfterMutation',
          oldValue: false,
          newValue: true,
          rationale: 'Verify immediate changes',
        },
      ];

      const mutatedConfig = applyMutation(
        applyMutation(baseConfig, candidateMutations[0]),
        candidateMutations[1],
      );

      const candidate: CandidateImplementation = {
        candidateId: 'cand-e2e',
        experimentId: 'exp-e2e',
        strategy: 'CONFIGURATION',
        filesChanged: ['packages/core/src/index.ts'],
        mutations: candidateMutations,
        config: mutatedConfig,
        status: 'VERIFIED',
      };

      const plan: ExperimentPlan = optimizer.designExperiment({
        hypothesis: {
          id: 'hyp-e2e',
          opportunityId: 'opp-1',
          targetComponent: 'ContextCompiler',
          domain: 'context_policy',
          proposedChange: 'Tune context weights',
          expectedMetricEffect: {
            metric: 'peak_context_tokens',
            expectedDelta: -0.3,
            direction: 'decrease',
          },
          requiredBenchmark: ['TOOL_USE'],
          successThreshold: 7000,
        },
        tasks: ['bench-causal-1'],
      });

      const runResults = await optimizer.evaluateCandidates({
        plan,
        candidates: [candidate],
        runner,
        tasks: [task],
        enableAblation: true,
      });

      expect(runResults).toHaveLength(1);
      const res = runResults[0];
      expect(res.causalAttribution).toBeDefined();
      expect(res.causalAttribution?.design).toBe('FULL_FACTORIAL');
      expect(res.causalAttribution?.attributions).toBeDefined();

      const explanation = optimizer.explainExperiment(plan.experimentId);
      expect(explanation).toContain('Causal Attribution & Ablation Analysis');
    });
  });
});
