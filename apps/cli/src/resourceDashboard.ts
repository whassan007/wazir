import { localCapacity, type AccountStatus, type LocalCapacityReport, type LocalEndpoint, type UsageRow } from '@wazir/core';
import { color } from './colors.js';
import type { RookEngine } from './engine.js';

type DashEngine = Pick<RookEngine, 'resources' | 'runtimes'>;

export interface ResourceSnapshot {
  generatedAt: string;
  policy: RookEngine['resources']['policy'];
  emergencyStop?: { at: number; reason: string };
  configError?: string;
  configPath: string;
  ledgerPath: string;
  accounts: Array<Omit<AccountStatus, 'account'> & {
    id: string; label?: string; provider: string; kind: string; integration: string;
    usage24h: { inputTokens: number; outputTokens: number; cachedInputTokens: number; requests: number; costUsd: number; costKnown: boolean; costStatus: 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN'; bySource: Record<string, number> };
    rateLimit?: { at: string; value: unknown };
  }>;
  local: LocalCapacityReport;
  economics: {
    window: '24h';
    totalTokens: number;
    localTokens: number;
    cloudTokens: number;
    /** Paid API cost computed from usage x configured prices; not a provider bill. */
    apiCostUsd: number;
    apiCostKnown: boolean;
    unpricedCloudRequests: number;
    cachedInputTokens: number;
    /** Local tokens priced at the cheapest configured API rate (undefined when no prices). */
    avoidedApiCostUsd?: number;
    requestsBySource: Record<string, number>;
    events: Record<string, number>;
    routing: { decisions: number; local: number; cloud: number };
  };
}

function localEndpoints(engine: DashEngine): LocalEndpoint[] {
  const endpoints: LocalEndpoint[] = [];
  for (const r of engine.runtimes.list()) {
    const url = (r as { url?: string; endpoint?: string }).url ?? (r as { endpoint?: string }).endpoint;
    if (r.type === 'lmstudio' && url) endpoints.push({ runtimeId: r.id, kind: 'lmstudio', baseUrl: url });
    if (r.type === 'ollama' && url) endpoints.push({ runtimeId: r.id, kind: 'ollama', baseUrl: url });
  }
  if (!endpoints.some((e) => e.kind === 'lmstudio')) endpoints.push({ runtimeId: 'lmstudio', kind: 'lmstudio', baseUrl: process.env.WAZIR_LMSTUDIO_URL ?? 'http://127.0.0.1:1234/v1' });
  if (!endpoints.some((e) => e.kind === 'ollama')) endpoints.push({ runtimeId: 'ollama', kind: 'ollama', baseUrl: process.env.WAZIR_OLLAMA_URL ?? 'http://127.0.0.1:11434' });
  if (process.env.WAZIR_VLLM_URL) endpoints.push({ runtimeId: 'vllm', kind: 'vllm', baseUrl: process.env.WAZIR_VLLM_URL });
  return endpoints;
}

const sum = (rows: UsageRow[], f: (r: UsageRow) => number) => rows.reduce((n, r) => n + f(r), 0);

export async function resourceSnapshot(engine: DashEngine): Promise<ResourceSnapshot> {
  const { ledger, budget, accounts } = engine.resources;
  ledger.recoverExpired();
  const now = ledger.now();
  const since = now - 86_400_000;
  const rows = ledger.usageRows({ since });
  const all = accounts.list();
  const localIds = all.filter((a) => a.kind === 'local').map((a) => a.id);

  const accountViews = all.map((a) => {
    const st = budget.status(a.id, now)!;
    const mine = rows.filter((r) => r.accountId === a.id);
    const rl = ledger.observation(a.id, 'rate_limit');
    const { account: _account, ...rest } = st;
    const hasUnknownCost = mine.some((r) => r.costKnown === false);
    const costKnown = a.kind === 'local' || Boolean(a.pricing) || (mine.length > 0 && !hasUnknownCost);
    const costStatus: 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN' = a.kind === 'local'
      ? 'ACTUAL'
      : !costKnown
        ? 'UNKNOWN'
        : mine.some((r) => r.costStatus === 'ACTUAL')
          ? 'ACTUAL'
          : 'ESTIMATED';
    return {
      ...rest, id: a.id, label: a.label, provider: a.provider, kind: a.kind, integration: a.integration,
      usage24h: {
        inputTokens: sum(mine, (r) => r.inputTokens), outputTokens: sum(mine, (r) => r.outputTokens),
        cachedInputTokens: sum(mine, (r) => r.cachedInputTokens), requests: sum(mine, (r) => r.requests),
        costUsd: sum(mine, (r) => r.costUsd),
        costKnown,
        costStatus,
        bySource: mine.reduce<Record<string, number>>((m, r) => ({ ...m, [r.source]: (m[r.source] ?? 0) + 1 }), {}),
      },
      rateLimit: rl ? { at: new Date(rl.at).toISOString(), value: rl.value } : undefined,
    };
  });

  const localRows = rows.filter((r) => r.local);
  const cloudRows = rows.filter((r) => !r.local);
  const unpricedCloudRequests = cloudRows.filter((r) => r.costKnown === false).length;
  const apiCostKnown = cloudRows.length === 0 || unpricedCloudRequests === 0;
  const prices = all.flatMap((a) => {
    const p = a.pricing;
    if (!p) return [];
    return 'inputPerMTok' in p && typeof p.inputPerMTok === 'number' ? [p as { inputPerMTok: number; outputPerMTok: number }] : Object.values(p as Record<string, { inputPerMTok: number; outputPerMTok: number }>);
  });
  const cheapest = prices.sort((x, y) => x.inputPerMTok + x.outputPerMTok - (y.inputPerMTok + y.outputPerMTok))[0];
  const events = ledger.events({ since, limit: 5_000 });
  const routing = events.filter((e) => e.kind === 'routing');
  const routedLocal = routing.filter((e) => localIds.includes(e.accountId ?? '')).length;

  return {
    generatedAt: new Date(now).toISOString(),
    policy: engine.resources.policy,
    emergencyStop: budget.stopped(),
    configError: engine.resources.configError,
    configPath: engine.resources.configPath,
    ledgerPath: engine.resources.ledgerPath,
    accounts: accountViews,
    local: await localCapacity(localEndpoints(engine), ledger, localIds),
    economics: {
      window: '24h',
      totalTokens: sum(rows, (r) => r.inputTokens + r.outputTokens),
      localTokens: sum(localRows, (r) => r.inputTokens + r.outputTokens),
      cloudTokens: sum(cloudRows, (r) => r.inputTokens + r.outputTokens),
      apiCostUsd: sum(cloudRows, (r) => r.costUsd),
      apiCostKnown,
      unpricedCloudRequests,
      cachedInputTokens: sum(rows, (r) => r.cachedInputTokens),
      avoidedApiCostUsd: cheapest ? sum(localRows, (r) => (r.inputTokens * cheapest.inputPerMTok + r.outputTokens * cheapest.outputPerMTok) / 1e6) : undefined,
      requestsBySource: rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.source]: (m[r.source] ?? 0) + 1 }), {}),
      events: events.reduce<Record<string, number>>((m, e) => ({ ...m, [e.kind]: (m[e.kind] ?? 0) + 1 }), {}),
      routing: { decisions: routing.length, local: routedLocal, cloud: routing.length - routedLocal },
    },
  };
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const gib = (b?: number) => (b === undefined ? 'unknown' : `${(b / 1024 ** 3).toFixed(1)} GiB`);
const when = (ms?: number) => (ms ? new Date(ms).toLocaleString() : '—');
const modeColor = (m: string) => (m === 'normal' ? color.green : m === 'advisory' || m === 'unknown' ? color.yellow : m === 'conserve' ? color.yellow : color.red)(m);
const healthColor = (h: string) => (h === 'ok' ? color.green(h) : color.red(h));

