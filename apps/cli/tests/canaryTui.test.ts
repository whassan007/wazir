import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CanaryDeploymentService } from '@wazir/evaluation';
import { renderCanaryView, type CanaryViewData } from '../src/tui/observabilityViews.js';
import { FleetTui } from '../src/tui/fleetTui.js';
import { TerminalScreen } from '../src/tui/screen.js';
import {
  canaryListCommand,
  canaryStatusCommand,
  canaryInspectCommand,
  canaryCompareCommand,
  canaryShadowCommand,
  canaryRollbackCommand,
} from '../src/commands.js';

describe('Level 3 Autonomous Continuous Canary Control Center (TUI & CLI)', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'canary-tui-test-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('renders canary dashboard with traffic allocation bars, sample counts, and correctness dominance', () => {
    const viewData: CanaryViewData = {
      activeCanary: {
        canaryId: 'canary-context_policy-001',
        candidateId: 'context-policy-v17',
        domain: 'context_policy',
        stage: 'CANARY_10',
        status: 'ACTIVE',
        currentAllocation: 0.10,
        startTime: new Date(Date.now() - 1122000), // ~18m 42s
        updatedAt: new Date(),
        minimumSamples: 120,
        baselineMetrics: {
          totalExecutions: 1284,
          taskSuccessRate: 0.911,
          verificationSuccessRate: 0.968,
          toolFailureRate: 0.013,
          totalTokens: 18420,
          wallTimeMs: 42100,
          repairCycles: 3,
        },
        canaryMetrics: {
          totalExecutions: 143,
          taskSuccessRate: 0.914,
          verificationSuccessRate: 0.972,
          toolFailureRate: 0.011,
          totalTokens: 14870,
          wallTimeMs: 37800,
          repairCycles: 2,
        },
      },
      activeTab: 'dashboard',
      width: 100,
      maxRows: 35,
    };

    const lines = renderCanaryView(viewData);
    const text = lines.join('\n');

    expect(text).toContain('Candidate: context-policy-v17');
    expect(text).toContain('Domain:    context_policy');
    expect(text).toContain('TRAFFIC');
    expect(text).toContain('Baseline');
    expect(text).toContain('Canary');
    expect(text).toContain('90%');
    expect(text).toContain('10%');
    expect(text).toContain('SAMPLES');
    expect(text).toContain('1,284');
    expect(text).toContain('143');
    expect(text).toContain('CORRECTNESS');
    expect(text).toContain('Verification Pass');
    expect(text).toContain('96.8%');
    expect(text).toContain('97.2%');
    expect(text).toContain('EFFICIENCY');
    expect(text).toContain('18.4K');
    expect(text).toContain('14.9K');
  });

  it('renders UNKNOWN for unobserved or undefined metrics instead of misleading 0% or 0', () => {
    const viewData: CanaryViewData = {
      activeCanary: {
        canaryId: 'canary-routing-fresh',
        candidateId: 'routing-candidate-new',
        domain: 'routing',
        stage: 'QUALIFIED',
        status: 'ACTIVE',
        currentAllocation: 0.01,
        startTime: new Date(),
        updatedAt: new Date(),
        minimumSamples: 50,
        baselineMetrics: {
          totalExecutions: 0,
        },
        canaryMetrics: {
          totalExecutions: 0,
        },
      },
      activeTab: 'dashboard',
      width: 90,
      maxRows: 30,
    };

    const lines = renderCanaryView(viewData);
    const text = lines.join('\n');

    expect(text).toContain('UNKNOWN');
    expect(text).not.toContain('0.0%');
  });

  it('visually dominates with prominent CANARY REGRESSION alert when correctness drops, ignoring token improvements', () => {
    const viewData: CanaryViewData = {
      activeCanary: {
        canaryId: 'canary-prompt-v2',
        candidateId: 'prompt-optimizer-v2',
        domain: 'prompts',
        stage: 'CANARY_10',
        status: 'ACTIVE',
        currentAllocation: 0.10,
        startTime: new Date(),
        updatedAt: new Date(),
        minimumSamples: 100,
        baselineMetrics: {
          totalExecutions: 500,
          taskSuccessRate: 0.95,
          verificationSuccessRate: 0.98,
          totalTokens: 25000,
          wallTimeMs: 40000,
        },
        canaryMetrics: {
          totalExecutions: 60,
          taskSuccessRate: 0.88, // Regression!
          verificationSuccessRate: 0.91, // Regression!
          totalTokens: 12000, // -52% tokens (efficiency win)
          wallTimeMs: 20000, // -50% latency (efficiency win)
        },
      },
      activeTab: 'dashboard',
      width: 100,
      maxRows: 35,
    };

    const lines = renderCanaryView(viewData);
    const text = lines.join('\n');

    expect(text).toContain('CANARY REGRESSION DETECTED — ROLLBACK REQUIRED');
  });

  it('renders state machine staged progression tree and rollback branch', () => {
    const viewData: CanaryViewData = {
      activeCanary: {
        canaryId: 'canary-orchestration-01',
        candidateId: 'orch-v3',
        domain: 'orchestration',
        stage: 'CANARY_10',
        status: 'ROLLED_BACK',
        currentAllocation: 0.0,
        startTime: new Date(),
        updatedAt: new Date(),
        minimumSamples: 80,
        baselineMetrics: { totalExecutions: 400 },
        canaryMetrics: { totalExecutions: 45 },
        rollbackReason: {
          metric: 'verification_failure_rate',
          baselineValue: 0.02,
          canaryValue: 0.09,
          delta: 0.07,
          threshold: 0.05,
          description: 'Verification failure rate exceeded baseline by 7%',
          timestamp: new Date(),
        },
      },
      activeTab: 'statemachine',
      width: 90,
      maxRows: 35,
    };

    const lines = renderCanaryView(viewData);
    const text = lines.join('\n');

    expect(text).toContain('CANARY STAGED PROGRESSION TREE');
    expect(text).toContain('QUALIFIED');
    expect(text).toContain('SHADOW');
    expect(text).toContain('CANARY_1');
    expect(text).toContain('CANARY_5');
    expect(text).toContain('CANARY_10');
    expect(text).toContain('ROLLBACK TRIGGERED');
    expect(text).toContain('Traffic: 0% Canary, 100% Baseline');
  });

  it('renders shadow mode evaluation isolated from production numbers', () => {
    const viewData: CanaryViewData = {
      activeTab: 'shadow',
      shadowResults: [
        {
          canaryId: 'canary-shadow-01',
          candidateId: 'cand-shadow-1',
          taskId: 'task-101',
          executionId: 'exec-101',
          productionOutcome: { success: true, verificationSuccess: true, tokensUsed: 1500, wallTimeMs: 3000 },
          shadowOutcome: { success: true, verificationSuccess: true, tokensUsed: 1200, wallTimeMs: 2500 },
          metricsDelta: { tokensDelta: -300, wallTimeDeltaMs: -500, verificationAgreed: true },
          timestamp: new Date(),
        },
      ],
      width: 90,
      maxRows: 30,
    };

    const lines = renderCanaryView(viewData);
    const text = lines.join('\n');

    expect(text).toContain('SHADOW EVALUATION (OFFLINE/PARALLEL)');
    expect(text).toContain('Production impact: NONE');
    expect(text).toContain('Workloads Evaluated: 1');
    expect(text).toContain('Task Success');
    expect(text).toContain('Verification Pass');
  });

  it('strictly displays domain boundary restriction when domain is wazir_source_code', () => {
    const viewData: CanaryViewData = {
      activeCanary: {
        canaryId: 'canary-forbidden',
        candidateId: 'core-kernel-v2',
        domain: 'wazir_source_code',
        stage: 'QUALIFIED',
        status: 'ACTIVE',
        currentAllocation: 0.0,
        startTime: new Date(),
        updatedAt: new Date(),
        minimumSamples: 10,
        baselineMetrics: { totalExecutions: 0 },
        canaryMetrics: { totalExecutions: 0 },
      },
      activeTab: 'dashboard',
      width: 90,
      maxRows: 25,
    };

    const lines = renderCanaryView(viewData);
    const text = lines.join('\n');

    expect(text).toContain('AUTONOMOUS DEPLOYMENT PROHIBITED: Operator action required.');
    expect(text).toContain('CANARY_DOMAIN_RESTRICTION: Source code changes cannot auto-roll');
  });

  it('CLI canary commands produce clean JSON without ANSI escape sequences', async () => {
    const canarySvc = new CanaryDeploymentService();
    const deployment = await canarySvc.registerCanary({
      candidateId: 'cand-routing-1',
      candidateConfig: { strategy: 'heuristic' },
      baselineConfig: { strategy: 'default' },
      domain: 'routing',
      qualificationStatus: 'QUALIFIED',
    });

    const mockEngine = {
      optimizer: {
        getCanaryDeploymentService: () => canarySvc,
      },
    } as any;

    const statusJsonStr = await canaryStatusCommand(mockEngine, { json: true });
    expect(() => JSON.parse(statusJsonStr)).not.toThrow();
    expect(statusJsonStr).not.toMatch(/\x1b\[[0-9;]*[a-zA-Z]/);

    const listJsonStr = await canaryListCommand(mockEngine, { json: true });
    const listParsed = JSON.parse(listJsonStr);
    expect(Array.isArray(listParsed)).toBe(true);
    expect(listJsonStr).not.toMatch(/\x1b\[[0-9;]*[a-zA-Z]/);

    const inspectJsonStr = await canaryInspectCommand(mockEngine, deployment.canaryId, { json: true });
    const inspectParsed = JSON.parse(inspectJsonStr);
    expect(inspectParsed.canaryId).toBe(deployment.canaryId);
    expect(inspectJsonStr).not.toMatch(/\x1b\[[0-9;]*[a-zA-Z]/);

    const compareJsonStr = await canaryCompareCommand(mockEngine, deployment.canaryId, { json: true });
    const compareParsed = JSON.parse(compareJsonStr);
    expect(compareParsed.canaryId).toBe(deployment.canaryId);
    expect(compareJsonStr).not.toMatch(/\x1b\[[0-9;]*[a-zA-Z]/);

    const rollbackJsonStr = await canaryRollbackCommand(mockEngine, deployment.canaryId, { json: true, reason: 'Test rollback' });
    const rollbackParsed = JSON.parse(rollbackJsonStr);
    expect(rollbackParsed.status).toBe('ROLLED_BACK');
    expect(rollbackJsonStr).not.toMatch(/\x1b\[[0-9;]*[a-zA-Z]/);
  });
});
