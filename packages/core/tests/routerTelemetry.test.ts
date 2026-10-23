import { describe, expect, it } from 'vitest';
import {
  TelemetryCollector,
  classifyExclusionReasons,
} from '../src/services/telemetryService.js';
import {
  explainExecution,
  formatRoutingExplanationJson,
} from '../src/services/executionExplanation.js';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import {
  createUnknownPromptCacheTelemetry,
  createUnsupportedPromptCacheTelemetry,
  toPromptCacheTelemetry,
} from '../src/types/telemetry.js';
import type { ExecutionRecord } from '../src/types/execution.js';

describe('Router Telemetry & Explainability (Group B4)', () => {
  it('1. records complete routing telemetry with harness, model, runtime, candidates, exclusions, calibration, latency, and cache reuse', () => {
    const collector = new TelemetryCollector();
    const record = collector.recordRoutingTelemetry({
      executionId: 'exec-1',
      taskId: 'task-1',
      jobId: 'job-1',
      routingPolicyVersion: '2.1.0',
      harnessId: 'native-wazir',
      modelId: 'claude-3-5-sonnet',
      runtimeId: 'anthropic',
      computerId: null,
      workerId: 'worker-a',
      accountId: 'acct-anth-1',
      predictedSuccessProbability: 0.88,
      calibrationEvidence: {
        sampleCount: 25,
        confidence: 0.84,
        isStale: false,
      },
      candidateAlternatives: [
        {
          harnessId: 'native-wazir',
          modelId: 'claude-3-5-sonnet',
          runtimeId: 'anthropic',
          eligible: true,
          score: 92.5,
          predictedSuccessProbability: 0.88,
          estimatedCostUSD: 0.045,
          reasons: ['empirical evidence [implementation]: score 88%, confidence 84% across 25 samples'],
        },
        {
          harnessId: 'acp-codex',
          modelId: 'qwen2.5-coder-7b',
          runtimeId: 'ollama',
          eligible: false,
          score: 0,
          reasons: ['context 8192 < required 32768'],
        },
      ],
      estimatedCostUSD: 0.045,
      actualCostUSD: 0.042,
      costStatus: 'ACTUAL',
      firstTokenLatencyMs: 320,
      endToEndLatencyMs: 4500,
      verificationDurationMs: 1200,
      cacheReuse: {
        cacheReadTokens: 8000,
        cacheWriteTokens: 2000,
        inputTokens: 10000,
      },
      coldStartOverheadMs: 0,
      retryOverheadMs: 500,
      retryCount: 1,
      verifiedSuccess: true,
    });

    expect(record.executionId).toBe('exec-1');
    expect(record.taskId).toBe('task-1');
    expect(record.routingPolicyVersion).toBe('2.1.0');
    expect(record.harnessId).toBe('native-wazir');
    expect(record.modelId).toBe('claude-3-5-sonnet');
    expect(record.runtimeId).toBe('anthropic');
    expect(record.workerId).toBe('worker-a');
    expect(record.accountId).toBe('acct-anth-1');
    expect(record.predictedSuccessProbability).toBe(0.88);
    expect(record.calibrationEvidence).toEqual({
      sampleCount: 25,
      confidence: 0.84,
      uncertainty: 0.16,
      isStale: false,
    });
    expect(record.estimatedCostUSD).toBe(0.045);
    expect(record.actualCostUSD).toBe(0.042);
    expect(record.costStatus).toBe('ACTUAL');
    expect(record.firstTokenLatencyMs).toBe(320);
    expect(record.endToEndLatencyMs).toBe(4500);
    expect(record.verificationDurationMs).toBe(1200);
    expect(record.coldStartOverheadMs).toBe(0);
    expect(record.retryOverheadMs).toBe(500);
    expect(record.retryCount).toBe(1);
    expect(record.cacheReuse).toEqual({
      cacheReadTokens: 8000,
      cacheWriteTokens: 2000,
      hitRate: 0.8,
    });
    expect(record.eligibilityExclusions).toEqual([
      {
        harnessId: 'acp-codex',
        modelId: 'qwen2.5-coder-7b',
        runtimeId: 'ollama',
        exclusionReasons: ['context 8192 < required 32768'],
        categories: ['context'],
      },
    ]);
  });

  it('2. classifies candidate exclusion reasons into policy, resource, context, capability, circuit_breaker, and availability', () => {
    expect(classifyExclusionReasons(["policy: model 'gpt-4o' is not in allowedModels"])).toEqual(['policy']);
    expect(classifyExclusionReasons(['routingMode=LOCAL_ONLY: hosted model is not permitted'])).toEqual(['policy']);
    expect(classifyExclusionReasons(['context 4096 < required 16384'])).toEqual(['context']);
    expect(classifyExclusionReasons(['tool calling: required but unsupported', 'vision: required but unsupported'])).toEqual(['capability']);
    expect(classifyExclusionReasons(['coding circuit OPEN: 4 consecutive failures'])).toEqual(['circuit_breaker']);
    expect(classifyExclusionReasons(['resource: insufficient usable GPU VRAM to fit model weights'])).toEqual(['resource']);
    expect(classifyExclusionReasons(['model unavailable: no runtime currently serves it'])).toEqual(['availability']);
  });

  it('3. enforces cost invariants in TelemetryCollector: local is ACTUAL $0, unpriced remote is UNKNOWN (never $0), estimated is ESTIMATED', () => {
    const collector = new TelemetryCollector();

    // Local inference -> ACTUAL $0
    const localRec = collector.recordRoutingTelemetry({
      executionId: 'exec-local',
      taskId: 'task-local',
      modelId: 'llama3.3-70b',
      runtimeId: 'ollama',
    });
    expect(localRec.costStatus).toBe('ACTUAL');
    expect(localRec.actualCostUSD).toBe(0);

    // Unpriced remote inference -> UNKNOWN and actualCostUSD is strictly null (even if caller passes 0!)
    const unknownRemote = collector.recordRoutingTelemetry({
      executionId: 'exec-unknown',
      taskId: 'task-unknown',
      modelId: 'custom-remote-model',
      runtimeId: 'custom-cloud',
      costStatus: 'UNKNOWN',
      actualCostUSD: 0,
    });
    expect(unknownRemote.costStatus).toBe('UNKNOWN');
    expect(unknownRemote.actualCostUSD).toBeNull();

    // Remote inference with only estimatedCostUSD -> ESTIMATED and actualCostUSD is null
    const estimatedRemote = collector.recordRoutingTelemetry({
      executionId: 'exec-est',
      taskId: 'task-est',
      modelId: 'claude-3-5-sonnet',
      runtimeId: 'anthropic',
      estimatedCostUSD: 0.032,
    });
    expect(estimatedRemote.costStatus).toBe('ESTIMATED');
    expect(estimatedRemote.estimatedCostUSD).toBe(0.032);
    expect(estimatedRemote.actualCostUSD).toBeNull();
  });

  it('4. derives actual cost and prompt cache reuse from recorded UsageRecords when not explicitly passed to recordRoutingTelemetry', () => {
    const collector = new TelemetryCollector();
    collector.recordModelCall({
      executionId: 'exec-derived',
      jobId: 'job-derived',
      modelId: 'claude-3-5-sonnet',
      runtimeId: 'anthropic',
      provider: 'anthropic',
      inputTokens: 10_000,
      outputTokens: 1_000,
      wallTimeMs: 2_200,
      promptCacheMetrics: {
        inputTokens: { value: 10_000, status: 'OBSERVED' },
        cacheReadTokens: { value: 6_000, status: 'OBSERVED' },
        cacheWriteTokens: { value: 1_000, status: 'OBSERVED' },
        source: 'OBSERVED',
      },
    });

    const routeRec = collector.recordRoutingTelemetry({
      executionId: 'exec-derived',
      taskId: 'task-derived',
      modelId: 'claude-3-5-sonnet',
      runtimeId: 'anthropic',
      estimatedCostUSD: 0.05,
    });

    expect(routeRec.costStatus).toBe('ACTUAL');
    expect(routeRec.actualCostUSD).toBeGreaterThan(0);
    expect(routeRec.cacheReuse).toEqual({
      cacheReadTokens: 6_000,
      cacheWriteTokens: 1_000,
      hitRate: 0.6,
    });
  });

  it('5. marks cacheReuse as UNOBSERVED in RoutingTelemetryRecord when cache metrics are absent', () => {
    const collector = new TelemetryCollector();
    const rec = collector.recordRoutingTelemetry({
      executionId: 'exec-no-cache',
      taskId: 'task-no-cache',
      modelId: 'qwen2.5-coder',
      runtimeId: 'ollama',
    });
    expect(rec.cacheReuse).toBe('UNOBSERVED');
  });

  it('6. filters and summarizes routing telemetry across multiple executions, computing calibration error and exclusion counts', () => {
    const collector = new TelemetryCollector();

    collector.recordRoutingTelemetry({
      executionId: 'e1',
      taskId: 't1',
      jobId: 'j1',
      routingPolicyVersion: '1.0.0',
      harnessId: 'native',
      modelId: 'claude-3-5-sonnet',
      runtimeId: 'anthropic',
      predictedSuccessProbability: 0.9,
      calibrationEvidence: { sampleCount: 15, confidence: 0.85, isStale: false },
      candidateAlternatives: [
        { modelId: 'claude-3-5-sonnet', runtimeId: 'anthropic', eligible: true, score: 90, reasons: ['best'] },
        { modelId: 'local-small', runtimeId: 'ollama', eligible: false, reasons: ['context 4096 < required 16384'] },
      ],
      estimatedCostUSD: 0.04,
      actualCostUSD: 0.05,
      costStatus: 'ACTUAL',
      firstTokenLatencyMs: 200,
      endToEndLatencyMs: 2000,
      verificationDurationMs: 500,
      coldStartOverheadMs: 0,
      retryOverheadMs: 0,
      retryCount: 0,
      cacheReuse: { cacheReadTokens: 4000, cacheWriteTokens: 500, hitRate: 0.8 },
      verifiedSuccess: true,
    });

    collector.recordRoutingTelemetry({
      executionId: 'e2',
      taskId: 't2',
      jobId: 'j1',
      routingPolicyVersion: '1.0.0',
      harnessId: 'acp-cli',
      modelId: 'qwen2.5-coder',
      runtimeId: 'ollama',
      predictedSuccessProbability: 0.7,
      calibrationEvidence: { sampleCount: 4, confidence: 0.4, isStale: true },
      candidateAlternatives: [
        { modelId: 'qwen2.5-coder', runtimeId: 'ollama', eligible: true, score: 70, reasons: ['local'] },
        { modelId: 'gpt-4o', runtimeId: 'openai', eligible: false, reasons: ['policy: localOnly task'] },
      ],
      estimatedCostUSD: 0,
      actualCostUSD: 0,
      costStatus: 'ACTUAL',
      firstTokenLatencyMs: 400,
      endToEndLatencyMs: 4000,
      verificationDurationMs: 1500,
      coldStartOverheadMs: 1200,
      retryOverheadMs: 600,
      retryCount: 2,
      cacheReuse: 'UNOBSERVED',
      verifiedSuccess: false,
    });

    expect(collector.getRoutingTelemetry({ harnessId: 'native' })).toHaveLength(1);
    expect(collector.getRoutingTelemetry({ modelId: 'qwen2.5-coder' })).toHaveLength(1);

    const summary = collector.summarizeRoutingTelemetry({ jobId: 'j1' });
    expect(summary.totalDecisions).toBe(2);
    expect(summary.byHarness).toEqual({ native: 1, 'acp-cli': 1 });
    expect(summary.byModel).toEqual({ 'claude-3-5-sonnet': 1, 'qwen2.5-coder': 1 });
    expect(summary.totalCandidatesEvaluated).toBe(4);
    expect(summary.totalCandidatesExcluded).toBe(2);
    expect(summary.exclusionsByCategory.context).toBe(1);
    expect(summary.exclusionsByCategory.policy).toBe(1);
    expect(summary.cost).toEqual({
      totalEstimatedCostUSD: 0.04,
      totalActualCostUSD: 0.05,
      unknownCostCount: 0,
      estimatedCostCount: 0,
      actualCostCount: 2,
      costStatus: 'ACTUAL',
    });
    expect(summary.latency).toEqual({
      avgFirstTokenLatencyMs: 300,
      avgEndToEndLatencyMs: 3000,
      avgVerificationDurationMs: 1000,
      avgColdStartOverheadMs: 600,
      avgRetryOverheadMs: 300,
      totalRetries: 2,
    });
    // e1 error = |0.9 - 1| = 0.1, e2 error = |0.7 - 0| = 0.7 -> MAE = 0.4
    expect(summary.calibration.avgPredictedSuccessProbability).toBeCloseTo(0.8);
    expect(summary.calibration.observedVerifiedSuccessRate).toBeCloseTo(0.5);
    expect(summary.calibration.meanAbsoluteCalibrationError).toBeCloseTo(0.4);
    expect(summary.calibration.staleCalibrationCount).toBe(1);
    expect(summary.cache).toEqual({
      observedCount: 1,
      unobservedCount: 1,
      totalCacheReadTokens: 4000,
      totalCacheWriteTokens: 500,
      avgHitRate: 0.8,
    });
  });

  it('7. explainExecution projects candidateAlternatives, eligibilityExclusions, predictedSuccessProbability, and calibration from empirical scheduling facts', async () => {
    const engine = new ExecutionEngine();
    const { execution } = await engine.create({
      task: {
        id: 'task-emp',
        type: 'coding',
        input: 'fix bug in parser.ts',
        requirements: { capabilities: ['coding'], toolCalling: true },
        priority: 'high',
        status: 'pending',
        createdAt: new Date(),
      },
      agentId: 'native-harness',
      computerId: 'mac-studio',
      runtimeId: 'ollama',
      modelId: 'qwen2.5-coder-32b',
      scheduling: {
        agentId: 'native-harness',
        modelId: 'qwen2.5-coder-32b',
        modelInstanceId: 'inst-1',
        runtimeId: 'ollama',
        computerId: 'mac-studio',
        readiness: 'READY_NOW',
        resourceType: 'LOCAL_GPU_INFERENCE',
        modelDecision: {
          modelId: 'qwen2.5-coder-32b',
          modelInstanceId: 'inst-1',
          strategy: 'empirical_profile',
          score: 48,
          reasons: [
            'required capability: bug_localization',
            'empirical evidence [bug_localization]: score 85%, confidence 80% across 20 samples (+3)',
          ],
          empiricalExplanation: {
            requiredCapability: 'bug_localization',
            language: 'typescript',
            phase: 'REPAIR',
            candidateModels: ['qwen2.5-coder-32b', 'llama3-8b', 'claude-3-5-sonnet', 'broken-model'],
            evaluatedCandidates: [
              {
                modelId: 'qwen2.5-coder-32b',
                runtimeId: 'ollama',
                profileFound: true,
                isStale: false,
                categoryScore: 0.85,
                effectiveScore: 48,
                confidence: 0.8,
                sampleCount: 20,
                policyAllowed: true,
                resourceAllowed: true,
                eligible: true,
                reasons: ['coding capability: present', 'empirical evidence [bug_localization]: score 85%'],
              },
              {
                modelId: 'llama3-8b',
                runtimeId: 'ollama',
                profileFound: true,
                isStale: false,
                categoryScore: 0.4,
                effectiveScore: 0,
                confidence: 0.7,
                sampleCount: 10,
                policyAllowed: true,
                resourceAllowed: false,
                resourceRejection: 'context 8192 < required 32768',
                eligible: false,
                reasons: ['context 8192 < required 32768'],
              },
              {
                modelId: 'claude-3-5-sonnet',
                runtimeId: 'anthropic',
                profileFound: false,
                isStale: false,
                effectiveScore: 0,
                sampleCount: 0,
                policyAllowed: false,
                policyRejection: 'routingMode=LOCAL_ONLY: hosted model is not permitted',
                resourceAllowed: true,
                eligible: false,
                reasons: ['routingMode=LOCAL_ONLY: hosted model is not permitted'],
              },
              {
                modelId: 'broken-model',
                runtimeId: 'ollama',
                profileFound: false,
                isStale: false,
                effectiveScore: 0,
                sampleCount: 0,
                policyAllowed: true,
                resourceAllowed: true,
                eligible: false,
                reasons: ['coding circuit OPEN: 5 consecutive failures'],
              },
            ],
            selectedModelId: 'qwen2.5-coder-32b',
            selectionReason: "Selected model 'qwen2.5-coder-32b' with highest verified evidence score (48)",
            policyConstraintsApplied: ['hosted-provider-gate', 'execution-policy-bounds'],
            resourceConstraintsApplied: ['context-headroom-requirement', 'gpu-memory'],
          },
        },
        computerDecision: {
          computerId: 'mac-studio',
          runtimeId: 'ollama',
          placementKind: 'local',
          resourceType: 'LOCAL_GPU_INFERENCE',
          score: 30,
          reasons: ['local GPU ready'],
        },
        reasons: ['model: bug_localization', 'computer: local GPU ready'],
        decidedAt: new Date(),
      },
    });

    await engine.recordEvent(execution.id, 'execution.scheduled', {
      routingPolicyVersion: 'policy-v3.2',
    });

    const why = explainExecution(engine.require(execution.id));

    expect(why.routing.harnessId).toBe('native-harness');
    expect(why.routing.policyVersion).toBe('policy-v3.2');
    expect(why.routing.predictedSuccessProbability).toBe(0.85);
    expect(why.routing.calibration).toEqual({
      sampleCount: 20,
      confidence: 0.8,
      isStale: false,
    });
    expect(why.routing.candidateAlternatives).toHaveLength(4);
    expect(why.routing.candidateAlternatives[0]).toMatchObject({
      modelId: 'qwen2.5-coder-32b',
      runtimeId: 'ollama',
      eligible: true,
      score: 48,
    });
    expect(why.routing.eligibilityExclusions).toEqual([
      {
        modelId: 'llama3-8b',
        runtimeId: 'ollama',
        exclusionReasons: ['context 8192 < required 32768'],
      },
      {
        modelId: 'claude-3-5-sonnet',
        runtimeId: 'anthropic',
        exclusionReasons: ['routingMode=LOCAL_ONLY: hosted model is not permitted'],
      },
      {
        modelId: 'broken-model',
        runtimeId: 'ollama',
        exclusionReasons: ['coding circuit OPEN: 5 consecutive failures'],
      },
    ]);
  });

  it('8. explainExecution does not use stale empirical profile score as predictedSuccessProbability and flags calibration.isStale = true', async () => {
    const engine = new ExecutionEngine();
    const { execution } = await engine.create({
      task: {
        id: 'task-stale',
        type: 'coding',
        input: 'fix',
        requirements: {},
        priority: 'normal',
        status: 'pending',
        createdAt: new Date(),
      },
      computerId: 'local',
      runtimeId: 'ollama',
      modelId: 'qwen2.5-coder',
      scheduling: {
        modelId: 'qwen2.5-coder',
        modelInstanceId: 'inst-1',
        runtimeId: 'ollama',
        computerId: 'local',
        modelDecision: {
          modelId: 'qwen2.5-coder',
          modelInstanceId: 'inst-1',
          strategy: 'empirical_profile',
          score: 10,
          reasons: ['empirical profile stale: runtime version changed'],
          empiricalExplanation: {
            requiredCapability: 'implementation',
            candidateModels: ['qwen2.5-coder'],
            evaluatedCandidates: [
              {
                modelId: 'qwen2.5-coder',
                runtimeId: 'ollama',
                profileFound: true,
                isStale: true,
                staleReason: 'runtime version changed',
                categoryScore: 0.92,
                effectiveScore: 10,
                confidence: 0.75,
                sampleCount: 12,
                policyAllowed: true,
                resourceAllowed: true,
                eligible: true,
                reasons: ['empirical profile stale: runtime version changed'],
              },
            ],
            selectedModelId: 'qwen2.5-coder',
            selectionReason: 'fallback to capability score',
            policyConstraintsApplied: [],
            resourceConstraintsApplied: [],
          },
        },
        computerDecision: {
          computerId: 'local',
          runtimeId: 'ollama',
          placementKind: 'local',
          score: 10,
          reasons: ['local'],
        },
        reasons: [],
        decidedAt: new Date(),
      },
    });

    const why = explainExecution(engine.require(execution.id));
    expect(why.routing.predictedSuccessProbability).toBeNull();
    expect(why.routing.calibration).toEqual({
      sampleCount: 12,
      confidence: 0.75,
      isStale: true,
    });
  });

  it('9. explainExecution enforces costComparison invariants across ACTUAL local ($0), ACTUAL remote, ESTIMATED remote, and UNKNOWN remote (never $0)', async () => {
    const engine = new ExecutionEngine();

    // Case A: Local runtime -> ACTUAL $0
    const { execution: localExec } = await engine.create({
      task: { id: 't-local', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'local',
      runtimeId: 'ollama',
      modelId: 'llama3',
    });
    const whyLocal = explainExecution(engine.require(localExec.id));
    expect(whyLocal.routing.costComparison).toEqual({
      estimatedCostUSD: null,
      actualCostUSD: 0,
      costStatus: 'ACTUAL',
    });

    // Case B: Unpriced remote provider -> UNKNOWN, actualCostUSD is null (never $0)
    const { execution: unknownExec } = await engine.create({
      task: { id: 't-unknown', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      runtimeId: 'claude-code-subscription',
      modelId: 'claude-sonnet',
    });
    const whyUnknown = explainExecution(engine.require(unknownExec.id));
    expect(whyUnknown.routing.costComparison).toEqual({
      estimatedCostUSD: null,
      actualCostUSD: null,
      costStatus: 'UNKNOWN',
    });

    // Case C: Remote provider with estimated cost at routing and actual cost at completion
    const { execution: pricedExec } = await engine.create({
      task: { id: 't-priced', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      runtimeId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
    });
    await engine.recordEvent(pricedExec.id, 'execution.scheduled', {
      estimatedCostUSD: 0.04,
    });
    // Before completion, costStatus is ESTIMATED and actualCostUSD is null
    const whyBefore = explainExecution(engine.require(pricedExec.id));
    expect(whyBefore.routing.costComparison).toEqual({
      estimatedCostUSD: 0.04,
      actualCostUSD: null,
      costStatus: 'ESTIMATED',
    });

    // After completion with actual cost
    await engine.recordEvent(pricedExec.id, 'execution.completed', {
      actualCostUSD: 0.038,
      costStatus: 'ACTUAL',
    });
    const whyAfter = explainExecution(engine.require(pricedExec.id));
    expect(whyAfter.routing.costComparison).toEqual({
      estimatedCostUSD: 0.04,
      actualCostUSD: 0.038,
      costStatus: 'ACTUAL',
    });
  });

  it('10. explainExecution computes latencyBreakdown from timestamps, check runs, cold-start events, and retry delays', async () => {
    const engine = new ExecutionEngine();
    const { execution } = await engine.create({
      task: { id: 't-latency', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'local',
      runtimeId: 'ollama',
      modelId: 'qwen2.5-coder',
    });
    const id = execution.id;

    // Record cold start (model.loading -> model.loaded = 1500ms)
    await engine.recordEvent(id, 'model.loading', { modelId: 'qwen2.5-coder', timestamp: '2026-05-01T10:00:00.000Z' });
    await engine.recordEvent(id, 'model.loaded', { modelId: 'qwen2.5-coder', timestamp: '2026-05-01T10:00:01.500Z' });

    // Record generation start and first token (350ms TTFT)
    await engine.recordEvent(id, 'generation.started', { timestamp: '2026-05-01T10:00:02.000Z' });
    await engine.recordEvent(id, 'generation.token', { timestamp: '2026-05-01T10:00:02.350Z' });

    // Record two retries (400ms + 800ms = 1200ms retry overhead)
    await engine.recordProviderEvent(
      id,
      { type: 'retry', error: 'rate limit', failureClass: 'RATE_LIMIT', retryAttempt: 1, retryDelayMs: 400 },
      { requestId: 'r1', model: 'qwen2.5-coder', provider: 'ollama' },
    );
    await engine.recordProviderEvent(
      id,
      { type: 'retry', error: 'timeout', failureClass: 'TIMEOUT', retryAttempt: 2, retryDelayMs: 800 },
      { requestId: 'r2', model: 'qwen2.5-coder', provider: 'ollama' },
    );

    // Record verification checks (300ms + 450ms = 750ms verification duration)
    await engine.recordCheck(id, { name: 'build', command: 'npm run build', ok: true, output: 'ok', durationMs: 300, workspaceRevision: 0 });
    await engine.recordCheck(id, { name: 'test', command: 'npm test', ok: true, output: 'ok', durationMs: 450, workspaceRevision: 0 });

    const rec = engine.require(id);
    // Set execution startedAt and completedAt (8000ms E2E)
    rec.execution.startedAt = new Date('2026-05-01T10:00:00.000Z');
    rec.execution.completedAt = new Date('2026-05-01T10:00:08.000Z');

    const why = explainExecution(rec);
    expect(why.routing.latencyBreakdown).toEqual({
      firstTokenLatencyMs: 350,
      endToEndLatencyMs: 8000,
      verificationDurationMs: 750,
      coldStartOverheadMs: 1500,
      retryOverheadMs: 1200,
    });
  });

  it('11. explainExecution derives cacheReuse when observed and returns null for UNKNOWN or UNSUPPORTED cache telemetry', async () => {
    const engine = new ExecutionEngine();
    const { execution } = await engine.create({
      task: { id: 't-cache', type: 'coding', input: 'fix', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      computerId: 'local',
      runtimeId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
    });
    const rec = engine.require(execution.id);

    // 1. UNKNOWN prompt cache telemetry -> cacheReuse is null (never 0!)
    rec.usage = {
      input: 5000,
      output: 500,
      promptCache: createUnknownPromptCacheTelemetry({
        runtimeId: 'anthropic',
        modelId: 'claude-3-5-sonnet',
        executionId: execution.id,
      }),
    };
    expect(explainExecution(rec).routing.cacheReuse).toBeNull();

    // 2. UNSUPPORTED prompt cache telemetry -> cacheReuse is null (never 0!)
    rec.usage = {
      input: 5000,
      output: 500,
      promptCache: createUnsupportedPromptCacheTelemetry({
        runtimeId: 'ollama',
        modelId: 'llama3',
        executionId: execution.id,
        inputTokens: 5000,
      }),
    };
    expect(explainExecution(rec).routing.cacheReuse).toBeNull();

    // 3. OBSERVED prompt cache telemetry -> cacheReuse populated with hitRate
    rec.usage = {
      input: 5000,
      output: 500,
      promptCache: toPromptCacheTelemetry({
        runtimeId: 'anthropic',
        modelId: 'claude-3-5-sonnet',
        executionId: execution.id,
        metrics: {
          inputTokens: { value: 5000, status: 'OBSERVED' },
          cacheReadTokens: { value: 3500, status: 'OBSERVED' },
          cacheWriteTokens: { value: 500, status: 'OBSERVED' },
          source: 'OBSERVED',
        },
      }),
    };
    expect(explainExecution(rec).routing.cacheReuse).toEqual({
      cacheReadTokens: 3500,
      cacheWriteTokens: 500,
      hitRate: 0.7,
    });
  });

  it('12. explainExecution emits no fabricated values when scheduling, usage, checks, and telemetry events are absent', () => {
    const minimalRecord: ExecutionRecord = {
      execution: {
        id: 'exec-minimal',
        taskId: 'task-minimal',
        runtimeId: 'unpriced-remote',
        modelId: 'some-model',
        status: 'pending',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      },
      task: {
        id: 'task-minimal',
        type: 'coding',
        input: 'do something',
        requirements: {},
        priority: 'normal',
        status: 'pending',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      },
      policyDecisions: [],
      toolCalls: [],
      filesChanged: [],
      checks: [],
      errors: [],
      events: [],
    };

    const why = explainExecution(minimalRecord);

    expect(why.executionId).toBe('exec-minimal');
    expect(why.routing.harnessId).toBeNull();
    expect(why.routing.policyVersion).toBeNull();
    expect(why.routing.predictedSuccessProbability).toBeNull();
    expect(why.routing.calibration).toBeNull();
    expect(why.routing.candidateAlternatives).toEqual([]);
    expect(why.routing.eligibilityExclusions).toEqual([]);
    expect(why.routing.costComparison).toEqual({
      estimatedCostUSD: null,
      actualCostUSD: null,
      costStatus: 'UNKNOWN',
    });
    expect(why.routing.latencyBreakdown).toEqual({
      firstTokenLatencyMs: null,
      endToEndLatencyMs: null,
      verificationDurationMs: null,
      coldStartOverheadMs: null,
      retryOverheadMs: null,
    });
    expect(why.routing.cacheReuse).toBeNull();
  });

  it('13. formatRoutingExplanationJson outputs valid machine-readable JSON preserving all explanation and routing audit fields', async () => {
    const engine = new ExecutionEngine();
    const { execution } = await engine.create({
      task: { id: 't-json', type: 'coding', input: 'test json', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
      agentId: 'acp-claude-code',
      computerId: 'local',
      runtimeId: 'lmstudio',
      modelId: 'deepseek-coder',
    });
    await engine.recordEvent(execution.id, 'execution.scheduled', {
      routingPolicyVersion: '1.2.0',
      predictedSuccessProbability: 0.78,
      estimatedCostUSD: 0,
      candidateAlternatives: [
        { harnessId: 'acp-claude-code', modelId: 'deepseek-coder', runtimeId: 'lmstudio', eligible: true, score: 82.1, reasons: ['ready now'] },
        { harnessId: 'native', modelId: 'gpt-4o', runtimeId: 'openai', eligible: false, reasons: ['policy: localOnly'] },
      ],
    });

    const explanation = explainExecution(engine.require(execution.id));
    const jsonString = formatRoutingExplanationJson(explanation);
    const parsed = JSON.parse(jsonString);

    expect(parsed.executionId).toBe(execution.id);
    expect(parsed.routing.harnessId).toBe('acp-claude-code');
    expect(parsed.routing.policyVersion).toBe('1.2.0');
    expect(parsed.routing.predictedSuccessProbability).toBe(0.78);
    expect(parsed.routing.candidateAlternatives).toHaveLength(2);
    expect(parsed.routing.eligibilityExclusions).toEqual([
      {
        harnessId: 'native',
        modelId: 'gpt-4o',
        runtimeId: 'openai',
        exclusionReasons: ['policy: localOnly'],
      },
    ]);
    expect(parsed.routingAudit).toEqual({
      harnessId: parsed.routing.harnessId,
      policyVersion: parsed.routing.policyVersion,
      predictedSuccessProbability: parsed.routing.predictedSuccessProbability,
      calibration: parsed.routing.calibration,
      candidateAlternatives: parsed.routing.candidateAlternatives,
      eligibilityExclusions: parsed.routing.eligibilityExclusions,
      costComparison: parsed.routing.costComparison,
      latencyBreakdown: parsed.routing.latencyBreakdown,
      cacheReuse: parsed.routing.cacheReuse,
    });
  });
});
