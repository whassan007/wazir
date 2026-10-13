import { isPaid, pricingFor } from './accounts.js';
import type { TokenBudgetManager } from './budgetManager.js';
import type { AccountConfig, WorkloadClass } from './types.js';

/**
 * `default` reports problems; `production` additionally requires every non-local account to
 * be explicitly configured with known limits and enforced. Selecting a profile only changes
 * what validation demands — it never changes the policy Wazir runs with.
 */
export type ValidationProfile = 'default' | 'production';
export type FindingLevel = 'error' | 'warn' | 'ok';

export interface SetupFinding {
  level: FindingLevel;
  subject: string;
  message: string;
}

export interface SetupValidationInput {
  budget: TokenBudgetManager;
  configError?: string;
  /** Account ids that come from resources.json (everything else is implicit). */
  configuredIds: ReadonlySet<string>;
  /** What this installation can dispatch to. */
  agents: string[];
  runtimes: string[];
  profile?: ValidationProfile;
}

export interface SetupValidation {
  profile: ValidationProfile;
  ok: boolean;
  findings: SetupFinding[];
  /** Admission preview for one minimal request per account and workload; reserves nothing. */
  probes: Array<{ accountId: string; workload: WorkloadClass; outcome: string; reasons: string[] }>;
}

const PROBE_WORKLOADS: WorkloadClass[] = ['routine', 'critical-review'];

/** Checks policy, account mappings and limits, and previews what admission would do now. */
export function validateResourceSetup(input: SetupValidationInput): SetupValidation {
  const profile = input.profile ?? 'default';
  const prod = profile === 'production';
  const { budget } = input;
  const policy = budget.policy;
  const findings: SetupFinding[] = [];
  const add = (level: FindingLevel, subject: string, message: string) => findings.push({ level, subject, message });
  /** Required in production, advisory otherwise. */
  const require = (subject: string, message: string) => add(prod ? 'error' : 'warn', subject, message);

  if (input.configError) add('error', 'resources.json', `${input.configError} (cloud dispatch is stopped until fixed)`);

  if (policy.enforce) add('ok', 'policy', 'limits are enforced (policy.enforce=true)');
  else require('policy', 'limits are accounted but NOT enforced (policy.enforce=false): quotas, spend ceilings, concurrency and the paid-API gate never refuse a request');

  const stop = budget.stopped();
  if (stop) add('warn', 'emergency stop', `active since ${new Date(stop.at).toISOString()}: ${stop.reason}`);

  // Every dispatch target must map to an account, or its requests are refused.
  for (const agent of input.agents) {
    const id = budget.accounts.candidates({ agent })[0]?.id;
    if (!id) add('error', `agent ${agent}`, 'no account serves this agent; delegation to it is refused');
    else if (!input.configuredIds.has(id)) require(`agent ${agent}`, `served by implicit account '${id}' (subscription, limits unknown); configure it in resources.json`);
  }
  for (const runtime of input.runtimes) {
    const id = budget.accounts.candidates({ runtimeId: runtime })[0]?.id;
    if (!id) add('error', `runtime ${runtime}`, 'no account serves this runtime; its requests are refused');
    else if (!input.configuredIds.has(id) && budget.accounts.get(id)?.kind !== 'local') {
      require(`runtime ${runtime}`, `served by implicit account '${id}'; configure it in resources.json`);
    }
  }

  const paidAllowed = (a: AccountConfig) => isPaid(a) && (policy.paidApiFallback || a.allowPaid === true);
  for (const a of budget.accounts.list()) {
    if (a.enabled === false) continue;
    const subject = `account ${a.id}`;
    const limits = [...(a.limits ?? [])];
    const known = limits.filter((l) => l.limit !== null);
    const unknown = limits.filter((l) => l.limit === null);
    if (a.kind !== 'local') {
      if (limits.length === 0 && !a.rpm && !a.tpm) {
        require(subject, 'no limits configured: treated as UNLIMITED (distinct from a limit whose value is unknown)');
      }
      for (const l of unknown) {
        const policyName = a.unknownLimitPolicy ?? 'conserve';
        const effect = policyName === 'allow' ? 'admitted as if unlimited' : policyName === 'deny' ? 'refused' : 'only complex/critical work admitted';
        add(prod && policyName === 'allow' ? 'error' : 'warn', subject, `${l.unit}/${l.window} limit value is UNKNOWN (${l.source}); when enforced, requests are ${effect} (unknownLimitPolicy=${policyName})`);
      }
      if (known.length > 0) add('ok', subject, `${known.length} known limit(s): ${known.map((l) => `${l.limit} ${l.unit}/${l.window} (${l.source}${l.hard === false ? ', soft' : ''})`).join(', ')}`);
      if (known.some((l) => l.source === 'estimated')) add('warn', subject, 'some limits are estimates, not provider-reported values');
    }
    if (isPaid(a)) {
      const priced = !!a.pricing && (a.models?.length ? a.models.every((m) => !!pricingFor(a, m)) : true);
      if (!priced) require(subject, 'paid API account without pricing: its cost is recorded as $0 and spend ceilings cannot see it');
      if (paidAllowed(a) && !(policy.dailySpendUsd > 0) && !(policy.monthlySpendUsd > 0)) {
        require(subject, 'paid dispatch is authorized but no daily or monthly spend ceiling is set');
      }
      if (!paidAllowed(a)) add('ok', subject, 'paid API is not authorized (paidApiFallback=false, allowPaid unset): never dispatched while enforced');
    }
    if (a.kind === 'local' && !a.maxConcurrent) add('warn', subject, 'local account without maxConcurrent: GPU requests are not queued');
    if (a.kind === 'subscription') add('ok', subject, 'subscription usage is estimated from prompt and output text; vendor CLIs report no token counts');
  }

  const probes: SetupValidation['probes'] = [];
  for (const a of budget.accounts.list().filter((x) => x.enabled !== false)) {
    for (const workload of PROBE_WORKLOADS) {
      const d = budget.preview({ requestId: `validate:${a.id}:${workload}`, accountId: a.id, modelId: a.models?.[0] ?? 'validate', workload, estimatedInputTokens: 1, estimatedOutputTokens: 1 });
      probes.push({ accountId: a.id, workload, outcome: d.outcome, reasons: d.reasons });
    }
  }

  return { profile, ok: !findings.some((f) => f.level === 'error'), findings, probes };
}
