import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import type { ExecutionRecord } from '../src/types/execution.js';
import {
  ModelIntelligenceService,
  type HarnessProfileSegmentationKey,
} from '../src/services/modelIntelligenceService.js';
import {
  HarnessPerformanceService,
  computeWilsonInterval,
  isProviderInfrastructureOutage,
} from '../src/services/harnessPerformanceService.js';
import { TaskCapabilityClassifier } from '../src/services/taskCapabilityClassifier.js';

describe('HarnessPerformanceService & Harness-Segmented Model Intelligence (Agent B1)', () => {
  let store: MemoryStore;
  let classifier: TaskCapabilityClassifier;
  let modelIntelligence: ModelIntelligenceService;
  let service: HarnessPerformanceService;
  let currentTimeMs: number;

  beforeEach(() => {
    store = new MemoryStore();
    classifier = new TaskCapabilityClassifier();
    modelIntelligence = new ModelIntelligenceService({ store, classifier });
    currentTimeMs = 1_700_000_000_000;
    service = new HarnessPerformanceService({
      store,
      modelIntelligence,
      classifier,
      minSamples: 3,
      maxAgeMs: 60_000,
      now: () => currentTimeMs,
    });
  });

  it('1. preserves exact 5-part segmentation key in ModelIntelligenceService when harnessId is omitted and extends when provided', () => {
    const legacyKey: HarnessProfileSegmentationKey = {
      model: 'qwen/qwen3-coder-next',
      modelVersion: '1.0.0',
      runtime: 'lmstudio',
      quantization: 'q4_k_m',
      wazirProtocolVersion: '1.0.0',
    };
    expect(modelIntelligence.getSegmentKey(legacyKey)).toBe(
      'qwen/qwen3-coder-next::1.0.0::lmstudio::q4_k_m::1.0.0',
    );

    const withHarnessKey: HarnessProfileSegmentationKey = {
      ...legacyKey,
      harnessId: 'claude-code-acp',
    };
    expect(modelIntelligence.getSegmentKey(withHarnessKey)).toBe(
      'qwen/qwen3-coder-next::1.0.0::lmstudio::q4_k_m::1.0.0::claude-code-acp',
    );

    const withHarnessAndEnvKey: HarnessProfileSegmentationKey = {
      ...legacyKey,
      harnessId: 'claude-code-acp',
      environment: 'darwin-arm64',
    };
    expect(modelIntelligence.getSegmentKey(withHarnessAndEnvKey)).toBe(
      'qwen/qwen3-coder-next::1.0.0::lmstudio::q4_k_m::1.0.0::claude-code-acp::darwin-arm64',
    );
  });

  it('2. maintains distinct evidence-backed performance profiles for two harnesses using the exact same model and runtime', () => {
    const sharedModel = 'claude-3-7-sonnet';
    const sharedRuntime = 'anthropic';

    // Native harness succeeds 5/5 times on compile_repair
    for (let i = 1; i <= 5; i++) {
      service.recordOutcome({
        executionId: `exec-native-${i}`,
        harnessId: 'native',
        modelId: sharedModel,
        runtimeId: sharedRuntime,
        taskCategory: 'compile_repair',
        environment: 'darwin-arm64',
        status: 'completed',
        verified: true,
        costUSD: 0.02,
        durationMs: 1200,
      });
    }

    // External CLI harness succeeds only 1/5 times on compile_repair with the exact same model
    for (let i = 1; i <= 5; i++) {
      service.recordOutcome({
        executionId: `exec-ext-${i}`,
        harnessId: 'external-cli',
        modelId: sharedModel,
        runtimeId: sharedRuntime,
        taskCategory: 'compile_repair',
        environment: 'darwin-arm64',
        status: i === 1 ? 'completed' : 'failed',
        verified: i === 1,
        terminationReason: i === 1 ? 'VERIFICATION_PASSED' : 'VERIFICATION_FAILED',
        errors: i === 1 ? [] : ['tsc build failed'],
        costUSD: 0.035,
        durationMs: 2800,
      });
    }

    const nativeProfile = service.getProfile({
      harnessId: 'native',
      modelId: sharedModel,
      runtimeId: sharedRuntime,
      taskCategory: 'compile_repair',
      environment: 'darwin-arm64',
    })!;
    const externalProfile = service.getProfile({
      harnessId: 'external-cli',
      modelId: sharedModel,
      runtimeId: sharedRuntime,
      taskCategory: 'compile_repair',
      environment: 'darwin-arm64',
    })!;

    expect(nativeProfile).toBeDefined();
    expect(externalProfile).toBeDefined();
    expect(nativeProfile.segmentKey).not.toBe(externalProfile.segmentKey);

    expect(nativeProfile.sampleCount).toBe(5);
    expect(nativeProfile.verifiedSuccessCount).toBe(5);
    expect(nativeProfile.verifiedSuccessRate).toBe(1.0);
    expect(nativeProfile.capabilityScore).toBeGreaterThan(0.9);

    expect(externalProfile.sampleCount).toBe(5);
    expect(externalProfile.verifiedSuccessCount).toBe(1);
    expect(externalProfile.codingFailureCount).toBe(4);
    expect(externalProfile.verifiedSuccessRate).toBe(0.2);
    expect(externalProfile.capabilityScore).toBeLessThan(0.35);

    const ranked = service.compareHarnesses({
      modelId: sharedModel,
      runtimeId: sharedRuntime,
      taskCategory: 'compile_repair',
      environment: 'darwin-arm64',
    });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].harnessId).toBe('native');
    expect(ranked[1].harnessId).toBe('external-cli');
  });

  it('3. enforces physical verification invariant: self-reported completion without controller verification is recorded as unverified/failed', () => {
    // Case A: status='completed' with verified=false
    service.recordOutcome({
      executionId: 'exec-unverified-1',
      harnessId: 'acp-harness',
      modelId: 'gpt-4o',
      runtimeId: 'openai',
      taskCategory: 'implementation',
      status: 'completed',
      verified: false,
      durationMs: 900,
    });

    // Case B: status='completed' with verified=undefined and no physical checks
    const profile = service.recordOutcome({
      executionId: 'exec-unverified-2',
      harnessId: 'acp-harness',
      modelId: 'gpt-4o',
      runtimeId: 'openai',
      taskCategory: 'implementation',
      status: 'completed',
      checks: [],
      durationMs: 1100,
    });

    expect(profile.sampleCount).toBe(2);
    expect(profile.verifiedSuccessCount).toBe(0);
    expect(profile.codingFailureCount).toBe(2);
    expect(profile.unverifiedCompletionCount).toBe(2);
    expect(profile.verifiedSuccessRate).toBe(0);
  });

  it('4. rejects checks that ran at an earlier workspaceRevision than the final revision', () => {
    const profile = service.recordOutcome({
      executionId: 'exec-stale-check-rev',
      harnessId: 'native',
      modelId: 'qwen/qwen3-coder-next',
      runtimeId: 'lmstudio',
      taskCategory: 'test_repair',
      status: 'completed',
      workspaceRevision: 5,
      filesChanged: ['src/index.ts'],
      checks: [
        {
          name: 'test',
          command: 'vitest run',
          ok: true,
          output: '1 passed',
          durationMs: 100,
          workspaceRevision: 4, // Stale revision! File mutated again at rev 5
        },
      ],
    });

    expect(profile.sampleCount).toBe(1);
    expect(profile.verifiedSuccessCount).toBe(0);
    expect(profile.codingFailureCount).toBe(1);
    expect(profile.verifiedSuccessRate).toBe(0);
  });

  it('5. separates provider/infrastructure outages from coding failures without penalizing coding capability score', () => {
    const baseSegment = {
      harnessId: 'native',
      modelId: 'deepseek-r1',
      runtimeId: 'nvidia',
      taskCategory: 'bug_localization' as const,
      environment: 'linux-x64',
    };

    // Record 4 verified coding successes
    for (let i = 1; i <= 4; i++) {
      service.recordOutcome({
        ...baseSegment,
        executionId: `exec-ok-${i}`,
        status: 'completed',
        verified: true,
        costUSD: 0.01,
        durationMs: 1000,
      });
    }

    // Record 1 genuine coding failure (VERIFICATION_FAILED)
    service.recordOutcome({
      ...baseSegment,
      executionId: 'exec-code-fail-1',
      status: 'failed',
      verified: false,
      terminationReason: 'VERIFICATION_FAILED',
      errorKind: 'verification',
      errors: ['AssertionError: expected 42 to equal 43'],
      costUSD: 0.01,
      durationMs: 1200,
    });

    const beforeOutages = service.getProfile(baseSegment)!;
    expect(beforeOutages.sampleCount).toBe(5);
    expect(beforeOutages.verifiedSuccessCount).toBe(4);
    expect(beforeOutages.codingFailureCount).toBe(1);
    expect(beforeOutages.verifiedSuccessRate).toBe(0.8);
    const capabilityBeforeOutages = beforeOutages.capabilityScore;

    // Now record 3 infrastructure/provider outages:
    // Outage 1: HTTP 429 rate limit
    service.recordOutcome({
      ...baseSegment,
      executionId: 'exec-outage-429',
      status: 'failed',
      errors: ['HTTP 429 Too Many Requests: rate limit exceeded'],
      durationMs: 50,
    });

    // Outage 2: errorKind === 'infrastructure' / ECONNREFUSED
    service.recordOutcome({
      ...baseSegment,
      executionId: 'exec-outage-conn',
      status: 'failed',
      errorKind: 'infrastructure',
      errors: ['connect ECONNREFUSED 127.0.0.1:11434'],
      durationMs: 15,
    });

    // Outage 3: PROVIDER_OUTAGE / timeout before model response
    const afterOutages = service.recordOutcome({
      ...baseSegment,
      executionId: 'exec-outage-timeout',
      status: 'failed',
      terminationReason: 'PROVIDER_OUTAGE',
      failureClassification: 'timeout_before_response',
      errors: ['Timeout before model response from upstream gateway (503 Service Unavailable)'],
      durationMs: 5000,
    });

    expect(afterOutages.providerOutageCount).toBe(3);
    // Coding sample count, verifiedSuccessRate, and capabilityScore MUST remain unchanged!
    expect(afterOutages.sampleCount).toBe(5);
    expect(afterOutages.verifiedSuccessCount).toBe(4);
    expect(afterOutages.codingFailureCount).toBe(1);
    expect(afterOutages.verifiedSuccessRate).toBe(0.8);
    expect(afterOutages.capabilityScore).toBe(capabilityBeforeOutages);
    // Availability reflects 5 completed task runs vs 3 provider outages = 5 / 8 = 0.625
    expect(afterOutages.availabilityRate).toBe(0.625);
  });

  it('6. accurately classifies provider outage patterns via isProviderInfrastructureOutage helper', () => {
    expect(isProviderInfrastructureOutage({ errorKind: 'infrastructure' })).toBe(true);
    expect(isProviderInfrastructureOutage({ terminationReason: 'PROVIDER_OUTAGE' })).toBe(true);
    expect(isProviderInfrastructureOutage({ errors: ['Error: 429 Too Many Requests'] })).toBe(true);
    expect(isProviderInfrastructureOutage({ errors: ['fetch failed: ECONNREFUSED'] })).toBe(true);
    expect(isProviderInfrastructureOutage({ errors: ['Timeout before model response'] })).toBe(true);
    expect(
      isProviderInfrastructureOutage({
        errorKind: 'verification',
        terminationReason: 'VERIFICATION_FAILED',
        errors: ['Test suite failed with 2 assertion errors'],
      }),
    ).toBe(false);
    expect(
      isProviderInfrastructureOutage({
        errorKind: 'protocol',
        terminationReason: 'MAX_REPAIRS',
        errors: ['Exceeded max repair cycles'],
      }),
    ).toBe(false);
  });

  it('7. deduplicates identical (executionId, attemptId) submissions without double-counting', () => {
    const outcome = {
      executionId: 'exec-dedup-100',
      attemptId: 'att-1',
      harnessId: 'native',
      modelId: 'qwen/qwen3-coder-next',
      runtimeId: 'lmstudio',
      taskCategory: 'implementation' as const,
      status: 'completed',
      verified: true,
      costUSD: 0,
      durationMs: 500,
    };

    const first = service.recordOutcome(outcome);
    expect(first.sampleCount).toBe(1);
    expect(first.verifiedSuccessCount).toBe(1);

    // Duplicate submissions of the same executionId and attemptId
    const second = service.recordOutcome(outcome);
    const third = service.recordOutcome({ ...outcome });

    expect(second.sampleCount).toBe(1);
    expect(third.sampleCount).toBe(1);
    expect(third.verifiedSuccessCount).toBe(1);
    expect(third.retryCount).toBe(0);
  });

  it('8. handles multi-attempt retry accounting: tracks retryCount and firstAttemptSuccess vs eventualVerifiedSuccess without double-counting sampleCount', () => {
    const seg = {
      harnessId: 'native',
      modelId: 'qwen/qwen3-coder-next',
      runtimeId: 'lmstudio',
      taskCategory: 'compile_repair' as const,
      environment: 'darwin-arm64',
    };

    // Attempt 1 of exec-retry-1 fails verification
    const afterAttempt1 = service.recordOutcome({
      ...seg,
      executionId: 'exec-retry-1',
      attemptId: 'att-1',
      status: 'failed',
      verified: false,
      terminationReason: 'VERIFICATION_FAILED',
      errors: ['Type error on line 10'],
      costUSD: 0.01,
      durationMs: 1000,
    });

    expect(afterAttempt1.sampleCount).toBe(1);
    expect(afterAttempt1.verifiedSuccessCount).toBe(0);
    expect(afterAttempt1.codingFailureCount).toBe(1);
    expect(afterAttempt1.retryCount).toBe(0);
    expect(afterAttempt1.firstAttemptSuccess).toBe(false);
    expect(afterAttempt1.eventualVerifiedSuccess).toBe(false);

    // Attempt 2 (retry) of exec-retry-1 passes controller verification
    const afterAttempt2 = service.recordOutcome({
      ...seg,
      executionId: 'exec-retry-1',
      attemptId: 'att-2',
      status: 'completed',
      verified: true,
      terminationReason: 'VERIFICATION_PASSED',
      costUSD: 0.015,
      durationMs: 800,
    });

    // Must NOT double-count sampleCount: it is still 1 execution that eventually succeeded on retry!
    expect(afterAttempt2.sampleCount).toBe(1);
    expect(afterAttempt2.verifiedSuccessCount).toBe(1);
    expect(afterAttempt2.codingFailureCount).toBe(0);
    expect(afterAttempt2.retryCount).toBe(1);
    expect(afterAttempt2.firstAttemptSuccess).toBe(false);
    expect(afterAttempt2.firstAttemptSuccessCount).toBe(0);
    expect(afterAttempt2.firstAttemptSuccessRate).toBe(0);
    expect(afterAttempt2.eventualVerifiedSuccess).toBe(true);
    expect(afterAttempt2.eventualVerifiedSuccessCount).toBe(1);
    expect(afterAttempt2.eventualVerifiedSuccessRate).toBe(1.0);
    expect(afterAttempt2.avgCostUSD).toBeCloseTo(0.025, 5);
    expect(afterAttempt2.avgDurationMs).toBe(1800);

    // Re-submitting attempt 2 is deduplicated
    const afterDuplicateAttempt2 = service.recordOutcome({
      ...seg,
      executionId: 'exec-retry-1',
      attemptId: 'att-2',
      status: 'completed',
      verified: true,
      costUSD: 0.015,
      durationMs: 800,
    });
    expect(afterDuplicateAttempt2.sampleCount).toBe(1);
    expect(afterDuplicateAttempt2.retryCount).toBe(1);

    const execSummary = service.getExecutionSummary('exec-retry-1', 'native')!;
    expect(execSummary.attemptIds).toEqual(['att-1', 'att-2']);
    expect(execSummary.retryCount).toBe(1);
    expect(execSummary.firstAttemptSuccess).toBe(false);
    expect(execSummary.eventualVerifiedSuccess).toBe(true);
  });

  it('9. handles single-call retryCount reporting accurately for firstAttemptSuccess vs eventualVerifiedSuccess', () => {
    const profile = service.recordOutcome({
      executionId: 'exec-single-retry-summary',
      harnessId: 'claude-code-acp',
      modelId: 'claude-3-7-sonnet',
      runtimeId: 'anthropic',
      taskCategory: 'test_repair',
      retryCount: 2,
      status: 'completed',
      verified: true,
      costUSD: 0.04,
      durationMs: 3200,
    });

    expect(profile.sampleCount).toBe(1);
    expect(profile.verifiedSuccessCount).toBe(1);
    expect(profile.retryCount).toBe(2);
    expect(profile.firstAttemptSuccess).toBe(false);
    expect(profile.firstAttemptSuccessCount).toBe(0);
    expect(profile.eventualVerifiedSuccess).toBe(true);
    expect(profile.eventualVerifiedSuccessCount).toBe(1);
  });

  it('10. computes Wilson score 95% confidence intervals whose uncertainty bounds shrink monotonically as sample count increases', () => {
    const seg = {
      harnessId: 'native',
      modelId: 'qwen/qwen3-coder-next',
      runtimeId: 'lmstudio',
      taskCategory: 'implementation' as const,
      environment: 'darwin-arm64',
    };

    // 2 samples (both pass)
    for (let i = 1; i <= 2; i++) {
      service.recordOutcome({
        ...seg,
        executionId: `exec-wilson-${i}`,
        status: 'completed',
        verified: true,
        durationMs: 400,
      });
    }
    const prof2 = service.getProfile(seg)!;

    // Add 8 more samples -> 10 samples (all pass)
    for (let i = 3; i <= 10; i++) {
      service.recordOutcome({
        ...seg,
        executionId: `exec-wilson-${i}`,
        status: 'completed',
        verified: true,
        durationMs: 400,
      });
    }
    const prof10 = service.getProfile(seg)!;

    // Add 30 more samples -> 40 samples (all pass)
    for (let i = 11; i <= 40; i++) {
      service.recordOutcome({
        ...seg,
        executionId: `exec-wilson-${i}`,
        status: 'completed',
        verified: true,
        durationMs: 400,
      });
    }
    const prof40 = service.getProfile(seg)!;

    expect(prof2.uncertainty.lowerBound).toBeGreaterThanOrEqual(0);
    expect(prof2.uncertainty.upperBound).toBeLessThanOrEqual(1);
    expect(prof2.uncertainty.width).toBeGreaterThan(prof10.uncertainty.width);
    expect(prof10.uncertainty.width).toBeGreaterThan(prof40.uncertainty.width);
    expect(prof40.uncertainty.lowerBound).toBeGreaterThan(prof10.uncertainty.lowerBound);
    expect(prof10.uncertainty.lowerBound).toBeGreaterThan(prof2.uncertainty.lowerBound);

    // Direct helper verification for 0 samples
    const zeroInterval = computeWilsonInterval(0, 0);
    expect(zeroInterval.lowerBound).toBe(0);
    expect(zeroInterval.upperBound).toBe(1);
    expect(zeroInterval.width).toBe(1);
  });

  it('11. flags insufficient evidence when sampleCount < minSamples and clears flag once threshold is met', () => {
    const seg = {
      harnessId: 'native',
      modelId: 'gemma-4-26b',
      runtimeId: 'lmstudio',
      taskCategory: 'architecture_reasoning' as const,
    };

    const p1 = service.recordOutcome({
      ...seg,
      executionId: 'exec-insuff-1',
      status: 'completed',
      verified: true,
      durationMs: 500,
    });
    expect(p1.sampleCount).toBe(1);
    expect(p1.insufficientEvidence).toBe(true);
    expect(p1.hasSufficientEvidence).toBe(false);
    expect(p1.insufficientEvidenceReason).toContain('1 < 3');

    const p2 = service.recordOutcome({
      ...seg,
      executionId: 'exec-insuff-2',
      status: 'completed',
      verified: true,
      durationMs: 500,
    });
    expect(p2.insufficientEvidence).toBe(true);
    expect(p2.hasSufficientEvidence).toBe(false);

    const p3 = service.recordOutcome({
      ...seg,
      executionId: 'exec-insuff-3',
      status: 'completed',
      verified: true,
      durationMs: 500,
    });
    expect(p3.sampleCount).toBe(3);
    expect(p3.insufficientEvidence).toBe(false);
    expect(p3.hasSufficientEvidence).toBe(true);
    expect(p3.insufficientEvidenceReason).toBeUndefined();
  });

  it('12. detects staleness on version/protocol/environment configuration drift and when profile age exceeds maxAgeMs', () => {
    const baseSeg = {
      harnessId: 'native',
      modelId: 'qwen/qwen3-coder-next',
      runtimeId: 'lmstudio',
      taskCategory: 'implementation' as const,
      environment: 'darwin-arm64',
      modelVersion: '1.0.0',
      harnessVersion: '1.0.0',
      wazirProtocolVersion: '1.0.0',
    };

    for (let i = 1; i <= 3; i++) {
      service.recordOutcome({
        ...baseSeg,
        executionId: `exec-fresh-${i}`,
        status: 'completed',
        verified: true,
        durationMs: 300,
      });
    }

    const fresh = service.getProfile(baseSeg)!;
    expect(fresh.isStale).toBe(false);
    expect(fresh.hasSufficientEvidence).toBe(true);

    // 1. Model version drift
    const driftedModelVer = service.getProfile({
      ...baseSeg,
      modelVersion: '2.0.0',
    })!;
    expect(driftedModelVer).toBeDefined();
    expect(driftedModelVer.isStale).toBe(true);
    expect(driftedModelVer.hasSufficientEvidence).toBe(false);
    expect(driftedModelVer.staleReason).toContain('modelVersion: 1.0.0 -> 2.0.0');

    // 2. Protocol version drift
    const driftedProto = service.getProfile({
      ...baseSeg,
      wazirProtocolVersion: '2.0.0',
    })!;
    expect(driftedProto.isStale).toBe(true);
    expect(driftedProto.staleReason).toContain('wazirProtocolVersion: 1.0.0 -> 2.0.0');

    // 3. Environment drift
    const driftedEnv = service.getProfile({
      ...baseSeg,
      environment: 'linux-x64',
    })!;
    expect(driftedEnv.isStale).toBe(true);
    expect(driftedEnv.staleReason).toContain('environment: darwin-arm64 -> linux-x64');

    // 4. Age expiration (> maxAgeMs = 60_000)
    currentTimeMs += 120_000;
    const expired = service.getProfile(baseSeg)!;
    expect(expired.isStale).toBe(true);
    expect(expired.hasSufficientEvidence).toBe(false);
    expect(expired.staleReason).toContain('exceeds maxAgeMs');
  });

  it('13. tracks avgCostUSD, costPerVerifiedSuccessUSD, and latency percentiles while honoring UNKNOWN cost invariant (never coerced to 0)', () => {
    // 1. Subscription CLI harness with UNKNOWN cost status -> avgCostUSD must remain undefined
    const unknownCostProfile = service.recordOutcome({
      executionId: 'exec-sub-cli-1',
      harnessId: 'external-cli',
      modelId: 'claude-code-sub',
      runtimeId: 'subscription-cli',
      taskCategory: 'implementation',
      status: 'completed',
      verified: true,
      costStatus: 'UNKNOWN',
      costUSD: undefined,
      durationMs: 2100,
    });
    expect(unknownCostProfile.avgCostUSD).toBeUndefined();
    expect(unknownCostProfile.costPerVerifiedSuccessUSD).toBeUndefined();
    expect(unknownCostProfile.unknownCostCount).toBe(1);
    expect(unknownCostProfile.avgDurationMs).toBe(2100);

    // 2. Priced API harness with ACTUAL costUSD
    const pricedSeg = {
      harnessId: 'acp',
      modelId: 'claude-3-7-sonnet',
      runtimeId: 'anthropic',
      taskCategory: 'implementation' as const,
    };
    service.recordOutcome({
      ...pricedSeg,
      executionId: 'exec-priced-1',
      status: 'completed',
      verified: true,
      costStatus: 'ACTUAL',
      costUSD: 0.02,
      durationMs: 1000,
      firstTokenLatencyMs: 180,
    });
    const pricedProfile = service.recordOutcome({
      ...pricedSeg,
      executionId: 'exec-priced-2',
      status: 'failed',
      verified: false,
      terminationReason: 'VERIFICATION_FAILED',
      errors: ['Test failed'],
      costStatus: 'ACTUAL',
      costUSD: 0.04,
      durationMs: 3000,
      firstTokenLatencyMs: 220,
    });

    expect(pricedProfile.avgCostUSD).toBeCloseTo(0.03, 5);
    // Total cost $0.06 across 1 verified success -> $0.06 per verified success
    expect(pricedProfile.costPerVerifiedSuccessUSD).toBeCloseTo(0.06, 5);
    expect(pricedProfile.avgDurationMs).toBe(2000);
    expect(pricedProfile.p50DurationMs).toBe(1000);
    expect(pricedProfile.p95DurationMs).toBe(3000);
    expect(pricedProfile.avgFirstTokenLatencyMs).toBe(200);
  });

  it('14. persists profiles durably to KeyValueStore under harness-perf/<segmentKey> and restores state and deduplication history on reload', async () => {
    const seg = {
      harnessId: 'native',
      modelId: 'qwen/qwen3-coder-next',
      runtimeId: 'lmstudio',
      taskCategory: 'tool_use' as const,
      environment: 'darwin-arm64',
    };

    await service.recordOutcome({
      ...seg,
      executionId: 'exec-persist-1',
      attemptId: 'att-1',
      status: 'completed',
      verified: true,
      costUSD: 0,
      durationMs: 600,
    });
    await service.recordOutcome({
      ...seg,
      executionId: 'exec-persist-2',
      attemptId: 'att-1',
      status: 'completed',
      verified: true,
      costUSD: 0,
      durationMs: 800,
    });

    const entries = await store.list('harness-perf/');
    expect(entries.length).toBe(1);
    expect(entries[0].key).toBe(
      'harness-perf/native::qwen/qwen3-coder-next::lmstudio::tool_use::darwin-arm64',
    );

    // Instantiate a brand-new HarnessPerformanceService backed by the same store
    const reloadedService = new HarnessPerformanceService({
      store,
      minSamples: 2,
      maxAgeMs: 60_000,
      now: () => currentTimeMs,
    });
    await reloadedService.ready;

    const restored = reloadedService.getProfile(seg)!;
    expect(restored).toBeDefined();
    expect(restored.sampleCount).toBe(2);
    expect(restored.verifiedSuccessCount).toBe(2);
    expect(restored.avgDurationMs).toBe(700);
    expect(restored.hasSufficientEvidence).toBe(true);

    // Re-submitting an already-persisted executionId/attemptId to the reloaded service must NOT double-count
    await reloadedService.recordOutcome({
      ...seg,
      executionId: 'exec-persist-1',
      attemptId: 'att-1',
      status: 'completed',
      verified: true,
      costUSD: 0,
      durationMs: 600,
    });
    expect(reloadedService.getProfile(seg)!.sampleCount).toBe(2);
  });

  it('15. ingests full ExecutionRecord objects via recordExecution, classifies task capability, and synchronizes with ModelIntelligenceService', () => {
    const record: ExecutionRecord = {
      execution: {
        id: 'exec-record-e2e-1',
        taskId: 'task-e2e-1',
        runtimeId: 'lmstudio',
        modelId: 'qwen/qwen3-coder-next',
        status: 'completed',
        createdAt: new Date(currentTimeMs - 1500),
        startedAt: new Date(currentTimeMs - 1400),
        completedAt: new Date(currentTimeMs),
      },
      task: {
        id: 'task-e2e-1',
        type: 'coding',
        title: 'Fix compiler syntax error in parser.ts',
        input: 'Resolve tsc compilation error in parser.ts',
        requirements: { capabilities: ['coding'] },
        priority: 'normal',
        status: 'completed',
        createdAt: new Date(currentTimeMs - 1500),
      },
      policyDecisions: [],
      toolCalls: [
        {
          id: 'tc-1',
          tool: 'write_file',
          input: {},
          ok: true,
          policyEffect: 'allow',
          policyRule: 'default',
          durationMs: 120,
          at: new Date(currentTimeMs - 500),
        },
      ],
      filesChanged: ['src/parser.ts'],
      checks: [
        {
          name: 'build',
          command: 'tsc --noEmit',
          ok: true,
          output: '',
          durationMs: 300,
          workspaceRevision: 2,
        },
      ],
      workspaceState: {
        workspaceId: 'ws-1',
        revision: 2,
        updatedAt: new Date(currentTimeMs),
      },
      errors: [],
      events: [],
    };

    const profile = service.recordExecution(record, {
      harnessId: 'native',
      environment: 'darwin-arm64',
      quantization: 'q4_k_m',
      modelVersion: '1.0.0',
    });

    expect(profile.taskCategory).toBe('compile_repair');
    expect(profile.sampleCount).toBe(1);
    expect(profile.verifiedSuccessCount).toBe(1);
    expect(profile.verifiedSuccessRate).toBe(1.0);
    expect(profile.avgDurationMs).toBe(1400);

    const modelProf = modelIntelligence.getProfile({
      model: 'qwen/qwen3-coder-next',
      runtime: 'lmstudio',
      quantization: 'q4_k_m',
      modelVersion: '1.0.0',
      wazirProtocolVersion: '1.0.0',
      harnessId: 'native',
      environment: 'darwin-arm64',
    });
    expect(modelProf).toBeDefined();
    expect(modelProf?.harnessId).toBe('native');
    expect(modelProf?.environment).toBe('darwin-arm64');
    const compileRepair = modelProf?.categoryMeasurements.find(
      (c) => c.category === 'compile_repair',
    );
    expect(compileRepair?.verifiedSuccessCount).toBe(1);
  });
});
