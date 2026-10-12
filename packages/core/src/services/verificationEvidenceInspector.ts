import type { ExecutionRecord, VerificationEvidence, EvidenceType } from '../types/execution.js';
import type { ArtifactProvenance } from '../types/artifact.js';
import type { FileMutationResult } from '../types/tool.js';
import { explainExecution } from './executionExplanation.js';

/**
 * Read-only projection of the durable ExecutionRecord that answers
 * "exactly why does Wazir believe this revision is verified?".
 *
 * INVARIANT: MODEL CLAIM != EXECUTION EVIDENCE. Only controller-written fields are read
 * (record.evidence, workspace.mutated events, workspaceState, evaluation, policy decisions,
 * provenance). record.result — the model's narration — is never consulted. Nothing here
 * writes; the ExecutionRecord remains the only evidence store.
 */

export type EvidenceSlotStatus = 'PASS' | 'FAIL' | 'ERROR' | 'STALE' | 'MISSING';
export const UNKNOWN = 'UNKNOWN' as const;
type Known<T> = T | typeof UNKNOWN;

export interface EvidenceSlot {
  oracle: EvidenceType;
  required: boolean;
  status: EvidenceSlotStatus;
  /** Status the evidence reported at the revision it ran against (differs from `status` only when STALE). */
  recordedStatus?: 'PASS' | 'FAIL' | 'ERROR';
  evidenceId?: string;
  command: Known<string>;
  exitCode: Known<number>;
  revision: Known<number>;
  evidenceHash?: string;
  /** TEST only: counts come from controller metadata; never parsed from prose. */
  passed?: Known<number>;
  failed?: Known<number>;
  /** ACCEPTANCE only: criteria satisfied / total. */
  criteria?: { satisfied: Known<number>; total: Known<number> };
  reasons: string[];
}

export interface PhysicalMutationRow {
  file: string;
  beforeHash: Known<string>;
  afterHash: Known<string>;
  revision: number;
  /** A mutation at a revision newer than the latest passing verification. */
  afterVerification: boolean;
}

export interface ProvenanceStep {
  kind: 'Task' | 'Job' | 'Agent' | 'Model' | 'Runtime' | 'Worker' | 'Tool' | 'Artifact' | 'Verification';
  values: string[];
}

export interface CompletionAssessment {
  workspaceRevision: number;
  required: EvidenceType[];
  /** Required oracles lacking a current, all-passing evidence set (same rule as ExecutionEngine.setStatus). */
  missing: EvidenceType[];
  evaluationInvalid: boolean;
  evaluationMissing: boolean;
  eligible: boolean;
}

export interface VerificationInspection {
  executionId: string;
  taskId: string;
  status: string;
  currentRevision: number;
  workspaceDigest: Known<string>;
  slots: EvidenceSlot[];
  mutations: PhysicalMutationRow[];
  policy: Array<{ decision: string; rule: string; tool?: string }>;
  unresolvedToolCalls: number;
  provenance: ProvenanceStep[];
  completion: CompletionAssessment & { eligible: boolean };
}

export interface WhyCompleteAnswer {
  complete: boolean;
  /** When complete: the evidence chain that satisfies completion. */
  chain: string[];
  /** When incomplete: what evidence is missing or invalid. */
  missing: string[];
}

const DISPLAY_ORACLES: EvidenceType[] = ['BUILD', 'TEST', 'ACCEPTANCE'];
const oracleOf = (e: VerificationEvidence): EvidenceType => (e.oracle ?? e.type);
const revOf = (e: VerificationEvidence): number => e.workspaceRevision ?? e.revision;

/**
 * The completion evidence rule, shared with ExecutionEngine.setStatus so the inspector
 * cannot drift from what actually gates completion. For each required oracle, the latest
 * evidence per command at the current revision must exist and all exit 0.
 */
export function assessCompletionEvidence(record: ExecutionRecord): CompletionAssessment {
  const revision = record.workspaceState?.revision ?? 0;
  const required = record.acceptanceContract?.requiredEvidence ?? [];
  const missing = required.filter((type) => {
    const latest = new Map<string, VerificationEvidence>();
    for (const evidence of record.evidence ?? []) {
      if (evidence.type === type && evidence.revision === revision) latest.set(evidence.command ?? '', evidence);
    }
    return latest.size === 0 || [...latest.values()].some((evidence) => evidence.exitCode !== 0);
  });
  const evaluationInvalid = Boolean(record.evaluation && (!record.evaluation.success || record.evaluation.workspaceRevision !== revision));
  const evaluationMissing = record.filesChanged.length > 0 && required.length === 0 && !record.evaluation;
  return {
    workspaceRevision: revision,
    required,
    missing,
    evaluationInvalid,
    evaluationMissing,
    eligible: missing.length === 0 && !evaluationInvalid && !evaluationMissing,
  };
}

