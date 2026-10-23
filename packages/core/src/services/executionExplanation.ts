import type { ExecutionRecord } from '../types/execution.js';
import { promptCacheReuse } from '../types/telemetry.js';

export interface RoutingCandidateExplanation {
  harnessId?: string;
  modelId: string;
  runtimeId: string;
  eligible: boolean;
  score?: number;
  reasons: string[];
}

export interface RoutingExclusionExplanation {
  harnessId?: string;
  modelId: string;
  runtimeId: string;
  exclusionReasons: string[];
}

export interface RoutingCalibrationExplanation {
  sampleCount: number | null;
  confidence: number | null;
  isStale: boolean;
}

export interface RoutingCostComparison {
  estimatedCostUSD: number | null;
  actualCostUSD: number | null;
  costStatus: string;
}

export interface RoutingLatencyBreakdown {
  firstTokenLatencyMs: number | null;
  endToEndLatencyMs: number | null;
  verificationDurationMs: number | null;
  coldStartOverheadMs: number | null;
  retryOverheadMs: number | null;
}

export interface RoutingCacheReuseExplanation {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  hitRate: number | null;
}

export interface RoutingAuditFields {
  harnessId: string | null;
  policyVersion: string | null;
  predictedSuccessProbability: number | null;
  calibration: RoutingCalibrationExplanation | null;
  candidateAlternatives: RoutingCandidateExplanation[];
  eligibilityExclusions: RoutingExclusionExplanation[];
  costComparison: RoutingCostComparison;
  latencyBreakdown: RoutingLatencyBreakdown;
  cacheReuse: RoutingCacheReuseExplanation | null;
}

/**
 * Answers "why?" for one execution from its durable record — never from the model's
 * narration. Each answer cites the facts it came from (scheduler reasons, typed
 * events, policy decisions), so an operator can trace every routing, retry,
 * escalation, termination and completion decision back to evidence.
 */
export interface ExecutionExplanation {
  executionId: string;
  routing: {
    modelId: string | null;
    runtimeId: string | null;
    computerId: string | null;
    hosted: boolean;
    modelReasons: string[];
    placementReasons: string[];
  } & RoutingAuditFields;
  routingAudit: RoutingAuditFields;
  escalations: Array<{
    at: string;
    previousModel: string;
    newModel: string | null;
    accepted: boolean;
    failureClass: string;
    trigger: string;
    decision: string;
  }>;
  /** Retries that continued this same execution (see planTaskResume), with the facts they resumed from. */
  resumes: Array<{ at: string; attempt: number | null; workspaceRevision: number | null; reasons: string[] }>;
  retries: Array<{ at: string; attempt: number | null; failureClass: string; provider: string | null; model: string | null; delayMs: number; exhausted: boolean }>;
  policyDenials: Array<{ tool: string; decision: string; rule: string; reasons: string[] }>;
  toolOutcomes: {
    unknown: Array<{ callId: string | null; tool: string }>;
    reconciled: Array<{ callId: string | null; tool: string; outcome: string; evidence: string; inspectedBy: string }>;
  };
  completionRejections: Array<{ at: string; reason: string; detail: string }>;
  evidenceInvalidations: Array<{ at: string; workspaceRevision: number | null }>;
  termination: { reason: string | null; modelId: string | null; status: string; errors: string[] };
}

type AnyEvent = ExecutionRecord['events'][number];
const eventType = (e: AnyEvent): string => e.eventType ?? e.type;
const iso = (value: Date | string): string => new Date(value).toISOString();
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const LOCAL_RUNTIMES = new Set(['ollama', 'lmstudio', 'local', 'vllm', 'llamacpp', 'llama.cpp', 'mlx']);

