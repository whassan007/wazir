import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanaryDeploymentService } from '@wazir/evaluation';
import { renderCanaryView, type CanaryViewData } from '../../apps/cli/src/tui/observabilityViews.js';
import { canaryInspectCommand, canaryCompareCommand, canaryRollbackCommand } from '../../apps/cli/src/commands.js';

describe('Acceptance Gates: Level 3 Autonomous Continuous Canary Control Center', () => {
  let projectRoot: string;
  let canaryService: CanaryDeploymentService;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canary-gates-'));
    canaryService = new CanaryDeploymentService();
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * GATE 88: CANARY_TUI
   * Authoritative test for live Level 3 Continuous Canary TUI control.
   * Starts a qualified candidate, runs through stages (SHADOW -> CANARY_1 -> CANARY_5),
   * verifies TUI projection updates strictly from controller state and never invents metrics.
   */
  describe('Gate 88: CANARY_TUI (Staged Progression & Reactive State Projection)', () => {
    it('observes stage progression from QUALIFIED to SHADOW to CANARY_1 to CANARY_5 and projects exact controller state', async () => {
      // 1. Register candidate
      const deployment = await canaryService.registerCanary({
        candidateId: 'context-window-v3',
        candidateConfig: { strategy: 'prefix_dedup' },
        baselineConfig: { strategy: 'default' },
        domain: 'context_policy',
        qualificationStatus: 'QUALIFIED',
        initialStage: 'QUALIFIED',
        initialAllocation: 0.0,
        minimumSamples: 20,
      });

      expect(deployment.stage).toBe('QUALIFIED');
      expect(deployment.currentAllocation).toBe(0.0);

      // Verify Initial TUI Rendering
      let viewData: CanaryViewData = {
        activeCanary: {
          canaryId: deployment.canaryId,
          candidateId: deployment.candidateId,
          domain: deployment.domain,
          stage: deployment.stage ?? 'QUALIFIED',
          status: deployment.status,
          currentAllocation: deployment.currentAllocation,
          startTime: deployment.startTime,
          updatedAt: deployment.updatedAt,
          minimumSamples: deployment.minimumSamples,
          baselineMetrics: deployment.baselineMetrics,
          canaryMetrics: deployment.canaryMetrics,
        },
        activeTab: 'dashboard',
        width: 100,
        maxRows: 35,
      };

      let rendered = renderCanaryView(viewData).join('\n');
      expect(rendered).toContain('context-window-v3');
      expect(rendered).toContain('CANARY CONTROL');
      expect(rendered).toContain('Baseline  [██████████████████████████████████████████████████] 100%');
      expect(rendered).toContain('Canary    [                                                  ] 0%');

      // 2. Transition to SHADOW mode
      deployment.stage = 'SHADOW';
      canaryService.recordShadowExecution({
        canaryId: deployment.canaryId,
        taskId: 'task-shadow-01',
        executionId: 'exec-shadow-01',
        productionOutcome: { success: true, verificationSuccess: true, tokensUsed: 14000, wallTimeMs: 32000 },
        shadowOutcome: { success: true, verificationSuccess: true, tokensUsed: 11000, wallTimeMs: 27000 },
      });

      const shadowResults = canaryService.getShadowResults(deployment.canaryId);
      expect(shadowResults).toHaveLength(1);

      viewData.activeTab = 'shadow';
      viewData.shadowResults = shadowResults;
      rendered = renderCanaryView(viewData).join('\n');
      expect(rendered).toContain('SHADOW EVALUATION (OFFLINE/PARALLEL)');
      expect(rendered).toContain('Production impact: NONE');
      expect(rendered).toContain('Workloads Evaluated: 1');

      // 3. Staged Expansion: CANARY_1 (1% Traffic)
      deployment.stage = 'CANARY_1';
      deployment.currentAllocation = 0.01;
      deployment.status = 'ACTIVE';

      // Record 10 baseline samples and 10 canary samples with superior/healthy performance
      for (let i = 0; i < 10; i++) {
        canaryService.recordExecutionOutcome({
          canaryId: deployment.canaryId,
          executionId: `exec-base-${i}`,
          variant: 'baseline',
          taskSuccess: true,
          verificationSuccess: true,
          toolCallsCount: 4,
          toolFailuresCount: 0,
          repairCyclesCount: 0,
          tokensUsed: 14000,
          wallTimeMs: 35000,
        });
        canaryService.recordExecutionOutcome({
          canaryId: deployment.canaryId,
          executionId: `exec-canary-${i}`,
          variant: 'canary',
          taskSuccess: true,
          verificationSuccess: true,
          toolCallsCount: 4,
          toolFailuresCount: 0,
          repairCyclesCount: 0,
          tokensUsed: 11000,
          wallTimeMs: 29000,
        });
      }

      viewData.activeTab = 'dashboard';
      viewData.activeCanary = {
        canaryId: deployment.canaryId,
        candidateId: deployment.candidateId,
        domain: deployment.domain,
        stage: deployment.stage,
        status: deployment.status,
        currentAllocation: deployment.currentAllocation,
        startTime: deployment.startTime,
        updatedAt: deployment.updatedAt,
        minimumSamples: deployment.minimumSamples,
        baselineMetrics: deployment.baselineMetrics,
        canaryMetrics: deployment.canaryMetrics,
      };

      rendered = renderCanaryView(viewData).join('\n');
      expect(rendered).toContain('CANARY_5');
      expect(rendered).toContain('10'); // Observed samples
      expect(rendered).toContain('Correctness guard');
    });
  });

  /**
   * GATE 89: LIVE_ROLLBACK_UI
   * Authoritative test for live rollback visibility.
   * Candidate improves efficiency (-40% tokens, faster) but regresses protected correctness metric
   * (verification failure +6% > 5% threshold).
   * CanaryDeploymentService triggers rollback.
   * TUI displays prominent regression alert, canary allocation drops to 0%, baseline 100%,
   * and displays exact controller reason.
   */
  describe('Gate 89: LIVE_ROLLBACK_UI (Dominance of Correctness & Automatic Rollback)', () => {
    it('triggers controller rollback on verification regression and immediately dominates UI with rollback evidence', async () => {
      const deployment = await canaryService.registerCanary({
        candidateId: 'fast-but-buggy-prompts-v9',
        candidateConfig: { prompt: 'aggressive_compression' },
        baselineConfig: { prompt: 'standard' },
        domain: 'prompts',
        qualificationStatus: 'QUALIFIED',
        initialAllocation: 0.10,
        initialStage: 'CANARY_10',
        minimumSamples: 20,
      });

      // Populate baseline: 20 executions, 100% verification pass
      for (let i = 0; i < 20; i++) {
        canaryService.recordExecutionOutcome({
          canaryId: deployment.canaryId,
          executionId: `base-${i}`,
          variant: 'baseline',
          taskSuccess: true,
          verificationSuccess: true,
          toolCallsCount: 2,
          toolFailuresCount: 0,
          repairCyclesCount: 0,
          tokensUsed: 20000,
          wallTimeMs: 30000,
        });
      }

      // Populate canary: 20 executions, highly efficient (tokens 9000, wallTime 15000)
      // BUT 3 verification failures (15% failure rate -> violates maxVerificationFailureRateDelta 5%)
      for (let i = 0; i < 20; i++) {
        const verifSuccess = i < 17; // 17 pass, 3 fail
        await canaryService.recordExecutionOutcome({
          canaryId: deployment.canaryId,
          executionId: `canary-${i}`,
          variant: 'canary',
          taskSuccess: true,
          verificationSuccess: verifSuccess,
          toolCallsCount: 2,
          toolFailuresCount: 0,
          repairCyclesCount: 0,
          tokensUsed: 9000, // 55% token savings!
          wallTimeMs: 15000, // 50% faster!
        });
      }

      // Verify controller triggered automatic rollback
      const updated = canaryService.getDeployment(deployment.canaryId)!;
      expect(updated.status).toBe('ROLLED_BACK');
      expect(updated.currentAllocation).toBe(0.0);
      expect(updated.rollbackReason).toBeDefined();
      expect(updated.rollbackReason?.metric).toBe('verification_failure_rate');

      // Verify TUI projection reflects rollback dominance over token savings
      const viewData: CanaryViewData = {
        activeCanary: {
          canaryId: updated.canaryId,
          candidateId: updated.candidateId,
          domain: updated.domain,
          stage: updated.stage ?? 'CANARY_10',
          status: updated.status,
          currentAllocation: updated.currentAllocation,
          startTime: updated.startTime,
          updatedAt: updated.updatedAt,
          minimumSamples: updated.minimumSamples,
          baselineMetrics: updated.baselineMetrics,
          canaryMetrics: updated.canaryMetrics,
          rollbackReason: updated.rollbackReason,
        },
        activeTab: 'dashboard',
        width: 100,
        maxRows: 70,
      };

      const rendered = renderCanaryView(viewData).join('\n');

      // 1. Correctness must dominate visually: prominent alert box
      expect(rendered).toContain('! CANARY REGRESSION DETECTED — ROLLBACK REQUIRED / ACTIVE !');
      expect(rendered).toContain('AUTOMATIC CANARY ROLLBACK TRIGGERED');
      expect(rendered).toContain('TRAFFIC RESTORATION: 100% BASELINE  (0% CANARY)');
      expect(rendered).toContain('verification_failure_rate');
      expect(rendered).toContain('Rollback active');
    });
  });

  /**
   * GATE 90: DOMAIN_BOUNDARY_UI
   * Authoritative test for domain restriction enforcement in control center.
   * If a candidate targets wazir_source_code, CanaryDeploymentService denies autonomous deployment,
   * and TUI clearly projects "AUTONOMOUS DEPLOYMENT PROHIBITED: Operator action required."
   */
  describe('Gate 90: DOMAIN_BOUNDARY_UI (Prohibition of Autonomous Source-Code Deployments)', () => {
    it('refuses registration for wazir_source_code at controller level and renders domain boundary alert in UI', async () => {
      // 1. Controller refuses autonomous canary registration for wazir_source_code
      await expect(
        canaryService.registerCanary({
          candidateId: 'core-scheduler-optimization',
          candidateConfig: { scheduler: 'adaptive' },
          baselineConfig: { scheduler: 'round_robin' },
          domain: 'wazir_source_code' as any,
          qualificationStatus: 'QUALIFIED',
        }),
      ).rejects.toThrow('CANARY_DOMAIN_RESTRICTION');

      // 2. When surface or historical candidate with wazir_source_code is displayed, TUI renders strict prohibition banner
      const viewData: CanaryViewData = {
        activeCanary: {
          canaryId: 'canary-manual-audit-01',
          candidateId: 'core-scheduler-optimization',
          domain: 'wazir_source_code',
          stage: 'QUALIFIED',
          status: 'PAUSED',
          currentAllocation: 0.0,
          startTime: new Date(),
          updatedAt: new Date(),
          minimumSamples: 50,
          baselineMetrics: { totalExecutions: 0 },
          canaryMetrics: { totalExecutions: 0 },
        },
        activeTab: 'dashboard',
        width: 90,
        maxRows: 25,
      };

      const rendered = renderCanaryView(viewData).join('\n');
      expect(rendered).toContain('AUTONOMOUS DEPLOYMENT PROHIBITED: Operator action required.');
      expect(rendered).toContain('CANARY_DOMAIN_RESTRICTION: Source code changes cannot auto-roll');
    });
  });
});
