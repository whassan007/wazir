import { describe, it, expect, vi } from 'vitest';
import type { RuntimeAdapter, GenerationRequest, GenerationEvent } from '@wazir/runtimes-interfaces';
import type {
  ImprovementOpportunity,
  ImprovementHypothesis,
  BenchmarkTask,
} from '@wazir/core';
import {
  LocalModelOptimizerHelper,
  LiveBenchmarkRunner,
  MetaOptimizerService,
  BenchmarkService,
  DEFAULT_OPTIMIZABLE_CONFIG,
} from '../src/index.js';

function createMockAdapter(generateHandler: (req: GenerationRequest) => AsyncIterable<GenerationEvent>): RuntimeAdapter {
  return {
    id: 'mock-lmstudio',
    type: 'lmstudio',
    async discover() {
      return { id: 'mock-lmstudio', name: 'Mock LMStudio', type: 'lmstudio' as const, status: 'ready' as const, models: [] };
    },
    async healthCheck() {
      return { status: 'healthy' as const, details: {} };
    },
    async listModels() {
      return [{ id: 'qwen/qwen3.8-27b', name: 'Qwen 3.8 27B', family: 'qwen', contextMax: 32768, capabilities: ['tools'] }];
    },
    async getCapabilities() {
      return { streaming: true, toolCalling: true, maxContext: 32768, modalities: ['text'] };
    },
    generate(req: GenerationRequest) {
      return generateHandler(req);
    },
  };
}

