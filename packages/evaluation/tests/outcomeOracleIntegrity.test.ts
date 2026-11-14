import { describe, expect, it } from 'vitest';
import type { VerificationEvidence } from '@wazir/core';
import { verifier } from '../src/index.js';

const receipt = (overrides: Partial<VerificationEvidence> = {}): VerificationEvidence => ({
  id: 'receipt-1',
  revision: 2,
  type: 'TEST',
  command: 'npm test',
  exitCode: 0,
  status: 'PASS',
  ...overrides,
});

const verify = (evidence: VerificationEvidence[]) => verifier.verify({
  workspaceRevision: 2,
  acceptanceContract: { requiredEvidence: ['TEST'] },
  evidence,
});

describe('Outcome oracle receipt integrity', () => {
  it.each([
    ['missing execution proof', []],
    ['stale receipt', [receipt({ revision: 1 })]],
    ['nonzero exit despite PASS', [receipt({ exitCode: 1 })]],
    ['failed status despite zero exit', [receipt({ status: 'FAIL' })]],
    ['error status despite zero exit', [receipt({ status: 'ERROR' })]],
    ['explicit self-report', [receipt({ metadata: { selfReported: true } })]],
    ['executor validating itself', [receipt({ metadata: { executorIdentity: 'agent', validatorIdentity: 'agent' } })]],
    ['wrong oracle', [receipt({ type: 'BUILD' })]],
  ] as const)('rejects %s', (_name, evidence) => {
    expect(verify([...evidence]).passed).toBe(false);
  });

  it('uses receipt order so a later failed retry invalidates an earlier pass', () => {
    const pass = receipt();
    const fail = receipt({ id: 'receipt-2', exitCode: 1, status: 'FAIL' });
    expect(verify([pass, fail]).passed).toBe(false);
    expect(verify([fail, pass]).passed).toBe(true);
  });

  it('does not let an unrelated passing command erase a failed check', () => {
    const fail = receipt({ exitCode: 1, status: 'FAIL' });
    const unrelated = receipt({ id: 'receipt-2', command: 'npm run smoke' });
    expect(verify([fail, unrelated]).passed).toBe(false);
  });

  it('accepts independent passing evidence at the current revision', () => {
    expect(verify([receipt({ metadata: { executorIdentity: 'agent', validatorIdentity: 'test-runner' } })]).passed).toBe(true);
  });
});
