import type {
  GovernanceLimits,
  BudgetConsumption,
  AdmissionDecision,
  GovernanceCheckResult,
  BudgetAuditEntry,
  Task,
} from '../types/index.js';
import type { ExecutionEngine } from './executionEngine.js';

export interface GovernanceServiceOptions {
  defaultLimits?: GovernanceLimits;
  pricing?: {
    costPer1kInputTokens?: number;
    costPer1kOutputTokens?: number;
  };
}

export class GovernanceService {
  private readonly defaultLimits: GovernanceLimits;
  private readonly pricing: { costPer1kInputTokens: number; costPer1kOutputTokens: number };
  private readonly consumptions = new Map<string, BudgetConsumption>();
  private readonly limitsMap = new Map<string, GovernanceLimits>();
  private readonly activeExecutions = new Set<string>();
  private readonly auditLog: BudgetAuditEntry[] = [];

  constructor(options: GovernanceServiceOptions = {}) {
    this.defaultLimits = {
      maxTotalTokens: 100_000,
      maxInputTokens: 80_000,
      maxOutputTokens: 20_000,
      maxTokensPerTurn: 8_000,
      maxToolCalls: 50,
      maxWallClockMs: 300_000,
      maxCostUsd: 1.0,
      maxConcurrency: 10,
      ...options.defaultLimits,
    };
    this.pricing = {
      costPer1kInputTokens: options.pricing?.costPer1kInputTokens ?? 0.003,
      costPer1kOutputTokens: options.pricing?.costPer1kOutputTokens ?? 0.015,
    };
  }

  /**
   * Pre-flight admission checks: enforces resource constraints, concurrency caps,
   * and recommends graceful degradation before execution starts.
   */
  public admit(task: Task, limitsOverride?: GovernanceLimits): AdmissionDecision {
    const limits: GovernanceLimits = { ...this.defaultLimits, ...limitsOverride };

    // 1. Concurrency limit check
    if (limits.maxConcurrency !== undefined && this.activeExecutions.size >= limits.maxConcurrency) {
      return {
        admitted: false,
        reason: `CONCURRENCY_EXCEEDED: Active tasks (${this.activeExecutions.size}) reached limit (${limits.maxConcurrency})`,
        limits,
      };
    }

    // 2. Minimum memory / GPU admission check
    if (task.requirements?.minimumGPUMemoryGB && limits.reservedGpuMemoryGB) {
      if (task.requirements.minimumGPUMemoryGB > limits.reservedGpuMemoryGB) {
        return {
          admitted: false,
          reason: `GPU_MEMORY_INSUFFICIENT: Required ${task.requirements.minimumGPUMemoryGB}GB exceeds reserved ${limits.reservedGpuMemoryGB}GB`,
          limits,
        };
      }
    }

    // 3. Graceful degradation recommendation if context is near limit
    let degradationAction: AdmissionDecision['degradationAction'] = 'none';
    if (task.requirements?.minimumContext && limits.maxInputTokens) {
      if (task.requirements.minimumContext > limits.maxInputTokens * 0.8) {
        degradationAction = 'compact_context';
      }
    }

    return {
      admitted: true,
      limits,
      degradationAction,
    };
  }

  /**
   * Starts tracking an execution session under governance.
   */
  public registerExecution(executionId: string, limits?: GovernanceLimits): void {
    this.activeExecutions.add(executionId);
    this.limitsMap.set(executionId, { ...this.defaultLimits, ...limits });
    this.consumptions.set(executionId, {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      wallClockMs: 0,
      costUsd: 0,
      activeConcurrency: this.activeExecutions.size,
    });
  }

