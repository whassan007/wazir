import { describe, expect, it } from 'vitest';
import { ExecutionEngine, inspectVerificationEvidence, explainCompletion } from '@wazir/core';
import { renderEvidenceView, formatVerificationInspection } from '../src/tui/observabilityViews.js';
import { evidenceCommand } from '../src/commands.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
const mut = (a: string, b: string) => ({ path: 'src/a.ts', attempted: true, succeeded: true, existedBefore: true, existsAfter: true, beforeHash: a, afterHash: b, changed: true });

async function staleRecord() {
  const engine = new ExecutionEngine();
  const { execution } = await engine.create({
    task: { id: 't', type: 'coding', input: 'x', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date(), acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] } },
    computerId: 'local', runtimeId: 'r', modelId: 'm',
  } as any);
  const id = execution.id;
  await engine.recordFileMutations(id, [mut('a'.repeat(64), 'b'.repeat(64))]);
  await engine.recordEvidence(id, { type: 'BUILD', revision: 1, command: 'npm run build', exitCode: 0 } as any);
  await engine.recordEvidence(id, { type: 'TEST', revision: 1, command: 'npm test', exitCode: 0 } as any);
  await engine.recordFileMutations(id, [mut('b'.repeat(64), 'c'.repeat(64))]);
  return { engine, id };
}

describe('verification evidence view', () => {
  it('never renders stale PASS as current; shows why incomplete', async () => {
    const { engine, id } = await staleRecord();
    const inspection = inspectVerificationEvidence(engine.require(id));
    const text = strip(formatVerificationInspection(inspection, explainCompletion(inspection)).join('\n'));
    expect(text).not.toMatch(/Status\s+PASS/);
    expect(text.match(/STALE — NOT VALID FOR COMPLETION/g)).toHaveLength(2);
    expect(text).toContain('recorded PASS at R1; current revision R2');
    expect(text).toMatch(/Eligible\s+NO/);
    expect(text).toContain('why incomplete?');
    expect(text).toContain('R2    src/a.ts  bbbbbbbbbbbb → cccccccccccc  AFTER VERIFICATION');
  });

  it('renders within width at narrow and wide terminals', async () => {
    const { engine, id } = await staleRecord();
    const inspection = inspectVerificationEvidence(engine.require(id));
    for (const width of [40, 80, 160]) {
      const lines = renderEvidenceView({ inspection, why: explainCompletion(inspection), provenanceDepth: 9, width, maxRows: 60 });
      expect(lines).toHaveLength(60);
      for (const l of lines) expect(strip(l).length).toBeLessThanOrEqual(width);
    }
  });

  it('with no record, states nothing is verified', () => {
    const text = strip(renderEvidenceView({ width: 80, maxRows: 10 }).join('\n'));
    expect(text).toContain('No execution record selected');
    expect(text).not.toContain('PASS');
  });

  it('wa evidence command: text and JSON, unknown execution exits 1', async () => {
    const { engine, id } = await staleRecord();
    const fake = { executions: engine, provenance: { getArtifactsByExecution: async () => [] } } as any;
    const text = await evidenceCommand(fake, id);
    expect(text.code).toBe(0);
    expect(strip(text.output)).toContain('STALE — NOT VALID FOR COMPLETION');
    const json = JSON.parse((await evidenceCommand(fake, id, { json: true })).output);
    expect(json.why.complete).toBe(false);
    expect(json.inspection.completion.missing).toEqual(['BUILD', 'TEST']);
    expect((await evidenceCommand(fake, 'exec-nope')).code).toBe(1);
  });
});
