import type {
  ExecutionRecord,
  EvaluationResult,
  EvaluationScoreReport,
  ExecutionMetrics,
  ComparativeEvaluation,
  BenchmarkTaskCategory,
  AcceptanceContract,
} from '@wazir/core';
import { evaluateExecution, type EvaluationOptions } from './index.js';

export interface EvaluationPricingConfig {
  costPer1kInputTokens?: number;   // default 0.003 USD
  costPer1kOutputTokens?: number;  // default 0.015 USD
}

export interface EvaluationServiceOptions extends EvaluationOptions {
  pricing?: EvaluationPricingConfig;
  requirePhysicalVerification?: boolean; // default true
  category?: BenchmarkTaskCategory;
  taskId?: string;
}

export class EvaluationService {
  constructor(
    private readonly defaultPricing: EvaluationPricingConfig = {
      costPer1kInputTokens: 0.003,
      costPer1kOutputTokens: 0.015,
    },
  ) {}

  /**
   * Authoritatively evaluates an execution record, computing multi-dimensional
   * execution metrics and enforcing anti-hallucination / physical verification invariants.
   */
  public evaluate(
    record: ExecutionRecord,
    options: EvaluationServiceOptions = {},
  ): EvaluationScoreReport {
    const pricing = { ...this.defaultPricing, ...options.pricing };
    const requirePhysicalVerification = options.requirePhysicalVerification ?? true;

    // 1. Run core deterministic execution evaluation
    const evaluationResult: EvaluationResult = evaluateExecution(record, options);

    // 2. Derive workspace revision
    const currentRevision =
      record.workspaceState?.revision ??
      evaluationResult.workspaceRevision ??
      (record.filesChanged && record.filesChanged.length > 0 ? 1 : 0);

    // 3. Compute physical verification success
    const physicalVerificationSuccess = this.checkPhysicalVerification(
      record,
      evaluationResult,
      currentRevision,
      options.acceptanceContract,
    );

    // 4. Extract model call counts and latencies
    const { totalModelCalls, modelLatencyMs, inputTokens, outputTokens } =
      this.extractModelMetrics(record);

    // 5. Extract tool metrics
    const totalToolCalls = record.toolCalls ? record.toolCalls.length : 0;
    const toolLatencyMs = (record.toolCalls ?? []).reduce(
      (sum, call) => sum + (call.durationMs || 0),
      0,
    );

    // 6. Extract repair cycles
    const repairCycles = this.extractRepairCycles(record);

    // 7. Extract context compaction metrics
    const compactedTokens = this.extractCompactedTokens(record);

    // 8. Extract verification latency
    const checkLatency = (record.checks ?? []).reduce(
      (sum, check) => sum + (check.durationMs || 0),
      0,
    );
    const evidenceLatency = (record.evidence ?? []).reduce(
      (sum, ev) => sum + (ev.durationMs || 0),
      0,
    );
    const verificationLatencyMs = Math.max(checkLatency, evidenceLatency);

    // 9. Extract wall time
    const totalWallTimeMs = this.extractWallTime(record, modelLatencyMs + toolLatencyMs);

    // 10. Compute cost estimate
    const costEstimateUsd = Number(
      (
        (inputTokens / 1000) * (pricing.costPer1kInputTokens ?? 0.003) +
        (outputTokens / 1000) * (pricing.costPer1kOutputTokens ?? 0.015)
      ).toFixed(6),
    );

    // 11. Compile execution metrics
    const taskSuccess = evaluationResult.success;
    const metrics: ExecutionMetrics = {
      taskSuccess,
      physicalVerificationSuccess,
      totalModelCalls,
      totalToolCalls,
      repairCycles,
      inputTokens,
      outputTokens,
      compactedTokens,
      totalWallTimeMs,
      modelLatencyMs,
      toolLatencyMs,
      costEstimateUsd,
      verificationLatencyMs,
      rawMetrics: {
        workspaceRevision: currentRevision,
        filesChangedCount: record.filesChanged?.length ?? 0,
        checksCount: record.checks?.length ?? 0,
        errorsCount: record.errors?.length ?? 0,
      },
    };

    // 12. Non-negotiable invariant check:
    // MODEL CLAIM != EXECUTION EVIDENCE
    // NO SUCCESSFUL VERIFICATION = NO COMPLETE
    let passed = taskSuccess && (!requirePhysicalVerification || physicalVerificationSuccess);
    let rejectionReason: string | undefined;

    if (requirePhysicalVerification && !physicalVerificationSuccess) {
      if (record.result || record.execution.status === 'completed' || taskSuccess) {
        passed = false;
        rejectionReason =
          'REJECTED_WITHOUT_VERIFICATION: Task or agent claimed success, but physical verification evidence is missing, stale, or failed for current workspace revision';
      }
    }

    if (!passed && !rejectionReason) {
      rejectionReason = evaluationResult.reasons.find((r) => !r.startsWith('evidence verified') && !r.startsWith('all expected'))
        ?? 'Task evaluation failed verification requirements';
    }

    const summary = this.formatReportSummary(
      record.execution.id,
      options.taskId ?? record.task.id,
      passed,
      rejectionReason,
      metrics,
    );

    return {
      executionId: record.execution.id,
      taskId: options.taskId ?? record.task.id,
      category: options.category,
      metrics,
      evaluationResult,
      passed,
      rejectionReason,
      summary,
    };
  }

