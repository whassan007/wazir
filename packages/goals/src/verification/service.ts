import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  AcceptanceGateDecision,
  EvidenceRecord,
  GoalRunLedger,
  GoalTarget,
  TargetAttempt,
  VerificationVerdict,
} from '../contracts.js';
import { GOAL_STORE_KEYS, GoalStudioFailure } from '../contracts.js';
import { createSandboxedCheckRunner, excerpt, runDeclaredCheck } from './checks.js';
import { snapshotArtifacts } from './digest.js';
import { evaluateGate, referenceState, resolveCriterion } from './gate.js';
import type {
  DeclaredCheck,
  GateInput,
  GoalVerificationService,
  SignoffInput,
  VerifiableTarget,
  VerificationServiceDeps,
  WorkspaceState,
} from './types.js';

export const DEFAULT_VALIDATOR_IDENTITY = 'verifier:wazir-deterministic';

const evidencePrefix = (runId: string) => GOAL_STORE_KEYS.evidence(runId, '');

/**
 * Independent verification for Goal Studio targets.
 *
 *  verify(): digests the actual artifact bytes, runs declared deterministic
 *  checks (bounded, sandboxed), records NOT_RUN for criteria nothing can check,
 *  runs the adversarial reviewer hook, and persists every result as an
 *  immutable EvidenceRecord under GOAL_STORE_KEYS.evidence.
 *  gate(): pure, see evaluateGate.
 */
