import { describe, it, expect, beforeEach } from 'vitest';
import {
  VerificationEngine,
  BuildOracle,
  TestOracle,
  StaticOracle,
  AcceptanceOracle,
  type CommandRunner,
} from '../src/index.js';

describe('VerificationEngine & Deterministic Verification', () => {
  let engine: VerificationEngine;
  const projectRoot = '/mock/repo';

  beforeEach(() => {
    engine = new VerificationEngine({
      projectRoot,
      protectedFiles: ['fixtures/golden.json', 'tests/protected.test.ts'],
    });
  });

  describe('Workspace Revision Progression', () => {
    it('successful mutation increments revision: R -> R+1', () => {
      expect(engine.getRevision()).toBe(0);

      // Edit 1: change bytes
      const outcome1 = engine.trackPhysicalMutation({
        filePath: 'src/main.ts',
        beforeContent: 'const a = 1;',
        afterContent: 'const a = 2;',
      });
      expect(outcome1.mutated).toBe(true);
      expect(outcome1.previousRevision).toBe(0);
      expect(outcome1.newRevision).toBe(1);
      expect(engine.getRevision()).toBe(1);

      // Edit 2: write new file
      const outcome2 = engine.trackPhysicalMutation({
        filePath: 'src/util.ts',
        beforeContent: null,
        afterContent: 'export const util = 42;',
      });
      expect(outcome2.mutated).toBe(true);
      expect(outcome2.newRevision).toBe(2);
      expect(engine.getRevision()).toBe(2);

      // Edit 3: delete file
      const outcome3 = engine.trackPhysicalMutation({
        filePath: 'src/old.ts',
        beforeContent: 'legacy code',
        afterContent: null,
      });
      expect(outcome3.mutated).toBe(true);
      expect(outcome3.newRevision).toBe(3);
      expect(engine.getRevision()).toBe(3);
    });

    it('failed edit does not increment revision: R remains R', () => {
      expect(engine.getRevision()).toBe(0);

      // Null before and null after
      const outcome = engine.trackPhysicalMutation({
        filePath: 'src/missing.ts',
        beforeContent: null,
        afterContent: null,
      });
      expect(outcome.mutated).toBe(false);
      expect(outcome.newRevision).toBe(0);
      expect(engine.getRevision()).toBe(0);
    });

    it('no-op edit does not increment revision: R remains R', () => {
      // Advance to R=1
      engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'initial',
        afterContent: 'updated',
      });
      expect(engine.getRevision()).toBe(1);

      // No-op edit: tool ran, but bytes are identical
      const outcome = engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'updated',
        afterContent: 'updated',
      });
      expect(outcome.mutated).toBe(false);
      expect(outcome.previousRevision).toBe(1);
      expect(outcome.newRevision).toBe(1);
      expect(engine.getRevision()).toBe(1);
    });
  });

  describe('Verification Evidence & Stale Invalidation', () => {
    it('successful test binds to current revision', () => {
      engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'v1',
        afterContent: 'v2',
      });
      expect(engine.getRevision()).toBe(1);

      const evidence = engine.recordEvidence({
        oracle: 'TEST',
        command: 'vitest run',
        exitCode: 0,
        output: '3 tests passed',
      });

      expect(evidence.workspaceRevision).toBe(1);
      expect(evidence.status).toBe('PASS');
      expect(evidence.evidenceHash).toBeDefined();

      const activeSet = engine.getActiveVerificationSet();
      expect(activeSet.workspaceRevision).toBe(1);
      expect(activeSet.evidence).toHaveLength(1);
      expect(activeSet.evidence[0].id).toBe(evidence.id);
    });

    it('subsequent mutation invalidates previous evidence', () => {
      // Revision 1
      engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'v1',
        afterContent: 'v2',
      });
      engine.recordEvidence({
        oracle: 'TEST',
        command: 'vitest run',
        exitCode: 0,
      });

      expect(engine.getActiveVerificationSet().evidence).toHaveLength(1);

      // Mutation: R1 -> R2
      const outcome = engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'v2',
        afterContent: 'v3',
      });
      expect(outcome.newRevision).toBe(2);
      expect(outcome.invalidatedEvidenceCount).toBe(1);

      // Active verification set for R2 has no valid evidence
      const activeSetR2 = engine.getActiveVerificationSet();
      expect(activeSetR2.workspaceRevision).toBe(2);
      expect(activeSetR2.evidence).toHaveLength(0);
    });

    it('old evidence cannot complete new revision', () => {
      // Revision 1 with passing test
      engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'v1',
        afterContent: 'v2',
      });
      engine.recordEvidence({
        oracle: 'TEST',
        exitCode: 0,
      });

      // Subsequent mutation to Revision 2
      engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'v2',
        afterContent: 'v3',
      });

      // Attempt to verify completion at R=2
      const evalResult = engine.verifyCompletion({
        requiredOracles: ['TEST'],
      });

      expect(evalResult.complete).toBe(false);
      expect(evalResult.reasons.some((r) => r.includes('TEST_EVIDENCE_STALE'))).toBe(true);
      expect(evalResult.missingOracles).toContain('TEST');
    });

    it('failed build prevents completion', () => {
      engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'v1',
        afterContent: 'v2',
      });

      engine.recordEvidence({
        oracle: 'BUILD',
        exitCode: 1,
        output: 'SyntaxError on line 12',
      });

      const evalResult = engine.verifyCompletion({
        requiredOracles: ['BUILD'],
      });

      expect(evalResult.complete).toBe(false);
      expect(evalResult.reasons.some((r) => r.includes('BUILD_FAILED'))).toBe(true);
    });

    it('failed test prevents completion', () => {
      engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'v1',
        afterContent: 'v2',
      });

      engine.recordEvidence({
        oracle: 'TEST',
        exitCode: 1,
        output: 'Expected 2 to be 3',
      });

      const evalResult = engine.verifyCompletion({
        requiredOracles: ['TEST'],
      });

      expect(evalResult.complete).toBe(false);
      expect(evalResult.reasons.some((r) => r.includes('TEST_FAILED'))).toBe(true);
    });

    it('model prose cannot create evidence', () => {
      // Agent mutates workspace
      engine.trackPhysicalMutation({
        filePath: 'src/index.ts',
        beforeContent: 'v1',
        afterContent: 'v2',
      });

      // Model claims in chat: "I ran all tests and builds, everything passed 100%!"
      // Notice: NO recordEvidence was called by the controller!
      const evalResult = engine.verifyCompletion({
        requiredOracles: ['TEST', 'BUILD'],
      });

      expect(evalResult.complete).toBe(false);
      expect(evalResult.reasons.some((r) => r.includes('NO_TEST_EVIDENCE'))).toBe(true);
      expect(evalResult.reasons.some((r) => r.includes('NO_BUILD_EVIDENCE'))).toBe(true);
    });
  });

  describe('Anti-Test-Theater Protections', () => {
    it('detects unpermitted test skipping and assertion removal', () => {
      const suite = `
        describe('sort', () => {
          it('sorts numbers', () => {
            expect(sort([3, 1, 2])).toEqual([1, 2, 3]);
          });
        });
      `;

      const weakenedSuite = `
        describe('sort', () => {
          it.skip('sorts numbers', () => {
            expect(true).toBe(true);
          });
        });
      `;

      const outcome = engine.trackPhysicalMutation({
        filePath: 'packages/core/tests/sort.test.ts',
        beforeContent: suite,
        afterContent: weakenedSuite,
      });

      expect(outcome.weakeningDetected).toBe(true);

      // Even if tests "pass" because they were skipped:
      engine.recordEvidence({
        oracle: 'TEST',
        exitCode: 0,
        output: '1 skipped, 0 failed',
      });

      const evalResult = engine.verifyCompletion({
        requiredOracles: ['TEST'],
      });

      expect(evalResult.complete).toBe(false);
      expect(evalResult.reasons.some((r) => r.includes('ANTI_TEST_THEATER_DETECTED'))).toBe(true);
    });

    it('detects modifying protected fixtures or files', () => {
      const outcome = engine.trackPhysicalMutation({
        filePath: 'fixtures/golden.json',
        beforeContent: '{"expected": [1, 2, 3]}',
        afterContent: '{"expected": [3, 2, 1]}',
      });

      expect(outcome.weakeningDetected).toBe(true);

      const evalResult = engine.verifyCompletion({
        requiredOracles: [],
      });

      expect(evalResult.complete).toBe(false);
      expect(evalResult.reasons.some((r) => r.includes('PROTECTED_FIXTURE_MODIFIED'))).toBe(true);
    });
  });

  describe('Golden Path Completion', () => {
    it('completes when physical mutation and all required oracles succeed on current revision', async () => {
      const mockRunner: CommandRunner = async (cmd) => {
        if (cmd.includes('build')) return { exitCode: 0, stdout: 'Build OK', stderr: '' };
        if (cmd.includes('test')) return { exitCode: 0, stdout: 'All 15 tests passed', stderr: '' };
        if (cmd.includes('typecheck')) return { exitCode: 0, stdout: 'Typecheck OK', stderr: '' };
        return { exitCode: 0, stdout: 'OK', stderr: '' };
      };

      engine.registerOracle(new BuildOracle('npm run build', mockRunner));
      engine.registerOracle(new TestOracle('npm test', mockRunner));
      engine.registerOracle(new StaticOracle('npm run typecheck', mockRunner));

      // 1. Legitimate physical mutation
      const mutation = engine.trackPhysicalMutation({
        filePath: 'src/sort.ts',
        beforeContent: 'export function sort(arr) { return arr; }',
        afterContent: 'export function sort(arr) { return arr.slice().sort((a,b)=>a-b); }',
      });
      expect(mutation.mutated).toBe(true);
      expect(mutation.newRevision).toBe(1);

      // 2. Run required build at R=1
      const buildEv = await engine.runOracle('BUILD');
      expect(buildEv.workspaceRevision).toBe(1);
      expect(buildEv.status).toBe('PASS');

      // 3. Run required test at R=1
      const testEv = await engine.runOracle('TEST');
      expect(testEv.workspaceRevision).toBe(1);
      expect(testEv.status).toBe('PASS');

      // 4. Verify completion
      const evalResult = engine.verifyCompletion({
        mutationRequired: true,
        expectedFiles: ['src/sort.ts'],
        requiredOracles: ['BUILD', 'TEST'],
      });

      expect(evalResult.complete).toBe(true);
      expect(evalResult.workspaceRevision).toBe(1);
      expect(evalResult.satisfiedOracles).toEqual(['BUILD', 'TEST']);
      expect(evalResult.reasons.some((r) => r.includes('VERIFICATION_COMPLETE'))).toBe(true);
    });
  });
});
