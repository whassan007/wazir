/**
 * Reference VerificationService and a deterministic TargetTaskExecutor.
 *
 * The fake verifier is an independent `checksum` validator: it re-reads every
 * declared artifact from disk and hashes the exact bytes. It never reads the
 * executor's summary. External-dependency targets additionally need an
 * `external-record` (EXTERNAL_RECORD_FILE in the workspace); approval targets
 * need a `human-signoff` evidence record (added via `recordHumanSignoff`).
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { KeyValueStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  type AcceptanceGateDecision,
  type EvidenceRecord,
  type GoalRunId,
  type GoalRunLedger,
  type GoalTarget,
  type TargetAttempt,
  type TargetId,
  type TargetTaskExecutor,
  type VerificationService,
  type VerificationVerdict,
  type GoalStudioEvent,
} from '../../../packages/goals/src/contracts.js';
import { clone, listIso, sha256Hex, systemClock, type Clock } from './util.js';

export const FAKE_VALIDATOR_IDENTITY = 'verifier:reference-checksum';
export const EXTERNAL_RECORD_FILE = (targetId: TargetId) => `.external-records/${targetId}.json`;

/** Artifact paths ending in '/' are directories; their content is `<dir>/README.md`. */
export function artifactFile(workspaceRoot: string, artifact: string): string {
  return path.join(workspaceRoot, artifact.endsWith('/') ? `${artifact}README.md` : artifact);
}

export class FakeVerificationService implements VerificationService {
  private readonly clock: Clock;
  constructor(private readonly store: KeyValueStore, opts: { clock?: Clock; validatorIdentity?: string } = {}) {
    this.clock = opts.clock ?? systemClock;
    this.validatorIdentity = opts.validatorIdentity ?? FAKE_VALIDATOR_IDENTITY;
  }
  private readonly validatorIdentity: string;

  async verify(input: { run: GoalRunLedger; target: GoalTarget; attempt: TargetAttempt; workspaceRoot: string; executorIdentity: string }): Promise<EvidenceRecord[]> {
    const validatorIdentity = this.validatorIdentity === input.executorIdentity ? `${this.validatorIdentity}#independent` : this.validatorIdentity;
    const artifacts: EvidenceRecord['artifacts'] = [];
    const missing: string[] = [];
    for (const a of input.target.artifacts) {
      try {
        const bytes = await fs.readFile(artifactFile(input.workspaceRoot, a));
        if (bytes.length === 0) missing.push(`${a} (empty)`);
        artifacts.push({ uri: `file://${artifactFile(input.workspaceRoot, a)}`, digest: `sha256:${sha256Hex(bytes)}`, sizeBytes: bytes.length });
      } catch {
        missing.push(a);
      }
    }
    const verdict: VerificationVerdict = input.target.artifacts.length === 0 ? 'UNKNOWN' : missing.length === 0 ? 'PASS' : 'FAIL';
    const workspaceRevision = `sha256:${sha256Hex(artifacts.map((a) => a.digest).join(','))}`;
    const now = this.clock().toISOString();
    const records: EvidenceRecord[] = input.target.acceptance.map((criterion) => ({
      id: `ev-${randomUUID()}`,
      runId: input.run.runId,
      targetId: input.target.id,
      attemptId: input.attempt.id,
      graphRevision: input.run.graphRevision,
      workspaceRevision,
      artifacts: clone(artifacts),
      validationMethod: 'checksum',
      validatorIdentity,
      executorIdentity: input.executorIdentity,
      verdict,
      criterion,
      outputExcerpt: missing.length ? `missing: ${missing.join(', ')}` : `${artifacts.length} artifact(s) present and hashed`,
      limitations: ['reference fake: checks artifact presence and digest only, not semantic acceptance'],
      createdAt: now,
    }));
    if (input.target.externalDependency) {
      try {
        const raw = await fs.readFile(path.join(input.workspaceRoot, EXTERNAL_RECORD_FILE(input.target.id)));
        const parsed = JSON.parse(raw.toString('utf8')) as { issuer?: string };
        records.push({
          id: `ev-${randomUUID()}`, runId: input.run.runId, targetId: input.target.id, attemptId: input.attempt.id, graphRevision: input.run.graphRevision,
          workspaceRevision, artifacts: [{ uri: `file://${EXTERNAL_RECORD_FILE(input.target.id)}`, digest: `sha256:${sha256Hex(raw)}` }],
          validationMethod: 'external-record', validatorIdentity, executorIdentity: input.executorIdentity,
          verdict: parsed.issuer ? 'PASS' : 'FAIL', limitations: ['issuer attribution only'], createdAt: now,
        });
      } catch {
        // No external record: the gate will answer awaiting_external.
      }
    }
    for (const r of records) await this.store.put(GOAL_STORE_KEYS.evidence(r.runId, r.id), r);
    return clone(records);
  }