  /**
   * Compares two evaluation reports (baseline vs candidate) without collapsing
   * multi-dimensional metrics into a single opaque score.
   */
  public compare(
    baseline: EvaluationScoreReport,
    candidate: EvaluationScoreReport,
  ): ComparativeEvaluation {
    const b = baseline.metrics;
    const c = candidate.metrics;

    const deltas = {
      taskSuccessDelta: (c.taskSuccess ? 1 : 0) - (b.taskSuccess ? 1 : 0),
      verificationSuccessDelta:
        (c.physicalVerificationSuccess ? 1 : 0) - (b.physicalVerificationSuccess ? 1 : 0),
      wallTimeDeltaMs: c.totalWallTimeMs - b.totalWallTimeMs,
      modelLatencyDeltaMs: c.modelLatencyMs - b.modelLatencyMs,
      toolLatencyDeltaMs: c.toolLatencyMs - b.toolLatencyMs,
      totalModelCallsDelta: c.totalModelCalls - b.totalModelCalls,
      totalToolCallsDelta: c.totalToolCalls - b.totalToolCalls,
      repairCyclesDelta: c.repairCycles - b.repairCycles,
      inputTokensDelta: c.inputTokens - b.inputTokens,
      outputTokensDelta: c.outputTokens - b.outputTokens,
      compactedTokensDelta: c.compactedTokens - b.compactedTokens,
      costDeltaUsd: Number((c.costEstimateUsd - b.costEstimateUsd).toFixed(6)),
      verificationLatencyDeltaMs: c.verificationLatencyMs - b.verificationLatencyMs,
    };

    const regressions: string[] = [];
    const improvements: string[] = [];

    // Success regressions/improvements
    if (baseline.passed && !candidate.passed) {
      regressions.push(`Candidate failed run (${candidate.rejectionReason ?? 'unspecified failure'}) while baseline passed.`);
    } else if (!baseline.passed && candidate.passed) {
      improvements.push('Candidate passed run while baseline failed.');
    }

    if (b.physicalVerificationSuccess && !c.physicalVerificationSuccess) {
      regressions.push('Candidate failed physical verification while baseline succeeded.');
    } else if (!b.physicalVerificationSuccess && c.physicalVerificationSuccess) {
      improvements.push('Candidate succeeded at physical verification while baseline failed.');
    }

    // Model & Tool calls
    if (deltas.totalModelCallsDelta > 2) {
      regressions.push(`Candidate made ${deltas.totalModelCallsDelta} more model calls (${c.totalModelCalls} vs ${b.totalModelCalls}).`);
    } else if (deltas.totalModelCallsDelta < -1) {
      improvements.push(`Candidate reduced model calls by ${Math.abs(deltas.totalModelCallsDelta)} (${c.totalModelCalls} vs ${b.totalModelCalls}).`);
    }

    if (deltas.totalToolCallsDelta > 4) {
      regressions.push(`Candidate made ${deltas.totalToolCallsDelta} more tool calls (${c.totalToolCalls} vs ${b.totalToolCalls}).`);
    } else if (deltas.totalToolCallsDelta < -2) {
      improvements.push(`Candidate reduced tool calls by ${Math.abs(deltas.totalToolCallsDelta)} (${c.totalToolCalls} vs ${b.totalToolCalls}).`);
    }

    // Repair cycles
    if (deltas.repairCyclesDelta > 0) {
      regressions.push(`Candidate required ${deltas.repairCyclesDelta} additional repair cycles.`);
    } else if (deltas.repairCyclesDelta < 0) {
      improvements.push(`Candidate required ${Math.abs(deltas.repairCyclesDelta)} fewer repair cycles.`);
    }

    // Cost & Tokens
    if (deltas.costDeltaUsd > 0.01) {
      regressions.push(`Candidate increased cost by $${deltas.costDeltaUsd.toFixed(4)}.`);
    } else if (deltas.costDeltaUsd < -0.005) {
      improvements.push(`Candidate decreased cost by $${Math.abs(deltas.costDeltaUsd).toFixed(4)}.`);
    }

    // Latency
    if (deltas.wallTimeDeltaMs > 5000) {
      regressions.push(`Candidate wall time was ${deltas.wallTimeDeltaMs}ms slower.`);
    } else if (deltas.wallTimeDeltaMs < -2000) {
      improvements.push(`Candidate wall time was ${Math.abs(deltas.wallTimeDeltaMs)}ms faster.`);
    }

    const summary = this.formatComparativeSummary(
      baseline.executionId,
      candidate.executionId,
      b,
      c,
      deltas,
      regressions,
      improvements,
    );

    return {
      baseline: {
        id: baseline.executionId,
        metrics: b,
        passed: baseline.passed,
      },
      candidate: {
        id: candidate.executionId,
        metrics: c,
        passed: candidate.passed,
      },
      deltas,
      summary,
      regressions,
      improvements,
    };
  }

