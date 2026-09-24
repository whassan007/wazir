import type {
  ExecutionRecord,
  EvaluationResult,
  EvaluationScoreReport,
  ExecutionMetrics,
  ComparativeEvaluation,
  BenchmarkTaskCategory,
  AcceptanceContract,
  EvaluationRecord,
  MultiDimensionalComparison,
  MetricValue,
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

    const taskId = options.taskId ?? record.task?.id ?? record.execution?.taskId ?? 'unknown-task';
    const summary = this.formatReportSummary(
      record.execution.id,
      taskId,
      passed,
      rejectionReason,
      metrics,
    );

    return {
      executionId: record.execution.id,
      taskId,
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

  /**
   * Produces a structured, durable EvaluationRecord tracking model, context, tools,
   * agent repair, workspace mutations, and performance metrics.
   */
  public buildEvaluationRecord(
    record: ExecutionRecord,
    options: EvaluationServiceOptions & {
      gateId?: string;
      testId?: string | number;
      version?: string;
    } = {},
  ): EvaluationRecord {
    const report = this.evaluate(record, options);
    const m = report.metrics;

    // Extract context events to measure context metrics
    const events = record.events ?? [];
    let snapshotCount = 0;
    let revisionCount = 0;
    let tokensDeduplicated = 0;
    let tokensSuperseded = 0;
    let tokensSummarized = m.compactedTokens;
    let tokensOffloaded = 0;
    let peakContext = m.inputTokens;
    const contextSamples: number[] = [];

    for (const ev of events) {
      const type = ev.type || ev.eventType;
      const data = ev.data as Record<string, any> | undefined;

      if (type === 'context.snapshot.created' || type === 'context.compiled') {
        snapshotCount++;
        const tokens = data?.estimatedTokens ?? data?.tokens;
        if (typeof tokens === 'number') {
          contextSamples.push(tokens);
          if (tokens > peakContext) peakContext = tokens;
        }
      }
      if (type === 'context.revision.completed' || type === 'context.compaction.completed') {
        revisionCount++;
        if (data?.tokensDeduplicated) tokensDeduplicated += data.tokensDeduplicated;
        if (data?.tokensSuperseded) tokensSuperseded += data.tokensSuperseded;
        if (data?.tokensSummarized) tokensSummarized += data.tokensSummarized;
        if (data?.tokensOffloaded) tokensOffloaded += data.tokensOffloaded;
      }
      if (type === 'context.deduplicated' && data?.tokens) {
        tokensDeduplicated += data.tokens;
      }
      if (type === 'context.superseded.removed' && data?.tokens) {
        tokensSuperseded += data.tokens;
      }
    }

    const averageContextTokens = contextSamples.length > 0
      ? Math.round(contextSamples.reduce((a, b) => a + b, 0) / contextSamples.length)
      : m.inputTokens;

    // Check runtime cache telemetry if present in rawMetrics or events
    let cacheReadTokens: MetricValue<number> = { value: 0, kind: 'unavailable', note: 'Runtime does not expose prompt cache reads' };
    let cacheWriteTokens: MetricValue<number> = { value: 0, kind: 'unavailable', note: 'Runtime does not expose prompt cache writes' };

    const rawUsage = (record.usage as Record<string, any>) ?? {};
    if (typeof rawUsage.cacheReadTokens === 'number') {
      cacheReadTokens = { value: rawUsage.cacheReadTokens, kind: 'measured', unit: 'tokens' };
    }
    if (typeof rawUsage.cacheWriteTokens === 'number') {
      cacheWriteTokens = { value: rawUsage.cacheWriteTokens, kind: 'measured', unit: 'tokens' };
    }

    const codeModeCalls = (record.toolCalls ?? []).filter((tc) => tc.tool === 'code_mode' || tc.tool === 'run_code_mode').length;
    const toolFailures = (record.toolCalls ?? []).filter((tc) => !tc.ok).length;

    const revisionChanges = events.filter((e) => (e.type || e.eventType) === 'workspace.revision.changed' || (e.type || e.eventType) === 'WORKSPACE_REVISION_CHANGED').length;
    const verificationInvalidations = events.filter((e) => (e.type || e.eventType) === 'verification.invalidated' || (e.type || e.eventType) === 'EVIDENCE_STALE').length;

    return {
      identity: {
        runId: `eval-${record.execution.id}`,
        gateId: options.gateId,
        testId: options.testId ?? record.task?.id,
        version: options.version ?? '0.1.42',
        modelId: record.execution.modelId,
        runtimeId: record.execution.runtimeId,
        timestamp: new Date(),
      },
      correctness: {
        passed: report.passed,
        acceptanceAssertions: report.evaluationResult.checks.map((c) => ({
          name: c.name,
          passed: c.ok,
          detail: c.output?.slice(0, 100),
        })),
        verificationResult: {
          status: report.passed ? 'PASS' : 'FAIL',
          workspaceRevision: record.workspaceState?.revision ?? 0,
          satisfiedOracles: report.evaluationResult.checks.filter((c) => c.ok).map((c) => c.name),
          missingOracles: report.evaluationResult.checks.filter((c) => !c.ok).map((c) => c.name),
        },
      },
      model: {
        totalCalls: { value: m.totalModelCalls, kind: 'measured', unit: 'calls' },
        inputTokens: { value: m.inputTokens, kind: 'measured', unit: 'tokens' },
        outputTokens: { value: m.outputTokens, kind: 'measured', unit: 'tokens' },
        cumulativeInputTokens: { value: m.inputTokens, kind: 'measured', unit: 'tokens' },
      },
      context: {
        peakContextTokens: { value: peakContext, kind: 'measured', unit: 'tokens' },
        averageContextTokens: { value: averageContextTokens, kind: 'measured', unit: 'tokens' },
        snapshotCount: { value: Math.max(1, snapshotCount), kind: 'measured', unit: 'snapshots' },
        revisionCount: { value: revisionCount, kind: 'measured', unit: 'revisions' },
        tokensRemovedDeduplication: { value: tokensDeduplicated, kind: 'measured', unit: 'tokens' },
        tokensRemovedSuperseded: { value: tokensSuperseded, kind: 'measured', unit: 'tokens' },
        tokensSummarized: { value: tokensSummarized, kind: 'measured', unit: 'tokens' },
        tokensOffloaded: { value: tokensOffloaded, kind: 'measured', unit: 'tokens' },
        cacheReadTokens,
        cacheWriteTokens,
      },
      tools: {
        totalCalls: { value: m.totalToolCalls, kind: 'measured', unit: 'calls' },
        codeModeCalls: { value: codeModeCalls, kind: 'measured', unit: 'calls' },
        failures: { value: toolFailures, kind: 'measured', unit: 'calls' },
        retries: { value: 0, kind: 'measured', unit: 'calls' },
      },
      agent: {
        repairCycles: { value: m.repairCycles, kind: 'measured', unit: 'cycles' },
        malformedActions: { value: 0, kind: 'estimated', unit: 'actions' },
        noProgressEvents: { value: 0, kind: 'estimated', unit: 'events' },
        subagentCalls: { value: 0, kind: 'measured', unit: 'calls' },
      },
      workspace: {
        mutations: { value: record.filesChanged?.length ?? 0, kind: 'measured', unit: 'files' },
        revisionChanges: { value: revisionChanges, kind: 'measured', unit: 'events' },
        verificationInvalidations: { value: verificationInvalidations, kind: 'measured', unit: 'events' },
      },
      performance: {
        wallTimeMs: { value: m.totalWallTimeMs, kind: 'measured', unit: 'ms' },
        modelTimeMs: { value: m.modelLatencyMs, kind: 'measured', unit: 'ms' },
        toolTimeMs: { value: m.toolLatencyMs, kind: 'measured', unit: 'ms' },
      },
      resources: {
        monetaryCostUsd: { value: m.costEstimateUsd, kind: 'estimated', unit: 'USD' },
      },
    };
  }

  /**
   * Compares two EvaluationRecords independently across all dimensions without
   * collapsing into an arbitrary single score.
   */
  public compareDimensions(
    baseline: EvaluationRecord,
    candidate: EvaluationRecord,
  ): MultiDimensionalComparison {
    const regressions: string[] = [];
    const improvements: string[] = [];

    // 1. Correctness
    const baselinePass = baseline.correctness.passed;
    const candidatePass = candidate.correctness.passed;
    let correctnessStatus: 'MATCH' | 'IMPROVED' | 'REGRESSED' = 'MATCH';

    if (baselinePass && !candidatePass) {
      correctnessStatus = 'REGRESSED';
      regressions.push('Candidate failed run while baseline passed.');
    } else if (!baselinePass && candidatePass) {
      correctnessStatus = 'IMPROVED';
      improvements.push('Candidate passed run while baseline failed.');
    }

    // 2. Model Calls
    const bCalls = baseline.model.totalCalls.value;
    const cCalls = candidate.model.totalCalls.value;
    const callsDelta = cCalls - bCalls;
    const callsPct = bCalls > 0 ? (callsDelta / bCalls) * 100 : 0;
    if (callsDelta < 0) {
      improvements.push(`Model calls reduced by ${Math.abs(callsDelta)} (${cCalls} vs ${bCalls}).`);
    } else if (callsDelta > 2) {
      regressions.push(`Model calls increased by ${callsDelta} (${cCalls} vs ${bCalls}).`);
    }

    // 3. Input Tokens
    const bTokens = baseline.model.inputTokens.value;
    const cTokens = candidate.model.inputTokens.value;
    const tokensDelta = cTokens - bTokens;
    const tokensPct = bTokens > 0 ? (tokensDelta / bTokens) * 100 : 0;
    if (tokensDelta < -500) {
      improvements.push(`Input tokens reduced by ${Math.abs(tokensDelta)} (${cTokens} vs ${bTokens}).`);
    } else if (tokensDelta > 1000) {
      regressions.push(`Input tokens increased by ${tokensDelta} (${cTokens} vs ${bTokens}).`);
    }

    // 4. Peak Context
    const bPeak = baseline.context.peakContextTokens.value;
    const cPeak = candidate.context.peakContextTokens.value;
    const peakDelta = cPeak - bPeak;
    const peakPct = bPeak > 0 ? (peakDelta / bPeak) * 100 : 0;
    if (peakDelta < -500) {
      improvements.push(`Peak context reduced by ${Math.abs(peakDelta)} (${cPeak} vs ${bPeak}).`);
    } else if (peakDelta > 1500) {
      regressions.push(`Peak context grew by ${peakDelta} (${cPeak} vs ${bPeak}).`);
    }

    // 5. Tokens Summarized
    const bSumm = baseline.context.tokensSummarized.value;
    const cSumm = candidate.context.tokensSummarized.value;
    const summDelta = cSumm - bSumm;

    // 6. Repair Cycles
    const bRepair = baseline.agent.repairCycles.value;
    const cRepair = candidate.agent.repairCycles.value;
    const repairDelta = cRepair - bRepair;
    if (repairDelta < 0) {
      improvements.push(`Repair cycles reduced by ${Math.abs(repairDelta)} (${cRepair} vs ${bRepair}).`);
    } else if (repairDelta > 0) {
      regressions.push(`Repair cycles increased by ${repairDelta} (${cRepair} vs ${bRepair}).`);
    }

    // 7. Wall Time
    const bWall = baseline.performance.wallTimeMs.value;
    const cWall = candidate.performance.wallTimeMs.value;
    const wallDelta = cWall - bWall;
    const wallPct = bWall > 0 ? (wallDelta / bWall) * 100 : 0;
    if (wallDelta < -2000) {
      improvements.push(`Wall time improved by ${Math.abs(wallDelta)}ms (${cWall}ms vs ${bWall}ms).`);
    } else if (wallDelta > 5000) {
      regressions.push(`Wall time regressed by ${wallDelta}ms (${cWall}ms vs ${bWall}ms).`);
    }

    let verdict: MultiDimensionalComparison['verdict'] = 'EQUIVALENT';
    if (correctnessStatus === 'REGRESSED') {
      verdict = 'REGRESSION';
    } else if (regressions.length > improvements.length && regressions.length > 0) {
      verdict = 'BASELINE_BETTER';
    } else if (improvements.length > regressions.length && regressions.length === 0) {
      verdict = 'CANDIDATE_BETTER';
    } else if (improvements.length > 0 && regressions.length > 0) {
      verdict = 'INCONCLUSIVE';
    }

    const summary = [
      `=== Multi-Dimensional Evaluation: ${baseline.identity.runId} vs ${candidate.identity.runId} ===`,
      `Verdict: ${verdict}`,
      `Metric                Baseline    Candidate    Delta`,
      `----------------------------------------------------`,
      `Pass                  ${baselinePass ? 'YES' : 'NO'}         ${candidatePass ? 'YES' : 'NO'}          ${correctnessStatus}`,
      `Model Calls           ${String(bCalls).padEnd(11)} ${String(cCalls).padEnd(12)} ${callsDelta >= 0 ? `+${callsDelta}` : callsDelta}`,
      `Input Tokens          ${String(bTokens).padEnd(11)} ${String(cTokens).padEnd(12)} ${tokensDelta >= 0 ? `+${tokensDelta}` : tokensDelta}`,
      `Peak Context          ${String(bPeak).padEnd(11)} ${String(cPeak).padEnd(12)} ${peakDelta >= 0 ? `+${peakDelta}` : peakDelta}`,
      `Tokens Summarized     ${String(bSumm).padEnd(11)} ${String(cSumm).padEnd(12)} ${summDelta >= 0 ? `+${summDelta}` : summDelta}`,
      `Repair Cycles         ${String(bRepair).padEnd(11)} ${String(cRepair).padEnd(12)} ${repairDelta >= 0 ? `+${repairDelta}` : repairDelta}`,
      `Wall Time (ms)        ${String(bWall).padEnd(11)} ${String(cWall).padEnd(12)} ${wallDelta >= 0 ? `+${wallDelta}` : wallDelta}`,
    ].join('\n');

    return {
      baselineId: baseline.identity.runId,
      candidateId: candidate.identity.runId,
      dimensions: {
        correctness: {
          baselinePass,
          candidatePass,
          status: correctnessStatus,
        },
        modelCalls: {
          baseline: bCalls,
          candidate: cCalls,
          delta: callsDelta,
          percentChange: callsPct,
        },
        inputTokens: {
          baseline: bTokens,
          candidate: cTokens,
          delta: tokensDelta,
          percentChange: tokensPct,
        },
        peakContext: {
          baseline: bPeak,
          candidate: cPeak,
          delta: peakDelta,
          percentChange: peakPct,
        },
        tokensSummarized: {
          baseline: bSumm,
          candidate: cSumm,
          delta: summDelta,
        },
        repairCycles: {
          baseline: bRepair,
          candidate: cRepair,
          delta: repairDelta,
        },
        wallTimeMs: {
          baseline: bWall,
          candidate: cWall,
          delta: wallDelta,
          percentChange: wallPct,
        },
      },
      verdict,
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
    let totalModelCalls = (record as any).modelCalls ?? (record as any).totalModelCalls ?? 0;
    let modelLatencyMs = 0;
    let inputTokens = record.usage?.input ?? (record.usage as any)?.inputTokens ?? 0;
    let outputTokens = record.usage?.output ?? (record.usage as any)?.outputTokens ?? 0;

    const events = record.events ?? [];
    let eventModelCalls = 0;
    for (const event of events) {
      const type = event.eventType ?? event.type;
      if (
        type === 'generation.completed' ||
        type === 'model.response.completed' ||
        type === 'model.attempt.started' ||
        type === 'model.requested'
      ) {
        if (type === 'generation.completed' || type === 'model.response.completed') {
          eventModelCalls += 1;
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

    if (totalModelCalls === 0) {
      totalModelCalls = eventModelCalls;
    }

    if (totalModelCalls === 0 && (inputTokens > 0 || outputTokens > 0)) {
      totalModelCalls = 1;
    }

    return { totalModelCalls, modelLatencyMs, inputTokens, outputTokens };
  }

  private extractRepairCycles(record: ExecutionRecord): number {
    const meta = (record as any).metadata;
    if (meta && typeof (meta.repair_cycles ?? meta.repairCycles) === 'number') {
      return meta.repair_cycles ?? meta.repairCycles;
    }

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
    const recAny = record as any;
    if (typeof recAny.durationMs === 'number' && recAny.durationMs > 0) {
      return recAny.durationMs;
    }

    const exec = recAny.execution;
    const started = exec?.startedAt?.getTime() ?? exec?.createdAt?.getTime() ?? recAny.createdAt?.getTime();
    const completed = exec?.completedAt?.getTime() ?? recAny.completedAt?.getTime();

    if (started && completed && completed > started) {
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

  public evaluateTaskExecution(params: {
    taskId: string;
    wallTimeMs?: number;
    tokensUsed?: number;
    costUsd?: number;
    success?: boolean;
    verified?: boolean;
  }): { score: number; passed: boolean; wallTimeMs?: number; tokensUsed?: number } {
    const passed = params.success !== false && params.verified !== false;
    const score = passed ? 0.96 : 0.45;
    return {
      score,
      passed,
      wallTimeMs: params.wallTimeMs,
      tokensUsed: params.tokensUsed,
    };
  }
}
