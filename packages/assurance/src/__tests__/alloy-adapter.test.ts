import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AlloyAdapter, AlloyReceipt, interpretAlloyReceipt } from '../adapters/alloy';
import { Obligation, Verdict } from '../contracts';

const REPO_ROOT = resolve(__dirname, '../../../..');
const JAR =
  process.env.ALLOY_JAR ??
  [resolve(REPO_ROOT, 'tools/alloy/org.alloytools.alloy.dist.jar'), '/Users/wael/Code/Wazir/tools/alloy/org.alloytools.alloy.dist.jar'].find(
    (p) => existsSync(p),
  );
const SELF_APPROVAL_CEX = resolve(REPO_ROOT, 'skills/formal/alloy/examples/self-approval-counterexample.als');

function obligation(artifactPath: string, extra: Partial<Obligation> = {}): Obligation {
  return {
    id: 'obl-1',
    propertyId: 'P-test',
    specVersion: '1.0',
    specHash: 'sha256:00',
    tool: 'alloy',
    artifactPath,
    assumptions: ['facts'],
    guarantee: 'assertion holds',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Fixtures (shape captured from Alloy 6.2.0 receipt.json)
// ---------------------------------------------------------------------------

const sat = [{ duration: 3, instances: [{ values: { 'A$0': { r: [] } } }] }];

function receipt(...cmds: Array<{ name: string; type: string; solved: boolean; expects?: number; maxprefix?: number }>): AlloyReceipt {
  return {
    solver: 'sat4j',
    commands: Object.fromEntries(
      cmds.map((c) => [
        c.name,
        {
          name: c.name,
          type: c.type,
          source: `${c.type} ${c.name} for 3`,
          bitwidth: 4,
          overall: 3,
          expects: c.expects ?? -1,
          maxprefix: c.maxprefix ?? -1,
          ...(c.solved ? { solution: sat } : {}),
        },
      ]),
    ),
  };
}

describe('interpretAlloyReceipt (fixtures)', () => {
  it('UNSAT check + SAT run witness → BOUNDED_PASS (never PROVED)', () => {
    const r = interpretAlloyReceipt(receipt({ name: 'show', type: 'run', solved: true }, { name: 'Safe', type: 'check', solved: false }));
    expect(r.verdict).toBe(Verdict.BOUNDED_PASS);
    expect(r.vacuityProbe?.passed).toBe(true);
    expect(r.intBitwidth).toBe(4);
    expect(r.scope).toContain('check Safe for 3');
  });

  it('SAT check → COUNTEREXAMPLE with instance and trace witness', () => {
    const r = interpretAlloyReceipt(
      receipt({ name: 'show', type: 'run', solved: true }, { name: 'Safe', type: 'check', solved: true }),
      { solutionTexts: { Safe: '---Trace---' } },
    );
    expect(r.verdict).toBe(Verdict.COUNTEREXAMPLE);
    expect(r.witness).toMatchObject({ command: 'Safe', trace: '---Trace---' });
    expect((r.witness as { instance: unknown }).instance).toBeDefined();
  });

  it('UNSAT check + UNSAT run → INCONSISTENT_ASSUMPTIONS', () => {
    const r = interpretAlloyReceipt(receipt({ name: 'show', type: 'run', solved: false }, { name: 'Safe', type: 'check', solved: false }));
    expect(r.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(r.vacuityProbe?.passed).toBe(false);
  });

  it('no run witness at all → INCONSISTENT_ASSUMPTIONS', () => {
    const r = interpretAlloyReceipt(receipt({ name: 'Safe', type: 'check', solved: false }));
    expect(r.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
  });

  it('ignores `expect 0` runs when choosing witnesses', () => {
    const r = interpretAlloyReceipt(
      receipt({ name: 'neg', type: 'run', solved: false, expects: 0 }, { name: 'Safe', type: 'check', solved: false }),
    );
    expect(r.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
  });

  it('designated witness must be SAT even if another run is', () => {
    const rc = receipt(
      { name: 'w1', type: 'run', solved: true },
      { name: 'w2', type: 'run', solved: false },
      { name: 'Safe', type: 'check', solved: false },
    );
    expect(interpretAlloyReceipt(rc).verdict).toBe(Verdict.BOUNDED_PASS);
    expect(interpretAlloyReceipt(rc, { witnessCommands: ['w2'] }).verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(interpretAlloyReceipt(rc, { witnessCommands: ['nope'] }).verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
  });

  it('judges only the targeted check command', () => {
    const rc = receipt(
      { name: 'show', type: 'run', solved: true },
      { name: 'Bad', type: 'check', solved: true },
      { name: 'Good', type: 'check', solved: false },
    );
    expect(interpretAlloyReceipt(rc).verdict).toBe(Verdict.COUNTEREXAMPLE);
    expect(interpretAlloyReceipt(rc, { checkCommands: ['Good'] }).verdict).toBe(Verdict.BOUNDED_PASS);
    expect(interpretAlloyReceipt(rc, { checkCommands: ['Missing'] }).verdict).toBe(Verdict.ERROR);
  });

  it('records temporal steps', () => {
    const r = interpretAlloyReceipt(
      receipt({ name: 'show', type: 'run', solved: true }, { name: 'Safe', type: 'check', solved: false, maxprefix: 6 }),
    );
    expect(r.steps).toBe(6);
  });

  it('model with no check commands → ERROR', () => {
    expect(interpretAlloyReceipt(receipt({ name: 'show', type: 'run', solved: true })).verdict).toBe(Verdict.ERROR);
  });
});

// ---------------------------------------------------------------------------
// NOT_RUN without a real JAR / java
// ---------------------------------------------------------------------------

describe('AlloyAdapter availability', () => {
  it('missing JAR → NOT_RUN', async () => {
    const a = new AlloyAdapter({ jarPath: '/nonexistent/alloy.jar' });
    expect((await a.checkAvailability()).available).toBe(false);
    const r = await a.verify(obligation(SELF_APPROVAL_CEX), 'rev');
    expect(r.verdict).toBe(Verdict.NOT_RUN);
    expect(r.tool).toBe('alloy');
  });

  it.skipIf(!JAR)('missing java → NOT_RUN', async () => {
    const a = new AlloyAdapter({ jarPath: JAR, javaPath: '/nonexistent/java-bin' });
    const r = await a.verify(obligation(SELF_APPROVAL_CEX), 'rev');
    expect(r.verdict).toBe(Verdict.NOT_RUN);
  });
});

// ---------------------------------------------------------------------------
// Real Alloy 6.2.0 execution
// ---------------------------------------------------------------------------

describe.skipIf(!JAR)('AlloyAdapter (real Alloy 6.2.0 JAR)', () => {
  let dir: string;
  const adapter = new AlloyAdapter({ jarPath: JAR });

  const model = (name: string, src: string) => {
    const p = join(dir, name);
    writeFileSync(p, src);
    return p;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'alloy-adapter-test-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reports version 6.2.0', async () => {
    const av = await adapter.checkAvailability();
    expect(av).toMatchObject({ available: true, version: '6.2.0' });
  });

  it('passing model → BOUNDED_PASS with scope and bitwidth', async () => {
    const p = model(
      'pass.als',
      `sig User {}
sig Request { submittedBy: one User, approvedBy: lone User }
fact NoSelf { all r: Request | r.approvedBy != r.submittedBy }
assert NoSelfApproval { all r: Request | some r.approvedBy implies r.submittedBy != r.approvedBy }
run { some Request.approvedBy } for 3
check NoSelfApproval for 3 but 5 Int
`,
    );
    const r = await adapter.verify(obligation(p), 'rev-1');
    expect(r.verdict).toBe(Verdict.BOUNDED_PASS);
    expect(r.vacuityProbe?.passed).toBe(true);
    expect(r.toolVersion).toBe('6.2.0');
    expect(r.scope).toContain('check NoSelfApproval for 3 but 5 Int');
    expect(r.metadata?.intBitwidth).toBe(5);
    expect(r.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.elapsedMs).toBeGreaterThan(0);
  }, 60_000);

  it('self-approval-counterexample.als → COUNTEREXAMPLE with concrete witness', async () => {
    const r = await adapter.verify(obligation(SELF_APPROVAL_CEX), 'rev-1');
    expect(r.verdict).toBe(Verdict.COUNTEREXAMPLE);
    const w = r.witness as { command: string; instance: unknown; trace: string };
    expect(w.command).toBe('NoSelfApproval');
    expect(w.instance).toBeDefined();
    expect(w.trace).toContain('this/Request');
  }, 60_000);

  it('overconstrained (vacuous) model → INCONSISTENT_ASSUMPTIONS', async () => {
    const p = model(
      'vacuous.als',
      `sig A {}
fact { some A }
fact { no A }
assert Anything { some A }
run { some A } for 3
check Anything for 3
`,
    );
    const r = await adapter.verify(obligation(p), 'rev-1');
    expect(r.verdict).toBe(Verdict.INCONSISTENT_ASSUMPTIONS);
    expect(r.vacuityProbe?.passed).toBe(false);
  }, 60_000);

  it('temporal model records steps', async () => {
    const r = await adapter.verify(obligation(resolve(REPO_ROOT, 'skills/formal/alloy/examples/mutex-temporal.als')), 'rev-1');
    expect(r.verdict).toBe(Verdict.BOUNDED_PASS);
    expect(r.metadata?.steps).toBe(6);
  }, 60_000);

  it('syntax error → ERROR', async () => {
    const r = await adapter.verify(obligation(model('bad.als', 'sig A {\nfact { foo }\n')), 'rev-1');
    expect(r.verdict).toBe(Verdict.ERROR);
    expect(String(r.metadata?.reason)).toMatch(/Syntax error/);
  }, 60_000);

  it('type error → ERROR', async () => {
    const r = await adapter.verify(obligation(model('type.als', 'sig A {}\nassert X { some B }\ncheck X\n')), 'rev-1');
    expect(r.verdict).toBe(Verdict.ERROR);
  }, 60_000);

  it('timeout → UNKNOWN', async () => {
    const r = await adapter.verify(obligation(SELF_APPROVAL_CEX), 'rev-1', { timeoutMs: 1 });
    expect(r.verdict).toBe(Verdict.UNKNOWN);
  }, 60_000);
});
