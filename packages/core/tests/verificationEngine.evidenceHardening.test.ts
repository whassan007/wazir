import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '@wazir/shared';
import {
  VerificationEngine,
  AcceptanceOracle,
  ProvenanceManager,
  evidencePassed,
  isSelfReportedEvidence,
  oracleSatisfied,
  inspectVerificationEvidence,
} from '../src/index.js';
import { artifactIdSuffix } from '../src/services/provenanceManager.js';
import type { VerificationEvidence } from '../src/types/verification.js';

function evidence(overrides: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return { id: 'e1', revision: 1, workspaceRevision: 1, oracle: 'TEST', type: 'TEST', exitCode: 0, status: 'PASS', ...overrides };
}

describe('verification evidence hardening (Goal Studio workstream 04)', () => {
  it('detects a binary change whose bytes decode to the same UTF-8 text (stale evidence must not survive)', () => {
    const engine = new VerificationEngine({ projectRoot: '/repo' });
    // 0xff and 0xfe are both invalid UTF-8 and both decode to U+FFFD.
    const before = Buffer.from([0x00, 0xff, 0x01]);
    const after = Buffer.from([0x00, 0xfe, 0x01]);
    expect(before.toString('utf8')).toBe(after.toString('utf8'));
    engine.recordEvidence({ oracle: 'TEST', exitCode: 0 });
    const outcome = engine.trackPhysicalMutation({ filePath: 'asset.bin', beforeContent: before, afterContent: after });
    expect(outcome.mutated).toBe(true);
    expect(outcome.newRevision).toBe(1);
    expect(engine.verifyCompletion({ requiredOracles: ['TEST'] }).complete).toBe(false);
  });

  it('still treats identical bytes as a no-op', () => {
    const engine = new VerificationEngine();
    const outcome = engine.trackPhysicalMutation({ filePath: 'a.txt', beforeContent: Buffer.from('x'), afterContent: 'x' });
    expect(outcome.mutated).toBe(false);
  });

  it('refuses to record evidence for a future workspace revision', () => {
    const engine = new VerificationEngine();
    expect(() => engine.recordEvidence({ oracle: 'TEST', exitCode: 0, workspaceRevision: 1 })).toThrow(/current revision is 0/);
    // Pre-certification would otherwise make the next mutation look verified.
    engine.trackPhysicalMutation({ filePath: 'a.ts', beforeContent: 'a', afterContent: 'b' });
    expect(engine.verifyCompletion({ requiredOracles: ['TEST'] }).complete).toBe(false);
    expect(() => engine.recordEvidence({ oracle: 'TEST', exitCode: 0, workspaceRevision: 0 })).not.toThrow();
  });

  it('never counts self-reported evidence as passing', () => {
    expect(evidencePassed(evidence())).toBe(true);
    for (const metadata of [
      { selfReported: true },
      { validationMethod: 'self-report' },
      { validatorIdentity: 'model:x', executorIdentity: 'model:x' },
    ]) {
      const item = evidence({ metadata });
      expect(isSelfReportedEvidence(item)).toBe(true);
      expect(evidencePassed(item)).toBe(false);
      expect(oracleSatisfied([item], 1, 'TEST')).toBe(false);
    }
    expect(evidencePassed(evidence({ metadata: { validatorIdentity: 'verifier', executorIdentity: 'model:x' } }))).toBe(true);
  });

  it('marks evidence from a revision other than the current one as STALE in the inspector', () => {
    const record: any = {
      execution: { id: 'x1', taskId: 't', status: 'running', agentId: 'a' },
      task: { id: 't' },
      events: [], toolCalls: [], policyDecisions: [], filesChanged: [],
      workspaceState: { revision: 2 },
      evidence: [evidence({ workspaceRevision: 3, revision: 3 })],
    };
    const slot = inspectVerificationEvidence(record, { toolCheckpoints: [] }).slots.find((s) => s.oracle === 'TEST');
    expect(slot?.status).toBe('STALE');
  });

  describe('AcceptanceOracle', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-acc-'));
    fs.writeFileSync(path.join(root, 'present.md'), 'hello world');
    const oracle = new AcceptanceOracle(root);

    it('passes only machine-checkable criteria that hold', async () => {
      const res = await oracle.verify({ metadata: { criteria: ['file_exists:present.md', 'file_contains:present.md::hello'] } });
      expect(res.status).toBe('PASS');
    });

    it('does not PASS unsupported, malformed or empty criteria', async () => {
      for (const criteria of [[], ['All tests pass'], ['file_contains:present.md']]) {
        const res = await oracle.verify({ metadata: { criteria } });
        expect(res.status).not.toBe('PASS');
        expect(res.exitCode).not.toBe(0);
      }
    });

    it('refuses paths outside the workspace', async () => {
      const outside = path.relative(root, path.join(os.tmpdir()));
      const res = await oracle.verify({ metadata: { criteria: [`file_exists:${outside}`, 'file_exists:/etc/hosts'] } });
      expect(res.status).toBe('FAIL');
    });
  });

  it('gives distinct provenance ids to artifacts with prefixed or non-hex hashes', async () => {
    expect(artifactIdSuffix('ab'.repeat(32))).toBe('ab'.repeat(8));
    expect(artifactIdSuffix(`sha256:${'cd'.repeat(32)}`)).toBe('cd'.repeat(8));
    expect(artifactIdSuffix('not-hex-1')).not.toBe(artifactIdSuffix('not-hex-2'));
    const pm = new ProvenanceManager(new MemoryStore());
    const base = { type: 'source', name: 'n', location: 'l', sizeBytes: 1, workspace: 'w', executionId: 'ex', agentId: 'a', modelId: 'm', runtimeId: 'r', computerId: 'c' };
    const a = await pm.registerArtifact({ ...base, contentHash: 'sha256-zz-1' });
    const b = await pm.registerArtifact({ ...base, contentHash: 'sha256-zz-2' });
    expect(a.artifactId).not.toBe(b.artifactId);
  });
});
