#!/usr/bin/env node
/* Reproducible, provider-free governance benchmark.
 * It exercises two independent subscription credentials sharing one quota group,
 * one local runtime, one hosted API, concurrent admission, quota exhaustion,
 * auth/rate-limit state, restart recovery, and duplicate settlement.
 * It intentionally reports measurements from this run; it does not invent live
 * provider throughput or quality results.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../packages/core/dist/src/index.js');

const dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-resource-bench-'));
const file = path.join(dir, 'resources.db');
const accounts = new core.AccountRegistry([
  { id: 'sub-a', provider: 'subscription', kind: 'subscription', integration: 'vendor-cli', agents: ['agent-a'], quotaGroup: 'subscription-plan', limits: [{ unit: 'requests', window: '5h', limit: 4, source: 'configured' }] },
  { id: 'sub-b', provider: 'subscription', kind: 'subscription', integration: 'vendor-cli', agents: ['agent-b'], quotaGroup: 'subscription-plan', limits: [{ unit: 'requests', window: '5h', limit: 4, source: 'configured' }] },
  { id: 'dgx', provider: 'lmstudio', kind: 'local', integration: 'local-endpoint', runtimeIds: ['lmstudio'], maxConcurrent: 1 },
  { id: 'hosted', provider: 'nvidia', kind: 'api', integration: 'api-key', runtimeIds: ['nvidia'], allowPaid: true, pricing: { inputPerMTok: 1, outputPerMTok: 2 } },
  { id: 'hosted-auth', provider: 'nvidia', kind: 'api', integration: 'api-key', runtimeIds: ['nvidia'], allowPaid: true, pricing: { inputPerMTok: 1, outputPerMTok: 2 } },
]);
const ledger = new core.ResourceLedger(file);
const policy = { ...core.DEFAULT_POLICY, enforce: true, paidApiFallback: true, estimateMargin: 0 };
const budget = new core.TokenBudgetManager(ledger, accounts, policy);
let seq = 0;
const admit = (accountId, workload = 'routine') => budget.admit({ requestId: `bench-${++seq}`, accountId, modelId: 'bench-model', workload, estimatedInputTokens: 100, estimatedOutputTokens: 50 });
const started = performance.now();
const concurrent = await Promise.all(['sub-a', 'sub-b', 'sub-a', 'sub-b', 'sub-a'].map((id) => Promise.resolve().then(() => admit(id, 'critical-review'))));
const admitted = concurrent.filter((x) => x.outcome === 'admitted');
const exhausted = concurrent.filter((x) => x.outcome !== 'admitted').length;
for (const d of admitted) budget.reconcile(d.requestId, { inputTokens: 100, outputTokens: 50, source: 'estimated' });
const rateLimited = admit('hosted');
if (rateLimited.outcome === 'admitted') budget.fail(rateLimited.requestId, { failureClass: 'RATE_LIMIT', retryAfterMs: 60_000, ambiguous: false, message: 'benchmark 429' });
const auth = admit('hosted-auth');
if (auth.outcome === 'admitted') budget.fail(auth.requestId, { failureClass: 'AUTH_FAILED', status: 401, ambiguous: false, message: 'benchmark auth failure' });
const recovered = admit('dgx');
const restartLedger = new core.ResourceLedger(file);
const recoveredCount = restartLedger.recoverExpired(Date.now() + policy.leaseMs + 1);
const duplicate = recovered.outcome === 'admitted'
  ? [budget.reconcile(recovered.requestId, { inputTokens: 1, outputTokens: 1, source: 'provider-reported' }), budget.reconcile(recovered.requestId, { inputTokens: 1, outputTokens: 1, source: 'provider-reported' })]
  : [];
console.log(JSON.stringify({
  benchmark: 'resource-routing-hardening',
  measured: true,
  durationMs: Number((performance.now() - started).toFixed(3)),
  concurrentTasks: concurrent.length,
  admittedTasks: admitted.length,
  quotaExhaustionDecisions: exhausted,
  sharedQuotaInFlightAfterSettlement: ledger.inFlight(['sub-a', 'sub-b']),
  rateLimitHealth: ledger.getHealth('hosted').health,
  authHealth: ledger.getHealth('hosted-auth').health,
  recoveredReservations: recoveredCount,
  duplicateSettlementResults: duplicate,
  usageRows: ledger.usageRows().length,
  note: 'Synthetic benchmark only; live DGX/provider latency, quality, throttling and cost require an operator-supplied run with real endpoints.',
}, null, 2));
restartLedger.close();
ledger.close();
rmSync(dir, { recursive: true, force: true });