  // --- Private Helpers ---

  private checkPhysicalVerification(
    record: ExecutionRecord,
    evaluationResult: EvaluationResult,
    currentRevision: number,
    contractOverride?: AcceptanceContract,
  ): boolean {
    const contract = contractOverride ?? record.acceptanceContract ?? record.task?.acceptanceContract;
    const requiredEvidence = contract?.requiredEvidence ?? [];

    const evidenceList = record.evidence ?? evaluationResult.evidence ?? [];
    const checks = record.checks ?? evaluationResult.checks ?? [];

    // If an acceptance contract requires evidence (BUILD, TEST, etc.)
    if (requiredEvidence.length > 0) {
      for (const required of requiredEvidence) {
        const matches = evidenceList.filter((e) => e.type === required && e.exitCode === 0);
        const atCurrentRevision = matches.find((e) => e.revision === currentRevision);
        if (!atCurrentRevision) {
          return false;
        }
      }
      return true;
    }

    // If mutations happened, did any checks run and pass for the current revision?
    if (currentRevision > 0 && record.filesChanged && record.filesChanged.length > 0) {
      if (evidenceList.length > 0) {
        const currentPassing = evidenceList.filter((e) => e.revision === currentRevision && e.exitCode === 0);
        const currentFailing = evidenceList.filter((e) => e.revision === currentRevision && e.exitCode !== 0);
        return currentFailing.length === 0 && currentPassing.length > 0;
      }
      if (checks.length > 0) {
        return checks.every((c) => c.ok);
      }
      // Mutation occurred with no verification evidence whatsoever
      return false;
    }

    // For read-only tasks (no file mutations)
    if (checks.length > 0) {
      return checks.every((c) => c.ok);
    }

    // If no mutations and no checks, check if any errors occurred
    return (record.errors?.length ?? 0) === 0;
  }

