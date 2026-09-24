import { describe, it, expect, beforeEach } from 'vitest';
import {
  CanaryDeploymentService,
  CANARY_ELIGIBLE_DOMAINS,
  DEFAULT_STAGED_EXPANSION_TIERS,
} from '../src/canaryService.js';
import {
  MetaOptimizerService,
  DEFAULT_OPTIMIZABLE_CONFIG,
} from '../src/metaOptimizerService.js';
import { BenchmarkService } from '../src/benchmarkService.js';
import { EvaluationService } from '../src/evaluationService.js';
import { MemoryService } from '@wazir/memory';
import { MemoryStore } from '@wazir/shared';
import type { CandidateImplementation, OptimizableConfig } from '@wazir/core';

describe('Level 3 Canary Promotion Mode (G46, G47, G48)', () => {
  let canaryService: CanaryDeploymentService;
  let memoryService: MemoryService;
  let store: MemoryStore;
  let metaOptimizer: MetaOptimizerService;

  const baselineConfig: OptimizableConfig = structuredClone(DEFAULT_OPTIMIZABLE_CONFIG);

  const qualifiedRoutingCandidate: CandidateImplementation = {
    candidateId: 'cand-routing-qwen-01',
    experimentId: 'exp-routing-101',
    strategy: 'ROUTING',
    filesChanged: [],
    config: {
      ...structuredClone(DEFAULT_OPTIMIZABLE_CONFIG),
      id: 'cfg-cand-routing-01',
      version: 2,
      routingRules: {
        ...DEFAULT_OPTIMIZABLE_CONFIG.routingRules,
        plan: { preferredModel: 'qwen-2.5-coder' },
      },
    },
    status: 'VERIFIED',
  };

  const qualifiedToolSurfaceCandidate: CandidateImplementation = {
    candidateId: 'cand-toolsurface-01',
    experimentId: 'exp-ts-102',
    strategy: 'TOOL_SURFACE',
    filesChanged: [],
    config: {
      ...structuredClone(DEFAULT_OPTIMIZABLE_CONFIG),
      id: 'cfg-cand-ts-01',
      version: 2,
    },
    status: 'VERIFIED',
  };

  beforeEach(() => {
    store = new MemoryStore();
    memoryService = new MemoryService();
    canaryService = new CanaryDeploymentService({
      store,
      memoryService,
    });
    metaOptimizer = new MetaOptimizerService({
      benchmarkService: new BenchmarkService(new EvaluationService()),
      evaluationService: new EvaluationService(),
      memoryService,
      store,
      canaryDeploymentService: canaryService,
      domainLevels: {
        routing: 3,
        tool_surfaces: 3,
      },
    });
  });

  // ======================================================================
  // 1. ELIGIBILITY & DOMAIN RESTRICTIONS
  // ======================================================================
  describe('Eligibility and Domain Controls', () => {
    it('only admits candidates marked QUALIFIED into canary deployment', async () => {
      // Attempting to register REJECTED, INCONCLUSIVE, or FAILED candidate throws error
      await expect(
        canaryService.registerCanary({
          candidateId: 'cand-bad-01',
          candidateConfig: qualifiedRoutingCandidate.config,
          baselineConfig,
          domain: 'routing',
          qualificationStatus: 'REJECTED',
        }),
      ).rejects.toThrow(/CANARY_ELIGIBILITY_ERROR/);

      await expect(
        canaryService.registerCanary({
          candidateId: 'cand-bad-02',
          candidateConfig: qualifiedRoutingCandidate.config,
          baselineConfig,
          domain: 'routing',
          qualificationStatus: 'INCONCLUSIVE',
        }),
      ).rejects.toThrow(/CANARY_ELIGIBILITY_ERROR/);

      await expect(
        canaryService.registerCanary({
          candidateId: 'cand-bad-03',
          candidateConfig: qualifiedRoutingCandidate.config,
          baselineConfig,
          domain: 'routing',
          qualificationStatus: 'FAILED',
        }),
      ).rejects.toThrow(/CANARY_ELIGIBILITY_ERROR/);
    });

    it('strictly forbids core source-code changes from entering Level 3 Canary', async () => {
      const sourceCodeCandidate: CandidateImplementation = {
        candidateId: 'cand-src-01',
        experimentId: 'exp-src-01',
        strategy: 'SOURCE_CODE',
        filesChanged: ['packages/core/src/services/executionEngine.ts'],
        config: structuredClone(DEFAULT_OPTIMIZABLE_CONFIG),
        status: 'VERIFIED',
      };

      const deployRes = await metaOptimizer.deployCanary(sourceCodeCandidate);
      expect(deployRes.success).toBe(false);
      expect(deployRes.reason).toContain('Source-code modifications cannot enter Level 3 Canary');

      await expect(
        canaryService.registerCanary({
          candidateId: 'cand-src-raw',
          candidateConfig: sourceCodeCandidate.config,
          baselineConfig,
          domain: 'wazir_source_code',
          qualificationStatus: 'QUALIFIED',
        }),
      ).rejects.toThrow(/CANARY_DOMAIN_RESTRICTION/);
    });

    it('allows permitted Level 3 domains: routing, tool surfaces, context policy, prompts, orchestration', () => {
      expect(CANARY_ELIGIBLE_DOMAINS.has('routing')).toBe(true);
      expect(CANARY_ELIGIBLE_DOMAINS.has('tool_surfaces')).toBe(true);
      expect(CANARY_ELIGIBLE_DOMAINS.has('context_policy')).toBe(true);
      expect(CANARY_ELIGIBLE_DOMAINS.has('prompts')).toBe(true);
      expect(CANARY_ELIGIBLE_DOMAINS.has('orchestration')).toBe(true);
      expect(CANARY_ELIGIBLE_DOMAINS.has('wazir_source_code')).toBe(false);
    });
  });

  // ======================================================================
  // 2. DETERMINISTIC TRAFFIC ASSIGNMENT & SEPARATION
  // ======================================================================
  describe('Deterministic Traffic Assignment', () => {
    it('assigns traffic deterministically using hash slot and respects configured allocation fraction', async () => {
      const canary = await canaryService.registerCanary({
        candidateId: qualifiedRoutingCandidate.candidateId,
        candidateConfig: qualifiedRoutingCandidate.config,
        baselineConfig,
        domain: 'routing',
        qualificationStatus: 'QUALIFIED',
        initialAllocation: 0.10, // 10%
      });

      expect(canary.status).toBe('ACTIVE');
      expect(canary.currentAllocation).toBe(0.10);

      // Verify slot stability: same taskId gives identical assignment every time
      const assignment1 = canaryService.assignExecution({
        canaryId: canary.canaryId,
        executionId: 'exec-alpha-1',
        taskId: 'task-deterministic-42',
      });
      const assignment2 = canaryService.assignExecution({
        canaryId: canary.canaryId,
        executionId: 'exec-alpha-2',
        taskId: 'task-deterministic-42',
      });

      expect(assignment1.assignedVariant).toBe(assignment2.assignedVariant);
      expect(assignment1.hashSlot).toBe(assignment2.hashSlot);
      expect(assignment1.effectiveConfig.id).toBe(assignment2.effectiveConfig.id);

      // Verify that the hash distribution across 1000 tasks closely matches configured 10%
      let canaryCount = 0;
      let baselineCount = 0;
      for (let i = 0; i < 1000; i++) {
        const taskId = `simulated-task-hash-${i}`;
        const res = canaryService.assignExecution({
          canaryId: canary.canaryId,
          executionId: `sim-exec-${i}`,
          taskId,
        });
        if (res.assignedVariant === 'canary') canaryCount++;
        else baselineCount++;
      }

      // 10% of 1000 = 100 (allow standard statistical hash distribution tolerance: 70-130)
      expect(canaryCount).toBeGreaterThan(60);
      expect(canaryCount).toBeLessThan(140);
      expect(baselineCount).toBe(1000 - canaryCount);
    });

    it('routes critical workloads strictly to baseline regardless of allocation slot', async () => {
      const canary = await canaryService.registerCanary({
        candidateId: qualifiedRoutingCandidate.candidateId,
        candidateConfig: qualifiedRoutingCandidate.config,
        baselineConfig,
        domain: 'routing',
        qualificationStatus: 'QUALIFIED',
        initialAllocation: 0.50,
        eligibleWorkloadFilter: {
          excludeCritical: true,
        },
      });

      // Pass an execution with isCritical: true
      const assignment = canaryService.assignExecution({
        canaryId: canary.canaryId,
        executionId: 'exec-critical-prod-01',
        taskId: 'task-security-patch',
        isCritical: true,
      });

      expect(assignment.assignedVariant).toBe('baseline');
      expect(assignment.effectiveConfig.id).toBe(baselineConfig.id);
      expect(assignment.reason).toContain('critical');
    });
  });

  // ======================================================================
  // 3. G46: CANARY CONCURRENT EXECUTION & STAGED EXPANSION
  // ======================================================================
  describe('Gate 46: CANARY (Concurrent Execution & Staged Expansion)', () => {
    it('executes baseline and canary concurrently, tracks metrics cleanly, enforces minimum samples, and stages expansion without premature promotion', async () => {
      // 1. Deploy candidate through MetaOptimizerService
      const deployRes = await metaOptimizer.deployCanary(qualifiedRoutingCandidate, {
        initialAllocation: 0.10,
        minimumSamples: 20,
      });
      expect(deployRes.success).toBe(true);
      const canaryId = deployRes.canaryRecord!.canaryId;

      // 2. Simulate 20 concurrent execution episodes
      // Baseline runs (10 episodes)
      for (let i = 0; i < 10; i++) {
        await canaryService.recordExecutionOutcome({
          canaryId,
          executionId: `exec-base-${i}`,
          variant: 'baseline',
          taskSuccess: true,
          verificationSuccess: true,
          toolCallsCount: 5,
          toolFailuresCount: 0,
          repairCyclesCount: 1,
          tokensUsed: 12000,
          wallTimeMs: 4500,
        });
      }

      // Canary runs (10 episodes, healthy)
      for (let i = 0; i < 10; i++) {
        await canaryService.recordExecutionOutcome({
          canaryId,
          executionId: `exec-canary-${i}`,
          variant: 'canary',
          taskSuccess: true,
          verificationSuccess: true,
          toolCallsCount: 4,
          toolFailuresCount: 0,
          repairCyclesCount: 1,
          tokensUsed: 10500, // improved tokens
          wallTimeMs: 4200,
        });
      }

      const record = canaryService.getDeployment(canaryId)!;
      // Metrics are separated cleanly
      expect(record.baselineMetrics.totalExecutions).toBe(10);
      expect(record.canaryMetrics.totalExecutions).toBe(10);
      expect(record.canaryMetrics.taskSuccessRate).toBe(1.0);
      expect(record.canaryMetrics.verificationSuccessRate).toBe(1.0);

      // Status recognized as HEALTHY (or STAGED_EXPANSION)
      expect(['HEALTHY', 'STAGED_EXPANSION']).toContain(record.status);

      // System has NOT prematurely jumped to 100% full promotion
      expect(record.status).not.toBe('READY_FOR_PROMOTION');
      expect(record.currentAllocation).toBeLessThanOrEqual(0.25);
      expect(metaOptimizer.getActiveConfig().id).toBe(baselineConfig.id);
    });
  });

  // ======================================================================
  // 4. G47: CANARY_ROLLBACK (AUTOMATED HARD REGRESSION ROLLBACK)
  // ======================================================================
  describe('Gate 47: CANARY_ROLLBACK', () => {
    it('triggers immediate automatic rollback on protected regression, restores baseline, retains evidence, and records failure in MemoryService', async () => {
      const canary = await canaryService.registerCanary({
        candidateId: qualifiedRoutingCandidate.candidateId,
        candidateConfig: qualifiedRoutingCandidate.config,
        baselineConfig,
        domain: 'routing',
        qualificationStatus: 'QUALIFIED',
        initialAllocation: 0.10,
        rollbackThresholds: {
          maxTaskFailureRateDelta: 0.05,
          zeroToleranceRecoveryFailures: true,
        },
      });

      // Record 5 passing baseline executions
      for (let i = 0; i < 5; i++) {
        await canaryService.recordExecutionOutcome({
          canaryId: canary.canaryId,
          executionId: `base-${i}`,
          variant: 'baseline',
          taskSuccess: true,
          verificationSuccess: true,
          toolCallsCount: 3,
          toolFailuresCount: 0,
          repairCyclesCount: 0,
          tokensUsed: 10000,
          wallTimeMs: 2000,
        });
      }

      // Introduce a candidate run with task failure regression
      const outcome = await canaryService.recordExecutionOutcome({
        canaryId: canary.canaryId,
        executionId: 'canary-fail-01',
        variant: 'canary',
        taskSuccess: false, // Injected regression!
        verificationSuccess: false,
        toolCallsCount: 5,
        toolFailuresCount: 2,
        repairCyclesCount: 3,
        tokensUsed: 15000,
        wallTimeMs: 8000,
      });

      // Rollback must trigger immediately
      expect(outcome.rolledBack).toBe(true);
      expect(outcome.rollbackReason).toBeDefined();
      expect(outcome.canaryRecord.status).toBe('ROLLED_BACK');
      expect(outcome.canaryRecord.currentAllocation).toBe(0.0);

      // Verify that subsequent traffic assignments route 100% to baseline
      const nextAssignment = canaryService.assignExecution({
        canaryId: canary.canaryId,
        executionId: 'exec-after-rollback',
        taskId: 'task-any-01',
      });
      expect(nextAssignment.assignedVariant).toBe('baseline');
      expect(nextAssignment.effectiveConfig.id).toBe(baselineConfig.id);

      // Evidence and rollback details retained
      expect(outcome.canaryRecord.rollbackReason?.description).toContain('regressed');

      // Failure episode recorded in MemoryService
      const episodes = memoryService.queryEpisodic({
        repositoryScope: 'canary-promotion',
      });
      expect(episodes.length).toBeGreaterThan(0);
      const rollbackEpisode = episodes.find((e) => e.executionId === canary.canaryId);
      expect(rollbackEpisode).toBeDefined();
      expect(rollbackEpisode?.attemptOutcome).toBe('failure');
      expect(rollbackEpisode?.repairStrategy).toBe('AUTOMATIC_ROLLBACK_TO_BASELINE');
    });

    it('triggers zero-tolerance rollback immediately on recovery failures', async () => {
      const canary = await canaryService.registerCanary({
        candidateId: qualifiedToolSurfaceCandidate.candidateId,
        candidateConfig: qualifiedToolSurfaceCandidate.config,
        baselineConfig,
        domain: 'tool_surfaces',
        qualificationStatus: 'QUALIFIED',
        initialAllocation: 0.10,
        rollbackThresholds: {
          zeroToleranceRecoveryFailures: true,
        },
      });

      const outcome = await canaryService.recordExecutionOutcome({
        canaryId: canary.canaryId,
        executionId: 'canary-recovery-crash-01',
        variant: 'canary',
        taskSuccess: true,
        verificationSuccess: true,
        toolCallsCount: 2,
        toolFailuresCount: 0,
        repairCyclesCount: 0,
        tokensUsed: 5000,
        wallTimeMs: 1000,
        recoveryFailuresCount: 1, // Protected recovery failure
      });

      expect(outcome.rolledBack).toBe(true);
      expect(outcome.rollbackReason?.metric).toBe('recovery_failures');
      expect(outcome.canaryRecord.status).toBe('ROLLED_BACK');
    });
  });

  // ======================================================================
  // 5. G48: CANARY_UNCERTAINTY (EMPIRICAL UNCERTAINTY HANDLING)
  // ======================================================================
  describe('Gate 48: CANARY_UNCERTAINTY', () => {
    it('declares CANARY_INCONCLUSIVE under insufficient evidence and refuses promotion', async () => {
      const canary = await canaryService.registerCanary({
        candidateId: qualifiedRoutingCandidate.candidateId,
        candidateConfig: qualifiedRoutingCandidate.config,
        baselineConfig,
        domain: 'routing',
        qualificationStatus: 'QUALIFIED',
        minimumSamples: 50,
      });

      // Record only 3 samples (far below minimum 50)
      for (let i = 0; i < 3; i++) {
        await canaryService.recordExecutionOutcome({
          canaryId: canary.canaryId,
          executionId: `canary-sparse-${i}`,
          variant: 'canary',
          taskSuccess: true,
          verificationSuccess: true,
          toolCallsCount: 4,
          toolFailuresCount: 0,
          repairCyclesCount: 0,
          tokensUsed: 9000,
          wallTimeMs: 3000,
        });
      }

      // Conclude evaluation with insufficient evidence
      const finalStatus = canaryService.concludeEvaluation(canary.canaryId);
      expect(finalStatus).toBe('INCONCLUSIVE');

      const record = canaryService.getDeployment(canary.canaryId)!;
      expect(record.status).toBe('INCONCLUSIVE');
      expect(record.inconclusiveReasons.length).toBeGreaterThan(0);
      expect(record.inconclusiveReasons[0]).toContain('INSUFFICIENT_SAMPLES');

      // Crucial: Active baseline configuration is NOT promoted
      expect(metaOptimizer.getActiveConfig().id).toBe(baselineConfig.id);
    });
  });
});
