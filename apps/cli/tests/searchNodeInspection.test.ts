import { describe, it, expect } from 'vitest';
import {
  assembleSearchNodeInspection,
  SearchNodeInspection,
} from '@wazir/core';
import { renderSearchNodeInspection } from '../src/tui/observabilityViews.js';

describe('Search Node Inspection & Evidence Rendering (Worker 2)', () => {
  // 1. Verified Node
  it('scenario 1: verified node — displays verified state, build pass, tests 17/17, and verify PASS', () => {
    const inspection = assembleSearchNodeInspection({
      nodeId: 'A1',
      candidate: {
        candidateId: 'A1',
        modelId: 'claude-3-5-sonnet',
        workerId: 'DGX-01',
        status: 'completed',
        evaluation: {
          qualifies: true,
          buildPassed: true,
          testsPassed: true,
          testSummary: '17/17 passed',
          verificationPassed: true,
          isParetoFrontier: true,
        },
      } as any,
    });

    expect(inspection.nodeId).toBe('A1');
    expect(inspection.state).toBe('VERIFIED');
    expect(inspection.verification?.buildStatus).toBe('PASS');
    expect(inspection.verification?.testsStatus).toBe('PASS');
    expect(inspection.verification?.testSummary).toBe('17/17 passed');
    expect(inspection.verification?.verifyStatus).toBe('PASS');
    expect(inspection.search?.paretoMembership).toBe('FRONTIER');

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('NODE A1');
    expect(rendered).toContain('State:       VERIFIED');
    expect(rendered).toContain('Build       PASS');
    expect(rendered).toContain('Tests       17/17 passed');
    expect(rendered).toContain('Acceptance  PASS');
    expect(rendered).toContain('Verify      PASS');
    expect(rendered).toContain('● FRONTIER');
  });

  // 2. Failed Node
  it('scenario 2: failed node — displays failed state, build fail, and failed tests', () => {
    const inspection = assembleSearchNodeInspection({
      nodeId: 'A2',
      candidate: {
        candidateId: 'A2',
        modelId: 'qwen-2.5-coder-32b',
        workerId: 'MAC-01',
        status: 'failed',
        evaluation: {
          qualifies: false,
          buildPassed: false,
          testsPassed: false,
          testSummary: 'build error: TS2345',
          verificationPassed: false,
          isDominated: true,
        },
      } as any,
    });

    expect(inspection.state).toBe('FAILED');
    expect(inspection.verification?.buildStatus).toBe('FAIL');
    expect(inspection.verification?.testsStatus).toBe('FAIL');
    expect(inspection.verification?.verifyStatus).toBe('FAIL');

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('NODE A2');
    expect(rendered).toContain('State:       FAILED');
    expect(rendered).toContain('Build       FAIL');
    expect(rendered).toContain('Verify      FAIL');
  });

  // 3. Pruned Node
  it('scenario 3: pruned node — displays pruned state, prune reason, and dominated Pareto membership', () => {
    const inspection = assembleSearchNodeInspection({
      nodeId: 'C3',
      candidate: {
        candidateId: 'C3',
        modelId: 'qwen-2.5-coder-32b',
        status: 'pruned',
        evaluation: {
          qualifies: false,
          isDominated: true,
          isParetoFrontier: false,
          disqualificationReasons: ['Dominated by candidate A1 on tokens and wallTime'],
        },
      } as any,
    });

    expect(inspection.state).toBe('PRUNED');
    expect(inspection.search?.paretoMembership).toBe('DOMINATED');

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('NODE C3');
    expect(rendered).toContain('State:       PRUNED');
    expect(rendered).toContain('Pareto membership    DOMINATED');
  });

  // 4. Running Node
  it('scenario 4: running node — displays running state and pending pareto membership', () => {
    const inspection = assembleSearchNodeInspection({
      nodeId: 'B1',
      candidate: {
        candidateId: 'B1',
        modelId: 'claude-3-5-sonnet',
        status: 'running',
      } as any,
    });

    expect(inspection.state).toBe('RUNNING');
    expect(inspection.search?.paretoMembership).toBe('PENDING');

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('NODE B1');
    expect(rendered).toContain('State:       RUNNING');
    expect(rendered).toContain('Pareto membership    PENDING');
  });

  // 5. Node with Physical Diff
  it('scenario 5: node with physical diff — extracts files changed, lines delta, patch digest, and file deltas', () => {
    const mockCheckpointService = {
      getCheckpoint: (id: string) => {
        if (id === 'cp-cur') {
          return {
            checkpointId: 'cp-cur',
            parentCheckpointId: 'cp-parent',
            worktreeState: {
              filesSnapshot: {
                'src/index.ts': 'line1\nline2\nline3\nline4\n',
                'src/new.ts': 'new line\n',
              },
            },
          };
        }
        if (id === 'cp-parent') {
          return {
            checkpointId: 'cp-parent',
            worktreeState: {
              filesSnapshot: {
                'src/index.ts': 'line1\n',
                'src/old.ts': 'old line 1\nold line 2\n',
              },
            },
          };
        }
        return undefined;
      },
    };

    const inspection = assembleSearchNodeInspection({
      nodeId: 'N-diff',
      node: {
        id: 'N-diff',
        checkpointId: 'cp-cur',
      } as any,
      checkpointService: mockCheckpointService as any,
    });

    expect(inspection.changeSummary).toBeDefined();
    expect(inspection.changeSummary?.filesChangedCount).toBe(3); // src/index.ts, src/new.ts, src/old.ts
    expect(inspection.changeSummary?.linesAdded).toBe(4); // index +3, new +1
    expect(inspection.changeSummary?.linesRemoved).toBe(2); // old -2
    expect(inspection.changeSummary?.patchDigest).toBeDefined();
    expect(inspection.changeSummary?.fileDeltas.length).toBeGreaterThan(0);

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('CHANGE SUMMARY');
    expect(rendered).toContain('files changed        3');
    expect(rendered).toContain('lines added/removed  +4, -2');
    expect(rendered).toContain(`patch/diff digest    ${inspection.changeSummary?.patchDigest}`);
  });

  // 6. Node without Diff
  it('scenario 6: node without diff — handles empty mutations / snapshot gracefully without crashing', () => {
    const mockCheckpointService = {
      getCheckpoint: (id: string) => ({
        checkpointId: id,
        parentCheckpointId: undefined,
        worktreeState: { filesSnapshot: {} },
      }),
    };

    const inspection = assembleSearchNodeInspection({
      nodeId: 'N-empty',
      node: {
        id: 'N-empty',
        checkpointId: 'cp-empty',
        mutations: [],
      } as any,
      checkpointService: mockCheckpointService as any,
    });

    expect(inspection.changeSummary).toBeDefined();
    expect(inspection.changeSummary?.filesChangedCount).toBe(0);
    expect(inspection.changeSummary?.linesAdded).toBe(0);
    expect(inspection.changeSummary?.linesRemoved).toBe(0);

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('files changed        0');
    expect(rendered).toContain('lines added/removed  +0, -0');
  });

  // 7. Unknown Metrics
  it('scenario 7: unknown metrics — renders UNKNOWN when metrics are absent, never 0, PASS, or NONE', () => {
    const inspection = assembleSearchNodeInspection({
      nodeId: 'N-minimal',
    });

    expect(inspection.phase).toBeUndefined();
    expect(inspection.modelId).toBeUndefined();
    expect(inspection.checkpointId).toBeUndefined();
    expect(inspection.search?.visits).toBeUndefined();
    expect(inspection.search?.controllerReward).toBeUndefined();

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('Phase:       UNKNOWN');
    expect(rendered).toContain('Model:       UNKNOWN');
    expect(rendered).toContain('Checkpoint:  UNKNOWN');
    expect(rendered).toContain('Revision:    UNKNOWN');
    expect(rendered).toContain('files changed        UNKNOWN');
    expect(rendered).toContain('lines added/removed  UNKNOWN');
    expect(rendered).toContain('patch/diff digest    UNKNOWN');
    expect(rendered).toContain('Visits               UNKNOWN');
    expect(rendered).toContain('Controller reward    UNKNOWN');
    expect(rendered).toContain('UCT components       UNKNOWN');
    expect(rendered).toContain('parent node          UNKNOWN');
    expect(rendered).toContain('checkpoint lineage   UNKNOWN');
    expect(rendered).toContain('execution id         UNKNOWN');
    expect(rendered).toContain('evidence ids         UNKNOWN');

    // Invariant: absent data must NEVER be defaulted to 0, PASS, or NONE
    expect(rendered).not.toContain('Visits               0');
    expect(rendered).not.toContain('Controller reward    0');
    expect(rendered).not.toContain('files changed        0');
    expect(rendered).not.toContain('files changed        NONE');
  });

  // 8. Checkpoint Lineage
  it('scenario 8: checkpoint lineage — traverses parent checkpoints up to bounded depth', () => {
    const checkpoints: Record<string, any> = {
      cp2: { checkpointId: 'cp2', parentCheckpointId: 'cp1' },
      cp1: { checkpointId: 'cp1', parentCheckpointId: 'cp0' },
      cp0: { checkpointId: 'cp0' },
    };

    const mockCheckpointService = {
      getCheckpoint: (id: string) => checkpoints[id],
    };

    const inspection = assembleSearchNodeInspection({
      nodeId: 'N-lineage',
      candidate: {
        candidateId: 'N-lineage',
        checkpointId: 'cp2',
      } as any,
      checkpointService: mockCheckpointService as any,
    });

    expect(inspection.provenance?.checkpointLineage).toBe('cp2 -> cp1 -> cp0');

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('checkpoint lineage   cp2 -> cp1 -> cp0');
  });

  // 9. Verification Evidence
  it('scenario 9: verification evidence — surfaces commands, exit codes, and asserts MODEL CLAIM != EXECUTION EVIDENCE', () => {
    const inspection = assembleSearchNodeInspection({
      nodeId: 'N-evidence',
      candidate: {
        candidateId: 'N-evidence',
        checks: [
          { name: 'typescript-compile', ok: true, exitCode: 0, command: 'tsc --build' },
          { name: 'unit-tests', ok: true, exitCode: 0, command: 'vitest run' },
        ],
      } as any,
    });

    expect(inspection.physicalEvidence?.buildCommand).toBe('tsc --build');
    expect(inspection.physicalEvidence?.buildExitCode).toBe(0);
    expect(inspection.physicalEvidence?.testCommand).toBe('vitest run');
    expect(inspection.physicalEvidence?.testExitCode).toBe(0);
    expect(inspection.physicalEvidence?.oracleResults).toHaveLength(2);

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('PHYSICAL EVIDENCE');
    expect(rendered).toContain('Build: Exit 0 (PASS) - tsc --build');
    expect(rendered).toContain('Tests: Exit 0 (PASS) - vitest run');
    expect(rendered).toContain('typescript-compile (exit 0)');
    expect(rendered).toContain('unit-tests (exit 0)');
    expect(rendered).toContain('MODEL CLAIM != EXECUTION EVIDENCE');
  });

  // 10. Large Output Truncation
  it('scenario 10: large output truncation — truncates command outputs exceeding 500 chars with exact truncated count', () => {
    const bigOutput = 'A'.repeat(2500);
    const inspection = assembleSearchNodeInspection({
      nodeId: 'N-trunc',
      candidate: {
        candidateId: 'N-trunc',
        checks: [
          {
            name: 'verbose-build',
            ok: false,
            exitCode: 1,
            command: 'cargo build',
            output: bigOutput,
          },
        ],
      } as any,
    });

    expect(inspection.physicalEvidence?.buildOutput).toBeDefined();
    expect(inspection.physicalEvidence!.buildOutput!.length).toBeLessThan(600);
    expect(inspection.physicalEvidence?.buildOutput).toContain('... [truncated 2000 chars]');

    const rendered = renderSearchNodeInspection(inspection).join('\n');
    expect(rendered).toContain('... [truncated 2000 chars]');
  });
});
