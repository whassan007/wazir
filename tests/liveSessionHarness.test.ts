import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Harness deliberately runs without building Wazir or adding runtime dependencies.
// @ts-ignore plain ESM harness
import { scenarios, gates } from '../scripts/live-session-harness/catalog.mjs';
// @ts-ignore plain ESM harness
import { assessRecord, snapshot, changedPaths } from '../scripts/live-session-harness/evidence.mjs';
// @ts-ignore plain ESM harness
import { runProcess, runSession } from '../scripts/live-session-harness/runner.mjs';
// @ts-ignore plain ESM harness
import { createFixture, hiddenOracle } from '../scripts/live-session-harness/fixtures.mjs';

describe('live session qualification harness integrity (not live qualification)', () => {
  it('enumerates all 36 cases without silently omitting unsupported gate members', async () => {
    expect(scenarios).toHaveLength(36);
    expect(new Set(scenarios.map((s: any) => s.id)).size).toBe(36);
    expect(gates['LIVE-SMOKE']).toEqual([1, 2, 3, 5, 16]);
    const result = await runSession(scenarios[17], { model: 'not-called' });
    expect(result.status).toBe('BLOCKED');
    expect(result.metrics.model_calls).toBeNull();
    expect(result.faults.every((f: any) => !f.fired)).toBe(true);
  });

  it('rejects stale verification, dishonest file claims and duplicate completion', () => {
    const before = { 'src/a.cpp': { hash: 'a' } }, after = { 'src/a.cpp': { hash: 'b' } };
    const record = {
      execution: { id: 'e', status: 'completed' }, workspaceState: { revision: 2 },
      evaluation: { success: true, workspaceRevision: 2, filesChanged: ['src/a.cpp'] },
      checks: ['build', 'test'].map(name => ({ name, ok: true, workspaceRevision: 2 })),
      events: [
        { type: 'generation.started', eventId: 'event', executionId: 'e', sequence: 1 },
        { type: 'tool.started', eventId: 'start', executionId: 'e', sequence: 2, callId: 'call' },
        { type: 'tool.completed', eventId: 'end', executionId: 'e', sequence: 3, callId: 'call' },
      ],
      toolCalls: [{ callId: 'call', tool: 'write', ok: true }],
    };
    const args = { before, after, executionId: 'e', completeEvents: 1 };
    expect(assessRecord(record, args).failures).toEqual([]);
    record.checks[1].workspaceRevision = 1;
    expect(assessRecord(record, args).failures).toContain('verification_success');
    record.evaluation.filesChanged = ['imaginary.cpp'];
    expect(assessRecord(record, args).failures).toContain('final_claim_matches_filesystem');
    expect(assessRecord(record, { ...args, completeEvents: 2 }).failures).toContain('provenance_complete');
    expect(assessRecord(undefined, args).failures).not.toHaveLength(0);
  });

  it('correlates production id fields and requires denied calls never to dispatch', () => {
    const record = {
      execution: { id: 'e', status: 'completed' }, workspaceState: { revision: 1 },
      evaluation: { success: true, workspaceRevision: 1, filesChanged: ['a'] },
      checks: ['build', 'test'].map(name => ({ name, ok: true, workspaceRevision: 1 })),
      events: [
        { type: 'generation.started', eventId: 'g', executionId: 'e', sequence: 1 },
        { type: 'tool.completed', eventId: 'd', executionId: 'e', sequence: 2, callId: 'denied' },
      ],
      toolCalls: [{ id: 'denied', tool: 'shell', ok: false, policyEffect: 'deny' }],
    };
    const args = { before: { a: { hash: 'old' } }, after: { a: { hash: 'new' } }, executionId: 'e', completeEvents: 1 };
    expect(assessRecord(record, args).metrics.provenance_complete).toBe(true);
    record.events.push({ type: 'tool.started', eventId: 's', executionId: 'e', sequence: 3, callId: 'denied' });
    expect(assessRecord(record, args).metrics.provenance_complete).toBe(false);
  });

  it('runs real compilers and detects the hidden implementation defect externally', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-harness-test-'));
    const workspace = path.join(root, 'repo');
    await fs.mkdir(workspace);
    try {
      await createFixture(workspace, 'average');
      const before = await snapshot(workspace);
      expect((await runProcess('node', ['build.cjs'], { cwd: workspace })).code).toBe(0);
      expect((await runProcess('node', ['test.cjs'], { cwd: workspace })).code).not.toBe(0);
      const oracle = path.join(root, 'oracle.cpp'), binary = path.join(root, 'oracle');
      await fs.writeFile(oracle, hiddenOracle);
      const verify = async () => {
        expect((await runProcess('g++', ['-std=c++17', '-I', path.join(workspace, 'src'), path.join(workspace, 'src/average.cpp'), oracle, '-o', binary])).code).toBe(0);
        return runProcess(binary, [], { cwd: root });
      };
      expect((await verify()).code).not.toBe(0);
      const source = path.join(workspace, 'src/average.cpp');
      await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace('values.size() - 1', 'values.size()'));
      expect((await verify()).code).toBe(0);
      expect(changedPaths(before, await snapshot(workspace))).toEqual(['src/average.cpp']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 30000);

  it('reveals the next compiler failure after repairing the first', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-compile-test-'));
    try {
      await createFixture(root, 'compile');
      const first = await runProcess('node', ['build.cjs'], { cwd: root });
      expect(first.code).not.toBe(0);
      expect(first.output).toContain('totl');
      const source = path.join(root, 'src/average.cpp');
      await fs.writeFile(source, (await fs.readFile(source, 'utf8')).replace('totl', 'total'));
      const second = await runProcess('node', ['build.cjs'], { cwd: root });
      expect(second.code).not.toBe(0);
      expect(second.output).toContain('cout');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 30000);

  it('bounds hanging processes and excessive tool output', async () => {
    const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { timeoutMs: 200 });
    expect(timeout.timedOut).toBe(true);
    const flood = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBytes: 1000 });
    expect(flood.outputLimit).toBe(true);
  });

  it('makes unsupported selections fail the aggregate gate without invoking a model', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-blocked-test-'));
    try {
      const result = await runProcess(process.execPath, [
        path.resolve('scripts/live-session-harness.mjs'), '--session', 'LS-18', '--model', 'never-invoked', '--output', root,
      ]);
      expect(result.code).toBe(2);
      const reportFile = (await fs.readdir(root)).find(name => name.startsWith('scorecard-'))!;
      const report = JSON.parse(await fs.readFile(path.join(root, reportFile), 'utf8'));
      expect(report.qualified).toBe(false);
      expect(report.results[0].status).toBe('BLOCKED');
      expect(report.results[0].metrics.model_calls).toBeNull();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
