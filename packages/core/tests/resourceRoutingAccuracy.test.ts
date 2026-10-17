import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountRegistry,
  DEFAULT_POLICY,
  ResourceLedger,
  TokenBudgetManager,
  type AccountConfig,
} from '../src/resources/index.js';
import { ResourceRouter } from '../src/resources/router.js';

const account: AccountConfig = {
  id: 'shared-openai', provider: 'openai', kind: 'api', integration: 'api-key',
  runtimeIds: ['openai'], allowPaid: true,
};

describe('evidence-based resource routing', () => {
  const ledgers: ResourceLedger[] = [];
  const make = () => {
    const ledger = new ResourceLedger(':memory:', () => Date.UTC(2026, 9, 17));
    ledgers.push(ledger);
    const budget = new TokenBudgetManager(ledger, new AccountRegistry([account]), {
      ...DEFAULT_POLICY, paidApiFallback: true, mode: 'quality-first',
    });
    const router = new ResourceRouter({ budget, resolveAccount: () => account.id });
    return { ledger, router, budget };
  };

  afterEach(() => {
    for (const ledger of ledgers.splice(0)) ledger.close();
  });

  it('reproduces account-scoped failures incorrectly lowering another model reliability', () => {
    const { ledger, router } = make();
    for (let i = 0; i < 3; i++) {
      ledger.settle({ requestId: `good-${i}`, accountId: account.id, modelId: 'model-good', workload: 'routine',
        inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0, requests: 1,
        costUsd: 0, source: 'provider-reported', at: ledger.now(), local: false });
      ledger.appendEvent('provider_error', { accountId: account.id, requestId: `bad-${i}` }, {
        failureClass: 'SERVER', model: 'model-bad', modelId: 'model-bad', provider: 'openai', workload: 'routine',
      });
    }

    const results = router.assess({ task: { id: 'task' }, workload: 'routine', estimatedInputTokens: 1, candidates: [
      { modelId: 'model-good', runtimeId: 'openai', capabilityScore: 1 },
      { modelId: 'model-bad', runtimeId: 'openai', capabilityScore: 1 },
    ] });
    const good = results.find((result) => result.modelId === 'model-good')!;
    const bad = results.find((result) => result.modelId === 'model-bad')!;

    // Baseline v0.2.6 reports 0.5 here because it adds the other model's three
    // provider errors to this model's three successes.
    const baselineModelReliability = 3 / (3 + 3);
    expect(good.reliabilityEvidence).toMatchObject({ status: 'measured', successfulRequests: 3, failedRequests: 0, samples: 3 });
    expect(bad.reliabilityEvidence).toMatchObject({ status: 'measured', successfulRequests: 0, failedRequests: 3, samples: 3 });
    expect(baselineModelReliability).toBe(0.5);
    expect(good.reliabilityEvidence?.scoreValue).toBe(0.875);
    expect(bad.factors!.reliability).toBeLessThan(good.factors!.reliability);
  });

  it('labels sparse evidence and unknown price/latency instead of presenting defaults as measured', () => {
    const { router, ledger } = make();
    // Legacy/provider-level telemetry without request model or workload is not attributable.
    ledger.appendEvent('provider_error', { accountId: account.id, requestId: 'unattributed' }, { failureClass: 'SERVER' });
    const [result] = router.assess({ task: { id: 'sparse' }, workload: 'complex', estimatedInputTokens: 1, candidates: [
      { modelId: 'unpriced-model', runtimeId: 'openai', capabilityScore: 9 },
    ] });

    expect(result.reliabilityEvidence).toMatchObject({ status: 'unknown', samples: 0, scoreValue: 0.8, confidence: 0 });
    expect(result.latencyEstimate).toMatchObject({ status: 'unknown', samples: 0, confidence: 0 });
    expect(result.costEstimate).toEqual({ status: 'unknown' });
    expect(result.effectiveCostPerSuccessUsd).toBeUndefined();
    expect(result.reasons.join(' ')).toMatch(/not measured/);
    expect(result.reasons.join(' ')).toMatch(/not treated as \$0/);
  });

  it('uses median latency only after three provider-reported samples from the matching workload', () => {
    const { ledger, router } = make();
    for (const [i, durationMs] of [10, 30, 20].entries()) {
      ledger.settle({ requestId: `latency-${i}`, accountId: account.id, modelId: 'measured-model', workload: 'routine',
        inputTokens: 10, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 0, requests: 1,
        costUsd: 0, source: 'provider-reported', at: ledger.now(), durationMs, local: false });
    }
    ledger.settle({ requestId: 'wrong-workload', accountId: account.id, modelId: 'measured-model', workload: 'complex',
      inputTokens: 10, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 0, requests: 1,
      costUsd: 0, source: 'provider-reported', at: ledger.now(), durationMs: 1, local: false });
    const [result] = router.assess({ task: { id: 'latency' }, workload: 'routine', estimatedInputTokens: 10,
      candidates: [{ modelId: 'measured-model', runtimeId: 'openai', capabilityScore: 1 }] });
    expect(result.latencyEstimate).toMatchObject({ status: 'measured', samples: 3, msPerOutputToken: 0.2, confidence: 0.5 });
  });

  it('keeps token-estimate calibration separate for the same model on different providers/accounts', () => {
    const { ledger } = make();
    ledger.calibrate('shared-model', 100, 200, 'provider-a:account-a');
    ledger.calibrate('shared-model', 100, 50, 'provider-b:account-b');
    expect(ledger.calibration('shared-model', 'provider-a:account-a')).toMatchObject({ ratio: 2, samples: 1 });
    expect(ledger.calibration('shared-model', 'provider-b:account-b')).toMatchObject({ ratio: 0.5, samples: 1 });
    expect(ledger.calibration('shared-model')).toMatchObject({ ratio: 1, samples: 0 });
  });

  it('does not turn a transient retry into a failed request when the final attempt settles', () => {
    const { ledger } = make();
    ledger.settle({ requestId: 'retry-success', accountId: account.id, modelId: 'retry-model', workload: 'routine',
      inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0, requests: 1,
      costUsd: 0, source: 'provider-reported', at: ledger.now(), local: false });
    ledger.appendEvent('provider_error', { accountId: account.id, requestId: 'retry-success' }, {
      model: 'retry-model', modelId: 'retry-model', provider: 'openai', workload: 'routine', retry: true,
    });
    expect(ledger.routingOutcomeCounts({ since: ledger.now() - 1, accountId: account.id, provider: 'openai',
      modelId: 'retry-model', workload: 'routine' })).toEqual({ successfulRequests: 1, failedRequests: 0 });
  });

  it('attributes terminal failures to the admitted model and workload, and excludes cancelled work from success counts', () => {
    const { ledger, router, budget } = make();
    const admit = (requestId: string, modelId: string, workload: 'routine' | 'complex' = 'routine') => budget.admit({
      requestId, accountId: account.id, modelId, workload, estimatedInputTokens: 1, estimatedOutputTokens: 1,
    });
    const settled = (requestId: string, modelId: string, workload: 'routine' | 'complex' = 'routine') => ledger.settle({
      requestId, accountId: account.id, modelId, workload, inputTokens: 1, outputTokens: 1,
      cachedInputTokens: 0, reasoningTokens: 0, requests: 1, costUsd: 0,
      source: 'provider-reported', at: ledger.now(), local: false,
    });

    settled('routine-ok-1', 'model-a');
    settled('routine-ok-2', 'model-a');
    settled('complex-ok', 'model-a', 'complex');
    expect(admit('routine-fail', 'model-a').outcome).toBe('admitted');
    budget.fail('routine-fail', { failureClass: 'SERVER', ambiguous: false });
    expect(admit('routine-ambiguous', 'model-a').outcome).toBe('admitted');
    budget.fail('routine-ambiguous', { failureClass: 'TIMEOUT', ambiguous: true });
    expect(admit('routine-cancel', 'model-a').outcome).toBe('admitted');
    budget.reconcile('routine-cancel', { inputTokens: 1, outputTokens: 1, source: 'provider-reported' }, { outcome: 'cancelled' });

    const [routine] = router.assess({ task: { id: 't-routine' }, workload: 'routine', estimatedInputTokens: 1,
      candidates: [{ modelId: 'model-a', runtimeId: 'openai', capabilityScore: 1 }] });
    const [complex] = router.assess({ task: { id: 't-complex' }, workload: 'complex', estimatedInputTokens: 1,
      candidates: [{ modelId: 'model-a', runtimeId: 'openai', capabilityScore: 1 }] });
    expect(routine.reliabilityEvidence).toMatchObject({ successfulRequests: 2, failedRequests: 2, samples: 4, status: 'measured' });
    expect(complex.reliabilityEvidence).toMatchObject({ successfulRequests: 1, failedRequests: 0, samples: 1, status: 'insufficient' });
    expect(ledger.events({ kind: 'cancelled' })).toHaveLength(1);
    expect(ledger.events({ kind: 'ambiguous' })).toHaveLength(1);
  });

  it('keeps routing reproducible for identical evidence and refuses materially weaker complex candidates', () => {
    const { router } = make();
    const input = { task: { id: 'stable' }, workload: 'complex' as const, estimatedInputTokens: 100, candidates: [
      { modelId: 'strong', runtimeId: 'openai', capabilityScore: 10 },
      { modelId: 'cheap-weak', runtimeId: 'openai', capabilityScore: 7.9 },
    ] };
    const first = router.assess(input);
    const second = router.assess(input);
    expect(first).toEqual(second);
    expect(first.find((result) => result.modelId === 'cheap-weak')).toMatchObject({ admissible: false });
    expect(first.find((result) => result.modelId === 'cheap-weak')?.reasons.join(' ')).toMatch(/cost cannot compensate/);
  });

  it('uses price for routine selection but does not let it replace the highest-capability complex model', () => {
    const strong: AccountConfig = {
      ...account, id: 'strong-account', runtimeIds: ['strong-runtime'],
      pricing: { inputPerMTok: 1_000, outputPerMTok: 1_000 },
    };
    const cheap: AccountConfig = {
      ...account, id: 'cheap-account', runtimeIds: ['cheap-runtime'],
      pricing: { inputPerMTok: 0.01, outputPerMTok: 0.01 },
    };
    const ledger = new ResourceLedger(':memory:', () => Date.UTC(2026, 9, 17));
    ledgers.push(ledger);
    const budget = new TokenBudgetManager(ledger, new AccountRegistry([strong, cheap]), {
      ...DEFAULT_POLICY, paidApiFallback: true, mode: 'budget-first',
    });
    const router = new ResourceRouter({ budget, resolveAccount: (runtime) => runtime === 'strong-runtime' ? strong.id : cheap.id });
    const candidates = [
      { modelId: 'strong-model', runtimeId: 'strong-runtime', capabilityScore: 10 },
      { modelId: 'cheap-model', runtimeId: 'cheap-runtime', capabilityScore: 9 },
    ];
    const routine = router.assess({ task: { id: 'routine-cost' }, workload: 'routine', estimatedInputTokens: 100, candidates });
    const routineWinner = [...routine].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))[0];
    const routineStrong = routine.find((result) => result.modelId === 'strong-model')!;
    expect(routineWinner.modelId).toBe('cheap-model');
    expect(routineWinner.costEstimate?.status).toBe('estimated');
    expect(routineWinner.costEstimate!.usd).toBeLessThan(routineStrong.costEstimate!.usd!);

    const complex = router.assess({ task: { id: 'complex-quality' }, workload: 'complex', estimatedInputTokens: 100, candidates });
    expect(complex.find((result) => result.modelId === 'strong-model')?.admissible).toBe(true);
    expect(complex.find((result) => result.modelId === 'cheap-model')).toMatchObject({ admissible: false });

    // Fixed two-candidate v0.2.6 evaluation: both pass its 50% capability floor,
    // while budget-first weights let the 90%-capability model win solely on price.
    const baselineScore = (quality: number, cost: number) =>
      0.5 * quality + 0.8 * 0.8 + 0.5 * 0.5 - 2 * cost - 0.2 * 0.5;
    const baselineWinner = baselineScore(0.9, 0) > baselineScore(1, 1) ? 'cheap-model' : 'strong-model';
    const revisedWinner = [...complex].filter((result) => result.admissible)
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity))[0]?.modelId;
    expect(baselineWinner).toBe('cheap-model');
    expect(revisedWinner).toBe('strong-model');
  });

  it('keeps quota exhaustion isolated across accounts and routes to an independently admissible account', () => {
    const sub = (id: string, runtimeId: string): AccountConfig => ({
      id, provider: 'vendor-cli', kind: 'subscription', integration: 'vendor-cli', agents: [runtimeId],
      limits: [{ unit: 'tokens', window: '5h', limit: 10_000, source: 'configured' }],
    });
    const first = sub('account-a', 'agent-a');
    const second = sub('account-b', 'agent-b');
    const ledger = new ResourceLedger(':memory:', () => Date.UTC(2026, 9, 17));
    ledgers.push(ledger);
    const budget = new TokenBudgetManager(ledger, new AccountRegistry([first, second]), {
      ...DEFAULT_POLICY, enforce: true, paidApiFallback: false,
    });
    expect(budget.admit({ requestId: 'exhaust-a', accountId: first.id, modelId: 'model-a', workload: 'critical-review',
      estimatedInputTokens: 10_000, estimatedOutputTokens: 0 }).outcome).toBe('admitted');
    const router = new ResourceRouter({ budget, resolveAccount: (runtime) => runtime === 'agent-a' ? first.id : second.id });
    const results = router.assess({ task: { id: 'quota-routing' }, workload: 'routine', estimatedInputTokens: 100, candidates: [
      { modelId: 'model-a', runtimeId: 'agent-a', capabilityScore: 10 },
      { modelId: 'model-b', runtimeId: 'agent-b', capabilityScore: 10 },
    ] });
    expect(results.find((result) => result.accountId === first.id)).toMatchObject({ admissible: false });
    expect(results.find((result) => result.accountId === second.id)).toMatchObject({ admissible: true });
  });
});
