import { describe, it, expect, beforeEach } from 'vitest';
import { GovernanceService, ExecutionEngine } from '../src/index.js';
import type { Task } from '../src/types/index.js';

describe('Gate 11: Cost and Resource Governance', () => {
  let governance: GovernanceService;

  beforeEach(() => {
    governance = new GovernanceService({
      defaultLimits: {
        maxTotalTokens: 10_000,
        maxCostUsd: 0.10,
        maxToolCalls: 10,
        maxConcurrency: 2,
        reservedGpuMemoryGB: 16,
      },
      pricing: {
        costPer1kInputTokens: 0.003,
        costPer1kOutputTokens: 0.015,
      },
    });
  });

  describe('Pre-flight Admission Checks', () => {
    const baseTask: Task = {
      id: 'task-1',
      type: 'coding',
      input: 'implement feature',
      requirements: {},
      priority: 'normal',
      status: 'pending',
      createdAt: new Date(),
    };

    it('admits task within resource and concurrency bounds', () => {
      const decision = governance.admit(baseTask);
      expect(decision.admitted).toBe(true);
      expect(decision.degradationAction).toBe('none');
    });

    it('rejects admission when concurrency limit is reached', () => {
      governance.registerExecution('exec-1');
      governance.registerExecution('exec-2');

      // 3rd task exceeds maxConcurrency of 2
      const decision = governance.admit(baseTask);
      expect(decision.admitted).toBe(false);
      expect(decision.reason).toContain('CONCURRENCY_EXCEEDED');

      // After releasing an execution, admission succeeds
      governance.releaseExecution('exec-1');
      const decisionAfterRelease = governance.admit(baseTask);
      expect(decisionAfterRelease.admitted).toBe(true);
    });

    it('rejects admission when task requires more GPU memory than reserved', () => {
      const heavyTask: Task = {
        ...baseTask,
        requirements: {
          minimumGPUMemoryGB: 24, // Exceeds 16GB reserved
        },
      };

      const decision = governance.admit(heavyTask);
      expect(decision.admitted).toBe(false);
      expect(decision.reason).toContain('GPU_MEMORY_INSUFFICIENT');
    });

    it('recommends graceful degradation when context requirements are near limit', () => {
      const largeContextTask: Task = {
        ...baseTask,
        requirements: {
          minimumContext: 75_000, // Near 80_000 max input tokens
        },
      };

      const decision = governance.admit(largeContextTask, { maxInputTokens: 80_000 });
      expect(decision.admitted).toBe(true);
      expect(decision.degradationAction).toBe('compact_context');
    });
  });

  describe('Budget Tracking & Graceful Degradation', () => {
    it('emits warnings and recommends compaction when nearing token budget', () => {
      const execId = 'exec-warn-1';
      governance.registerExecution(execId, { maxTotalTokens: 10_000 });

      // 1. Consume 8,500 tokens (85% - warning)
      const res1 = governance.recordUsage(execId, { inputTokens: 7000, outputTokens: 1500 });
      expect(res1.ok).toBe(true);
      expect(res1.exhausted).toBe(false);
      expect(res1.warnings.some((w) => w.includes('TOTAL_TOKENS_WARNING'))).toBe(true);

      // 2. Consume 700 more tokens (92% - critical degradation recommended)
      const res2 = governance.recordUsage(execId, { inputTokens: 500, outputTokens: 200 });
      expect(res2.ok).toBe(true);
      expect(res2.degradationRecommended).toBe('compact_context');
      expect(res2.warnings.some((w) => w.includes('TOTAL_TOKENS_CRITICAL'))).toBe(true);
    });

    it('enforces hard termination when total token budget is exhausted', () => {
      const execId = 'exec-exhaust-1';
      governance.registerExecution(execId, { maxTotalTokens: 5_000 });

      const res = governance.recordUsage(execId, { inputTokens: 4000, outputTokens: 1500 }); // 5500 > 5000
      expect(res.ok).toBe(false);
      expect(res.exhausted).toBe(true);
      expect(res.hardTerminate).toBe(true);
      expect(res.warnings.some((w) => w.includes('TOTAL_TOKENS_EXHAUSTED'))).toBe(true);
    });

    it('enforces hard termination when tool invocation budget is exhausted', () => {
      const execId = 'exec-tools-1';
      governance.registerExecution(execId, { maxToolCalls: 5 });

      governance.recordUsage(execId, { toolCalls: 3 });
      const res = governance.recordUsage(execId, { toolCalls: 2 }); // Total 5 >= 5
      expect(res.exhausted).toBe(true);
      expect(res.hardTerminate).toBe(true);
      expect(res.warnings.some((w) => w.includes('TOOL_BUDGET_EXHAUSTED'))).toBe(true);
    });

    it('enforces cost cap termination and recommends model downgrade at warning threshold', () => {
      const execId = 'exec-cost-1';
      governance.registerExecution(execId, { maxCostUsd: 0.10 });

      // Add cost nearing threshold ($0.09 = 90%)
      const res1 = governance.recordUsage(execId, { costUsd: 0.09 });
      expect(res1.ok).toBe(true);
      expect(res1.degradationRecommended).toBe('downgrade_model');

      // Exceed cap ($0.11 > $0.10)
      const res2 = governance.recordUsage(execId, { costUsd: 0.02 });
      expect(res2.ok).toBe(false);
      expect(res2.exhausted).toBe(true);
      expect(res2.hardTerminate).toBe(true);
    });
  });

  describe('Budget Consumption Audit Logging & Hard Termination', () => {
    it('maintains a structured audit log and terminates execution in engine', async () => {
      const engine = new ExecutionEngine();
      const record = await engine.create({
        task: {
          id: 'task-term',
          type: 'coding',
          input: 'code',
          requirements: {},
          priority: 'normal',
          status: 'running',
          createdAt: new Date(),
        },
        computerId: 'local',
        runtimeId: 'rt',
        modelId: 'model',
      });

      const execId = record.execution.id;
      governance.registerExecution(execId, { maxCostUsd: 0.05 });

      governance.recordUsage(execId, { inputTokens: 1000, outputTokens: 200, toolCalls: 2 });
      governance.recordUsage(execId, { costUsd: 0.06 }); // Exceeds cap

      // Enforce termination
      await governance.terminate(execId, 'Budget cap exceeded ($0.06 > $0.05)', engine);

      expect(record.execution.status).toBe('failed');
      const termEvents = record.events.filter((e) => (e.eventType ?? e.type) === 'termination.completed');
      expect(termEvents.length).toBe(1);

      // Audit log entries
      const auditEntries = governance.getAuditLog(execId);
      expect(auditEntries.length).toBeGreaterThan(0);
      expect(auditEntries.some((e) => e.event === 'terminated')).toBe(true);
    });
  });
});
