#!/usr/bin/env node
// Measures the per-request cost of resource admission + accounting.
// 1) synthetic: an instant fake adapter, ungoverned vs governed (file-backed WAL ledger)
// 2) live (if LM Studio answers): a small prompt, raw adapter vs governed adapter
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../packages/core/dist/src/index.js');
const { LMStudioAdapter } = require('../packages/runtimes/lmstudio/dist/src/index.js');

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const stats = (xs) => ({ n: xs.length, p50: +pct(xs, 50).toFixed(3), p95: +pct(xs, 95).toFixed(3), mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) });

async function time(adapter, req) {
  const t = performance.now();
  for await (const _ of adapter.generate(req)) { /* drain */ }
  return performance.now() - t;
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-bench-'));
const ledger = new core.ResourceLedger(path.join(dir, 'bench.db'));
const accounts = new core.AccountRegistry([
  { id: 'dgx', provider: 'lmstudio', kind: 'local', integration: 'local-endpoint', runtimeIds: ['fake', 'lmstudio'] },
]);
const budget = new core.TokenBudgetManager(ledger, accounts, core.validateResourceConfig({}).policy);
const govern = (a) => core.governAdapter(a, { budget, resolveAccount: () => 'dgx' });

const fake = { id: 'fake', type: 'other', async *generate() { yield { type: 'token', content: 'ok' }; yield { type: 'completed', usage: { inputTokens: 10, outputTokens: 2 } }; } };
const req = { modelId: 'm', messages: [{ role: 'user', content: 'x'.repeat(400) }] };
const N = Number(process.env.N ?? 500);
for (let i = 0; i < 20; i++) { await time(fake, req); await time(govern(fake), req); } // warm-up
const raw = []; const gov = [];
for (let i = 0; i < N; i++) { raw.push(await time(fake, req)); gov.push(await time(govern(fake), req)); }
const out = { synthetic: { ungoverned_ms: stats(raw), governed_ms: stats(gov), overhead_p50_ms: +(pct(gov, 50) - pct(raw, 50)).toFixed(3) } };

const lm = new LMStudioAdapter(process.env.WAZIR_LMSTUDIO_URL ?? 'http://127.0.0.1:1234/v1');
const model = process.env.BENCH_MODEL ?? 'nvidia/nemotron-3-nano-omni';
try {
  if ((await lm.healthCheck()).status !== 'healthy') throw new Error('LM Studio not healthy');
  const live = { modelId: model, maxTokens: 32, messages: [{ role: 'user', content: 'Reply with the word ready.' }] };
  await time(lm, live);
  const lr = []; const lg = [];
  const L = Number(process.env.L ?? 10);
  for (let i = 0; i < L; i++) { lr.push(await time(lm, live)); lg.push(await time(govern(lm), live)); }
  out.live = { model, raw_ms: stats(lr), governed_ms: stats(lg), overhead_p50_ms: +(pct(lg, 50) - pct(lr, 50)).toFixed(1) };
} catch (e) {
  out.live = { skipped: String(e.message ?? e) };
}
out.ledgerRows = ledger.usageRows().length;
ledger.close();
rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 2));
