import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  GoalStudioFailure,
  createVerificationService,
  digestArtifact,
  evaluateGate,
  normalizeArtifactPath,
  resolveCriterion,
  validateSchema,
  type AdversarialReviewer,
  type CheckRunner,
  type DeclaredCheck,
  type EvidenceRecord,
  type GoalRunLedger,
  type GoalStudioEvent,
  type GoalTarget,
  type TargetAttempt,
  type VerifiableTarget,
} from '../../src/index.js';
import { ApiAuth } from '../../../../apps/api/src/auth.js';
import { registerVerificationRoutes } from '../../../../apps/api/src/goalStudio/verificationRoutes.js';

const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function makeRun(overrides: Partial<GoalRunLedger> = {}): GoalRunLedger {
  const now = '2026-10-22T18:00:00.000Z';
  return {
    runId: 'run-1',
    graphId: 'graph-1',
    graphRevision: 1,
    graphDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    status: 'running',
    ledgerRevision: 1,
    targets: {
      'Y1.1': {
        targetId: 'Y1.1',
        status: 'verifying',
        attempts: 1,
        repairs: 0,
        lastAttemptId: 'attempt-1',
        evidenceIds: [],
        blockers: [],
        updatedAt: now,
      },
    },
    resource: {
      tasksStarted: 1,
      hostedSpendUsd: 0,
      startedAt: now,
      deadlineAt: '2026-10-22T19:30:00.000Z',
    },
    createdBy: 'user:operator',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeTarget(overrides: Partial<VerifiableTarget> = {}): VerifiableTarget {
  return {
    id: 'Y1.1',
    stage: 'foundational_research',
    title: 'Define a bounded formal safety claim',
    dependsOn: [],
    priority: 100,
    executor: 'axiomatize',
    artifacts: ['scope.md', 'formal-claim.md'],
    acceptance: [
      'Formal assumptions and trust boundary are explicit.',
      'At least one counterexample to an overbroad claim is documented.',
    ],
    ...overrides,
  };
}

function makeAttempt(overrides: Partial<TargetAttempt> = {}): TargetAttempt {
  return {
    id: 'attempt-1',
    runId: 'run-1',
    targetId: 'Y1.1',
    attempt: 1,
    phase: 'INDEPENDENT_VERIFY',
    startedAt: '2026-10-22T18:01:00.000Z',
    outcome: 'succeeded',
    ...overrides,
  };
}

describe('Goal Studio VerificationService & AcceptanceGate', () => {
  let tmpDir: string;
  let store: MemoryStore;
  let clockTicks: number;
  const clock = () => new Date(Date.parse('2026-10-22T18:05:00.000Z') + clockTicks++ * 1000);

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-goal-verify-'));
    store = new MemoryStore();
    clockTicks = 0;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects missing artifacts during verify() and returns decision: repair in gate()', async () => {
    // Only write one of the two required artifacts; formal-claim.md is missing
    await fs.writeFile(path.join(tmpDir, 'scope.md'), '# Scope\nTrust boundary defined.\n');

    const service = createVerificationService({
      store,
      workspaceRoot: tmpDir,
      clock,
      plan: () => [
        { id: 'c1', kind: 'contains', artifact: 'scope.md', pattern: 'Trust boundary', criterion: '#1' },
        { id: 'c2', kind: 'contains', artifact: 'formal-claim.md', pattern: 'Counterexample', criterion: '#2' },
      ],
    });

    const run = makeRun();
    const target = makeTarget();
    const attempt = makeAttempt();

    const evidence = await service.verify({
      run,
      target,
      attempt,
      workspaceRoot: tmpDir,
      executorIdentity: 'executor:model-a',
    });

    const missingChecksum = evidence.find(
      (e) => e.validationMethod === 'checksum' && e.verdict === 'FAIL' && e.outputExcerpt?.includes('artifact missing: formal-claim.md'),
    );
    expect(missingChecksum).toBeDefined();

    const decision = service.gate({ run, target, attempt, evidence });
    expect(decision.decision).toBe('repair');
    expect(decision.reasons.some((r) => r.includes('artifact missing: formal-claim.md'))).toBe(true);
  });

  it('rejects empty or corrupted artifacts (0-byte file, empty directory, invalid JSON schema, path traversal)', async () => {
    // 0-byte file and invalid JSON
    await fs.writeFile(path.join(tmpDir, 'scope.md'), '');
    await fs.writeFile(path.join(tmpDir, 'formal-claim.md'), '{ corrupted json ');
    await fs.mkdir(path.join(tmpDir, 'empty-dir'));

    const target = makeTarget({
      artifacts: ['scope.md', 'formal-claim.md', 'empty-dir'],
      checks: [
        { id: 'c1', kind: 'non-empty', artifact: 'scope.md', criterion: '#1' },
        {
          id: 'c2',
          kind: 'json-schema',
          artifact: 'formal-claim.md',
          schema: { type: 'object', required: ['counterexample'] },
          criterion: '#2',
        },
      ],
    });

    const service = createVerificationService({ store, workspaceRoot: tmpDir, clock });
    const run = makeRun();
    const attempt = makeAttempt();

    const evidence = await service.verify({
      run,
      target,
      attempt,
      workspaceRoot: tmpDir,
      executorIdentity: 'executor:model-a',
    });

    // Empty file and empty directory produce FAIL checksum evidence
    const emptyFileRecord = evidence.find((e) => e.validationMethod === 'checksum' && e.limitations.some((l) => l.includes('artifact is empty: scope.md')));
    expect(emptyFileRecord?.verdict).toBe('FAIL');

    const emptyDirRecord = evidence.find((e) => e.validationMethod === 'checksum' && e.limitations.some((l) => l.includes('artifact directory is empty: empty-dir/')));
    expect(emptyDirRecord?.verdict).toBe('FAIL');

    // Corrupted JSON produces FAIL schema evidence
    const schemaRecord = evidence.find((e) => e.validationMethod === 'schema');
    expect(schemaRecord?.verdict).toBe('FAIL');
    expect(schemaRecord?.outputExcerpt).toContain('invalid JSON');

    const decision = service.gate({ run, target, attempt, evidence });
    expect(decision.decision).toBe('repair');

    // Also test corrupted / non-sha256 digest in gate() directly
    const forgedEvidence: EvidenceRecord[] = [
      {
        id: 'ev-forged-1',
        runId: run.runId,
        targetId: target.id,
        attemptId: attempt.id,
        graphRevision: run.graphRevision,
        workspaceRevision: 'content:sha256:aaaa',
        artifacts: [
          { uri: 'scope.md', digest: 'md5:not-a-sha256', sizeBytes: 10 },
          { uri: 'formal-claim.md', digest: `sha256:${sha256Hex('valid')}`, sizeBytes: 5 },
          { uri: 'empty-dir/', digest: `sha256:${sha256Hex('valid2')}`, sizeBytes: 5 },
        ],
        validationMethod: 'checksum',
        validatorIdentity: 'verifier:wazir-deterministic',
        executorIdentity: 'executor:model-a',
        verdict: 'PASS',
        limitations: [],
        createdAt: '2026-10-22T18:05:00.000Z',
      },
    ];
    const forgedGate = service.gate({ run, target, attempt, evidence: forgedEvidence });
    expect(forgedGate.decision).toBe('repair');
    expect(forgedGate.reasons.some((r) => r.includes('ARTIFACT_INVALID_DIGEST'))).toBe(true);

    // Path traversal is rejected by normalizeArtifactPath and digestArtifact
    expect(() => normalizeArtifactPath('../outside.txt')).toThrow();
    expect(() => normalizeArtifactPath('/etc/passwd')).toThrow();
    const traversalDigest = await digestArtifact(tmpDir, '../../etc/passwd');
    expect(traversalDigest.problem).toContain('escapes the workspace');
  });

  it('rejects self-certified evidence (validatorIdentity === executorIdentity) in both verify() and gate()', async () => {
    await fs.writeFile(path.join(tmpDir, 'scope.md'), 'Trust boundary is explicit.');
    await fs.writeFile(path.join(tmpDir, 'formal-claim.md'), 'Counterexample 1 documented.');

    const run = makeRun();
    const target = makeTarget({
      checks: [
        { id: 'c1', kind: 'contains', artifact: 'scope.md', pattern: 'Trust boundary', criterion: '#1' },
        { id: 'c2', kind: 'contains', artifact: 'formal-claim.md', pattern: 'Counterexample', criterion: '#2' },
      ],
    });
    const attempt = makeAttempt();

    // Case A: service configured with validatorIdentity === executorIdentity
    const selfService = createVerificationService({
      store,
      workspaceRoot: tmpDir,
      clock,
      validatorIdentity: 'executor:same-agent',
      reviewer: {
        identity: 'executor:same-agent',
        async review() {
          return {
            validatorIdentity: 'executor:same-agent',
            findings: [{ criterion: '#1', verdict: 'PASS', objection: 'Looks great to me (self)' }],
          };
        },
      },
    });

    const selfEvidence = await selfService.verify({
      run,
      target,
      attempt,
      workspaceRoot: tmpDir,
      executorIdentity: 'executor:same-agent',
    });

    // No PASS record is allowed when validatorIdentity === executorIdentity
    expect(selfEvidence.every((e) => e.verdict !== 'PASS')).toBe(true);
    expect(selfEvidence.some((e) => e.limitations.some((l) => l.includes('self-verification') || l.includes('self-review')))).toBe(true);

    const selfGate = selfService.gate({ run, target, attempt, evidence: selfEvidence });
    expect(selfGate.decision).not.toBe('completed');
    expect(selfGate.decision).toBe('repair');

    // Case B: injected raw EvidenceRecord claiming PASS where validatorIdentity === executorIdentity
    const scopeBytes = await fs.readFile(path.join(tmpDir, 'scope.md'));
    const claimBytes = await fs.readFile(path.join(tmpDir, 'formal-claim.md'));
    const artifacts = [
      { uri: 'scope.md', digest: `sha256:${sha256Hex(scopeBytes)}`, sizeBytes: scopeBytes.length },
      { uri: 'formal-claim.md', digest: `sha256:${sha256Hex(claimBytes)}`, sizeBytes: claimBytes.length },
    ];
    const wsRev = 'content:sha256:123456';
    const injectedSelfPass: EvidenceRecord[] = [
      {
        id: 'ev-checksum',
        runId: run.runId,
        targetId: target.id,
        attemptId: attempt.id,
        graphRevision: run.graphRevision,
        workspaceRevision: wsRev,
        artifacts,
        validationMethod: 'checksum',
        validatorIdentity: 'verifier:independent',
        executorIdentity: 'executor:model-x',
        verdict: 'PASS',
        limitations: [],
        createdAt: '2026-10-22T18:05:00.000Z',
      },
      ...target.acceptance.map((criterion, idx) => ({
        id: `ev-self-${idx}`,
        runId: run.runId,
        targetId: target.id,
        attemptId: attempt.id,
        graphRevision: run.graphRevision,
        workspaceRevision: wsRev,
        artifacts,
        validationMethod: 'command',
        validatorIdentity: 'executor:model-x', // Self-certified!
        executorIdentity: 'executor:model-x',
        verdict: 'PASS' as const,
        criterion,
        limitations: [],
        createdAt: '2026-10-22T18:05:01.000Z',
      })),
    ];

    const gateDecision = evaluateGate({ run, target, attempt, evidence: injectedSelfPass });
    expect(gateDecision.decision).toBe('repair');
    expect(gateDecision.reasons.some((r) => r.includes('SELF_VERIFICATION_REJECTED'))).toBe(true);
    expect(gateDecision.perCriterion.every((c) => c.verdict === 'UNKNOWN')).toBe(true);
  });

  it('rejects stale evidence (wrong attemptId, wrong graphRevision, or wrong workspaceRevision)', async () => {
    await fs.writeFile(path.join(tmpDir, 'scope.md'), 'Trust boundary v1');
    await fs.writeFile(path.join(tmpDir, 'formal-claim.md'), 'Counterexample v1');

    const target = makeTarget({
      checks: [
        { id: 'c1', kind: 'contains', artifact: 'scope.md', pattern: 'Trust boundary', criterion: '#1' },
        { id: 'c2', kind: 'contains', artifact: 'formal-claim.md', pattern: 'Counterexample', criterion: '#2' },
      ],
    });
    const service = createVerificationService({ store, workspaceRoot: tmpDir, clock });
    const runV1 = makeRun({ graphRevision: 1 });
    const attempt1 = makeAttempt({ id: 'attempt-1', attempt: 1 });

    const evidenceAttempt1 = await service.verify({
      run: runV1,
      target,
      attempt: attempt1,
      workspaceRoot: tmpDir,
      executorIdentity: 'executor:worker-1',
    });

    // Sanity check: valid for attempt-1 at rev 1
    expect(service.gate({ run: runV1, target, attempt: attempt1, evidence: evidenceAttempt1 }).decision).toBe('completed');

    // 1. Wrong attemptId: attempt-2 cannot reuse attempt-1's evidence
    const attempt2 = makeAttempt({ id: 'attempt-2', attempt: 2 });
    const runOnAttempt2 = makeRun({
      graphRevision: 1,
      targets: {
        'Y1.1': {
          targetId: 'Y1.1',
          status: 'verifying',
          attempts: 2,
          repairs: 1,
          lastAttemptId: 'attempt-2',
          evidenceIds: [],
          updatedAt: '2026-10-22T18:10:00.000Z',
        },
      },
    });
    const wrongAttemptDecision = service.gate({
      run: runOnAttempt2,
      target,
      attempt: attempt2,
      evidence: evidenceAttempt1,
    });
    expect(wrongAttemptDecision.decision).toBe('repair');
    expect(wrongAttemptDecision.reasons.some((r) => r.includes('IGNORED_OTHER_ATTEMPTS'))).toBe(true);

    // Also if caller tries to gate old attempt-1 while ledger says current attempt is attempt-2:
    const supersededAttemptDecision = service.gate({
      run: runOnAttempt2,
      target,
      attempt: attempt1,
      evidence: evidenceAttempt1,
    });
    expect(supersededAttemptDecision.decision).toBe('repair');
    expect(supersededAttemptDecision.reasons.some((r) => r.includes('STALE_ATTEMPT'))).toBe(true);

    // 2. Wrong graphRevision: run is on graphRevision 2, evidence was recorded on graphRevision 1
    const runV2 = makeRun({ graphRevision: 2 });
    const wrongGraphRevDecision = service.gate({
      run: runV2,
      target,
      attempt: attempt1,
      evidence: evidenceAttempt1,
    });
    expect(wrongGraphRevDecision.decision).toBe('repair');
    expect(wrongGraphRevDecision.reasons.some((r) => r.includes('IGNORED_GRAPH_REVISION'))).toBe(true);

    // 3. Wrong workspaceRevision: workspace file mutated after verification
    await fs.writeFile(path.join(tmpDir, 'scope.md'), 'Trust boundary TAMPERED AFTER VERIFY');
    const postTamperGate = await service.gateCurrent({
      run: runV1,
      target,
      attempt: attempt1,
      workspaceRoot: tmpDir,
    });
    expect(postTamperGate.decision).toBe('repair');
    expect(postTamperGate.reasons.some((r) => r.includes('STALE_EVIDENCE'))).toBe(true);
  });

  it('prevents completed when any criterion is UNKNOWN or NOT_RUN (returns decision: repair)', async () => {
    await fs.writeFile(path.join(tmpDir, 'scope.md'), 'Trust boundary is explicit.');
    await fs.writeFile(path.join(tmpDir, 'formal-claim.md'), JSON.stringify({ counterexample: 'ce-1' }));

    // Case 1: Criterion #2 has NO declared check -> recorded as NOT_RUN
    const targetWithNotRun = makeTarget({
      checks: [
        { id: 'c1', kind: 'contains', artifact: 'scope.md', pattern: 'Trust boundary', criterion: '#1' },
      ],
    });
    const service = createVerificationService({ store, workspaceRoot: tmpDir, clock });
    const run = makeRun();
    const attempt = makeAttempt();

    const evNotRun = await service.verify({
      run,
      target: targetWithNotRun,
      attempt,
      workspaceRoot: tmpDir,
      executorIdentity: 'executor:worker-1',
    });

    const notRunRecord = evNotRun.find((e) => e.criterion === targetWithNotRun.acceptance[1]);
    expect(notRunRecord?.verdict).toBe('NOT_RUN');

    const gateNotRun = service.gate({ run, target: targetWithNotRun, attempt, evidence: evNotRun });
    expect(gateNotRun.decision).toBe('repair');
    expect(gateNotRun.perCriterion[0]?.verdict).toBe('PASS');
    expect(gateNotRun.perCriterion[1]?.verdict).toBe('NOT_RUN');

    // Case 2: Criterion #2 uses an unsupported JSON schema keyword -> recorded as UNKNOWN
    const targetWithUnknown = makeTarget({
      checks: [
        { id: 'c1', kind: 'contains', artifact: 'scope.md', pattern: 'Trust boundary', criterion: '#1' },
        {
          id: 'c2',
          kind: 'json-schema',
          artifact: 'formal-claim.md',
          schema: { type: 'object', required: ['counterexample'], patternProperties: { '^.*$': { type: 'string' } } },
          criterion: '#2',
        },
      ],
    });
    const attempt2 = makeAttempt({ id: 'attempt-2', attempt: 2 });
    const run2 = makeRun({
      targets: {
        'Y1.1': {
          targetId: 'Y1.1',
          status: 'verifying',
          attempts: 2,
          repairs: 1,
          lastAttemptId: 'attempt-2',
          evidenceIds: [],
          updatedAt: '2026-10-22T18:10:00.000Z',
        },
      },
    });

    const evUnknown = await service.verify({
      run: run2,
      target: targetWithUnknown,
      attempt: attempt2,
      workspaceRoot: tmpDir,
      executorIdentity: 'executor:worker-1',
    });

    const unknownRecord = evUnknown.find((e) => e.validationMethod === 'schema');
    expect(unknownRecord?.verdict).toBe('UNKNOWN');

    const gateUnknown = service.gate({ run: run2, target: targetWithUnknown, attempt: attempt2, evidence: evUnknown });
    expect(gateUnknown.decision).toBe('repair');
    expect(gateUnknown.perCriterion[1]?.verdict).toBe('UNKNOWN');
  });

  it('enforces externalDependency -> awaiting_external until external-record / human-signoff PASS is recorded, and requiresApproval -> needs_approval', async () => {
    await fs.writeFile(path.join(tmpDir, 'scope.md'), 'Trust boundary is explicit.');
    await fs.writeFile(path.join(tmpDir, 'formal-claim.md'), 'Counterexample is documented.');

    const target = makeTarget({
      externalDependency: true,
      requiresApproval: true,
      checks: [
        { id: 'c1', kind: 'contains', artifact: 'scope.md', pattern: 'Trust boundary', criterion: '#1' },
        { id: 'c2', kind: 'contains', artifact: 'formal-claim.md', pattern: 'Counterexample', criterion: '#2' },
      ],
    });

    const events: GoalStudioEvent[] = [];
    const audits: GoalStudioEvent[] = [];
    const service = createVerificationService({
      store,
      workspaceRoot: tmpDir,
      clock,
      events: {
        async append(ev) {
          const full: GoalStudioEvent = { seq: events.length + 1, timestamp: clock().toISOString(), ...ev };
          events.push(full);
          return full;
        },
      },
      audit: async (ev) => {
        audits.push(ev);
      },
    });

    const run = makeRun();
    const attempt = makeAttempt();

    const evidence1 = await service.verify({
      run,
      target,
      attempt,
      workspaceRoot: tmpDir,
      executorIdentity: 'executor:worker-1',
    });

    // Both criteria PASS deterministically, but externalDependency is true -> awaiting_external
    const gate1 = service.gate({ run, target, attempt, evidence: evidence1 });
    expect(gate1.perCriterion.every((c) => c.verdict === 'PASS')).toBe(true);
    expect(gate1.decision).toBe('awaiting_external');
    expect(gate1.reasons.some((r) => r.includes('AWAITING_EXTERNAL'))).toBe(true);

    // Executor cannot sign off its own work
    await expect(
      service.recordSignoff({
        runId: run.runId,
        targetId: target.id,
        principal: 'executor:worker-1',
        method: 'external-record',
        verdict: 'PASS',
        source: 'https://registry.example.org/record/42',
      }),
    ).rejects.toThrow(GoalStudioFailure);

    // Operator provides external-record PASS
    await service.recordSignoff({
      runId: run.runId,
      targetId: target.id,
      principal: 'operator-alice',
      method: 'external-record',
      verdict: 'PASS',
      source: 'https://registry.example.org/record/42',
      note: 'Independent audit registry entry verified',
    });

    // Now externalDependency is satisfied, but requiresApproval is true and only external-record was provided -> needs_approval
    const allAfterExternal = await service.evidence(run.runId, target.id);
    const gate2 = service.gate({ run, target, attempt, evidence: allAfterExternal });
    expect(gate2.decision).toBe('needs_approval');
    expect(gate2.reasons.some((r) => r.includes('NEEDS_APPROVAL'))).toBe(true);

    // Operator provides human-signoff PASS
    await service.recordSignoff({
      runId: run.runId,
      targetId: target.id,
      principal: 'operator-alice',
      method: 'human-signoff',
      verdict: 'PASS',
      note: 'Approved for completion',
    });

    const allAfterSignoff = await service.evidence(run.runId, target.id);
    const gate3 = service.gate({ run, target, attempt, evidence: allAfterSignoff });
    expect(gate3.decision).toBe('completed');
    expect(audits.length).toBe(2);
    expect(events.length).toBeGreaterThanOrEqual(5);
  });

  it('passes valid independent verification across command, test-suite, schema, content, and adversarial review checks and produces decision: completed', async () => {
    await fs.writeFile(path.join(tmpDir, 'scope.md'), '# Scope\nFormal assumptions and trust boundary are explicit.\n');
    await fs.writeFile(
      path.join(tmpDir, 'formal-claim.md'),
      JSON.stringify({
        assumptions: ['bounded-network-delay'],
        counterexample: { id: 'CE-01', description: 'Unbounded clock drift violates safety' },
        verified: true,
      }),
    );

    const runnerCalls: string[] = [];
    const mockRunner: CheckRunner = {
      async run({ command }) {
        runnerCalls.push(command);
        return {
          exitCode: 0,
          stdout: `PASS: ${command}`,
          stderr: '',
          timedOut: false,
          durationMs: 12,
          sandbox: 'sandbox-exec',
        };
      },
    };

    const reviewer: AdversarialReviewer = {
      identity: 'reviewer:red-team-v1',
      async review() {
        return {
          findings: [
            {
              criterion: '#1',
              verdict: 'PASS',
              objection: 'No counterexample found against bounded claim.',
              limitations: ['Reviewed bounded state space only'],
            },
          ],
        };
      },
    };

    const checks: DeclaredCheck[] = [
      { id: 'chk-content', kind: 'contains', artifact: 'scope.md', pattern: 'trust boundary', criterion: '#1' },
      {
        id: 'chk-schema',
        kind: 'json-schema',
        artifact: 'formal-claim.md',
        schema: {
          type: 'object',
          required: ['assumptions', 'counterexample', 'verified'],
          properties: {
            assumptions: { type: 'array', minItems: 1, items: { type: 'string', minLength: 3 } },
            counterexample: {
              type: 'object',
              required: ['id', 'description'],
              properties: { id: { type: 'string' }, description: { type: 'string' } },
            },
            verified: { const: true },
          },
        },
        criterion: '#2',
      },
      {
        id: 'chk-test',
        kind: 'command',
        command: 'npx vitest run formal-claim',
        testSuite: true,
        criterion: '#2',
      },
    ];

    const target = makeTarget({ checks });
    const run = makeRun();
    const attempt = makeAttempt();

    const service = createVerificationService({
      store,
      workspaceRoot: tmpDir,
      clock,
      checks: mockRunner,
      reviewer,
    });

    const evidence = await service.verify({
      run,
      target,
      attempt,
      workspaceRoot: tmpDir,
      executorIdentity: 'executor:axiomatize-agent',
    });

    expect(runnerCalls).toEqual(['npx vitest run formal-claim']);
    // Every EvidenceRecord is bound to (runId, targetId, attemptId, graphRevision, workspaceRevision) with sha256 digests and limitations
    for (const rec of evidence) {
      expect(rec.runId).toBe(run.runId);
      expect(rec.targetId).toBe(target.id);
      expect(rec.attemptId).toBe(attempt.id);
      expect(rec.graphRevision).toBe(run.graphRevision);
      expect(rec.workspaceRevision).toMatch(/^content:sha256:[0-9a-f]{64}$/);
      expect(rec.validatorIdentity).not.toBe(rec.executorIdentity);
      expect(Array.isArray(rec.limitations)).toBe(true);
      for (const art of rec.artifacts) {
        expect(art.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
      // Persisted in store under GOAL_STORE_KEYS.evidence
      const stored = await store.get<EvidenceRecord>(GOAL_STORE_KEYS.evidence(run.runId, rec.id));
      expect(stored?.id).toBe(rec.id);
    }

    const decision = service.gate({ run, target, attempt, evidence });
    expect(decision.decision).toBe('completed');
    expect(decision.perCriterion).toHaveLength(2);
    expect(decision.perCriterion.every((c) => c.verdict === 'PASS' && c.evidenceIds.length > 0)).toBe(true);

    // Also test adversarial reviewer raising a FAIL objection overrides deterministic PASS and forces repair
    const failingReviewer: AdversarialReviewer = {
      identity: 'reviewer:red-team-v1',
      async review() {
        return {
          findings: [
            {
              criterion: '#1',
              verdict: 'FAIL',
              objection: 'Trust boundary omits network replay channel',
              reproduction: 'Send duplicate frame seq=1',
            },
          ],
        };
      },
    };
    const attempt2 = makeAttempt({ id: 'attempt-2', attempt: 2 });
    const run2 = makeRun({
      targets: {
        'Y1.1': {
          targetId: 'Y1.1',
          status: 'verifying',
          attempts: 2,
          repairs: 0,
          lastAttemptId: 'attempt-2',
          evidenceIds: [],
          blockers: [],
          updatedAt: '2026-10-22T18:10:00.000Z',
        },
      },
    });
    const serviceWithObjection = createVerificationService({
      store,
      workspaceRoot: tmpDir,
      clock,
      checks: mockRunner,
      reviewer: failingReviewer,
    });
    const ev2 = await serviceWithObjection.verify({
      run: run2,
      target,
      attempt: attempt2,
      workspaceRoot: tmpDir,
      executorIdentity: 'executor:axiomatize-agent',
    });
    const decision2 = serviceWithObjection.gate({ run: run2, target, attempt: attempt2, evidence: ev2 });
    expect(decision2.decision).toBe('repair');
    expect(decision2.perCriterion[0]?.verdict).toBe('FAIL');
  });

  it('exposes HTTP routes in verificationRoutes with viewer/operator RBAC and 503 degradation', async () => {
    await fs.writeFile(path.join(tmpDir, 'scope.md'), 'Trust boundary explicit');
    await fs.writeFile(path.join(tmpDir, 'formal-claim.md'), 'Counterexample documented');

    const auth = new ApiAuth({
      operatorToken: 'op-secret-token',
      viewerToken: 'view-secret-token',
      allowUnauthenticated: false,
      store,
    });
    const service = createVerificationService({ store, workspaceRoot: tmpDir, clock });
    const run = makeRun();
    const target = makeTarget({
      externalDependency: true,
      checks: [
        { id: 'c1', kind: 'contains', artifact: 'scope.md', pattern: 'Trust boundary', criterion: '#1' },
        { id: 'c2', kind: 'contains', artifact: 'formal-claim.md', pattern: 'Counterexample', criterion: '#2' },
      ],
    });
    const attempt = makeAttempt();

    const app = express();
    app.use(express.json());
    registerVerificationRoutes(app, {
      auth,
      store,
      services: { verification: service },
    });

    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/api/v1/goal-studio`;

    try {
      // 1. Unauthenticated GET is rejected with 401
      const unauthRes = await fetch(`${baseUrl}/runs/run-1/evidence`);
      expect(unauthRes.status).toBe(401);

      // 2. Viewer token cannot POST verify (403)
      const viewerPost = await fetch(`${baseUrl}/runs/run-1/targets/Y1.1/verify`, {
        method: 'POST',
        headers: { Authorization: 'Bearer view-secret-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ run, target, attempt, workspaceRoot: tmpDir, executorIdentity: 'executor:worker-1' }),
      });
      expect(viewerPost.status).toBe(403);

      // 3. Operator token POSTs verify -> returns evidence + gate (awaiting_external)
      const opVerify = await fetch(`${baseUrl}/runs/run-1/targets/Y1.1/verify`, {
        method: 'POST',
        headers: { Authorization: 'Bearer op-secret-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ run, target, attempt, workspaceRoot: tmpDir, executorIdentity: 'executor:worker-1' }),
      });
      expect(opVerify.status).toBe(200);
      const verifyBody = (await opVerify.json()) as { evidence: EvidenceRecord[]; gate: { decision: string } };
      expect(verifyBody.gate.decision).toBe('awaiting_external');
      expect(verifyBody.evidence.length).toBeGreaterThanOrEqual(4);

      // 4. Viewer token CAN read GET /runs/:runId/evidence and GET /runs/:runId/targets/:targetId/evidence
      const viewerGetRun = await fetch(`${baseUrl}/runs/run-1/evidence`, {
        headers: { Authorization: 'Bearer view-secret-token' },
      });
      expect(viewerGetRun.status).toBe(200);
      const runEvBody = (await viewerGetRun.json()) as { evidence: EvidenceRecord[] };
      expect(runEvBody.evidence.length).toBe(verifyBody.evidence.length);

      const viewerGetTarget = await fetch(`${baseUrl}/runs/run-1/targets/Y1.1/evidence`, {
        headers: { Authorization: 'Bearer view-secret-token' },
      });
      expect(viewerGetTarget.status).toBe(200);

      // 5. Operator posts external-evidence
      const opExt = await fetch(`${baseUrl}/runs/run-1/targets/Y1.1/external-evidence`, {
        method: 'POST',
        headers: { Authorization: 'Bearer op-secret-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'external-record',
          verdict: 'PASS',
          source: 'https://doi.org/10.1000/verified',
          note: 'External DOI record confirmed',
        }),
      });
      expect(opExt.status).toBe(201);
      const extBody = (await opExt.json()) as { evidence: EvidenceRecord[] };
      expect(extBody.evidence[0]?.validationMethod).toBe('external-record');
      expect(extBody.evidence[0]?.validatorIdentity).toBe('user:operator');
    } finally {
      server.close();
    }
  });

  it('covers helper edge cases (resolveCriterion and validateSchema)', () => {
    const target = makeTarget();
    expect(resolveCriterion(target, '#1')).toBe(target.acceptance[0]);
    expect(resolveCriterion(target, '#99')).toBeUndefined();
    expect(resolveCriterion(target, target.acceptance[1])).toBe(target.acceptance[1]);
    expect(resolveCriterion(target, 'non-existent')).toBeUndefined();

    expect(validateSchema({ a: 1 }, { type: 'object', additionalProperties: false, properties: { a: { type: 'integer', minimum: 0, maximum: 10 } } }).verdict).toBe('PASS');
    expect(validateSchema({ a: 1, extra: true }, { type: 'object', additionalProperties: false, properties: { a: { type: 'integer' } } }).verdict).toBe('FAIL');
  });
});