function num(value: unknown): Known<number> {
  return typeof value === 'number' && Number.isFinite(value) ? value : UNKNOWN;
}

function buildSlot(oracle: EvidenceType, record: ExecutionRecord, currentRevision: number, required: boolean): EvidenceSlot {
  const all = (record.evidence ?? []).filter((e) => oracleOf(e) === oracle);
  const latest = all[all.length - 1];
  if (!latest) {
    return { oracle, required, status: 'MISSING', command: UNKNOWN, exitCode: UNKNOWN, revision: UNKNOWN, reasons: [] };
  }
  const recorded = latest.status ?? (latest.exitCode === 0 ? 'PASS' : 'FAIL');
  // A PASS is only a PASS if the exit code agrees; never upgrade a nonzero exit.
  const recordedStatus: 'PASS' | 'FAIL' | 'ERROR' = recorded === 'PASS' && latest.exitCode !== 0 ? 'FAIL' : recorded;
  const rev = revOf(latest);
  const slot: EvidenceSlot = {
    oracle,
    required,
    status: rev < currentRevision ? 'STALE' : recordedStatus,
    recordedStatus,
    evidenceId: latest.id,
    command: latest.command ?? UNKNOWN,
    exitCode: num(latest.exitCode),
    revision: rev,
    evidenceHash: latest.evidenceHash,
    reasons: latest.reasons ?? [],
  };
  const meta = latest.metadata ?? {};
  if (oracle === 'TEST') {
    slot.passed = num(meta.passed);
    slot.failed = num(meta.failed);
  }
  if (oracle === 'ACCEPTANCE') {
    const criteria = Array.isArray(meta.criteria) ? meta.criteria : undefined;
    const failedReasons = (latest.reasons ?? []).filter((r) => r.startsWith('Acceptance failed')).length;
    const total = criteria ? criteria.length : num(meta.criteriaTotal);
    const satisfied = typeof meta.criteriaSatisfied === 'number'
      ? meta.criteriaSatisfied
      : criteria ? criteria.length - failedReasons : UNKNOWN;
    slot.criteria = { satisfied, total };
  }
  return slot;
}

function collectMutations(record: ExecutionRecord, lastVerifiedRevision: number | null): PhysicalMutationRow[] {
  const rows: PhysicalMutationRow[] = [];
  const seen = new Set<string>();
  for (const event of record.events) {
    if ((event.eventType ?? event.type) !== 'workspace.mutated') continue;
    const data = event.data as { workspaceRevision?: number; mutations?: FileMutationResult[] } | undefined;
    const revision = data?.workspaceRevision ?? event.workspaceRevision ?? 0;
    for (const m of data?.mutations ?? []) {
      // Failed and no-op edits are not physical changes, even if a caller logged them.
      if (!m.changed || m.succeeded === false || m.beforeHash === m.afterHash) continue;
      if (!m.existedBefore && !m.existsAfter) continue;
      seen.add(`${m.path}@${revision}`);
      rows.push({
        file: m.path,
        beforeHash: m.existedBefore ? m.beforeHash ?? UNKNOWN : 'ABSENT',
        afterHash: m.existsAfter ? m.afterHash ?? UNKNOWN : 'DELETED',
        revision,
        afterVerification: lastVerifiedRevision !== null && revision > lastVerifiedRevision,
      });
    }
  }
  // Revisions recorded without hash evidence (recordFilesChanged called directly).
  for (const entry of record.mutationHistory ?? []) {
    if (seen.has(`${entry.path}@${entry.revision}`)) continue;
    rows.push({
      file: entry.path,
      beforeHash: UNKNOWN,
      afterHash: UNKNOWN,
      revision: entry.revision,
      afterVerification: lastVerifiedRevision !== null && entry.revision > lastVerifiedRevision,
    });
  }
  return rows.sort((a, b) => a.revision - b.revision);
}

function buildProvenance(record: ExecutionRecord, artifacts: ArtifactProvenance[]): ProvenanceStep[] {
  const ex = record.execution;
  const tools = [...new Set(record.toolCalls.map((t) => t.tool))];
  return [
    { kind: 'Task', values: [record.task?.id ?? ex.taskId ?? UNKNOWN] },
    { kind: 'Job', values: [ex.jobId ?? UNKNOWN] },
    { kind: 'Agent', values: [ex.agentId || UNKNOWN] },
    { kind: 'Model', values: [record.scheduling?.modelId ?? ex.modelId ?? UNKNOWN] },
    { kind: 'Runtime', values: [record.scheduling?.runtimeId ?? ex.runtimeId ?? UNKNOWN] },
    { kind: 'Worker', values: [ex.workerId ?? ex.computerId ?? UNKNOWN] },
    { kind: 'Tool', values: tools.length ? tools : [UNKNOWN] },
    { kind: 'Artifact', values: artifacts.length ? artifacts.map((a) => `${a.location} ${a.contentHash.slice(0, 12)}`) : [UNKNOWN] },
    { kind: 'Verification', values: (record.evidence ?? []).length ? (record.evidence ?? []).map((e) => `${e.id} ${oracleOf(e)}@R${revOf(e)}`) : [UNKNOWN] },
  ];
}

