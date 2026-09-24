import type { ExecutionRecord } from '../types/execution.js';

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
  };
  escalations: Array<{
    at: string;
    previousModel: string;
    newModel: string | null;
    accepted: boolean;
    failureClass: string;
    trigger: string;
    decision: string;
  }>;
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
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function explainExecution(record: ExecutionRecord): ExecutionExplanation {
  const events = [...record.events].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const s = record.scheduling;
  const out: ExecutionExplanation = {
    executionId: record.execution.id,
    routing: {
      modelId: s?.modelId ?? record.execution.modelId ?? null,
      runtimeId: s?.runtimeId ?? record.execution.runtimeId ?? null,
      computerId: s?.computerId ?? record.execution.computerId ?? null,
      hosted: s?.computerDecision.placementKind === 'hosted',
      modelReasons: s?.modelDecision.reasons ?? [],
      placementReasons: s?.computerDecision.reasons ?? [],
    },
    escalations: [],
    retries: [],
    policyDenials: record.policyDecisions
      .filter((d) => d.decision !== 'allow')
      .map((d) => ({ tool: d.tool ?? 'unknown', decision: d.decision, rule: d.rule, reasons: d.reasons })),
    toolOutcomes: { unknown: [], reconciled: [] },
    completionRejections: [],
    evidenceInvalidations: [],
    termination: { reason: null, modelId: null, status: record.execution.status, errors: record.errors.map((e) => e.slice(0, 300)) },
  };

  const unknownByCall = new Map<string, { callId: string | null; tool: string }>();
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (eventType(event)) {
      case 'model.route.changed':
        out.escalations.push({
          at: iso(event.timestamp),
          previousModel: str(data.previousModel) ?? 'unknown',
          newModel: str(data.newModel),
          accepted: data.accepted === true,
          failureClass: str(data.failureClass) ?? 'unknown',
          trigger: str(data.reason) ?? '',
          decision: str(data.routeDecision) ?? '',
        });
        break;
      case 'retry.scheduled':
      case 'retry.exhausted':
        out.retries.push({
          at: iso(event.timestamp),
          attempt: typeof data.attempt === 'number' ? data.attempt : null,
          failureClass: str(data.failureClass) ?? 'unknown',
          provider: str(data.provider),
          model: str(data.model),
          delayMs: typeof data.delay === 'number' ? data.delay : 0,
          exhausted: eventType(event) === 'retry.exhausted',
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
          out.toolOutcomes.reconciled.push({
            callId, tool: str(data.tool) ?? 'unknown',
            outcome: reconciled.outcome ?? 'unknown', evidence: reconciled.evidence ?? '', inspectedBy: reconciled.inspectedBy ?? 'unknown',
          });
        }
        if (callId) unknownByCall.delete(callId);
        break;
      }
      case 'completion.rejected': {
        const reason = str(data.reason) ?? 'unknown';
        const detail = reason === 'VERIFICATION_REQUIRED'
          ? `revision ${String(data.workspaceRevision ?? '?')} lacks current evidence${Array.isArray(data.missing) && data.missing.length ? `: missing ${data.missing.join(', ')}` : ''}${data.evaluationInvalid ? '; evaluation is for another revision' : ''}${data.evaluationMissing ? '; no evaluation' : ''}`
          : reason === 'TOOL_OUTCOME_UNKNOWN'
            ? 'a dispatched tool call has no confirmed outcome and must be reconciled first'
            : '';
        out.completionRejections.push({ at: iso(event.timestamp), reason, detail });
        break;
      }
      case 'verification.invalidated':
        out.evidenceInvalidations.push({ at: iso(event.timestamp), workspaceRevision: typeof data.workspaceRevision === 'number' ? data.workspaceRevision : null });
        break;
      case 'termination.completed':
        out.termination.reason = str(data.reason);
        out.termination.modelId = str(data.modelId);
        break;
      default:
        break;
    }
  }
  out.toolOutcomes.unknown = [...unknownByCall.values()];
  return out;
}