  /** Fake-only: a human sign-off evidence record (approval targets). */
  async recordHumanSignoff(input: { run: GoalRunLedger; target: GoalTarget; attempt: TargetAttempt; principal: string; executorIdentity: string }): Promise<EvidenceRecord> {
    if (!input.principal.startsWith('user:')) throw new Error('human-signoff requires a human principal');
    const r: EvidenceRecord = {
      id: `ev-${randomUUID()}`, runId: input.run.runId, targetId: input.target.id, attemptId: input.attempt.id, graphRevision: input.run.graphRevision,
      workspaceRevision: 'n/a', artifacts: [], validationMethod: 'human-signoff', validatorIdentity: input.principal, executorIdentity: input.executorIdentity,
      verdict: 'PASS', limitations: [], createdAt: this.clock().toISOString(),
    };
    await this.store.put(GOAL_STORE_KEYS.evidence(r.runId, r.id), r);
    return r;
  }

  gate(input: { run: GoalRunLedger; target: GoalTarget; attempt: TargetAttempt; evidence: EvidenceRecord[] }): AcceptanceGateDecision {
    const independent = input.evidence.filter(
      (e) => e.attemptId === input.attempt.id && e.targetId === input.target.id && e.runId === input.run.runId && e.validatorIdentity !== e.executorIdentity && e.validatorIdentity.length > 0,
    );
    const reasons: string[] = [];
    const selfCount = input.evidence.length - independent.length;
    if (selfCount > 0) reasons.push(`${selfCount} evidence record(s) ignored (self-verified or foreign attempt)`);
    const perCriterion = input.target.acceptance.map((criterion) => {
      const ev = independent.filter((e) => e.criterion === criterion);
      const verdict: VerificationVerdict = ev.length === 0 ? 'NOT_RUN' : ev.some((e) => e.verdict === 'FAIL') ? 'FAIL' : ev.every((e) => e.verdict === 'PASS') ? 'PASS' : 'UNKNOWN';
      return { criterion, verdict, evidenceIds: ev.map((e) => e.id) };
    });
    const base = { runId: input.run.runId, targetId: input.target.id, attemptId: input.attempt.id, perCriterion, decidedAt: this.clock().toISOString() };
    if (input.target.acceptance.length === 0) return { ...base, decision: 'blocked', reasons: [...reasons, 'target has no acceptance criteria; cannot be verified'] };
    const notPass = perCriterion.filter((c) => c.verdict !== 'PASS');
    if (notPass.length > 0) return { ...base, decision: 'repair', reasons: [...reasons, ...notPass.map((c) => `${c.verdict}: ${c.criterion}`)] };
    const pass = (method: string) => independent.some((e) => e.validationMethod === method && e.verdict === 'PASS');
    if (input.target.externalDependency && !pass('external-record') && !pass('human-signoff')) {
      return { ...base, decision: 'awaiting_external', reasons: [...reasons, 'external dependency has no attributable external record'] };
    }
    if (input.target.requiresApproval && !pass('human-signoff')) return { ...base, decision: 'needs_approval', reasons: [...reasons, 'human sign-off required'] };
    return { ...base, decision: 'completed', reasons: [...reasons, 'all criteria PASS with independent evidence'] };
  }

  async evidence(runId: GoalRunId, targetId?: TargetId): Promise<EvidenceRecord[]> {
    return (await listIso<EvidenceRecord>(this.store, `goals/evidence/${runId}/`)).map((e) => e.value).filter((e) => (targetId ? e.targetId === targetId : true)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
}

/**
 * Deterministic executor double: writes the target's declared artifacts into
 * the workspace and counts real side effects in `sideEffects`. `failFirst`
 * makes the first N calls for a target fail (retryable) to exercise recovery.
 */
export class FakeTargetTaskExecutor implements TargetTaskExecutor {
  readonly sideEffects = new Map<string, number>();
  readonly calls: string[] = [];
  constructor(private readonly opts: { failFirst?: Record<TargetId, number>; delayMs?: number; omitArtifact?: Record<TargetId, string> } = {}) {}

  async execute(input: Parameters<TargetTaskExecutor['execute']>[0]) {
    this.calls.push(input.key);
    input.onEvent({ seq: 0, type: 'execution.event', runId: input.run.runId, targetId: input.target.id, attemptId: input.attempt.id, timestamp: new Date().toISOString(), data: { message: 'started', key: input.key } } as GoalStudioEvent);
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (input.signal.aborted) return { executionId: `exec-${input.key}`, ok: false, summary: 'cancelled', error: { code: 'CANCELLED' as const, message: 'aborted', retryable: true } };
    const remaining = this.opts.failFirst?.[input.target.id] ?? 0;
    const seen = this.calls.filter((k) => k.startsWith(`${input.run.runId}:${input.target.id}:`)).length;
    if (seen <= remaining) {
      return { executionId: `exec-${input.key}`, ok: false, summary: 'injected failure', error: { code: 'EXECUTION_FAILED' as const, message: 'injected transient failure', retryable: true } };
    }
    for (const a of input.target.artifacts) {
      if (this.opts.omitArtifact?.[input.target.id] === a) continue;
      const file = artifactFile(input.workspaceRoot, a);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `# ${input.target.id}: ${a}\nattempt ${input.attempt.attempt} via ${input.route.modelId}\n`);
    }
    this.sideEffects.set(input.target.id, (this.sideEffects.get(input.target.id) ?? 0) + 1);
    return { executionId: `exec-${input.key}`, ok: true, summary: `wrote ${input.target.artifacts.length} artifact(s)` };
  }
}
