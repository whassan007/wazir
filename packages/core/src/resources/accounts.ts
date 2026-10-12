import { isValidWindow } from './windows.js';
import {
  DEFAULT_POLICY,
  WORKLOAD_CLASSES,
  type AccountConfig,
  type LimitSpec,
  type Pricing,
  type ResourcePolicy,
  type WorkloadClass,
} from './types.js';

export interface ResourceConfigFile {
  version?: 1;
  policy?: Partial<ResourcePolicy>;
  accounts?: AccountConfig[];
}

export class ResourceConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid resource configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ResourceConfigError';
  }
}

const KINDS = ['local', 'api', 'subscription'];
const INTEGRATIONS = ['local-endpoint', 'api-key', 'oauth', 'vendor-cli'];
const UNITS = ['tokens', 'input_tokens', 'output_tokens', 'requests', 'cost_usd'];
const SOURCES = ['provider-reported', 'provider-documented', 'configured', 'estimated'];
const MODES = ['balanced', 'local-first', 'quality-first', 'budget-first'];

/** Validates a parsed resources.json; throws ResourceConfigError listing every problem. */
export function validateResourceConfig(raw: unknown): { policy: ResourcePolicy; accounts: AccountConfig[] } {
  const problems: string[] = [];
  const cfg = (raw ?? {}) as ResourceConfigFile;
  const policy: ResourcePolicy = { ...DEFAULT_POLICY, ...(cfg.policy ?? {}) };
  if (!MODES.includes(policy.mode)) problems.push(`policy.mode must be one of ${MODES.join(', ')}`);
  if (typeof policy.enforce !== 'boolean') problems.push('policy.enforce must be true or false');
  for (const k of ['estimateMargin', 'leaseMs', 'maxTaskTokens', 'dailySpendUsd', 'monthlySpendUsd', 'localQueueTimeoutMs'] as const) {
    if (typeof policy[k] !== 'number' || !(policy[k] >= 0)) problems.push(`policy.${k} must be a non-negative number`);
  }
  for (const w of policy.localOnlyWorkloads ?? []) if (!WORKLOAD_CLASSES.includes(w)) problems.push(`policy.localOnlyWorkloads: unknown workload '${w}'`);

  const ids = new Set<string>();
  const accounts = (cfg.accounts ?? []).map((a, i) => {
    const at = `accounts[${i}]${a?.id ? ` (${a.id})` : ''}`;
    if (!a || typeof a.id !== 'string' || !a.id) { problems.push(`${at}: id is required`); return a; }
    if (ids.has(a.id)) problems.push(`${at}: duplicate id`);
    ids.add(a.id);
    if (!KINDS.includes(a.kind)) problems.push(`${at}: kind must be one of ${KINDS.join(', ')}`);
    if (!INTEGRATIONS.includes(a.integration)) problems.push(`${at}: integration must be one of ${INTEGRATIONS.join(', ')}`);
    if (a.kind === 'subscription' && a.integration !== 'vendor-cli') {
      problems.push(`${at}: subscriptions may only be used through their vendor CLI (integration 'vendor-cli')`);
    }
    if (a.kind === 'subscription' && !a.agents?.length) problems.push(`${at}: a subscription must name the agent(s) that use it`);
    if (a.kind !== 'subscription' && !a.runtimeIds?.length) problems.push(`${at}: local and api accounts must name runtimeIds`);
    for (const [j, l] of (a.limits ?? []).entries()) checkLimit(l, `${at}.limits[${j}]`, problems);
    for (const w of [...(a.workloads ?? []), ...(a.reserveFor ?? []), ...(a.criticalOnly ?? [])]) {
      if (!WORKLOAD_CLASSES.includes(w)) problems.push(`${at}: unknown workload '${w}'`);
    }
    for (const n of ['maxConcurrent', 'rpm', 'tpm', 'priority'] as const) {
      if (a[n] !== undefined && !(typeof a[n] === 'number' && a[n]! >= 0)) problems.push(`${at}: ${n} must be a non-negative number`);
    }
    if (a.env) {
      for (const [k, v] of Object.entries(a.env)) {
        if (/key|token|secret|password/i.test(k) && typeof v === 'string' && v.length > 0) {
          problems.push(`${at}: env.${k} looks like a secret; store credentials in the vendor CLI or SecretBroker, and use credentialRef for env var names`);
        }
      }
    }
    return a;
  });
  if (problems.length) throw new ResourceConfigError(problems);
  return { policy, accounts };
}

