import type { AccountConfig, ResourceConfigFile } from '@wazir/core';
import type { RookEngine } from './engine.js';

/**
 * A starting resources.json for this machine: detected local runtimes as DGX/local accounts
 * with GPU concurrency limits, detected delegated agents as subscriptions whose quotas are
 * UNKNOWN (null) until the operator sets them, and paid API fallback off.
 */
export function exampleResourceConfig(engine: Pick<RookEngine, 'runtimes' | 'agents'>): ResourceConfigFile {
  const accounts: AccountConfig[] = [];
  const local = engine.runtimes.list().filter((r) => r.type === 'lmstudio' || r.type === 'ollama');
  for (const r of local) {
    accounts.push({
      id: `dgx-${r.id}`, label: `DGX Spark — ${r.id}`, provider: r.id, kind: 'local', integration: 'local-endpoint',
      runtimeIds: [r.id], maxConcurrent: 2, priority: 10,
    });
  }
  const external = engine.agents.list().filter((a) => a.source === 'external').map((a) => a.descriptor.name);
  const subscription = (agent: string, priority: number, reserve: AccountConfig['reserveFor']): AccountConfig => ({
    id: `sub-${agent}`, label: `${agent} subscription (vendor CLI login)`, provider: agent, kind: 'subscription', integration: 'vendor-cli',
    agents: [agent], priority, reserveFor: reserve, unknownLimitPolicy: 'conserve',
    limits: [
      { unit: 'requests', window: '5h', limit: null, source: 'estimated', note: 'set from your plan; vendors do not publish or expose subscription quotas' },
      { unit: 'requests', window: 'week', limit: null, source: 'estimated' },
    ],
  });
  if (external.includes('claude-code')) accounts.push(subscription('claude-code', 5, ['complex', 'critical-review']));
  if (external.includes('codex')) accounts.push(subscription('codex', 4, ['complex', 'critical-review', 'routine']));
  if (external.includes('antigravity')) accounts.push(subscription('antigravity', 3, ['complex', 'critical-review', 'routine']));
  return {
    version: 1,
    policy: {
      mode: 'local-first',
      paidApiFallback: false,
      estimateMargin: 0.25,
      maxTaskTokens: 0,
      dailySpendUsd: 0,
      monthlySpendUsd: 0,
      localOnlyWorkloads: [],
    },
    accounts,
  };
}