describe('Local Model Optimization Integration', () => {
  const opportunity: ImprovementOpportunity = {
    id: 'opp-repair-01',
    category: 'HIGH_REPAIR_RATE',
    component: 'AgentLoop',
    observation: 'High iteration repair cycles observed in TypeScript tasks',
    evidence: 14,
    suspectedCause: 'Ambiguous diagnostic error messages fed back into context',
    metric: 'repair_cycles',
    baseline: 4.2,
    domain: 'prompts',
  };

  describe('LocalModelOptimizerHelper', () => {
    it('formulates structured hypothesis from local model JSON response', async () => {
      const mockModelJson = JSON.stringify({
        proposedChange: 'Inject compiler diagnostics directly into repair prompt with line-targeted fixes',
        domain: 'prompts',
        expectedMetric: 'repair_cycles',
        expectedDelta: -0.35,
        direction: 'decrease',
        possibleRegressions: ['wall_time', 'task_success'],
        configMutations: [
          {
            type: 'PROMPT_TWEAK',
            path: 'prompts.repairGuidance',
            newValue: 'Examine exact compiler error line numbers and verify with build oracle before completing.',
            rationale: 'Reduce repair cycles',
          },
        ],
      });

      const adapter = createMockAdapter(async function* () {
        yield { type: 'token', content: '```json\n' + mockModelJson + '\n```' };
        yield { type: 'completed', content: mockModelJson, usage: { inputTokens: 120, outputTokens: 90 } };
      });

      const helper = new LocalModelOptimizerHelper({
        adapter,
        defaultModelId: 'qwen/qwen3.8-27b',
      });

      const hypothesis = await helper.formulateHypothesis(opportunity);
      expect(hypothesis).not.toBeNull();
      expect(hypothesis?.proposedChange).toContain('Inject compiler diagnostics');
      expect(hypothesis?.expectedMetricEffect.expectedDelta).toBe(-0.35);
      expect(hypothesis?.configMutations?.length).toBe(1);
      expect(hypothesis?.configMutations?.[0].path).toBe('prompts.repairGuidance');
    });

    it('falls back gracefully to null when local model returns malformed output or errors', async () => {
      const adapter = createMockAdapter(async function* () {
        yield { type: 'error', error: 'Connection refused to local runtime' };
      });

      const helper = new LocalModelOptimizerHelper({
        adapter,
        defaultModelId: 'qwen/qwen3.8-27b',
      });

      const hypothesis = await helper.formulateHypothesis(opportunity);
      expect(hypothesis).toBeNull();
    });

    it('generates candidate mutations via local model', async () => {
      const mockMutationsJson = JSON.stringify([
        {
          type: 'PROMPT_TWEAK',
          path: 'prompts.systemPromptPrefix',
          newValue: 'You are Wazir with enhanced diagnostic isolation.',
          rationale: 'Improve prompt context accuracy',
        },
      ]);

      const adapter = createMockAdapter(async function* () {
        yield { type: 'completed', content: mockMutationsJson, usage: { inputTokens: 80, outputTokens: 40 } };
      });

      const helper = new LocalModelOptimizerHelper({
        adapter,
        defaultModelId: 'qwen/qwen3.8-27b',
      });

      const hypothesis: ImprovementHypothesis = {
        id: 'hyp-1',
        opportunityId: 'opp-1',
        targetComponent: 'AgentLoop',
        domain: 'prompts',
        proposedChange: 'Enhance diagnostic prefix',
        expectedMetricEffect: { metric: 'repair_cycles', expectedDelta: -0.2, direction: 'decrease' },
        possibleRegressions: [],
        requiredBenchmark: ['PROMPTS'],
        successThreshold: 3.0,
      };

      const mutations = await helper.generateCandidateMutations(hypothesis);
      expect(mutations).not.toBeNull();
      expect(mutations?.length).toBe(1);
      expect(mutations?.[0].newValue).toContain('enhanced diagnostic isolation');
    });
  });

  describe('LiveBenchmarkRunner', () => {
    it('executes benchmark task against model adapter and returns valid ExecutionRecord', async () => {
      const adapter = createMockAdapter(async function* () {
        yield { type: 'token', content: 'function add(a, b) { return a + b; }' };
        yield {
          type: 'completed',
          content: 'function add(a, b) { return a + b; }',
          usage: { inputTokens: 45, outputTokens: 25 },
        };
      });

      const runner = new LiveBenchmarkRunner({
        adapter,
        modelId: 'qwen/qwen3.8-27b',
        runtimeId: 'lmstudio',
      });

      const task: BenchmarkTask = {
        id: 'task-math-01',
        name: 'Implement add function',
        category: 'FUNCTIONAL_LOGIC',
        prompt: 'Write an add function in TypeScript',
        difficulty: 'easy',
        expectedFiles: ['src/math.ts'],
      };

      const record = await runner.run(task);
      expect(record.execution.status).toBe('completed');
      expect(record.execution.modelId).toBe('qwen/qwen3.8-27b');
      expect(record.execution.runtimeId).toBe('lmstudio');
      expect(record.usage?.input).toBe(45);
      expect(record.usage?.output).toBe(25);
      expect(record.checks.length).toBeGreaterThan(0);
      expect(record.checks[0].ok).toBe(true);
      expect(record.result).toContain('function add');
    });
  });

  describe('MetaOptimizerService Integration', () => {
    it('uses LocalModelOptimizerHelper in formulateHypothesesAsync and tracks model calls budget', async () => {
      const mockModelJson = JSON.stringify({
        proposedChange: 'Tune recency relevance to reduce peak context tokens',
        domain: 'context_policy',
        expectedMetric: 'peak_context_tokens',
        expectedDelta: -0.22,
        direction: 'decrease',
        possibleRegressions: ['task_success'],
        configMutations: [
          {
            type: 'WEIGHT_ADJUSTMENT',
            path: 'contextWeights.recencyRelevance',
            newValue: 0.25,
            rationale: 'Prune stale context',
          },
        ],
      });

      const adapter = createMockAdapter(async function* () {
        yield { type: 'completed', content: mockModelJson, usage: { inputTokens: 100, outputTokens: 80 } };
      });

      const helper = new LocalModelOptimizerHelper({
        adapter,
        defaultModelId: 'qwen/qwen3.8-27b',
      });

      const benchmarkService = new BenchmarkService();
      const optimizer = new MetaOptimizerService({
        benchmarkService,
        modelHelper: helper,
      });

      const contextOpportunity: ImprovementOpportunity = {
        id: 'opp-ctx-01',
        category: 'HIGH_CONTEXT_GROWTH',
        component: 'ContextCompiler',
        observation: 'Rapid context growth on long tasks',
        evidence: 20,
        suspectedCause: 'Excessive retention of old turn history',
        metric: 'peak_context_tokens',
        baseline: 85000,
        domain: 'context_policy',
      };

      const hypotheses = await optimizer.formulateHypothesesAsync(contextOpportunity);
      expect(hypotheses.length).toBe(1);
      expect(hypotheses[0].proposedChange).toContain('Tune recency relevance');
      expect(optimizer.getConsumption().modelCallsCount).toBe(1);

      // Candidate generation should use the hypothesis mutations
      const plan = optimizer.designExperiment({ hypothesis: hypotheses[0], sampleSize: 1 });
      const candidates = await optimizer.generateCandidates(plan, 1);
      expect(candidates.length).toBe(1);
      expect(candidates[0].config.contextWeights?.recencyRelevance).toBe(0.25);
    });
  });
});
