import { describe, it, expect, beforeEach } from 'vitest';
import {
  type ModelRecord,
  type Computer,
  type Task,
  type ProfileSegmentationKey,
  type BenchmarkTask,
  type BenchmarkRunResult,
  type EvaluationScoreReport,
} from '../src/types/index.js';
import { ComputerRegistry } from '../src/services/computerRegistry.js';
import { RuntimeRegistry } from '../src/services/runtimeRegistry.js';
import { ModelRegistry } from '../src/services/modelRegistry.js';
import { PolicyEngine } from '../src/services/policyEngine.js';
import { Scheduler } from '../src/services/scheduler.js';
import { ModelIntelligenceService } from '../src/services/modelIntelligenceService.js';
import { TaskCapabilityClassifier } from '../src/services/taskCapabilityClassifier.js';

describe('Model Intelligence Gates: G54, G55, G56', () => {
  let computers: ComputerRegistry;
  let runtimes: RuntimeRegistry;
  let models: ModelRegistry;
  let policy: PolicyEngine;
  let intelligence: ModelIntelligenceService;
  let classifier: TaskCapabilityClassifier;
  let scheduler: Scheduler;

  const localComputer: Computer = {
    id: 'comp-local-1',
    name: 'Local Workstation',
    type: 'workstation',
    status: 'online',
    health: 'healthy',
    local: true,
    os: { platform: 'linux', architecture: 'x64', version: '6.5' },
    hardware: {
      cpu: 'x86_64',
      cpuCores: 16,
      memoryGB: 64,
    },
    runtimes: ['lmstudio'],
    models: [],
    capabilities: ['localExecution'],
    runtimeHealth: {},
    modelHealth: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const modelAId = 'qwen/qwen3-coder-next';
  const modelBId = 'gemma-4-26b-a4b-it-qat';

  const modelARecord: ModelRecord = {
    id: modelAId,
    name: 'Qwen 3 Coder Next',
    provider: 'local',
    family: 'qwen',
    contextMax: 32768,
    capabilities: ['coding'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    quantization: 'q4_k_m',
    version: '1.0.0',
    runtimeCompatibility: ['lmstudio'],
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const modelBRecord: ModelRecord = {
    id: modelBId,
    name: 'Gemma 4 26B QAT',
    provider: 'local',
    family: 'gemma',
    contextMax: 96000,
    capabilities: ['coding'],
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    audio: false,
    embedding: false,
    reasoning: true,
    quantization: 'qat',
    version: '1.0.0',
    runtimeCompatibility: ['lmstudio'],
    local: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const segmentA: ProfileSegmentationKey = {
    model: modelAId,
    runtime: 'lmstudio',
    quantization: 'q4_k_m',
    modelVersion: '1.0.0',
    wazirProtocolVersion: '1.0.0',
  };

  const segmentB: ProfileSegmentationKey = {
    model: modelBId,
    runtime: 'lmstudio',
    quantization: 'qat',
    modelVersion: '1.0.0',
    wazirProtocolVersion: '1.0.0',
  };

  beforeEach(() => {
    computers = new ComputerRegistry();
    computers.register(localComputer);

    runtimes = new RuntimeRegistry();
    runtimes.register({
      id: 'lmstudio',
      name: 'LM Studio',
      type: 'lmstudio',
      status: 'healthy',
      endpoint: 'http://localhost:1234',
      local: true,
      lastHealthCheck: new Date(),
    });

    models = new ModelRegistry(runtimes);
    models.register(modelARecord);
    models.register(modelBRecord);

    models.upsertInstance({
      id: 'inst-model-a',
      modelId: modelAId,
      runtimeId: 'lmstudio',
      computerId: localComputer.id,
      state: 'READY',
      loaded: true,
      health: 'healthy',
      lastHealthCheck: new Date(),
    });

    models.upsertInstance({
      id: 'inst-model-b',
      modelId: modelBId,
      runtimeId: 'lmstudio',
      computerId: localComputer.id,
      state: 'READY',
      loaded: true,
      health: 'healthy',
      lastHealthCheck: new Date(),
    });

    policy = new PolicyEngine();
    classifier = new TaskCapabilityClassifier();
    intelligence = new ModelIntelligenceService({ classifier });

    scheduler = new Scheduler({
      computers,
      runtimes,
      models,
      policy,
      modelIntelligence: intelligence,
      classifier,
    });
  });

  // ======================================================================
  // G54: MODEL_PROFILE
  // ======================================================================
  describe('Gate 54: MODEL_PROFILE', () => {
    it('benchmarks at least two models across multiple categories and produces distinct capability profiles', () => {
      // Helper to generate benchmark result
      const makeBenchResult = (
        taskId: string,
        category: BenchmarkTask['category'],
        runnerId: string,
        passed: boolean,
        repairCycles: number,
      ): BenchmarkRunResult => ({
        taskId,
        taskName: taskId,
        category,
        runnerId,
        durationMs: 1500,
        scoreReport: {
          executionId: `exec-${taskId}-${runnerId}`,
          taskId,
          passed,
          summary: passed ? 'Passed benchmark' : 'Failed benchmark',
          evaluationResult: {
            success: passed,
            assertions: [],
            errors: passed ? [] : ['Assertion failed'],
            evaluatedAt: new Date(),
          },
          metrics: {
            taskSuccess: passed,
            physicalVerificationSuccess: passed,
            totalModelCalls: 2,
            totalToolCalls: 3,
            repairCycles,
            inputTokens: 1200,
            outputTokens: 300,
            compactedTokens: 0,
            totalWallTimeMs: 1500,
            modelLatencyMs: 1200,
            toolLatencyMs: 300,
            costEstimateUsd: 0.005,
            verificationLatencyMs: 100,
          },
        },
      });

      // Benchmark Model A: Strong in compile_repair & tool_use, weak in architecture_reasoning
      const benchRepairA: BenchmarkTask = {
        id: 'bench-repair-1',
        name: 'Syntax and Compile Repair',
        category: 'CODE_REPAIR',
        description: 'Fix compile error in parser',
        prompt: 'Fix compile error',
      };
      const benchToolA: BenchmarkTask = {
        id: 'bench-tool-1',
        name: 'MCP Tool Protocol',
        category: 'TOOL_USE',
        description: 'Tool use invocation',
        prompt: 'Invoke tool with schema',
      };
      const benchArchA: BenchmarkTask = {
        id: 'bench-arch-1',
        name: 'System Architecture Design',
        category: 'FEATURE_IMPLEMENTATION',
        description: 'Design distributed DAG system architecture',
        prompt: 'Design architecture',
        metadata: { capabilityCategory: 'architecture_reasoning' },
      };

      // Model A runs:
      intelligence.recordBenchmarkResult(makeBenchResult('bench-repair-1', 'CODE_REPAIR', modelAId, true, 0), benchRepairA, segmentA);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-repair-2', 'CODE_REPAIR', modelAId, true, 0), benchRepairA, segmentA);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-tool-1', 'TOOL_USE', modelAId, true, 0), benchToolA, segmentA);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-tool-2', 'TOOL_USE', modelAId, true, 0), benchToolA, segmentA);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-arch-1', 'FEATURE_IMPLEMENTATION', modelAId, false, 3), benchArchA, segmentA);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-arch-2', 'FEATURE_IMPLEMENTATION', modelAId, false, 4), benchArchA, segmentA);

      // Model B runs: Strong in architecture_reasoning & repository_navigation, weak in compile_repair
      const benchNavB: BenchmarkTask = {
        id: 'bench-nav-1',
        name: 'Repository File Exploration',
        category: 'REPOSITORY_NAVIGATION',
        description: 'Navigate repo and find files',
        prompt: 'Locate symbol references',
      };

      intelligence.recordBenchmarkResult(makeBenchResult('bench-arch-1', 'FEATURE_IMPLEMENTATION', modelBId, true, 0), benchArchA, segmentB);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-arch-2', 'FEATURE_IMPLEMENTATION', modelBId, true, 0), benchArchA, segmentB);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-nav-1', 'REPOSITORY_NAVIGATION', modelBId, true, 0), benchNavB, segmentB);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-nav-2', 'REPOSITORY_NAVIGATION', modelBId, true, 0), benchNavB, segmentB);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-repair-1', 'CODE_REPAIR', modelBId, false, 3), benchRepairA, segmentB);
      intelligence.recordBenchmarkResult(makeBenchResult('bench-repair-2', 'CODE_REPAIR', modelBId, false, 4), benchRepairA, segmentB);

      const profileA = intelligence.getProfile(segmentA)!;
      const profileB = intelligence.getProfile(segmentB)!;

      expect(profileA).toBeDefined();
      expect(profileB).toBeDefined();

      // Assert separate, asymmetric capability profiles emerge
      const repairA = profileA.categoryMeasurements.find((c) => c.category === 'compile_repair')!;
      const repairB = profileB.categoryMeasurements.find((c) => c.category === 'compile_repair')!;
      expect(repairA.score).toBeGreaterThan(repairB.score);
      expect(repairA.verifiedSuccessCount).toBe(2);
      expect(repairB.verifiedSuccessCount).toBe(0);

      const archA = profileA.categoryMeasurements.find((c) => c.category === 'architecture_reasoning')!;
      const archB = profileB.categoryMeasurements.find((c) => c.category === 'architecture_reasoning')!;
      expect(archB.score).toBeGreaterThan(archA.score);
      expect(archB.verifiedSuccessCount).toBe(2);
      expect(archA.verifiedSuccessCount).toBe(0);

      const toolA = profileA.categoryMeasurements.find((c) => c.category === 'tool_use')!;
      expect(toolA.score).toBeGreaterThan(0.7);

      const navB = profileB.categoryMeasurements.find((c) => c.category === 'repository_navigation')!;
      expect(navB.score).toBeGreaterThan(0.7);

      // Invariant: Zero global scalar ranking
      expect((profileA as Record<string, unknown>).overallScore).toBeUndefined();
      expect((profileB as Record<string, unknown>).overallScore).toBeUndefined();
    });
  });

  // ======================================================================
  // G55: EMPIRICAL_ROUTING
  // ======================================================================
  describe('Gate 55: EMPIRICAL_ROUTING', () => {
    beforeEach(() => {
      // Setup empirical profiles with asymmetric strengths:
      // Model A is superior at compile_repair
      // Model B is superior at architecture_reasoning
      const dummyTaskRepair: BenchmarkTask = {
        id: 't-rep',
        name: 'Compile repair',
        category: 'CODE_REPAIR',
        description: 'Fix compile error',
        prompt: 'Fix tsc error',
      };
      const dummyTaskArch: BenchmarkTask = {
        id: 't-arch',
        name: 'Architecture',
        category: 'FEATURE_IMPLEMENTATION',
        description: 'System architecture design',
        prompt: 'Design distributed DAG system',
        metadata: { capabilityCategory: 'architecture_reasoning' },
      };

      const passResult = (taskId: string, category: BenchmarkTask['category'], modelId: string): BenchmarkRunResult => ({
        taskId,
        taskName: taskId,
        category,
        runnerId: modelId,
        durationMs: 1000,
        scoreReport: {
          executionId: `exec-${taskId}-${modelId}`,
          taskId,
          passed: true,
          summary: 'Pass',
          evaluationResult: { success: true, assertions: [], errors: [], evaluatedAt: new Date() },
          metrics: {
            taskSuccess: true,
            physicalVerificationSuccess: true,
            totalModelCalls: 1,
            totalToolCalls: 2,
            repairCycles: 0,
            inputTokens: 1000,
            outputTokens: 200,
            compactedTokens: 0,
            totalWallTimeMs: 1000,
            modelLatencyMs: 800,
            toolLatencyMs: 200,
            costEstimateUsd: 0.003,
            verificationLatencyMs: 50,
          },
        },
      });

      const failResult = (taskId: string, category: BenchmarkTask['category'], modelId: string): BenchmarkRunResult => ({
        taskId,
        taskName: taskId,
        category,
        runnerId: modelId,
        durationMs: 1000,
        scoreReport: {
          executionId: `exec-${taskId}-${modelId}`,
          taskId,
          passed: false,
          summary: 'Fail',
          evaluationResult: { success: false, assertions: [], errors: ['Failed'], evaluatedAt: new Date() },
          metrics: {
            taskSuccess: false,
            physicalVerificationSuccess: false,
            totalModelCalls: 2,
            totalToolCalls: 2,
            repairCycles: 2,
            inputTokens: 1000,
            outputTokens: 200,
            compactedTokens: 0,
            totalWallTimeMs: 1000,
            modelLatencyMs: 800,
            toolLatencyMs: 200,
            costEstimateUsd: 0.003,
            verificationLatencyMs: 50,
          },
        },
      });

      // Model A passes repair, fails arch
      intelligence.recordBenchmarkResult(passResult('t-rep-1', 'CODE_REPAIR', modelAId), dummyTaskRepair, segmentA);
      intelligence.recordBenchmarkResult(passResult('t-rep-2', 'CODE_REPAIR', modelAId), dummyTaskRepair, segmentA);
      intelligence.recordBenchmarkResult(failResult('t-arch-1', 'FEATURE_IMPLEMENTATION', modelAId), dummyTaskArch, segmentA);
      intelligence.recordBenchmarkResult(failResult('t-arch-2', 'FEATURE_IMPLEMENTATION', modelAId), dummyTaskArch, segmentA);

      // Model B passes arch, fails repair
      intelligence.recordBenchmarkResult(passResult('t-arch-1', 'FEATURE_IMPLEMENTATION', modelBId), dummyTaskArch, segmentB);
      intelligence.recordBenchmarkResult(passResult('t-arch-2', 'FEATURE_IMPLEMENTATION', modelBId), dummyTaskArch, segmentB);
      intelligence.recordBenchmarkResult(failResult('t-rep-1', 'CODE_REPAIR', modelBId), dummyTaskRepair, segmentB);
      intelligence.recordBenchmarkResult(failResult('t-rep-2', 'CODE_REPAIR', modelBId), dummyTaskRepair, segmentB);
    });

    it('routes multiple tasks using measured profiles and produces transparent auditable explanations', () => {
      // 1. Task requiring compile_repair -> Must route to Model A
      const repairTask: Task = {
        id: 'task-route-repair',
        type: 'coding',
        title: 'Fix compiler syntax error in index.ts',
        input: 'Repair compilation error in index.ts',
        requirements: { capabilities: ['coding'], toolCalling: true },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const repairDecision = scheduler.plan({ task: repairTask });
      expect(repairDecision.modelId).toBe(modelAId);
      expect(repairDecision.modelDecision.strategy).toBe('empirical_profile');

      const expRepair = repairDecision.modelDecision.empiricalExplanation;
      expect(expRepair).toBeDefined();
      expect(expRepair?.requiredCapability).toBe('compile_repair');
      expect(expRepair?.candidateModels).toContain(modelAId);
      expect(expRepair?.candidateModels).toContain(modelBId);
      expect(expRepair?.selectedModelId).toBe(modelAId);
      expect(expRepair?.policyConstraintsApplied.length).toBeGreaterThan(0);
      expect(expRepair?.resourceConstraintsApplied.length).toBeGreaterThan(0);

      const candidateA = expRepair?.evaluatedCandidates.find((c) => c.modelId === modelAId);
      const candidateB = expRepair?.evaluatedCandidates.find((c) => c.modelId === modelBId);
      expect(candidateA?.categoryScore).toBeGreaterThan(candidateB?.categoryScore ?? 0);

      // 2. Task requiring architecture_reasoning -> Must route to Model B
      const archTask: Task = {
        id: 'task-route-arch',
        type: 'architecture',
        title: 'Design component hierarchy and DAG decomposition',
        input: 'Produce system architecture plan for distributed task graph',
        requirements: { capabilities: ['coding'], toolCalling: true },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const archDecision = scheduler.plan({ task: archTask });
      expect(archDecision.modelId).toBe(modelBId);
      expect(archDecision.modelDecision.strategy).toBe('empirical_profile');

      const expArch = archDecision.modelDecision.empiricalExplanation;
      expect(expArch).toBeDefined();
      expect(expArch?.requiredCapability).toBe('architecture_reasoning');
      expect(expArch?.selectedModelId).toBe(modelBId);
      expect(expArch?.evaluatedCandidates.find((c) => c.modelId === modelBId)?.categoryScore).toBeGreaterThan(
        expArch?.evaluatedCandidates.find((c) => c.modelId === modelAId)?.categoryScore ?? 0,
      );
    });

    it('enforces hard capability and resource constraints without bypassing them for high empirical scores', () => {
      // Model A is great at compile_repair, BUT if task requires 50,000 context tokens and Model A only has 32,768:
      const hugeContextTask: Task = {
        id: 'task-huge-context',
        type: 'coding',
        title: 'Fix compiler syntax error in index.ts',
        input: 'Repair compilation error in large repository',
        requirements: { capabilities: ['coding'], minimumContext: 50_000, toolCalling: true },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      // Model A must be REJECTED despite its high compile_repair score because context 32768 < 50000.
      // Model B has 96,000 context, so it should be placed.
      const decision = scheduler.plan({ task: hugeContextTask, requiredContextTokens: 50_000 });
      expect(decision.modelId).toBe(modelBId);

      const exp = decision.modelDecision.empiricalExplanation;
      const candidateA = exp?.evaluatedCandidates.find((c) => c.modelId === modelAId);
      expect(candidateA?.eligible).toBe(false);
      expect(candidateA?.resourceAllowed).toBe(false);
      expect(candidateA?.resourceRejection).toContain('context');
    });
  });

  // ======================================================================
  // G56: PROFILE_DRIFT
  // ======================================================================
  describe('Gate 56: PROFILE_DRIFT', () => {
    it('simulates model version upgrade and asserts stale profile does not silently apply as current evidence', () => {
      // 1. Record evidence for Model A on version 1.0.0
      const dummyTaskRepair: BenchmarkTask = {
        id: 't-rep',
        name: 'Compile repair',
        category: 'CODE_REPAIR',
        description: 'Fix compile error',
        prompt: 'Fix tsc error',
      };
      const passResult: BenchmarkRunResult = {
        taskId: 't-rep',
        taskName: 't-rep',
        category: 'CODE_REPAIR',
        runnerId: modelAId,
        durationMs: 1000,
        scoreReport: {
          executionId: 'exec-pass-v1',
          taskId: 't-rep',
          passed: true,
          summary: 'Pass',
          evaluationResult: { success: true, assertions: [], errors: [], evaluatedAt: new Date() },
          metrics: {
            taskSuccess: true,
            physicalVerificationSuccess: true,
            totalModelCalls: 1,
            totalToolCalls: 2,
            repairCycles: 0,
            inputTokens: 1000,
            outputTokens: 200,
            compactedTokens: 0,
            totalWallTimeMs: 1000,
            modelLatencyMs: 800,
            toolLatencyMs: 200,
            costEstimateUsd: 0.003,
            verificationLatencyMs: 50,
          },
        },
      };

      intelligence.recordBenchmarkResult(passResult, dummyTaskRepair, segmentA);
      intelligence.recordBenchmarkResult(passResult, dummyTaskRepair, segmentA);

      // Verify v1 profile is active and has compile_repair evidence
      const profileV1 = intelligence.getProfile(segmentA);
      expect(profileV1?.isStale).toBeFalsy();
      expect(profileV1?.categoryMeasurements.find((c) => c.category === 'compile_repair')?.sampleCount).toBe(2);

      // 2. Simulate model version bump from 1.0.0 to 2.0.0 in ModelRegistry
      const upgradedModelA: ModelRecord = {
        ...modelARecord,
        id: modelAId,
      };
      // Attach version 2.0.0
      (upgradedModelA as Record<string, unknown>).version = '2.0.0';
      models.register(upgradedModelA);

      // 3. Query scheduler with task requiring compile_repair
      const task: Task = {
        id: 'task-test-drift',
        type: 'coding',
        title: 'Fix compiler error in parser',
        input: 'Repair compilation failure',
        requirements: { capabilities: ['coding'], toolCalling: true },
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      };

      const decision = scheduler.plan({ task });

      // Invariant G56: Stale profile must NOT silently apply as current evidence
      const exp = decision.modelDecision.empiricalExplanation;
      const candidateA = exp?.evaluatedCandidates.find((c) => c.modelId === modelAId);

      expect(candidateA?.isStale).toBe(true);
      expect(candidateA?.staleReason).toContain('Profile configuration drift');
      expect(candidateA?.reasons.some((r) => r.includes('stale') && r.includes('evidence ignored'))).toBe(true);
    });
  });
});