export function createVerificationService(deps: VerificationServiceDeps): GoalVerificationService {
  const clock = deps.clock ?? (() => new Date());
  const validator = deps.validatorIdentity ?? DEFAULT_VALIDATOR_IDENTITY;
  const runner = deps.checks ?? createSandboxedCheckRunner();
  let seq = 0;

  function evidenceId(fields: Record<string, unknown>, createdAt: string): string {
    seq = (seq + 1) % 1_000_000;
    const h = createHash('sha256').update(JSON.stringify(fields)).update(String(seq)).update(createdAt).digest('hex').slice(0, 12);
    return `ev-${Date.parse(createdAt).toString(36).padStart(9, '0')}-${String(seq).padStart(6, '0')}-${h}`;
  }

  async function persist(record: EvidenceRecord): Promise<void> {
    const key = GOAL_STORE_KEYS.evidence(record.runId, record.id);
    // Evidence is append-only: never overwrite an existing record.
    if (deps.store.update) {
      await deps.store.update<EvidenceRecord>(key, (current) => {
        if (current) throw new GoalStudioFailure('DUPLICATE', `evidence ${record.id} already exists`);
        return record;
      });
    } else {
      if (await deps.store.get(key)) throw new GoalStudioFailure('DUPLICATE', `evidence ${record.id} already exists`);
      await deps.store.put(key, record);
    }
    if (deps.events) {
      await deps.events.append({
        type: 'verification.evidence',
        runId: record.runId,
        targetId: record.targetId,
        attemptId: record.attemptId,
        data: { evidenceId: record.id, verdict: record.verdict, validationMethod: record.validationMethod, criterion: record.criterion, workspaceRevision: record.workspaceRevision },
      }).catch(() => undefined);
    }
  }

  async function listEvidence(runId: string, targetId?: string): Promise<EvidenceRecord[]> {
    const entries = await deps.store.list(evidencePrefix(runId));
    return entries
      .map((e) => e.value as EvidenceRecord)
      .filter((e): e is EvidenceRecord => Boolean(e && e.id && e.runId === runId))
      .filter((e) => targetId === undefined || e.targetId === targetId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }

  async function snapshot(target: GoalTarget, workspaceRoot = deps.workspaceRoot): Promise<WorkspaceState> {
    return snapshotArtifacts(path.resolve(workspaceRoot), target.artifacts, deps.limits);
  }

  function gate(input: GateInput): AcceptanceGateDecision {
    return evaluateGate(input, deps.gateOptions);
  }

  async function verify(input: { run: GoalRunLedger; target: GoalTarget; attempt: TargetAttempt; workspaceRoot: string; executorIdentity: string }): Promise<EvidenceRecord[]> {
    const { run, target, attempt, executorIdentity } = input;
    if (attempt.runId !== run.runId || attempt.targetId !== target.id) {
      throw new GoalStudioFailure('VALIDATION', `attempt ${attempt.id} does not belong to run ${run.runId} target ${target.id}`);
    }
    if (!executorIdentity || !executorIdentity.trim()) throw new GoalStudioFailure('VALIDATION', 'executorIdentity is required');
    const root = path.resolve(input.workspaceRoot || deps.workspaceRoot);
    const independentValidator = validator !== executorIdentity;
    const records: EvidenceRecord[] = [];

    const before = await snapshot(target, root);
    const make = (fields: {
      validationMethod: string;
      verdict: VerificationVerdict;
      criterion?: string;
      command?: string;
      exitCode?: number;
      outputExcerpt?: string;
      limitations: string[];
      artifacts?: EvidenceRecord['artifacts'];
      validatorIdentity?: string;
      workspaceRevision?: string;
    }): EvidenceRecord => {
      const createdAt = clock().toISOString();
      const validatorIdentity = fields.validatorIdentity ?? validator;
      let verdict = fields.verdict;
      const limitations = [...fields.limitations];
      if (validatorIdentity === executorIdentity && verdict === 'PASS') {
        verdict = 'UNKNOWN';
        limitations.push('validator identity equals executor identity; self-verification is not evidence');
      }
      const base = {
        runId: run.runId,
        targetId: target.id,
        attemptId: attempt.id,
        graphRevision: run.graphRevision,
        workspaceRevision: fields.workspaceRevision ?? before.workspaceRevision,
        artifacts: fields.artifacts ?? before.artifacts,
        validationMethod: fields.validationMethod,
        validatorIdentity,
        executorIdentity,
        verdict,
        criterion: fields.criterion,
        command: fields.command,
        exitCode: fields.exitCode,
        outputExcerpt: fields.outputExcerpt,
        limitations,
        createdAt,
      };
      return { id: evidenceId(base, createdAt), ...base };
    };

    // 1. Checksums of the exact bytes (one record per declared artifact).
    const problemByUri = new Map(before.problems.map((p) => [p.uri, p.reason]));
    for (const ref of before.artifacts) {
      const problem = problemByUri.get(ref.uri);
      records.push(make({
        validationMethod: 'checksum',
        verdict: problem ? 'FAIL' : 'PASS',
        artifacts: [ref],
        outputExcerpt: `${ref.uri} ${ref.digest} (${ref.sizeBytes ?? 0} bytes)`,
        limitations: problem ? [problem] : ['checksum binds evidence to bytes; it does not establish correctness'],
      }));
    }
    for (const p of before.problems) {
      if (before.artifacts.some((a) => a.uri === p.uri)) continue;
      records.push(make({ validationMethod: 'checksum', verdict: 'FAIL', artifacts: [], outputExcerpt: p.reason, limitations: [p.reason] }));
    }
    if (target.artifacts.length === 0) {
      records.push(make({ validationMethod: 'checksum', verdict: 'UNKNOWN', artifacts: [], outputExcerpt: 'target declares no artifacts', limitations: ['no artifacts to bind evidence to'] }));
    }

    // 2. Declared deterministic checks (graph-declared + operator plan; never model-declared).
    const declared: DeclaredCheck[] = [
      ...((target as VerifiableTarget).checks ?? []),
      ...((await deps.plan?.({ run, target, attempt })) ?? []),
    ];
    const covered = new Set<string>();
    for (const check of declared) {
      const criterion = check.criterion === undefined ? undefined : resolveCriterion(target, check.criterion);
      if (check.criterion !== undefined && criterion === undefined) {
        records.push(make({ validationMethod: check.kind === 'command' ? 'command' : 'existence', verdict: 'NOT_RUN', command: check.command, limitations: [`check ${check.id} references unknown criterion '${check.criterion}'`] }));
        continue;
      }
      const outcome = await runDeclaredCheck(check, root, independentValidator ? runner : undefined);
      if (!independentValidator) outcome.limitations.push('validator identity equals executor identity; check not run as independent evidence');
      if (criterion) covered.add(criterion);
      records.push(make({
        validationMethod: outcome.method,
        verdict: outcome.verdict,
        criterion,
        command: outcome.command,
        exitCode: outcome.exitCode,
        outputExcerpt: outcome.outputExcerpt,
        limitations: [`check ${check.id}`, ...outcome.limitations],
      }));
    }

    // 3. Checks must not have altered the artifacts they verified.
    const after = await snapshot(target, root);
    if (after.workspaceRevision !== before.workspaceRevision) {
      records.push(make({
        validationMethod: 'checksum',
        verdict: 'FAIL',
        artifacts: after.artifacts,
        workspaceRevision: after.workspaceRevision,
        outputExcerpt: `artifacts changed during verification: ${before.workspaceRevision} -> ${after.workspaceRevision}`,
        limitations: ['artifacts mutated while checks ran; earlier evidence is stale'],
      }));
    }

    // 4. Adversarial review (CHALLENGE). Self-review is never evidence.
    if (deps.reviewer) {
      const reviewer = deps.reviewer;
      let reviewerIdentity = reviewer.identity;
      try {
        const review = await reviewer.review({
          run, target, attempt, workspaceRoot: root, workspaceRevision: before.workspaceRevision,
          artifacts: before.artifacts, executorIdentity, evidence: [...records],
        });
        reviewerIdentity = review.validatorIdentity ?? reviewer.identity;
        const selfReview = !reviewerIdentity || reviewerIdentity === executorIdentity;
        for (const finding of review.findings ?? []) {
          const criterion = finding.criterion === undefined ? undefined : resolveCriterion(target, finding.criterion);
          const limitations = [...(finding.limitations ?? [])];
          let verdict: VerificationVerdict = finding.verdict;
          if (selfReview) {
            verdict = 'UNKNOWN';
            limitations.push('reviewer identity equals executor identity; self-review rejected');
          }
          if (finding.criterion !== undefined && criterion === undefined) {
            limitations.push(`finding references unknown criterion '${finding.criterion}'`);
            if (verdict === 'PASS') verdict = 'UNKNOWN';
          }
          if (!['PASS', 'FAIL', 'UNKNOWN', 'NOT_RUN'].includes(verdict)) verdict = 'UNKNOWN';
          records.push(make({
            validationMethod: 'adversarial-review',
            verdict,
            criterion,
            validatorIdentity: reviewerIdentity || `reviewer:anonymous`,
            outputExcerpt: excerpt([finding.objection, finding.reproduction && `reproduce: ${finding.reproduction}`].filter(Boolean).join('\n')),
            limitations,
          }));
        }
      } catch (error) {
        records.push(make({
          validationMethod: 'adversarial-review',
          verdict: 'UNKNOWN',
          validatorIdentity: reviewerIdentity || 'reviewer:anonymous',
          outputExcerpt: excerpt(`reviewer failed: ${(error as Error).message}`),
          limitations: ['adversarial review did not complete'],
        }));
      }
    }

    // 5. Criteria nothing could check are recorded NOT_RUN (missing), never PASS.
    for (const criterion of target.acceptance) {
      if (covered.has(criterion)) continue;
      if (records.some((r) => r.criterion === criterion)) continue;
      records.push(make({
        validationMethod: 'coverage',
        verdict: 'NOT_RUN',
        criterion,
        limitations: ['no deterministic check declared for this criterion; requires a declared check or human-signoff'],
      }));
    }

    for (const record of records) await persist(record);
    return records;
  }

  async function gateCurrent(input: { run: GoalRunLedger; target: GoalTarget; attempt: TargetAttempt; workspaceRoot?: string; executorIdentity?: string }): Promise<AcceptanceGateDecision> {
    const evidence = await listEvidence(input.run.runId, input.target.id);
    const current = await snapshot(input.target, input.workspaceRoot ?? deps.workspaceRoot);
    return gate({ run: input.run, target: input.target, attempt: input.attempt, evidence, current, executorIdentity: input.executorIdentity });
  }

  async function recordSignoff(input: SignoffInput): Promise<EvidenceRecord[]> {
    if (!input.principal || !input.principal.trim()) throw new GoalStudioFailure('UNAUTHORIZED', 'signoff requires an authenticated principal');
    if (input.verdict !== 'PASS' && input.verdict !== 'FAIL') throw new GoalStudioFailure('VALIDATION', "verdict must be 'PASS' or 'FAIL'");
    const method = input.method ?? 'human-signoff';
    if (method !== 'human-signoff' && method !== 'external-record') throw new GoalStudioFailure('VALIDATION', `unsupported signoff method '${method}'`);
    if (method === 'external-record' && !input.source?.trim()) throw new GoalStudioFailure('VALIDATION', 'external-record requires a source (issuer, URL or record id)');

    const all = await listEvidence(input.runId, input.targetId);
    const checksums = all.filter((e) => e.validationMethod === 'checksum' && (input.attemptId === undefined || e.attemptId === input.attemptId));
    const latest = checksums[checksums.length - 1];
    if (!latest) throw new GoalStudioFailure('VALIDATION', 'no verified workspace revision for this target; run verification before signoff');
    const ref = referenceState(all, latest.attemptId);
    if (!ref) throw new GoalStudioFailure('VALIDATION', 'no verified workspace revision for this target');
    if (input.workspaceRevision !== undefined && input.workspaceRevision !== ref.workspaceRevision) {
      throw new GoalStudioFailure('VALIDATION', `workspaceRevision ${input.workspaceRevision} is not the latest verified revision ${ref.workspaceRevision}`, { details: { latest: ref.workspaceRevision } });
    }
    const validatorIdentity = `user:${input.principal}`;
    if (validatorIdentity === latest.executorIdentity || input.principal === latest.executorIdentity) {
      throw new GoalStudioFailure('FORBIDDEN', 'the executor of an attempt cannot sign off its own work');
    }
    const criteria = [...new Set(input.criteria ?? [])];
    for (const c of criteria) if (typeof c !== 'string' || !c.trim()) throw new GoalStudioFailure('VALIDATION', 'criteria must be non-empty strings');
    const note = input.note ? excerpt(input.note).slice(0, 2000) : undefined;
    const source = input.source ? excerpt(input.source).slice(0, 500) : undefined;
    const createdAt = clock().toISOString();
    const records: EvidenceRecord[] = (criteria.length ? criteria : [undefined]).map((criterion) => {
      const base = {
        runId: input.runId,
        targetId: input.targetId,
        attemptId: latest.attemptId,
        graphRevision: latest.graphRevision,
        workspaceRevision: ref.workspaceRevision,
        artifacts: ref.artifacts,
        validationMethod: method,
        validatorIdentity,
        executorIdentity: latest.executorIdentity,
        verdict: input.verdict as VerificationVerdict,
        criterion,
        outputExcerpt: [note, source && `source: ${source}`].filter(Boolean).join('\n') || undefined,
        limitations: [method === 'external-record' ? 'operator-attested external record; authenticity rests on the cited source' : 'human judgement bound to the verified artifact digests'],
        createdAt,
      };
      return { id: evidenceId(base, createdAt), ...base };
    });
    for (const r of records) await persist(r);
    if (deps.audit) {
      await deps.audit({
        seq: 0,
        type: 'verification.evidence',
        runId: input.runId,
        targetId: input.targetId,
        attemptId: latest.attemptId,
        timestamp: createdAt,
        data: { action: 'signoff', method, verdict: input.verdict, principal: validatorIdentity, evidenceIds: records.map((r) => r.id) },
      }).catch(() => undefined);
    }
    return records;
  }

  return {
    verify,
    gate,
    evidence: listEvidence,
    snapshot,
    gateCurrent,
    recordSignoff,
  };
}