export function inspectVerificationEvidence(
  record: ExecutionRecord,
  options: {
    artifacts?: ArtifactProvenance[];
    provenanceLimit?: number;
    /** ExecutionEngine.toolCheckpoints(id): the same source setStatus uses to block completion. */
    toolCheckpoints?: Array<{ state: string }>;
  } = {},
): VerificationInspection {
  const completion = assessCompletionEvidence(record);
  const currentRevision = completion.workspaceRevision;
  const oracles = [...DISPLAY_ORACLES];
  for (const t of completion.required) if (!oracles.includes(t)) oracles.push(t);
  for (const e of record.evidence ?? []) if (!oracles.includes(oracleOf(e))) oracles.push(oracleOf(e));
  const slots = oracles.map((o) => buildSlot(o, record, currentRevision, completion.required.includes(o)));

  const passingRevisions = (record.evidence ?? [])
    .filter((e) => e.exitCode === 0 && (e.status ?? 'PASS') === 'PASS')
    .map(revOf);
  const lastVerifiedRevision = passingRevisions.length ? Math.max(...passingRevisions) : null;

  const unresolvedToolCalls = options.toolCheckpoints
    ? options.toolCheckpoints.filter((c) => c.state === 'STARTED' || c.state === 'OUTCOME_UNKNOWN').length
    : explainExecution(record).toolOutcomes.unknown.length;
  const limit = options.provenanceLimit ?? 8;
  const provenance = buildProvenance(record, options.artifacts ?? []).map((s) => ({
    kind: s.kind,
    values: s.values.length > limit ? [...s.values.slice(0, limit), `(+${s.values.length - limit} more)`] : s.values,
  }));

  return {
    executionId: record.execution.id,
    taskId: record.task?.id ?? record.execution.taskId,
    status: record.execution.status,
    currentRevision,
    workspaceDigest: record.workspaceState?.contentFingerprint ?? UNKNOWN,
    slots,
    mutations: collectMutations(record, lastVerifiedRevision),
    policy: record.policyDecisions.map((p) => ({ decision: String(p.decision), rule: p.rule, tool: p.tool })),
    unresolvedToolCalls,
    provenance,
    completion: { ...completion, eligible: completion.eligible && unresolvedToolCalls === 0 },
  };
}

/** "why complete?" / "why incomplete?" — the exact evidence chain, or what is missing. */
export function explainCompletion(inspection: VerificationInspection): WhyCompleteAnswer {
  const c = inspection.completion;
  const rev = inspection.currentRevision;
  if (c.eligible) {
    const chain = [`Workspace revision R${rev} (digest ${inspection.workspaceDigest})`];
    for (const slot of inspection.slots) {
      if (!slot.required || slot.status !== 'PASS') continue;
      chain.push(`${slot.oracle} ${slot.evidenceId} — \`${slot.command}\` exit ${slot.exitCode} at R${slot.revision}`);
    }
    if (c.required.length === 0) chain.push(`No evidence contract; controller evaluation passed at R${rev}`);
    chain.push('All dispatched tool calls reconciled');
    return { complete: true, chain, missing: [] };
  }
  const missing: string[] = [];
  for (const oracle of c.missing) {
    const slot = inspection.slots.find((s) => s.oracle === oracle);
    if (!slot || slot.status === 'MISSING') missing.push(`${oracle}: no evidence recorded for R${rev}`);
    else if (slot.status === 'STALE') missing.push(`${oracle}: STALE — evidence is for R${slot.revision}, current revision is R${rev}`);
    else missing.push(`${oracle}: ${slot.status} at R${slot.revision} (exit ${slot.exitCode})`);
  }
  if (c.evaluationInvalid) missing.push(`EVALUATION: controller evaluation failed or is not bound to R${rev}`);
  if (c.evaluationMissing) missing.push(`EVALUATION: files changed but no controller evaluation recorded for R${rev}`);
  if (inspection.unresolvedToolCalls > 0) missing.push(`TOOL_OUTCOME_UNKNOWN: ${inspection.unresolvedToolCalls} dispatched tool call(s) unreconciled`);
  return { complete: false, chain: [], missing };
}
