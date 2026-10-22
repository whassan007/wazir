import { expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fixture, config, policy } from './harness.js';
import { raceHash, type RaceRecord } from '../../packages/core/src/services/competitiveExecution.js';
import { ModelIntelligenceService } from '../../packages/core/src/services/modelIntelligenceService.js';
import { executeTask } from '../../apps/cli/src/run.js';
import { buildTestEngine } from './legacyEngine.js';

/** Explicitly run to regenerate artifacts; regular CI executes functional tests only.
 * This is a deterministic harness calibration, not an estimate of real model performance. */
it.runIf(process.env.WAZIR_WRITE_COMPETITIVE_BENCHMARK === '1')('records actual legacy/race/adaptive/progressive timings with fixed deterministic agents', async () => {
  const rows: Record<string, unknown>[] = [];
  const modes = ['legacy-single', 'race-2', 'race-3', 'adaptive', 'progressive'];
  for (let sample = 0; sample < 5; sample++) {
    for (const mode of modes) {
      let firstOutputMs: number | undefined;
      let started = 0; let startedWall = 0;
      const f = await fixture({ run: async ({ attempt, event }) => {
        // Alternate task difficulty: configuration a cannot solve hard fixtures; b/c can.
        const begin = performance.now();
        const good = sample % 2 === 0 || attempt.configuration.id !== 'a';
        await fs.writeFile(path.join(attempt.worktree!.worktreeDir, 'src/add.cjs'), good ? 'exports.add=(a,b)=>a+b;\n' : 'exports.add=()=>0;\n');
        if (firstOutputMs === undefined) firstOutputMs = performance.now() - started;
        await event('tool', { tool: 'write', ok: true });
        return { firstOutputMs: performance.now() - begin, toolCalls: 1, toolFailures: 0 };
      } });
      try {
        let success = false; let attempts = 1; let toolFailures = 0; let toolCalls = 0; let firstVerifiedOutputMs: number | undefined; let winnerAccuracy: number | undefined;
        let verifiedAlternativeRegret: number | undefined; let record: RaceRecord | undefined;
        const before = process.memoryUsage().rss;
        started = performance.now(); startedWall = Date.now();
        if (mode === 'legacy-single') {
          const content = sample % 2 === 0 ? 'exports.add=(a,b)=>a+b;\n' : 'exports.add=()=>0;\n';
          const engine = await buildTestEngine(f.root, [
            JSON.stringify({ action: 'plan', content: 'inspect and fix the add implementation' }),
            JSON.stringify({ action: 'tool', tool: 'write', input: { path: 'src/add.cjs', content } }),
            JSON.stringify({ action: 'done', summary: 'implemented candidate' }),
          ]);
          const adapter = engine.adapters.get('fake')!; const generate = adapter.generate.bind(adapter);
          adapter.generate = async function* (request) { for await (const e of generate(request)) { if (e.type === 'token' && firstOutputMs === undefined) firstOutputMs = performance.now() - started; yield e; } };
          const outcome = await executeTask(engine, 'Fix add in src/add.cjs', { type: 'coding', model: 'fake-model', agent: 'wazir-coding', quiet: true, maxTurns: 3 });
          const checks = await f.deps.verify(f.root, policy, new AbortController().signal);
          success = checks.every(c => c.passed);
          toolFailures = engine.executions.require(outcome.executionId).toolCalls.filter(t => !t.ok).length;
          toolCalls = engine.executions.require(outcome.executionId).toolCalls.length;
          if (success) firstVerifiedOutputMs = performance.now() - started;
        } else {
          let configurations = mode === 'race-3' ? [config('a'), config('b'), config('c')] : [config('a'), config('b')];
          if (mode === 'adaptive') {
            const intelligence = new ModelIntelligenceService({ store: f.store });
            // Cold start is intentional; no fabricated historic observations or benchmark ingestion.
            const task: any = { id: 'benchmark', input: 'Fix add in JavaScript src/add.cjs', type: 'coding', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() };
            configurations = (await intelligence.rankCompetitiveConfigurations(task, configurations, raceHash(JSON.stringify(policy)))).configurations.slice(0, 1);
          }
          record = await f.service.run((await f.create(configurations, { ...policy, progressive: mode === 'progressive' })).id);
          success = record.state === 'AWAITING_MERGE'; attempts = record.attempts.filter(a => a.startedAt).length;
          toolFailures = record.attempts.reduce((n, a) => n + (a.measurement?.toolFailures ?? 0), 0);
          toolCalls = record.attempts.reduce((n, a) => n + (a.measurement?.toolCalls ?? 0), 0);
          if (success) firstVerifiedOutputMs = Math.min(...record.attempts.filter(a => a.state === 'VERIFIED').map(a => Date.parse(a.completedAt!) - startedWall));
          if (record.winnerId) winnerAccuracy = record.attempts.find(a => a.id === record!.winnerId)?.state === 'VERIFIED' ? 1 : 0;
          // Regret is observable only for alternatives actually run and independently verified.
          if (record.attempts.filter(a => a.checks?.length).length >= 2) verifiedAlternativeRegret = Number(record.attempts.some(a => a.state === 'VERIFIED')) - Number(success);
        }
        rows.push({ mode, sample, fixture: sample % 2 ? 'hard-a-fails' : 'easy-all-pass', fixtureVersion: 20261021, agentType: mode === 'legacy-single' ? 'native-CodingAgent/scripted-model' : 'controller-fake-file-agent',
          success: Number(success), durationMs: +(performance.now() - started).toFixed(3), firstOutputMs: firstOutputMs?.toFixed(3), firstVerifiedOutputMs: firstVerifiedOutputMs?.toFixed(3), attempts,
          inputTokens: '', outputTokens: '', costUsd: '', toolCalls, toolFailures, toolFailureRate: toolCalls > 0 ? toolFailures / toolCalls : undefined, winnerSelectionAccuracy: winnerAccuracy, recoverySuccess: '', observedRoutingRegret: verifiedAlternativeRegret,
          rssDeltaBytes: process.memoryUsage().rss - before, verification: 'trusted CI node assertions; production sandbox measured separately',
        });
      } finally { await f.dispose(); }
    }
  }
  const keys = Object.keys(rows[0]); const quote = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  await fs.writeFile(path.join(__dirname, 'benchmark-results.csv'), [keys.map(quote).join(','), ...rows.map(r => keys.map(k => quote(r[k])).join(','))].join('\n') + '\n');
  const summary = modes.map(mode => {
    const runs = rows.filter(r => r.mode === mode); const times = runs.map(r => Number(r.durationMs)).sort((a, b) => a - b);
    return { mode, n: runs.length, successes: runs.reduce((n, r) => n + Number(r.success), 0), medianMs: times[Math.floor(times.length / 2)], p95Ms: times[Math.ceil(times.length * 0.95) - 1] };
  });
  await fs.writeFile(path.join(__dirname, 'benchmark-summary.json'), JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), platform: process.platform, node: process.version, summary, limitations: 'Five synthetic cases per mode, two agent harnesses; quality and overhead are not comparable as model benchmarks. Missing cost/tokens/recovery/regret remain missing. Adaptive mode is cold-start. No paid APIs.' }, null, 2) + '\n');
  expect(rows).toHaveLength(25);
}, 120_000);
