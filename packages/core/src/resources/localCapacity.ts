import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ResourceLedger } from './ledger.js';

const execFileAsync = promisify(execFile);

/** Every value says where it came from; a missing measurement is undefined, never zero. */
export interface LocalCapacityReport {
  observedAt: string;
  memory?: { totalBytes: number; availableBytes: number; source: 'measured:/proc/meminfo' };
  gpu?: { name?: string; utilizationPercent?: number; temperatureC?: number; powerW?: number; memoryUsedBytes?: number; memoryTotalBytes?: number; source: 'measured:nvidia-smi' };
  runtimes: Array<{
    runtimeId: string;
    endpoint: string;
    reachable: boolean;
    loadedModels: Array<{ id: string; contextLength?: number }>;
    /** vLLM only: provider-reported scheduler state. */
    running?: number;
    waiting?: number;
    kvCacheUsage?: number;
    error?: string;
  }>;
  /** From the ledger: Wazir's own local requests. */
  inFlight: number;
  queued: number;
  tokensPerSecond?: number;
  throughputSamples: number;
}

const num = (v: string | undefined) => {
  if (v === undefined) return undefined;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : undefined;
};

export async function readMemInfo(file = '/proc/meminfo'): Promise<LocalCapacityReport['memory']> {
  try {
    const text = await readFile(file, 'utf8');
    const kb = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)?.[1]);
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    return Number.isFinite(total) && Number.isFinite(available)
      ? { totalBytes: total * 1024, availableBytes: available * 1024, source: 'measured:/proc/meminfo' }
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readNvidiaSmi(): Promise<LocalCapacityReport['gpu']> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name,utilization.gpu,temperature.gpu,power.draw,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 5_000 });
    const [name, util, temp, power, used, total] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
    const mib = (v: string) => { const n = num(v); return n === undefined ? undefined : n * 1024 * 1024; };
    return {
      name, utilizationPercent: num(util), temperatureC: num(temp), powerW: num(power),
      // On unified-memory systems (GB10) nvidia-smi reports [N/A] for memory: left undefined.
      memoryUsedBytes: mib(used), memoryTotalBytes: mib(total), source: 'measured:nvidia-smi',
    };
  } catch {
    return undefined;
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export interface LocalEndpoint { runtimeId: string; kind: 'lmstudio' | 'ollama' | 'vllm' | 'openai-compatible'; baseUrl: string }

/** Probes a local inference server for loaded models (and vLLM scheduler metrics). */
export async function probeEndpoint(e: LocalEndpoint): Promise<LocalCapacityReport['runtimes'][number]> {
  const base = e.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const out: LocalCapacityReport['runtimes'][number] = { runtimeId: e.runtimeId, endpoint: base, reachable: false, loadedModels: [] };
  try {
    if (e.kind === 'lmstudio') {
      const data = await getJson(`${base}/api/v0/models`) as { data?: Array<{ id: string; state?: string; loaded_context_length?: number; max_context_length?: number }> };
      out.loadedModels = (data.data ?? []).filter((m) => m.state === 'loaded').map((m) => ({ id: m.id, contextLength: m.loaded_context_length ?? m.max_context_length }));
    } else if (e.kind === 'ollama') {
      const data = await getJson(`${base}/api/ps`) as { models?: Array<{ name: string; context_length?: number }> };
      out.loadedModels = (data.models ?? []).map((m) => ({ id: m.name, contextLength: m.context_length }));
    } else {
      const data = await getJson(`${base}/v1/models`) as { data?: Array<{ id: string; max_model_len?: number }> };
      out.loadedModels = (data.data ?? []).map((m) => ({ id: m.id, contextLength: m.max_model_len }));
      if (e.kind === 'vllm') {
        const metrics = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(3_000) }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
        const metric = (name: string) => num(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, 'm').exec(metrics)?.[1]);
        out.running = metric('vllm:num_requests_running');
        out.waiting = metric('vllm:num_requests_waiting');
        out.kvCacheUsage = metric('vllm:gpu_cache_usage_perc') ?? metric('vllm:kv_cache_usage_perc');
      }
    }
    out.reachable = true;
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
  }
  return out;
}

/**
 * One on-demand snapshot of local capacity: unified memory, GPU, inference servers, and
 * Wazir's own measured local throughput and queue (from the ledger). Nothing here polls.
 */
export async function localCapacity(endpoints: LocalEndpoint[], ledger?: ResourceLedger, localAccountIds: string[] = []): Promise<LocalCapacityReport> {
  const [memory, gpu, runtimes] = await Promise.all([readMemInfo(), readNvidiaSmi(), Promise.all(endpoints.map(probeEndpoint))]);
  let inFlight = 0;
  let tokensPerSecond: number | undefined;
  let samples = 0;
  let queued = 0;
  if (ledger) {
    const now = ledger.now();
    for (const id of localAccountIds) inFlight += ledger.inFlight(id, now);
    queued = ledger.events({ kind: 'deferred', since: now - 60_000, limit: 500 }).filter((e) => localAccountIds.includes(e.accountId ?? '')).length;
    const rows = ledger.usageRows({ since: now - 24 * 3_600_000 }).filter((u) => u.local && u.durationMs && u.outputTokens > 20 && u.source === 'provider-reported');
    samples = rows.length;
    if (rows.length) tokensPerSecond = rows.reduce((n, u) => n + u.outputTokens / (u.durationMs! / 1000), 0) / rows.length;
  }
  return { observedAt: new Date().toISOString(), memory, gpu, runtimes, inFlight, queued, tokensPerSecond, throughputSamples: samples };
}