export function renderResourceSnapshot(s: ResourceSnapshot): string {
  const L: string[] = [];
  L.push(color.bold(`Wazir resources — ${new Date(s.generatedAt).toLocaleString()}   policy: ${s.policy.mode}, limits ${s.policy.enforce ? 'ENFORCED' : 'not enforced (accounting only)'}, paid API fallback ${s.policy.paidApiFallback ? 'ALLOWED' : 'off'}`));
  if (s.emergencyStop) L.push(color.red(`EMERGENCY STOP since ${when(s.emergencyStop.at)}: ${s.emergencyStop.reason} — cloud dispatch blocked (wa resources resume)`));
  if (s.configError) L.push(color.red(s.configError));
  L.push(color.gray('Values: measured = observed on this machine · provider = reported by the provider · computed = Wazir accounting · est = estimate'));

  L.push('', color.bold('Accounts'));
  for (const a of s.accounts) {
    L.push(`  ${color.bold(a.id)} ${color.gray(`${a.kind} · ${a.provider} · ${a.integration}`)}  budget ${modeColor(a.mode)}  health ${healthColor(a.health)}${a.healthUntil ? ` until ${when(a.healthUntil)}` : ''}${a.healthReason && a.health !== 'ok' ? color.gray(` (${a.healthReason})`) : ''}  in flight ${a.inFlight}`);
    for (const l of a.limits) {
      const pct = l.utilization === undefined ? 'unknown' : `${Math.round(l.utilization * 100)}%`;
      L.push(`    ${l.unit}/${l.window}: used ${k(l.used)} + reserved ${k(l.reserved)} of ${l.limit === null ? 'UNKNOWN limit' : k(l.limit)} (${l.source}) → ${pct} ${modeColor(l.mode)}, resets ${when(l.windowEnd)}`);
    }
    if (a.limits.length === 0) L.push(color.gray('    no limits configured (local accounting only)'));
    const u = a.usage24h;
    const costLabel = u.costKnown ? `$${u.costUsd.toFixed(4)}` : u.costUsd > 0 ? `$${u.costUsd.toFixed(4)}+ (partial, unpriced model)` : 'unknown (no pricing configured)';
    L.push(color.gray(`    24h computed: ${k(u.inputTokens)} in / ${k(u.outputTokens)} out / ${k(u.cachedInputTokens)} cached, ${u.requests} req, cost ${costLabel}  sources ${JSON.stringify(u.bySource)}`));
    if (a.rateLimit) L.push(color.gray(`    provider rate-limit headers @ ${a.rateLimit.at}: ${JSON.stringify(a.rateLimit.value)}`));
  }

  const lc = s.local;
  L.push('', color.bold('DGX Spark / local inference'));
  L.push(`  memory (measured): ${lc.memory ? `${gib(lc.memory.availableBytes)} available of ${gib(lc.memory.totalBytes)} unified` : 'unknown'}`);
  L.push(`  GPU (measured): ${lc.gpu ? `${lc.gpu.name ?? 'GPU'} ${lc.gpu.utilizationPercent ?? '?'}% util, ${lc.gpu.temperatureC ?? '?'}°C, ${lc.gpu.powerW ?? '?'} W, GPU memory ${lc.gpu.memoryUsedBytes === undefined ? 'n/a (unified memory)' : gib(lc.gpu.memoryUsedBytes)}` : 'nvidia-smi unavailable'}`);
  for (const r of lc.runtimes) {
    L.push(`  ${r.runtimeId} ${r.reachable ? color.green('reachable') : color.red('unreachable')} ${color.gray(r.endpoint)}${r.error ? color.gray(` (${r.error})`) : ''}`);
    for (const m of r.loadedModels) L.push(`    loaded: ${m.id}${m.contextLength ? ` ctx ${m.contextLength}` : ''}`);
    if (r.running !== undefined) L.push(`    vLLM (provider): running ${r.running}, waiting ${r.waiting ?? '?'}, KV cache ${r.kvCacheUsage !== undefined ? `${Math.round(r.kvCacheUsage * 100)}%` : '?'}`);
  }
  L.push(`  Wazir local requests (computed): in flight ${lc.inFlight}, deferred last min ${lc.queued}, throughput ${lc.tokensPerSecond !== undefined ? `${lc.tokensPerSecond.toFixed(1)} tok/s (n=${lc.throughputSamples}, measured)` : 'not yet measured'}`);

  const e = s.economics;
  L.push('', color.bold('Workflow economics (last 24h)'));
  const share = e.totalTokens ? Math.round((e.localTokens / e.totalTokens) * 100) : 0;
  L.push(`  tokens: ${k(e.totalTokens)} total — local ${k(e.localTokens)} (${share}%), cloud ${k(e.cloudTokens)}; cached input ${k(e.cachedInputTokens)}`);
  const apiCostText = e.apiCostKnown
    ? `$${e.apiCostUsd.toFixed(4)}`
    : e.apiCostUsd > 0
      ? `$${e.apiCostUsd.toFixed(4)}+ (${e.unpricedCloudRequests} req unknown cost)`
      : `unknown (${e.unpricedCloudRequests} req without pricing configured)`;
  L.push(`  paid API cost (computed from usage × configured prices, not a bill): ${apiCostText}`);
  L.push(`  avoided API cost (est., local tokens at cheapest configured API price): ${e.avoidedApiCostUsd === undefined ? 'n/a (no API prices configured)' : `$${e.avoidedApiCostUsd.toFixed(4)}`}`);
  L.push(`  usage records by source: ${JSON.stringify(e.requestsBySource)}`);
  L.push(`  routing decisions: ${e.routing.decisions} (local ${e.routing.local}, cloud ${e.routing.cloud})`);
  L.push(`  events: ${JSON.stringify(e.events)}`);
  L.push(color.gray(`  ledger ${s.ledgerPath} · config ${s.configPath}`));
  return L.join('\n');
}