  private extractModelMetrics(record: ExecutionRecord): {
    totalModelCalls: number;
    modelLatencyMs: number;
    inputTokens: number;
    outputTokens: number;
  } {
    let totalModelCalls = 0;
    let modelLatencyMs = 0;
    let inputTokens = record.usage?.input ?? 0;
    let outputTokens = record.usage?.output ?? 0;

    const events = record.events ?? [];
    for (const event of events) {
      const type = event.eventType ?? event.type;
      if (
        type === 'generation.completed' ||
        type === 'model.response.completed' ||
        type === 'model.attempt.started' ||
        type === 'model.requested'
      ) {
        if (type === 'generation.completed' || type === 'model.response.completed') {
          totalModelCalls += 1;
        }
        const data = event.data as Record<string, unknown> | undefined;
        if (data) {
          if (typeof data.durationMs === 'number') {
            modelLatencyMs += data.durationMs;
          }
          const usage = data.usage as { inputTokens?: number; outputTokens?: number } | undefined;
          if (usage) {
            if (inputTokens === 0 && typeof usage.inputTokens === 'number') {
              inputTokens += usage.inputTokens;
            }
            if (outputTokens === 0 && typeof usage.outputTokens === 'number') {
              outputTokens += usage.outputTokens;
            }
          }
        }
      }
    }

    if (totalModelCalls === 0 && (inputTokens > 0 || outputTokens > 0)) {
      totalModelCalls = 1;
    }

    return { totalModelCalls, modelLatencyMs, inputTokens, outputTokens };
  }

  private extractRepairCycles(record: ExecutionRecord): number {
    let repairCycles = 0;
    const events = record.events ?? [];

    for (const event of events) {
      const type = event.eventType ?? event.type;
      if (type === 'retry.scheduled') {
        repairCycles += 1;
      } else if (type === 'turn.started') {
        const data = event.data as { turn?: number } | undefined;
        if (data && typeof data.turn === 'number' && data.turn > 1) {
          repairCycles += 1;
        }
      }
    }

    // Also check check runs: if there were failing checks that were followed by mutations
    const failedChecks = (record.checks ?? []).filter((c) => !c.ok);
    if (repairCycles === 0 && failedChecks.length > 0) {
      repairCycles = failedChecks.length;
    }

    return repairCycles;
  }

  private extractCompactedTokens(record: ExecutionRecord): number {
    let compactedTokens = 0;
    const events = record.events ?? [];

    for (const event of events) {
      const type = event.eventType ?? event.type;
      if (type === 'context.compacted' || type === 'context.compaction.completed') {
        const data = event.data as { compactedTokens?: number; tokensCompacted?: number } | undefined;
        if (data) {
          compactedTokens += (data.compactedTokens ?? data.tokensCompacted ?? 0);
        }
      }
    }

    return compactedTokens;
  }

  private extractWallTime(record: ExecutionRecord, fallbackLatency: number): number {
    const started = record.execution.startedAt?.getTime() ?? record.execution.createdAt?.getTime();
    const completed = record.execution.completedAt?.getTime();

    if (started && completed && completed >= started) {
      return completed - started;
    }

    const events = record.events ?? [];
    if (events.length >= 2) {
      const first = new Date(events[0].timestamp).getTime();
      const last = new Date(events[events.length - 1].timestamp).getTime();
      if (last >= first) {
        return last - first;
      }
    }

    return fallbackLatency;
  }

  private formatReportSummary(
    executionId: string,
    taskId: string,
    passed: boolean,
    rejectionReason: string | undefined,
    m: ExecutionMetrics,
  ): string {
    const status = passed ? 'PASSED' : `FAILED (${rejectionReason ?? 'evaluation failure'})`;
    return [
      `=== Evaluation Report: ${executionId} (Task: ${taskId}) ===`,
      `Status: ${status}`,
      `Task Success: ${m.taskSuccess} | Physical Verification: ${m.physicalVerificationSuccess}`,
      `Model Calls: ${m.totalModelCalls} | Tool Calls: ${m.totalToolCalls} | Repair Cycles: ${m.repairCycles}`,
      `Tokens: In=${m.inputTokens}, Out=${m.outputTokens}, Compacted=${m.compactedTokens}`,
      `Wall Time: ${m.totalWallTimeMs}ms | Model Latency: ${m.modelLatencyMs}ms | Tool Latency: ${m.toolLatencyMs}ms`,
      `Verification Latency: ${m.verificationLatencyMs}ms | Est. Cost: $${m.costEstimateUsd.toFixed(4)}`,
    ].join('\n');
  }

