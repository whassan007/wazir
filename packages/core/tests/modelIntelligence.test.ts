import { describe, it, expect, beforeEach } from 'vitest';
import {
  MODEL_CAPABILITY_CATEGORIES,
  type ModelCapabilityCategory,
  type ProfileSegmentationKey,
  type ExecutionRecord,
  type BenchmarkTask,
  type BenchmarkRunResult,
} from '../src/types/index.js';
import { ModelIntelligenceService } from '../src/services/modelIntelligenceService.js';
import { TaskCapabilityClassifier } from '../src/services/taskCapabilityClassifier.js';

describe('Model Intelligence: Capability Taxonomy & Profiles', () => {
  let service: ModelIntelligenceService;
  let classifier: TaskCapabilityClassifier;

  const segmentA: ProfileSegmentationKey = {
    model: 'qwen/qwen3-coder-next',
    runtime: 'lmstudio',
    quantization: 'q4_k_m',
    hardwareClass: 'apple-silicon',
    modelVersion: '1.0.0',
    wazirProtocolVersion: '1.0.0',
  };

  const segmentB: ProfileSegmentationKey = {
    model: 'gemma-4-26b-a4b-it-qat',
    runtime: 'lmstudio',
    quantization: 'qat',
    hardwareClass: 'apple-silicon',
    modelVersion: '1.0.0',
    wazirProtocolVersion: '1.0.0',
  };

  beforeEach(() => {
    classifier = new TaskCapabilityClassifier();
    service = new ModelIntelligenceService({ classifier });
  });

  describe('Taxonomy & Profile Structure', () => {
    it('defines all 13 measurable engineering capability categories', () => {
      expect(MODEL_CAPABILITY_CATEGORIES).toHaveLength(13);
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('repository_navigation');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('code_comprehension');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('architecture_reasoning');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('bug_localization');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('implementation');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('compile_repair');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('test_repair');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('tool_use');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('structured_action_reliability');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('long_horizon_execution');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('context_efficiency');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('delegation');
      expect(MODEL_CAPABILITY_CATEGORIES).toContain('verification_reasoning');
    });

    it('initializes profile adhering strictly to ModelCapabilityProfile structure without global scalar ranking', () => {
      const dummyRecord: ExecutionRecord = {
        execution: {
          id: 'exec-init-1',
          taskId: 'task-init',
          runtimeId: 'lmstudio',
          modelId: segmentA.model,
          status: 'completed',
          createdAt: new Date(),
        },
        task: {
          id: 'task-init',
          type: 'coding',
          title: 'Initial feature test',
          input: 'Implement parser helper',
          requirements: { capabilities: ['coding'] },
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [{ id: 't1', tool: 'write', input: {}, ok: true }],
        filesChanged: ['parser.ts'],
        checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 50 }],
        errors: [],
        events: [],
      };

      const profile = service.recordExecution(dummyRecord, segmentA);

      expect(profile.model).toBe(segmentA.model);
      expect(profile.runtime).toBe(segmentA.runtime);
      expect(profile.quantization).toBe(segmentA.quantization);
      expect(profile.hardwareClass).toBe(segmentA.hardwareClass);
      expect(profile.categoryMeasurements).toBeDefined();
      expect(profile.sampleCounts).toBeDefined();
      expect(profile.confidence).toBeGreaterThan(0);
      expect(profile.lastUpdated).toBeInstanceOf(Date);

      // Invariant: Do not reduce the entire model to one score
      expect((profile as Record<string, unknown>).overallScore).toBeUndefined();
      expect((profile as Record<string, unknown>).globalScore).toBeUndefined();
      expect((profile as Record<string, unknown>).rank).toBeUndefined();
    });
  });

  describe('Conditional Performance (Phase & Language)', () => {
    it('captures phase-specific and language-specific performance breakdowns', () => {
      // Record successful PLAN in TypeScript
      const planRecord: ExecutionRecord = {
        execution: {
          id: 'exec-plan-ts-1',
          taskId: 'task-plan-ts',
          runtimeId: 'lmstudio',
          modelId: segmentA.model,
          status: 'completed',
          createdAt: new Date(),
        },
        task: {
          id: 'task-plan-ts',
          type: 'architecture',
          title: 'Design distributed DAG system',
          input: 'Design blueprint in typescript',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['dag.ts'],
        checks: [{ name: 'build', command: 'tsc', ok: true, durationMs: 20 }],
        errors: [],
        events: [],
      };

      service.recordExecution(planRecord, segmentA);

      // Record failed REPAIR in Rust
      const repairRecord: ExecutionRecord = {
        execution: {
          id: 'exec-repair-rs-1',
          taskId: 'task-repair-rs',
          runtimeId: 'lmstudio',
          modelId: segmentA.model,
          status: 'failed',
          createdAt: new Date(),
        },
        task: {
          id: 'task-repair-rs',
          type: 'debugging',
          title: 'Fix compiler borrow checker error in rust',
          input: 'Fix compilation error in cargo project',
          requirements: {},
          priority: 'normal',
          status: 'failed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['main.rs'],
        checks: [{ name: 'build', command: 'cargo check', ok: false, durationMs: 300 }],
        errors: ['cargo check failed: borrow checker error'],
        events: [],
      };

      const updated = service.recordExecution(repairRecord, segmentA);

      // Verify phase-specific conditional measurements
      const planPhase = updated.conditionalMeasurements.byPhase['PLAN'];
      expect(planPhase).toBeDefined();
      expect(planPhase.find((c) => c.category === 'architecture_reasoning')?.score).toBe(1.0);

      const repairPhase = updated.conditionalMeasurements.byPhase['REPAIR'];
      expect(repairPhase).toBeDefined();
      expect(repairPhase.find((c) => c.category === 'compile_repair')?.score).toBe(0.0);

      // Verify language-specific conditional measurements
      const tsLang = updated.conditionalMeasurements.byLanguage['typescript'];
      expect(tsLang).toBeDefined();
      expect(tsLang.find((c) => c.category === 'architecture_reasoning')?.score).toBe(1.0);

      const rsLang = updated.conditionalMeasurements.byLanguage['rust'];
      expect(rsLang).toBeDefined();
      expect(rsLang.find((c) => c.category === 'compile_repair')?.score).toBe(0.0);
    });
  });

  describe('Online Learning & Deduplication', () => {
    it('updates evidence from verified executions and failure modes without double counting retries', () => {
      const record1: ExecutionRecord = {
        execution: {
          id: 'exec-unique-1',
          taskId: 'task-1',
          runtimeId: 'lmstudio',
          modelId: segmentA.model,
          status: 'completed',
          createdAt: new Date(),
        },
        task: {
          id: 'task-1',
          type: 'coding',
          title: 'Fix test suite in jest',
          input: 'Repair failing unit test',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [{ id: 't1', tool: 'replace_file_content', input: {}, ok: true }],
        filesChanged: ['test.spec.ts'],
        checks: [{ name: 'test', command: 'npm test', ok: true, durationMs: 40 }],
        errors: [],
        events: [],
      };

      service.recordExecution(record1, segmentA);
      const afterFirst = service.getProfile(segmentA)!;
      expect(afterFirst.sampleCounts.total).toBe(1);
      expect(afterFirst.sampleCounts.verifiedSuccess).toBe(1);

      // Attempting to record the same execution ID (e.g. duplicated retry provenance) must be ignored
      service.recordExecution(record1, segmentA);
      const afterDuplicate = service.getProfile(segmentA)!;
      expect(afterDuplicate.sampleCounts.total).toBe(1);

      // Record a second distinct execution with failure
      const record2: ExecutionRecord = {
        execution: {
          id: 'exec-unique-2',
          taskId: 'task-2',
          runtimeId: 'lmstudio',
          modelId: segmentA.model,
          status: 'failed',
          createdAt: new Date(),
        },
        task: {
          id: 'task-2',
          type: 'coding',
          title: 'Fix test failure',
          input: 'Repair regression test',
          requirements: {},
          priority: 'normal',
          status: 'failed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [{ id: 't1', tool: 'edit', input: {}, ok: false }],
        filesChanged: ['test.spec.ts'],
        checks: [{ name: 'test', command: 'npm test', ok: false, durationMs: 40 }],
        errors: ['Test assertion failed'],
        events: [],
      };

      service.recordExecution(record2, segmentA);
      const afterSecond = service.getProfile(segmentA)!;
      expect(afterSecond.sampleCounts.total).toBe(2);
      expect(afterSecond.sampleCounts.verifiedSuccess).toBe(1);
      expect(afterSecond.sampleCounts.failed).toBe(1);

      const testRepair = afterSecond.categoryMeasurements.find((c) => c.category === 'test_repair')!;
      expect(testRepair.sampleCount).toBe(2);
      expect(testRepair.verifiedSuccessCount).toBe(1);
      expect(testRepair.failureCount).toBe(1);
    });
  });

  describe('Segmentation and Decay (Gate 56 drift guard)', () => {
    it('segregates profiles across model versions, quantizations, and runtimes without blending', () => {
      const exec1: ExecutionRecord = {
        execution: {
          id: 'exec-seg-1',
          taskId: 't-1',
          runtimeId: 'lmstudio',
          modelId: segmentA.model,
          status: 'completed',
          createdAt: new Date(),
        },
        task: {
          id: 't-1',
          type: 'coding',
          title: 'Compile repair',
          input: 'Fix syntax error',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['main.ts'],
        checks: [{ name: 'build', command: 'tsc', ok: true, durationMs: 10 }],
        errors: [],
        events: [],
      };

      service.recordExecution(exec1, segmentA);

      // Record execution for segmentB (different model & quantization)
      const exec2: ExecutionRecord = {
        execution: {
          id: 'exec-seg-2',
          taskId: 't-2',
          runtimeId: 'lmstudio',
          modelId: segmentB.model,
          status: 'failed',
          createdAt: new Date(),
        },
        task: {
          id: 't-2',
          type: 'coding',
          title: 'Compile repair',
          input: 'Fix syntax error',
          requirements: {},
          priority: 'normal',
          status: 'failed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['main.ts'],
        checks: [{ name: 'build', command: 'tsc', ok: false, durationMs: 10 }],
        errors: ['Build error'],
        events: [],
      };

      service.recordExecution(exec2, segmentB);

      const profA = service.getProfile(segmentA)!;
      const profB = service.getProfile(segmentB)!;

      expect(profA.id).not.toBe(profB.id);
      expect(profA.model).toBe(segmentA.model);
      expect(profB.model).toBe(segmentB.model);

      const repairA = profA.categoryMeasurements.find((c) => c.category === 'compile_repair')!;
      const repairB = profB.categoryMeasurements.find((c) => c.category === 'compile_repair')!;
      expect(repairA.score).toBeGreaterThan(repairB.score);
    });

    it('flags stale profile when model version drifts and refuses to silently blend', () => {
      const execV1: ExecutionRecord = {
        execution: {
          id: 'exec-v1-1',
          taskId: 't-v1',
          runtimeId: 'lmstudio',
          modelId: segmentA.model,
          status: 'completed',
          createdAt: new Date(),
        },
        task: {
          id: 't-v1',
          type: 'coding',
          title: 'Fix compiler error',
          input: 'Fix compilation failure',
          requirements: {},
          priority: 'normal',
          status: 'completed',
          createdAt: new Date(),
        },
        policyDecisions: [],
        toolCalls: [],
        filesChanged: ['app.ts'],
        checks: [{ name: 'build', command: 'tsc', ok: true, durationMs: 20 }],
        errors: [],
        events: [],
      };

      service.recordExecution(execV1, segmentA);

      // Query with version 2.0.0 (simulated model upgrade)
      const segmentV2: ProfileSegmentationKey = {
        ...segmentA,
        modelVersion: '2.0.0',
      };

      const result = service.getProfile(segmentV2);
      expect(result).toBeDefined();
      expect(result?.isStale).toBe(true);
      expect(result?.staleReason).toContain('Profile configuration drift');
      expect(result?.staleReason).toContain('1.0.0');
      expect(result?.staleReason).toContain('2.0.0');
    });
  });
});
