import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixture, config, policy } from './harness.js';
import { CompetitiveExecution, raceGit, raceHash, rankRace, RACE_PREFIX, type RaceAttempt } from '../../packages/core/src/services/competitiveExecution.js';
import { JsonFileStore } from '../../packages/shared/src/store.js';
import { ModelIntelligenceService } from '../../packages/core/src/services/modelIntelligenceService.js';
import { raceToolAllowed, verifyCompetitiveCandidate } from '../../apps/cli/src/competitive.js';
import { bwrapArgs, seatbeltProfile } from '../../packages/tools/src/sandbox.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(overrides: Parameters<typeof fixture>[0] = {}) { const f = await fixture(overrides); cleanups.push(f.dispose); return f; }
describe('competitive execution, real Git + deterministic independent acceptance', () => {
  it('runs two agents concurrently on the same immutable baseline, verifies pristine patches, preserves target', async () => {
    let active = 0; let peak = 0;
    const f = await setup({ run: async ({ attempt, event }) => {
      active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 25));
      await fs.writeFile(path.join(attempt.worktree!.worktreeDir, 'src/add.cjs'), 'exports.add=(a,b)=>a+b;\n');
      await event('tool', { tool: 'write', ok: true }); active--; return {};
    } });
    const before = await raceGit(f.root, ['rev-parse', 'HEAD']);
    const r = await f.service.run((await f.create()).id);
    expect(r.state).toBe('AWAITING_MERGE'); expect(peak).toBe(2);
    expect(r.attempts.every(a => a.state === 'VERIFIED')).toBe(true);
    expect(new Set(r.attempts.map(a => a.worktree!.baseSha))).toEqual(new Set([before]));
    expect(new Set(r.attempts.map(a => a.worktree!.worktreeDir)).size).toBe(2);
    expect(f.verificationRoots.every(cwd => !r.attempts.some(a => a.worktree!.worktreeDir === cwd))).toBe(true);
    expect(await raceGit(f.root, ['rev-parse', 'HEAD'])).toBe(before);
    expect(await fs.readFile(path.join(f.root, 'src/add.cjs'), 'utf8')).toContain('a - b');
    expect(r.explanation).toContain('mandatory');
    expect(r.attempts.every(a => a.measurement?.estimatedCostUsd === undefined && a.measurement?.inputTokens === undefined)).toBe(true);
    expect(await f.service.export(r.id, 'csv')).toContain('estimatedCostUsd');
    expect(JSON.parse(await f.service.export(r.id, 'json')).toolEvents).toHaveLength(2);
  });
  it('passing candidate wins over failing implementation; outages fail over without false evidence', async () => {
    const f = await setup({ run: async ({ attempt }) => {
      if (attempt.configuration.id === 'outage') throw new Error('provider unavailable');
      await fs.writeFile(path.join(attempt.worktree!.worktreeDir, 'src/add.cjs'), attempt.configuration.id === 'bad' ? 'exports.add=()=>5;\n' : 'exports.add=(a,b)=>a+b;\n'); return {};
    } });
    const r = await f.service.run((await f.create([config('outage'), config('bad'), config('good')])).id);
    expect(r.attempts.map(a => a.state)).toEqual(['FAILED', 'FAILED', 'VERIFIED']);
    expect(r.winnerId).toBe(r.attempts[2].id); expect(r.attempts[0].checks).toBeUndefined();
  });
  it('all failed checks yield NO_VALID_WINNER', async () => {
    const f = await setup({ run: async ({ attempt }) => { await fs.writeFile(path.join(attempt.worktree!.worktreeDir, 'src/add.cjs'), 'exports.add=()=>99;\n'); return {}; } });
    const r = await f.service.run((await f.create()).id); expect(r.state).toBe('NO_VALID_WINNER'); expect(r.winnerId).toBeUndefined();
  });
  it.each(['acceptance.cjs', 'package.json', 'tests/hidden.test.js', '.wazir-race.json'])('rejects verification/policy tampering: %s', async file => {
    const f = await setup({ run: async ({ attempt }) => {
      const output = path.join(attempt.worktree!.worktreeDir, file); await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, 'tampered'); return {};
    } });
    const r = await f.service.run((await f.create()).id);
    expect(r.state).toBe('NO_VALID_WINNER'); expect(f.verificationRoots).toHaveLength(0);
    expect(r.attempts.every(a => a.violations!.includes(file))).toBe(true);
  });
  it('rejects symlink patches and unauthorized files', async () => {
    const f = await setup({ run: async ({ attempt }) => { await fs.symlink('/etc/passwd', path.join(attempt.worktree!.worktreeDir, 'src/leak')); return {}; } });
    const r = await f.service.run((await f.create()).id); expect(r.state).toBe('NO_VALID_WINNER'); expect(r.attempts[0].violations).toContain('symlinks and submodules are prohibited');
  });
  it('cancels agents and marks timeout, and cleanup retains branches and evidence', async () => {
    let stopped = 0;
    const f = await setup({ run: ({ signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) { stopped++; reject(signal.reason); return; }
      signal.addEventListener('abort', () => { stopped++; reject(signal.reason); }, { once: true });
    }) });
    const r = await f.service.run((await f.create(undefined, { ...policy, timeoutMs: 250 })).id);
    expect(r.state).toBe('TIMED_OUT'); expect(stopped).toBeGreaterThan(0);
    await f.service.cleanup(r.id);
    for (const a of r.attempts) expect(await fs.access(a.worktree!.worktreeDir).then(() => true).catch(() => false)).toBe(false);
    expect(await f.service.get(r.id)).toBeDefined();
  });
  it('marks uncooperative cancelled adapters RECOVERY_REQUIRED and refuses unsafe cleanup', async () => {
    const f = await setup({ run: () => new Promise(() => undefined) });
    const r = await f.service.run((await f.create(undefined, { ...policy, timeoutMs: 300 })).id);
    expect(r.state).toBe('RECOVERY_REQUIRED'); await expect(f.service.cleanup(r.id)).rejects.toThrow('uncertain');
  });
  it('honors cancellation persisted before coordinator dispatch', async () => {
    let calls = 0; const f = await setup({ run: async () => { calls++; return {}; } });
    const r = await f.create(); await f.service.cancel(r.id);
    const done = await f.service.run(r.id); expect(done.state).toBe('CANCELLED'); expect(calls).toBe(0);
    expect(done.attempts.every(a => a.worktree === undefined)).toBe(true);
  });
  it('cross-coordinator cancellation persists and stops all running attempts', async () => {
    const f = await setup({ run: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason);
    }) });
    const r = await f.create(); const running = f.service.run(r.id);
    await new Promise(resolve => setTimeout(resolve, 160));
    const second = new CompetitiveExecution(f.deps); await second.cancel(r.id);
    const done = await running; expect(done.state).toBe('CANCELLED'); expect(done.winnerId).toBeUndefined();
  });
  it('reserves cost before execution and fails closed on unknown prices/missing usage', async () => {
    const f = await setup();
    const configs = [{ ...config('a'), pricing: 'metered' as const, maxCostUsd: 1 }, { ...config('b'), pricing: 'metered' as const, maxCostUsd: 1 }];
    await expect(f.create([{ ...config('unknown'), pricing: 'unknown' }], { ...policy, maxCostUsd: 1 })).rejects.toThrow('usable pricing');
    const r = await f.service.run((await f.create(configs, { ...policy, maxCostUsd: 1 })).id);
    expect(r.attempts[0].reservedCostUsd).toBe(1); expect(r.attempts[0].failure).toContain('missing cost');
    expect(r.attempts[1].state).toBe('SKIPPED'); expect(r.state).toBe('NO_VALID_WINNER');
  });
  it('progressive racing stops after independent acceptance and enforces concurrency', async () => {
    const f = await setup(); const r = await f.service.run((await f.create(undefined, { ...policy, progressive: true, maxConcurrency: 1 })).id);
    expect(r.attempts.map(a => a.state)).toEqual(['VERIFIED', 'SKIPPED']); expect(r.state).toBe('AWAITING_MERGE');
  });
  it('survives a durable-store restart without duplicate dispatch, and fences dead owners', async () => {
    const f = await setup();
    const store = new JsonFileStore(path.join(f.root, '.wazir', 'history.json'));
    const first = new CompetitiveExecution({ ...f.deps, store });
    const r = await first.create({ repository: f.root, task: 'Fix add', configurations: [config('a')], policy });
    const second = new CompetitiveExecution({ ...f.deps, store: new JsonFileStore(path.join(f.root, '.wazir', 'history.json')) });
    const results = await Promise.allSettled([first.run(r.id), second.run(r.id)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await second.get(r.id)).state).toBe('AWAITING_MERGE');
    await expect(second.run(r.id)).rejects.toThrow('already claimed');
    const interrupted = await f.create();
    await f.store.update!(`${RACE_PREFIX}${interrupted.id}`, (record: any) => ({ ...record, state: 'RUNNING', owner: { ...record.owner, pid: 2147483647 } }));
    expect((await f.service.recover(interrupted.id)).state).toBe('RECOVERY_REQUIRED');
    await expect(f.service.run(interrupted.id)).rejects.toThrow('already claimed');
    const live = await f.create(); await expect(f.service.recover(live.id)).rejects.toThrow('still alive');
  });
  it('records integration/persistence errors as failures rather than fabricated timeouts', async () => {
    const f = await setup({ finalize: async () => { throw new Error('execution record persistence failed'); } });
    const result = await f.service.run((await f.create([config('a')])).id);
    expect(result.state).toBe('FAILED'); expect(result.events.at(-1)?.detail).toContain('persistence failed');
  });
  it('worktree conflicts fail closed and never reuse stale branches', async () => {
    const f = await setup(); const r = await f.create();
    await fs.mkdir(path.join(f.root, '.wazir', 'worktrees', `${r.id}-0`), { recursive: true });
    const done = await f.service.run(r.id); expect(done.state).toBe('FAILED');
    expect(done.events.at(-1)?.detail).toContain('refusing to replace');
  });
  it('re-verifies drifted merge targets; regression blocks promotion and preserves rollback', async () => {
    const f = await setup(); const r = await f.service.run((await f.create()).id);
    await fs.writeFile(path.join(f.root, 'acceptance.cjs'), "throw new Error('new regression requirement');\n");
    await raceGit(f.root, ['add', 'acceptance.cjs']); await raceGit(f.root, ['commit', '-m', 'new target requirement']);
    const target = await raceGit(f.root, ['rev-parse', 'HEAD']); const promoted = await f.service.promote(r.id);
    expect(promoted.promotion?.ready).toBe(false); expect(promoted.promotion?.rollbackSha).toBe(target);
    expect(await raceGit(f.root, ['rev-parse', 'HEAD'])).toBe(target);
    expect(promoted.state).toBe('AWAITING_MERGE');
  });
  it('promotion requires fresh verification even on an unchanged target', async () => {
    const f = await setup(); const r = await f.service.run((await f.create()).id); const previous = f.verificationRoots.length;
    const promoted = await f.service.promote(r.id); expect(promoted.promotion?.ready).toBe(true);
    expect(f.verificationRoots.length).toBe(previous + 1);
    expect(await raceGit(f.root, ['rev-parse', 'HEAD'])).toBe(r.baselineCommit);
  });
  it('replay preserves original snapshot and winner; simultaneous races never share attempts', async () => {
    const f = await setup(); const r = await f.service.run((await f.create()).id); const snapshot = JSON.stringify(await f.service.get(r.id));
    const replay = await f.service.replay(r.id, [config('alternative')]);
    expect(replay.replayOf).toBe(r.id); expect(replay.reproduction).toBe('approximate'); expect(replay.baselineCommit).toBe(r.baselineCommit);
    expect(JSON.stringify(await f.service.get(r.id))).toBe(snapshot);
    const records = await Promise.all([f.create(), f.create()]); const concurrent = await Promise.all(records.map(r => f.service.run(r.id)));
    expect(new Set(concurrent.flatMap(r => r.attempts.map(a => a.worktree!.worktreeDir))).size).toBe(4);
  });
  it('rejects duplicate/invalid model configurations and invalid resource policies', async () => {
    const f = await setup(); await expect(f.create([config('a'), config('a')])).rejects.toThrow('duplicate');
    await expect(f.create([{ ...config('a'), model: '' }])).rejects.toThrow('invalid');
    await expect(f.create(undefined, { ...policy, maxConcurrency: 99 })).rejects.toThrow('hard limit');
  });
  it('ties deterministically; missing mandatory evidence cannot win; costs compare only when known', () => {
    const a: RaceAttempt = { id: 'a', configuration: config('a'), state: 'VERIFIED', patchHash: 'hash', headSha: 'sha', durationMs: 10, checks: [{ name: 'acceptance', passed: true, exitCode: 0, outputHash: 'hash', output: '', durationMs: 1 }] };
    const b = { ...a, id: 'b' };
    expect(rankRace([b, a], policy).map(a => a.id)).toEqual(['a', 'b']);
    expect(rankRace([{ ...a, checks: [] }, { ...b, state: 'FAILED' }], policy)).toEqual([]);
    expect(rankRace([{ ...a, measurement: { estimatedCostUsd: 0.2 } }, { ...b, measurement: { estimatedCostUsd: 0.1 } }], policy)[0].id).toBe('b');
  });
  it('adaptive routing uses verified matching outcomes, explores new configurations, excludes replays', async () => {
    const f = await setup(); const r = await f.service.run((await f.create([config('a')])).id);
    const intelligence = new ModelIntelligenceService({ store: f.store });
    const task: any = { id: 't', input: r.task, type: 'coding', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() };
    const result = await intelligence.rankCompetitiveConfigurations(task, [config('a'), config('new')], r.policyHash);
    expect(result.configurations[0].id).toBe('new'); expect(result.reasons.join()).toContain('observations=1');
    await f.service.replay(r.id, [config('new')]);
    const again = await intelligence.rankCompetitiveConfigurations(task, [config('a'), config('new')], r.policyHash);
    expect(again.reasons.find(s => s.startsWith('new:'))).toContain('observations=0');
    const cold = await intelligence.rankCompetitiveConfigurations(task, [config('a'), config('new')], 'unseen-policy'); expect(cold.reasons[0]).toContain('cold start');
  });
});
describe('race isolation policy', () => {
  it('denies malicious tools, metadata, secrets, acceptance and traversal destinations', () => {
    for (const tool of ['shell', 'git', 'dispatch_subagent', 'mcp.exec', 'test', 'web.fetch']) expect(raceToolAllowed(tool, 'src/a.ts', policy)).toBe(false);
    for (const file of ['.git/config', '.env', '../other/file', 'src/../../test.js', 'acceptance.cjs']) expect(raceToolAllowed('write', file, policy)).toBe(false);
    expect(raceToolAllowed('write', 'src/a.ts', policy)).toBe(true);
  });
  it('strict sandbox profiles omit shared caches, temp writes, Git and networking', () => {
    const options = { projectRoot: '/isolated/race', cwd: '/isolated/race', competitiveIsolation: true, immutablePaths: ['/isolated/race/acceptance.cjs'] };
    const mac = seatbeltProfile(options); expect(mac).toContain('(deny network*)'); expect(mac).not.toContain('(subpath "/private/tmp")'); expect(mac).toContain('deny file-write* (subpath "/isolated/race/acceptance.cjs")');
    const linux = bwrapArgs(options); expect(linux).toContain('--unshare-all'); expect(linux).not.toContain('/run'); expect(linux).toContain('--ro-bind');
  });
});