  private formatComparativeSummary(
    baselineId: string,
    candidateId: string,
    b: ExecutionMetrics,
    c: ExecutionMetrics,
    deltas: ComparativeEvaluation['deltas'],
    regressions: string[],
    improvements: string[],
  ): string {
    return [
      `=== Comparative Evaluation: Baseline (${baselineId}) vs Candidate (${candidateId}) ===`,
      `| Metric                 | Baseline | Candidate | Delta      |`,
      `|------------------------|----------|-----------|------------|`,
      `| Task Success           | ${b.taskSuccess ? 'PASS' : 'FAIL'}     | ${c.taskSuccess ? 'PASS' : 'FAIL'}      | ${deltas.taskSuccessDelta >= 0 ? `+${deltas.taskSuccessDelta}` : deltas.taskSuccessDelta}         |`,
      `| Physical Verification  | ${b.physicalVerificationSuccess ? 'PASS' : 'FAIL'}     | ${c.physicalVerificationSuccess ? 'PASS' : 'FAIL'}      | ${deltas.verificationSuccessDelta >= 0 ? `+${deltas.verificationSuccessDelta}` : deltas.verificationSuccessDelta}         |`,
      `| Total Model Calls      | ${b.totalModelCalls.toString().padEnd(8)} | ${c.totalModelCalls.toString().padEnd(9)} | ${(deltas.totalModelCallsDelta >= 0 ? `+${deltas.totalModelCallsDelta}` : `${deltas.totalModelCallsDelta}`).padEnd(10)} |`,
      `| Total Tool Calls       | ${b.totalToolCalls.toString().padEnd(8)} | ${c.totalToolCalls.toString().padEnd(9)} | ${(deltas.totalToolCallsDelta >= 0 ? `+${deltas.totalToolCallsDelta}` : `${deltas.totalToolCallsDelta}`).padEnd(10)} |`,
      `| Repair Cycles          | ${b.repairCycles.toString().padEnd(8)} | ${c.repairCycles.toString().padEnd(9)} | ${(deltas.repairCyclesDelta >= 0 ? `+${deltas.repairCyclesDelta}` : `${deltas.repairCyclesDelta}`).padEnd(10)} |`,
      `| Input Tokens           | ${b.inputTokens.toString().padEnd(8)} | ${c.inputTokens.toString().padEnd(9)} | ${(deltas.inputTokensDelta >= 0 ? `+${deltas.inputTokensDelta}` : `${deltas.inputTokensDelta}`).padEnd(10)} |`,
      `| Output Tokens          | ${b.outputTokens.toString().padEnd(8)} | ${c.outputTokens.toString().padEnd(9)} | ${(deltas.outputTokensDelta >= 0 ? `+${deltas.outputTokensDelta}` : `${deltas.outputTokensDelta}`).padEnd(10)} |`,
      `| Compacted Tokens       | ${b.compactedTokens.toString().padEnd(8)} | ${c.compactedTokens.toString().padEnd(9)} | ${(deltas.compactedTokensDelta >= 0 ? `+${deltas.compactedTokensDelta}` : `${deltas.compactedTokensDelta}`).padEnd(10)} |`,
      `| Wall Time (ms)         | ${b.totalWallTimeMs.toString().padEnd(8)} | ${c.totalWallTimeMs.toString().padEnd(9)} | ${(deltas.wallTimeDeltaMs >= 0 ? `+${deltas.wallTimeDeltaMs}` : `${deltas.wallTimeDeltaMs}`).padEnd(10)} |`,
      `| Est. Cost (USD)        | $${b.costEstimateUsd.toFixed(4).padEnd(7)} | $${c.costEstimateUsd.toFixed(4).padEnd(8)} | ${(deltas.costDeltaUsd >= 0 ? `+$${deltas.costDeltaUsd.toFixed(4)}` : `-$${Math.abs(deltas.costDeltaUsd).toFixed(4)}`).padEnd(10)} |`,
      '',
      `Improvements (${improvements.length}):`,
      ...(improvements.length > 0 ? improvements.map((i) => `  ✓ ${i}`) : ['  (None)']),
      `Regressions (${regressions.length}):`,
      ...(regressions.length > 0 ? regressions.map((r) => `  ✗ ${r}`) : ['  (None)']),
    ].join('\n');
  }
}