  /**
   * Records resource consumption delta (tokens, tool calls, elapsed time)
   * and enforces hard budget termination & graceful degradation thresholds.
   */
  public recordUsage(
    executionId: string,
    delta: {
      inputTokens?: number;
      outputTokens?: number;
      toolCalls?: number;
      wallClockMs?: number;
      costUsd?: number;
    },
  ): GovernanceCheckResult {
    let c = this.consumptions.get(executionId);
    if (!c) {
      this.registerExecution(executionId);
      c = this.consumptions.get(executionId)!;
    }

    const limits = this.limitsMap.get(executionId) ?? this.defaultLimits;

    // Update cumulative consumption
    const inTokens = delta.inputTokens ?? 0;
    const outTokens = delta.outputTokens ?? 0;
    const tools = delta.toolCalls ?? 0;
    const wallMs = delta.wallClockMs ?? 0;

    c.inputTokens += inTokens;
    c.outputTokens += outTokens;
    c.totalTokens += inTokens + outTokens;
    c.toolCalls += tools;
    c.wallClockMs += wallMs;

    const addedCost = delta.costUsd ?? (
      (inTokens / 1000) * this.pricing.costPer1kInputTokens +
      (outTokens / 1000) * this.pricing.costPer1kOutputTokens
    );
    c.costUsd = Number((c.costUsd + addedCost).toFixed(6));
    c.activeConcurrency = this.activeExecutions.size;

    // Evaluate budget thresholds
    const warnings: string[] = [];
    let exhausted = false;
    let hardTerminate = false;
    let degradationRecommended: GovernanceCheckResult['degradationRecommended'];

    // 1. Token budget check
    if (limits.maxTotalTokens) {
      const ratio = c.totalTokens / limits.maxTotalTokens;
      if (ratio >= 1.0) {
        exhausted = true;
        hardTerminate = true;
        warnings.push(`TOTAL_TOKENS_EXHAUSTED: ${c.totalTokens} >= ${limits.maxTotalTokens}`);
      } else if (ratio >= 0.9) {
        degradationRecommended = 'compact_context';
        warnings.push(`TOTAL_TOKENS_CRITICAL: ${Math.round(ratio * 100)}% of token budget consumed`);
      } else if (ratio >= 0.8) {
        warnings.push(`TOTAL_TOKENS_WARNING: ${Math.round(ratio * 100)}% of token budget consumed`);
      }
    }

    // 2. Cost cap check
    if (limits.maxCostUsd) {
      const ratio = c.costUsd / limits.maxCostUsd;
      if (ratio >= 1.0) {
        exhausted = true;
        hardTerminate = true;
        warnings.push(`COST_CAP_EXCEEDED: $${c.costUsd.toFixed(4)} >= $${limits.maxCostUsd.toFixed(4)}`);
      } else if (ratio >= 0.85) {
        if (!degradationRecommended) degradationRecommended = 'downgrade_model';
        warnings.push(`COST_WARNING: ${Math.round(ratio * 100)}% of cost cap reached ($${c.costUsd.toFixed(4)})`);
      }
    }

    // 3. Tool invocation budget check
    if (limits.maxToolCalls && c.toolCalls >= limits.maxToolCalls) {
      exhausted = true;
      hardTerminate = true;
      warnings.push(`TOOL_BUDGET_EXHAUSTED: ${c.toolCalls} >= ${limits.maxToolCalls}`);
    }

    // Record audit entry
    this.auditLog.push({
      executionId,
      timestamp: new Date(),
      delta,
      cumulative: { ...c },
      event: hardTerminate ? 'exhausted' : warnings.length > 0 ? 'warning' : 'turn',
    });

    return {
      ok: !exhausted,
      exhausted,
      hardTerminate,
      warnings,
      degradationRecommended,
      consumption: { ...c },
      limits,
    };
  }

  /**
   * Enforces hard termination on an execution when budget limits are exhausted.
   */
  public async terminate(
    executionId: string,
    reason: string,
    executionEngine?: ExecutionEngine,
  ): Promise<void> {
    this.activeExecutions.delete(executionId);

    const c = this.consumptions.get(executionId);
    if (c) {
      this.auditLog.push({
        executionId,
        timestamp: new Date(),
        delta: {},
        cumulative: { ...c },
        event: 'terminated',
      });
    }

    if (executionEngine) {
      try {
        const record = await executionEngine.get(executionId);
        if (record) {
          record.execution.status = 'failed';
          (executionEngine as any).pushEvent?.(record, 'budget.exhausted', {
            executionId,
            reason,
            consumption: c,
          });
          (executionEngine as any).pushEvent?.(record, 'termination.completed', {
            executionId,
            reason: `Hard termination: ${reason}`,
            terminatedAt: new Date(),
          });
        }
      } catch {
        // ignore engine update error
      }
    }
  }

  /**
   * Releases an execution from active concurrency tracking upon completion.
   */
  public releaseExecution(executionId: string): void {
    this.activeExecutions.delete(executionId);
  }

  /**
   * Retrieves consumption record for an execution.
   */
  public getConsumption(executionId: string): BudgetConsumption | undefined {
    return this.consumptions.get(executionId);
  }

  /**
   * Retrieves audit log entries for an execution or globally.
   */
  public getAuditLog(executionId?: string): BudgetAuditEntry[] {
    if (!executionId) return [...this.auditLog];
    return this.auditLog.filter((e) => e.executionId === executionId);
  }
}
