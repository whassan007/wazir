import { describe, it, expect } from 'vitest';
import { AccountRegistry, DEFAULT_POLICY, ResourceLedger, TokenBudgetManager, validateResourceSetup, type AccountConfig, type ResourcePolicy } from '../src/resources/index.js';

function setup(accounts: AccountConfig[], policy: Partial<ResourcePolicy> = {}, implicitAgents: string[] = []) {
  const registry = new AccountRegistry(accounts);
  registry.addImplicit({ localRuntimes: [], hostedRuntimes: [], agents: implicitAgents, hostedAuthorized: false });
  const budget = new TokenBudgetManager(new ResourceLedger(':memory:'), registry, { ...DEFAULT_POLICY, ...policy });
  return { budget, configuredIds: new Set(accounts.map((a) => a.id)) };
}

const claude: AccountConfig = {
  id: 'claude-max', provider: 'anthropic', kind: 'subscription', integration: 'vendor-cli', agents: ['claude'],
  limits: [{ unit: 'requests', window: '5h', limit: 200, source: 'configured' }],
};
const openai: AccountConfig = { id: 'openai', provider: 'openai', kind: 'api', integration: 'api-key', runtimeIds: ['openai'], allowPaid: true };
const levels = (r: ReturnType<typeof validateResourceSetup>, subject: string) => r.findings.filter((f) => f.subject === subject).map((f) => f.level);

describe('wa resources validate', () => {
  it('default profile: unenforced and unconfigured setups are valid, with warnings that say so', () => {
    const { budget, configuredIds } = setup([], {}, ['codex']);
    const r = validateResourceSetup({ budget, configuredIds, agents: ['codex'], runtimes: [] });
    expect(r.ok).toBe(true);
    expect(r.findings.find((f) => f.subject === 'policy')).toMatchObject({ level: 'warn', message: expect.stringMatching(/NOT enforced/) });
    expect(r.findings.find((f) => f.subject === 'agent codex')?.message).toMatch(/implicit account 'sub:codex'/);
    expect(r.findings.find((f) => f.subject === 'account sub:codex')?.message).toMatch(/UNKNOWN .*admitted as if unlimited/);
  });

  it('production profile requires enforcement, explicit accounts, known limits, pricing and a spend ceiling', () => {
    const { budget, configuredIds } = setup([openai], { paidApiFallback: false }, ['codex']);
    const r = validateResourceSetup({ budget, configuredIds, agents: ['codex'], runtimes: ['openai'], profile: 'production' });
    expect(r.ok).toBe(false);
    expect(levels(r, 'policy')).toEqual(['error']);
    expect(levels(r, 'agent codex')).toEqual(['error']);
    const api = r.findings.filter((f) => f.subject === 'account openai' && f.level === 'error').map((f) => f.message).join('\n');
    expect(api).toMatch(/UNLIMITED/);
    expect(api).toMatch(/without pricing/);
    expect(api).toMatch(/no daily or monthly spend ceiling/);
  });

  it('a complete production configuration passes', () => {
    const priced = { ...openai, pricing: { inputPerMTok: 2, outputPerMTok: 8 }, limits: [{ unit: 'cost_usd' as const, window: 'day', limit: 5, source: 'configured' as const }] };
    const { budget, configuredIds } = setup([claude, priced], { enforce: true, dailySpendUsd: 5 });
    const r = validateResourceSetup({ budget, configuredIds, agents: ['claude'], runtimes: ['openai'], profile: 'production' });
    expect(r.findings.filter((f) => f.level === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('probes admission without reserving anything, and reflects enforcement', () => {
    const { budget, configuredIds } = setup([openai], { enforce: true, paidApiFallback: false });
    budget.accounts.get('openai')!.allowPaid = false;
    const r = validateResourceSetup({ budget, configuredIds, agents: [], runtimes: ['openai'] });
    expect(r.probes.find((p) => p.accountId === 'openai' && p.workload === 'routine')).toMatchObject({ outcome: 'blocked', reasons: [expect.stringMatching(/paid fallback is not authorized/)] });
    expect(budget.ledger.activeReservations()).toHaveLength(0);
    expect(budget.ledger.events()).toHaveLength(0);
  });

  it('a target with no account at all is an error in every profile; an invalid file is too', () => {
    const { budget, configuredIds } = setup([]);
    const r = validateResourceSetup({ budget, configuredIds, agents: ['ghost'], runtimes: [], configError: 'invalid resource configuration' });
    expect(r.ok).toBe(false);
    expect(levels(r, 'agent ghost')).toEqual(['error']);
    expect(levels(r, 'resources.json')).toEqual(['error']);
  });
});