export function explainExecution(record: ExecutionRecord): ExecutionExplanation {
  const events = [...record.events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const s = record.scheduling;
  const sAny = (s ?? {}) as Record<string, unknown>;
  const mdAny = (s?.modelDecision ?? {}) as Record<string, unknown>;
  const empAny = (s?.modelDecision?.empiricalExplanation ?? {}) as Record<string, unknown>;
  const exAny = (record.execution ?? {}) as unknown as Record<string, unknown>;
  const usageAny = (record.usage ?? {}) as unknown as Record<string, unknown>;

  const modelId = s?.modelId ?? record.execution.modelId ?? null;
  const runtimeId = s?.runtimeId ?? record.execution.runtimeId ?? null;
  const computerId = s?.computerId ?? record.execution.computerId ?? null;
  const hosted = s?.computerDecision.placementKind === 'hosted';

  // Collect event-sourced facts while walking the sequenced event log
  let eventHarnessId: string | null = null;
  let eventPolicyVersion: string | null = null;
  let eventPredictedProb: number | null = null;
  let eventCalibration: RoutingCalibrationExplanation | null = null;
  let eventEstimatedCostUSD: number | null = null;
  let eventActualCostUSD: number | null = null;
  let eventCostStatus: string | null = null;
  let eventFirstTokenMs: number | null = null;
  let eventEndToEndMs: number | null = null;
  let eventVerificationMs: number | null = null;
  let eventColdStartMs: number | null = null;
  let eventRetryOverheadMs: number | null = null;
  let eventCacheRead: number | null = null;
  let eventCacheWrite: number | null = null;
  let eventCacheHitRate: number | null = null;
  let eventCacheObserved = false;

  let modelLoadingTs: number | null = null;
  let modelLoadedTs: number | null = null;
  let generationStartedTs: number | null = null;
  let firstTokenTs: number | null = null;
  let executionStartedTs: number | null = null;
  let executionEndedTs: number | null = null;

  const eventCandidates: RoutingCandidateExplanation[] = [];
  const eventExclusions: RoutingExclusionExplanation[] = [];

  const escalations: ExecutionExplanation['escalations'] = [];
  const resumes: ExecutionExplanation['resumes'] = [];
  const retries: ExecutionExplanation['retries'] = [];
  const policyDenials = record.policyDecisions
    .filter((d) => d.decision !== 'allow')
    .map((d) => ({ tool: d.tool ?? 'unknown', decision: d.decision, rule: d.rule, reasons: d.reasons }));
  const toolOutcomes: ExecutionExplanation['toolOutcomes'] = { unknown: [], reconciled: [] };
  const completionRejections: ExecutionExplanation['completionRejections'] = [];
  const evidenceInvalidations: ExecutionExplanation['evidenceInvalidations'] = [];
  const termination: ExecutionExplanation['termination'] = {
    reason: null,
    modelId: null,
    status: record.execution.status,
    errors: record.errors.map((e) => e.slice(0, 300)),
  };

  const unknownByCall = new Map<string, { callId: string | null; tool: string }>();

  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const type = eventType(event);
    const rawTs =
      typeof data.timestamp === 'string' || typeof data.timestamp === 'number' || data.timestamp instanceof Date
        ? data.timestamp
        : event.timestamp;
    const ts = new Date(rawTs).getTime();

    if (str(data.harnessId)) eventHarnessId = str(data.harnessId);
    if (str(data.routingPolicyVersion) ?? str(data.policyVersion)) {
      eventPolicyVersion = str(data.routingPolicyVersion) ?? str(data.policyVersion);
    }
    if (num(data.predictedSuccessProbability) !== null || num(data.predictedVerifiedSuccessProb) !== null) {
      eventPredictedProb = num(data.predictedSuccessProbability) ?? num(data.predictedVerifiedSuccessProb);
    }
    if (data.calibration && typeof data.calibration === 'object') {
      const cal = data.calibration as Record<string, unknown>;
      eventCalibration = {
        sampleCount: num(cal.sampleCount),
        confidence: num(cal.confidence),
        isStale: Boolean(cal.isStale),
      };
    }
    if (num(data.estimatedCostUSD) !== null || num(data.expectedTotalCostUsd) !== null || num(data.effectiveCostPerSuccessUsd) !== null) {
      eventEstimatedCostUSD = num(data.estimatedCostUSD) ?? num(data.expectedTotalCostUsd) ?? num(data.effectiveCostPerSuccessUsd);
    }
    if (str(data.costStatus)) {
      eventCostStatus = str(data.costStatus);
    }
    if (num(data.actualCostUSD) !== null || num(data.costUSD) !== null) {
      eventActualCostUSD = num(data.actualCostUSD) ?? num(data.costUSD);
    }
    if (num(data.firstTokenLatencyMs) !== null) eventFirstTokenMs = num(data.firstTokenLatencyMs);
    if (num(data.endToEndLatencyMs) !== null) eventEndToEndMs = num(data.endToEndLatencyMs);
    if (num(data.verificationDurationMs) !== null) eventVerificationMs = num(data.verificationDurationMs);
    if (num(data.coldStartOverheadMs) !== null || num(data.loadTimeMs) !== null) {
      eventColdStartMs = num(data.coldStartOverheadMs) ?? num(data.loadTimeMs);
    }
    if (num(data.retryOverheadMs) !== null) eventRetryOverheadMs = num(data.retryOverheadMs);

    if (Array.isArray(data.candidateAlternatives)) {
      for (const c of data.candidateAlternatives) {
        if (c && typeof c === 'object') {
          const cObj = c as Record<string, unknown>;
          const mId = str(cObj.modelId) ?? str(cObj.model);
          const rId = str(cObj.runtimeId) ?? str(cObj.runtime) ?? 'unknown';
          if (mId) {
            eventCandidates.push({
              ...(str(cObj.harnessId) ? { harnessId: str(cObj.harnessId)! } : {}),
              modelId: mId,
              runtimeId: rId,
              eligible: cObj.eligible !== undefined ? Boolean(cObj.eligible) : Boolean(cObj.admissible ?? true),
              ...(num(cObj.score) !== null ? { score: num(cObj.score)! } : {}),
              reasons: Array.isArray(cObj.reasons) ? cObj.reasons.filter((r): r is string => typeof r === 'string') : [],
            });
          }
        }
      }
    }
    if (Array.isArray(data.eligibilityExclusions)) {
      for (const ex of data.eligibilityExclusions) {
        if (ex && typeof ex === 'object') {
          const exObj = ex as Record<string, unknown>;
          const mId = str(exObj.modelId) ?? str(exObj.model);
          const rId = str(exObj.runtimeId) ?? str(exObj.runtime) ?? 'unknown';
          if (mId) {
            eventExclusions.push({
              ...(str(exObj.harnessId) ? { harnessId: str(exObj.harnessId)! } : {}),
              modelId: mId,
              runtimeId: rId,
              exclusionReasons: Array.isArray(exObj.exclusionReasons)
                ? exObj.exclusionReasons.filter((r): r is string => typeof r === 'string')
                : Array.isArray(exObj.reasons)
                  ? exObj.reasons.filter((r): r is string => typeof r === 'string')
                  : [],
            });
          }
        }
      }
    }

    switch (type) {
      case 'execution.started':
        if (executionStartedTs === null && Number.isFinite(ts)) executionStartedTs = ts;
        break;
      case 'execution.completed':
      case 'execution.failed':
      case 'execution.cancelled':
        if (Number.isFinite(ts)) executionEndedTs = ts;
        if (num(data.durationMs) !== null && eventEndToEndMs === null) {
          eventEndToEndMs = num(data.durationMs);
        }
        break;
      case 'model.loading':
        if (modelLoadingTs === null && Number.isFinite(ts)) modelLoadingTs = ts;
        break;
      case 'model.loaded':
        if (Number.isFinite(ts)) modelLoadedTs = ts;
        break;
      case 'generation.started':
      case 'model.attempt.started':
      case 'model.requested':
        if (generationStartedTs === null && Number.isFinite(ts)) generationStartedTs = ts;
        break;
      case 'generation.token':
        if (firstTokenTs === null && Number.isFinite(ts)) firstTokenTs = ts;
        break;
      case 'model.cache.telemetry':
      case 'prompt_cache.telemetry':
      case 'prompt_cache.observed': {
        const readVal =
          num(data.cacheReadTokens) ??
          (data.cacheReadTokens && typeof data.cacheReadTokens === 'object'
            ? num((data.cacheReadTokens as Record<string, unknown>).value)
            : null);
        const writeVal =
          num(data.cacheWriteTokens) ??
          (data.cacheWriteTokens && typeof data.cacheWriteTokens === 'object'
            ? num((data.cacheWriteTokens as Record<string, unknown>).value)
            : null);
        const hitRateVal = num(data.hitRate);
        if (readVal !== null || writeVal !== null || hitRateVal !== null) {
          eventCacheObserved = true;
          if (readVal !== null) eventCacheRead = (eventCacheRead ?? 0) + readVal;
          if (writeVal !== null) eventCacheWrite = (eventCacheWrite ?? 0) + writeVal;
          if (hitRateVal !== null) eventCacheHitRate = hitRateVal;
        }
        break;
      }
      case 'model.route.changed':
        escalations.push({
          at: iso(event.timestamp),
          previousModel: str(data.previousModel) ?? 'unknown',
          newModel: str(data.newModel),
          accepted: data.accepted === true,
          failureClass: str(data.failureClass) ?? 'unknown',
          trigger: str(data.reason) ?? '',
          decision: str(data.routeDecision) ?? '',
        });
        break;
      case 'execution.resumed':
        resumes.push({
          at: iso(event.timestamp),
          attempt: typeof data.attempt === 'number' ? data.attempt : null,
          workspaceRevision: typeof data.workspaceRevision === 'number' ? data.workspaceRevision : null,
          reasons: Array.isArray(data.reasons) ? data.reasons.filter((r): r is string => typeof r === 'string') : [],
        });
        break;
      case 'retry.scheduled':
      case 'retry.exhausted':
        retries.push({
          at: iso(event.timestamp),
          attempt: typeof data.attempt === 'number' ? data.attempt : null,
          failureClass: str(data.failureClass) ?? 'unknown',
          provider: str(data.provider),
          model: str(data.model),
          delayMs: typeof data.delay === 'number' ? data.delay : (typeof data.retryDelayMs === 'number' ? data.retryDelayMs : 0),
          exhausted: type === 'retry.exhausted',
        });
        break;
      case 'tool.call.outcome_unknown': {
        const callId = str(data.callId) ?? event.callId ?? null;
        unknownByCall.set(callId ?? `#${event.sequence}`, { callId, tool: str(data.tool) ?? 'unknown' });
        break;
      }
      case 'tool.call.completed':
      case 'tool.call.failed': {
        const reconciled = data.reconciled as { outcome?: string; evidence?: string; inspectedBy?: string } | undefined;
        const callId = str(data.callId) ?? event.callId ?? null;
        if (reconciled) {
          toolOutcomes.reconciled.push({
            callId,
            tool: str(data.tool) ?? 'unknown',
            outcome: reconciled.outcome ?? 'unknown',
            evidence: reconciled.evidence ?? '',
            inspectedBy: reconciled.inspectedBy ?? 'unknown',
          });
        }
        if (callId) unknownByCall.delete(callId);
        break;
      }
      case 'completion.rejected': {
        const reason = str(data.reason) ?? 'unknown';
        const detail =
          reason === 'VERIFICATION_REQUIRED'
            ? `revision ${String(data.workspaceRevision ?? '?')} lacks current evidence${Array.isArray(data.missing) && data.missing.length ? `: missing ${data.missing.join(', ')}` : ''}${data.evaluationInvalid ? '; evaluation is for another revision' : ''}${data.evaluationMissing ? '; no evaluation' : ''}`
            : reason === 'TOOL_OUTCOME_UNKNOWN'
              ? 'a dispatched tool call has no confirmed outcome and must be reconciled first'
              : '';
        completionRejections.push({ at: iso(event.timestamp), reason, detail });
        break;
      }
      case 'verification.invalidated':
        evidenceInvalidations.push({
          at: iso(event.timestamp),
          workspaceRevision: typeof data.workspaceRevision === 'number' ? data.workspaceRevision : null,
        });
        break;
      case 'termination.completed':
        termination.reason = str(data.reason);
        termination.modelId = str(data.modelId);
        if (executionEndedTs === null && Number.isFinite(ts)) executionEndedTs = ts;
        if (num(data.durationMs) !== null && eventEndToEndMs === null) {
          eventEndToEndMs = num(data.durationMs);
        }
        break;
      default:
        break;
    }
  }

  toolOutcomes.unknown = [...unknownByCall.values()];

  // 1. harnessId
  const harnessId =
    str(sAny.harnessId) ??
    str(mdAny.harnessId) ??
    str(exAny.harnessId) ??
    str(s?.agentId) ??
    str(record.execution.agentId) ??
    eventHarnessId ??
    null;

  // 2. policyVersion
  const policyVersion =
    str(sAny.routingPolicyVersion) ??
    str(sAny.policyVersion) ??
    str(mdAny.routingPolicyVersion) ??
    str(mdAny.policyVersion) ??
    str(empAny.routingPolicyVersion) ??
    str(empAny.policyVersion) ??
    eventPolicyVersion ??
    null;

  // 3. candidateAlternatives & eligibilityExclusions
  const evaluatedCandidates = s?.modelDecision?.empiricalExplanation?.evaluatedCandidates;
  const candidateAlternatives: RoutingCandidateExplanation[] = [];
  const eligibilityExclusions: RoutingExclusionExplanation[] = [];

  if (Array.isArray(evaluatedCandidates) && evaluatedCandidates.length > 0) {
    for (const c of evaluatedCandidates) {
      const cAny = c as unknown as Record<string, unknown>;
      const cHarness = str(cAny.harnessId);
      const score = num(c.effectiveScore) ?? num(cAny.score) ?? num(c.categoryScore);
      const reasons = Array.isArray(c.reasons)
        ? c.reasons.filter((r): r is string => typeof r === 'string')
        : [];

      candidateAlternatives.push({
        ...(cHarness ? { harnessId: cHarness } : {}),
        modelId: c.modelId,
        runtimeId: c.runtimeId,
        eligible: Boolean(c.eligible),
        ...(score !== null ? { score } : {}),
        reasons,
      });

      if (!c.eligible) {
        const exclusionReasons = [...reasons];
        if (c.policyRejection && !exclusionReasons.includes(c.policyRejection)) {
          exclusionReasons.push(c.policyRejection);
        }
        if (c.resourceRejection && !exclusionReasons.includes(c.resourceRejection)) {
          exclusionReasons.push(c.resourceRejection);
        }
        eligibilityExclusions.push({
          ...(cHarness ? { harnessId: cHarness } : {}),
          modelId: c.modelId,
          runtimeId: c.runtimeId,
          exclusionReasons,
        });
      }
    }
  } else if (eventCandidates.length > 0) {
    candidateAlternatives.push(...eventCandidates);
    for (const c of eventCandidates) {
      if (!c.eligible && !eventExclusions.some((e) => e.modelId === c.modelId && e.runtimeId === c.runtimeId)) {
        eligibilityExclusions.push({
          ...(c.harnessId ? { harnessId: c.harnessId } : {}),
          modelId: c.modelId,
          runtimeId: c.runtimeId,
          exclusionReasons: [...c.reasons],
        });
      }
    }
  }

  for (const ex of eventExclusions) {
    if (!eligibilityExclusions.some((e) => e.modelId === ex.modelId && e.runtimeId === ex.runtimeId)) {
      eligibilityExclusions.push(ex);
    }
  }

  if (Array.isArray(s?.fallbacks)) {
    for (const fb of s.fallbacks) {
      if (!eligibilityExclusions.some((e) => e.modelId === fb.from)) {
        eligibilityExclusions.push({
          modelId: fb.from,
          runtimeId: runtimeId ?? 'unknown',
          exclusionReasons: [fb.reason],
        });
      }
    }
  }

  // 4. predictedSuccessProbability & calibration
  const selectedCandidate = Array.isArray(evaluatedCandidates)
    ? evaluatedCandidates.find((c) => c.modelId === modelId)
    : undefined;
  const selAny = (selectedCandidate ?? {}) as Record<string, unknown>;

  const predictedSuccessProbability =
    num(sAny.predictedSuccessProbability) ??
    num(sAny.predictedVerifiedSuccessProb) ??
    num(mdAny.predictedSuccessProbability) ??
    num(mdAny.predictedVerifiedSuccessProb) ??
    num(selAny.predictedSuccessProbability) ??
    num(selAny.predictedVerifiedSuccessProb) ??
    (selectedCandidate && selectedCandidate.profileFound && !selectedCandidate.isStale
      ? (num(selectedCandidate.categoryScore) ?? num(selectedCandidate.conditionalScore))
      : null) ??
    eventPredictedProb ??
    null;

  let calibration: RoutingCalibrationExplanation | null = null;
  if (sAny.calibration && typeof sAny.calibration === 'object') {
    const cal = sAny.calibration as Record<string, unknown>;
    calibration = {
      sampleCount: num(cal.sampleCount),
      confidence: num(cal.confidence),
      isStale: Boolean(cal.isStale),
    };
  } else if (mdAny.calibration && typeof mdAny.calibration === 'object') {
    const cal = mdAny.calibration as Record<string, unknown>;
    calibration = {
      sampleCount: num(cal.sampleCount),
      confidence: num(cal.confidence),
      isStale: Boolean(cal.isStale),
    };
  } else if (
    selectedCandidate &&
    (selectedCandidate.profileFound ||
      selectedCandidate.isStale ||
      typeof selectedCandidate.confidence === 'number' ||
      (typeof selectedCandidate.sampleCount === 'number' && selectedCandidate.sampleCount > 0))
  ) {
    calibration = {
      sampleCount: num(selectedCandidate.sampleCount),
      confidence: num(selectedCandidate.confidence),
      isStale: Boolean(selectedCandidate.isStale),
    };
  } else if (eventCalibration) {
    calibration = eventCalibration;
  }

  // 5. costComparison
  let estimatedCostUSD =
    num(sAny.estimatedCostUSD) ??
    num(sAny.expectedTotalCostUsd) ??
    num(mdAny.estimatedCostUSD) ??
    num(mdAny.expectedTotalCostUsd) ??
    num(selAny.estimatedCostUSD) ??
    num(selAny.expectedTotalCostUsd) ??
    num(selAny.effectiveCostPerSuccessUsd) ??
    num(usageAny.estimatedCostUSD) ??
    eventEstimatedCostUSD ??
    null;

  const usageMonetary =
    usageAny.monetary && typeof usageAny.monetary === 'object'
      ? (usageAny.monetary as Record<string, unknown>)
      : null;

  const explicitCostStatus =
    str(usageAny.costStatus) ??
    str(usageMonetary?.status) ??
    eventCostStatus ??
    str(sAny.costStatus) ??
    null;

  const rawActualCost =
    num(usageAny.actualCostUSD) ??
    num(usageAny.costUSD) ??
    num(usageMonetary?.amount) ??
    eventActualCostUSD ??
    null;

  const isKnownLocal =
    !hosted &&
    (s?.computerDecision?.placementKind === 'local' ||
      s?.resourceType === 'LOCAL_GPU_INFERENCE' ||
      (runtimeId !== null && LOCAL_RUNTIMES.has(runtimeId.toLowerCase())));

  let actualCostUSD: number | null = null;
  let costStatus: string;

  if (explicitCostStatus === 'UNKNOWN') {
    // Non-negotiable invariant: UNKNOWN remote costs never fabricate $0
    costStatus = 'UNKNOWN';
    actualCostUSD = null;
  } else if (explicitCostStatus === 'ESTIMATED') {
    costStatus = 'ESTIMATED';
    actualCostUSD = null;
    if (estimatedCostUSD === null && rawActualCost !== null) {
      estimatedCostUSD = rawActualCost;
    }
  } else if (explicitCostStatus === 'ACTUAL') {
    if (rawActualCost !== null) {
      costStatus = 'ACTUAL';
      actualCostUSD = rawActualCost;
    } else if (isKnownLocal) {
      costStatus = 'ACTUAL';
      actualCostUSD = 0;
    } else {
      costStatus = estimatedCostUSD !== null ? 'ESTIMATED' : 'UNKNOWN';
      actualCostUSD = null;
    }
  } else if (rawActualCost !== null) {
    costStatus = 'ACTUAL';
    actualCostUSD = rawActualCost;
  } else if (isKnownLocal) {
    costStatus = 'ACTUAL';
    actualCostUSD = 0;
  } else if (estimatedCostUSD !== null) {
    costStatus = 'ESTIMATED';
    actualCostUSD = null;
  } else {
    costStatus = 'UNKNOWN';
    actualCostUSD = null;
  }

  const costComparison: RoutingCostComparison = {
    estimatedCostUSD,
    actualCostUSD,
    costStatus,
  };

  // 6. latencyBreakdown
  const firstTokenLatencyMs =
    num(usageAny.firstTokenLatencyMs) ??
    eventFirstTokenMs ??
    (generationStartedTs !== null && firstTokenTs !== null && firstTokenTs >= generationStartedTs
      ? firstTokenTs - generationStartedTs
      : null);

  const startedAtMs = record.execution.startedAt ? new Date(record.execution.startedAt).getTime() : null;
  const completedAtMs = record.execution.completedAt ? new Date(record.execution.completedAt).getTime() : null;
  const endToEndLatencyMs =
    num(usageAny.endToEndLatencyMs) ??
    num(usageAny.durationMs) ??
    num(usageAny.wallTimeMs) ??
    eventEndToEndMs ??
    (startedAtMs !== null && completedAtMs !== null && completedAtMs >= startedAtMs
      ? completedAtMs - startedAtMs
      : executionStartedTs !== null && executionEndedTs !== null && executionEndedTs > executionStartedTs
        ? executionEndedTs - executionStartedTs
        : null);

  const checksToSum =
    record.checks.length > 0
      ? record.checks
      : record.evaluation?.checks && record.evaluation.checks.length > 0
        ? record.evaluation.checks
        : [];
  const verificationDurationMs =
    num(usageAny.verificationDurationMs) ??
    eventVerificationMs ??
    (checksToSum.length > 0
      ? checksToSum.reduce((acc, c) => acc + (typeof c.durationMs === 'number' ? c.durationMs : 0), 0)
      : null);

  const coldStartOverheadMs =
    num(usageAny.coldStartOverheadMs) ??
    num(sAny.coldStartOverheadMs) ??
    num(mdAny.coldStartOverheadMs) ??
    eventColdStartMs ??
    (modelLoadingTs !== null && modelLoadedTs !== null && modelLoadedTs >= modelLoadingTs
      ? modelLoadedTs - modelLoadingTs
      : null);

  const retryOverheadMs =
    num(usageAny.retryOverheadMs) ??
    eventRetryOverheadMs ??
    (retries.length > 0 ? retries.reduce((acc, r) => acc + r.delayMs, 0) : null);

  const latencyBreakdown: RoutingLatencyBreakdown = {
    firstTokenLatencyMs,
    endToEndLatencyMs,
    verificationDurationMs,
    coldStartOverheadMs,
    retryOverheadMs,
  };

  // 7. cacheReuse
  let cacheReuse: RoutingCacheReuseExplanation | null = null;
  const pc = record.usage?.promptCache;
  const pcm = record.usage?.promptCacheMetrics;

  let readTokens: number | null = num(record.usage?.cacheReadTokens);
  let writeTokens: number | null = num(record.usage?.cacheWriteTokens);
  let hitRate: number | null = num(usageAny.cacheHitRate) ?? num(usageAny.hitRate);
  let cacheObserved = readTokens !== null || writeTokens !== null || hitRate !== null;

  if (pc && (pc.source === 'OBSERVED' || pc.source === 'ESTIMATED')) {
    const pcRead =
      pc.cacheReadTokens.status === 'OBSERVED' || pc.cacheReadTokens.status === 'ESTIMATED'
        ? num(pc.cacheReadTokens.value)
        : null;
    const pcWrite =
      pc.cacheWriteTokens.status === 'OBSERVED' || pc.cacheWriteTokens.status === 'ESTIMATED'
        ? num(pc.cacheWriteTokens.value)
        : null;
    const pcInput =
      pc.inputTokens.status === 'OBSERVED' || pc.inputTokens.status === 'ESTIMATED'
        ? num(pc.inputTokens.value)
        : num(record.usage?.input);
    if (pcRead !== null) readTokens = pcRead;
    if (pcWrite !== null) writeTokens = pcWrite;
    if (hitRate === null && readTokens !== null && pcInput !== null && pcInput > 0) {
      hitRate = Math.max(0, Math.min(1, Number((readTokens / pcInput).toFixed(4))));
    }
    if (readTokens !== null || writeTokens !== null || hitRate !== null) {
      cacheObserved = true;
    }
  } else if (pcm) {
    const pcmRead =
      pcm.cacheReadTokens.status === 'OBSERVED' || pcm.cacheReadTokens.status === 'ESTIMATED'
        ? num(pcm.cacheReadTokens.value)
        : null;
    const pcmWrite =
      pcm.cacheWriteTokens.status === 'OBSERVED' || pcm.cacheWriteTokens.status === 'ESTIMATED'
        ? num(pcm.cacheWriteTokens.value)
        : null;
    if (pcmRead !== null) readTokens = pcmRead;
    if (pcmWrite !== null) writeTokens = pcmWrite;
    const reuse = promptCacheReuse(pcm);
    if (hitRate === null && reuse !== undefined) {
      hitRate = Number(reuse.toFixed(4));
    }
    if (readTokens !== null || writeTokens !== null || hitRate !== null) {
      cacheObserved = true;
    }
  } else if (eventCacheObserved) {
    if (readTokens === null && eventCacheRead !== null) readTokens = eventCacheRead;
    if (writeTokens === null && eventCacheWrite !== null) writeTokens = eventCacheWrite;
    if (hitRate === null && eventCacheHitRate !== null) hitRate = eventCacheHitRate;
    cacheObserved = true;
  }

  if (cacheObserved) {
    const totalInput = num(record.usage?.input);
    if (hitRate === null && readTokens !== null && totalInput !== null && totalInput > 0) {
      hitRate = Math.max(0, Math.min(1, Number((readTokens / totalInput).toFixed(4))));
    }
    cacheReuse = {
      cacheReadTokens: readTokens,
      cacheWriteTokens: writeTokens,
      hitRate,
    };
  }

  const routingAudit: RoutingAuditFields = {
    harnessId,
    policyVersion,
    predictedSuccessProbability,
    calibration,
    candidateAlternatives,
    eligibilityExclusions,
    costComparison,
    latencyBreakdown,
    cacheReuse,
  };

  return {
    executionId: record.execution.id,
    routing: {
      modelId,
      runtimeId,
      computerId,
      hosted,
      modelReasons: s?.modelDecision.reasons ?? [],
      placementReasons: s?.computerDecision.reasons ?? [],
      ...routingAudit,
    },
    routingAudit,
    escalations,
    resumes,
    retries,
    policyDenials,
    toolOutcomes,
    completionRejections,
    evidenceInvalidations,
    termination,
  };
}

/**
 * Formats an ExecutionExplanation into a deterministic, machine-readable JSON string.
 */
export function formatRoutingExplanationJson(explanation: ExecutionExplanation): string {
  return JSON.stringify(explanation, null, 2);
}