function checkLimit(l: LimitSpec, at: string, problems: string[]): void {
  if (!l || !UNITS.includes(l.unit)) problems.push(`${at}: unit must be one of ${UNITS.join(', ')}`);
  if (!l || !isValidWindow(l.window)) problems.push(`${at}: window must be like 5h, 1m, 24h, 7d, day, week or month`);
  if (!l || !(l.limit === null || (typeof l.limit === 'number' && l.limit > 0))) problems.push(`${at}: limit must be a positive number, or null when unknown`);
  if (!l || !SOURCES.includes(l.source)) problems.push(`${at}: source must be one of ${SOURCES.join(', ')}`);
}

const glob = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);

export function servesModel(account: AccountConfig, modelId: string): boolean {
  return !account.models?.length || account.models.some((p) => glob(p, modelId));
}

export function pricingFor(account: AccountConfig, modelId: string): Pricing | undefined {
  const p = account.pricing;
  if (!p) return undefined;
  if ('inputPerMTok' in p && typeof p.inputPerMTok === 'number') return p as Pricing;
  const table = p as Record<string, Pricing>;
  const key = Object.keys(table).find((k) => glob(k, modelId));
  return key ? table[key] : undefined;
}

export function costUsd(pricing: Pricing | undefined, input: number, output: number, cachedInput = 0): number {
  if (!pricing) return 0;
  const cached = Math.min(cachedInput, input);
  return ((input - cached) * pricing.inputPerMTok + cached * (pricing.cachedInputPerMTok ?? pricing.inputPerMTok) + output * pricing.outputPerMTok) / 1e6;
}

export const isPaid = (a: AccountConfig) => a.kind === 'api';

/** The registry of configured accounts, plus implicit ones for anything left unconfigured. */
export class AccountRegistry {
  private readonly byId = new Map<string, AccountConfig>();

  constructor(accounts: AccountConfig[]) {
    for (const a of accounts) this.byId.set(a.id, a);
  }

  list(): AccountConfig[] {
    return [...this.byId.values()];
  }

  get(id: string): AccountConfig | undefined {
    return this.byId.get(id);
  }

  /**
   * Adds implicit accounts so every runtime and agent is accounted for even without
   * configuration: local runtimes become unlimited local accounts, hosted runtimes become API
   * accounts (paid only if hosted providers were already authorised), and delegated agents
   * become subscriptions with unknown limits. Explicit configuration always wins.
   */
  addImplicit(input: { localRuntimes: string[]; hostedRuntimes: string[]; agents: string[]; hostedAuthorized: boolean }): void {
    const covered = (pred: (a: AccountConfig) => boolean) => this.list().some((a) => a.enabled !== false && pred(a));
    for (const r of input.localRuntimes) {
      if (!covered((a) => !!a.runtimeIds?.includes(r))) {
        this.byId.set(`local:${r}`, { id: `local:${r}`, label: `${r} (this machine)`, provider: r, kind: 'local', integration: 'local-endpoint', runtimeIds: [r], maxConcurrent: 2 });
      }
    }
    for (const r of input.hostedRuntimes) {
      if (!covered((a) => !!a.runtimeIds?.includes(r))) {
        this.byId.set(`api:${r}`, { id: `api:${r}`, label: `${r} API`, provider: r, kind: 'api', integration: 'api-key', runtimeIds: [r], allowPaid: input.hostedAuthorized });
      }
    }
    for (const agent of input.agents) {
      if (!covered((a) => !!a.agents?.includes(agent))) {
        this.byId.set(`sub:${agent}`, {
          id: `sub:${agent}`, label: `${agent} (vendor CLI login)`, provider: agent, kind: 'subscription', integration: 'vendor-cli',
          agents: [agent], unknownLimitPolicy: 'allow',
          limits: [{ unit: 'requests', window: '5h', limit: null, source: 'estimated', note: 'subscription quota not published or queryable' }],
        });
      }
    }
  }

  /** Accounts able to serve a runtime+model or an agent, most preferred first. */
  candidates(target: { runtimeId?: string; agent?: string; modelId?: string }): AccountConfig[] {
    return this.list()
      .filter((a) => a.enabled !== false)
      .filter((a) => (target.agent ? !!a.agents?.includes(target.agent) : !!target.runtimeId && !!a.runtimeIds?.includes(target.runtimeId)))
      .filter((a) => !target.modelId || servesModel(a, target.modelId))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  }
}

export const DEFAULT_RESERVE_FOR: WorkloadClass[] = ['complex', 'critical-review'];
export const DEFAULT_CRITICAL_ONLY: WorkloadClass[] = ['critical-review'];
