import type { ModelInstance, ModelRegistry, RuntimeRegistry } from '@wazir/core';
import { errorMessage, isHostedAdapter, isHostedInstance, resolveAdapter } from './hosting.js';
import type { ProbeAdapter, ProbeAdapterResolver, ProbeGenerationEvent, ProbeOptions, ReadinessProbe, ReadinessRecord } from './types.js';

export interface RuntimeReadinessProbeOptions {
  models: ModelRegistry;
  runtimes?: RuntimeRegistry;
  adapters?: ProbeAdapterResolver;
  /** Successful readiness is trusted for this long. Default 10 minutes. */
  ttlMs?: number;
  /** Per-probe deadline (generation + optional tool probe each). Default 20 s. */
  timeoutMs?: number;
  /** Max tokens the probe may generate. Default 32. */
  maxTokens?: number;
  clock?: () => Date;
  /** Called with every new record (e.g. to persist it). */
  onRecord?: (record: ReadinessRecord) => void;
}

const UNPROBEABLE_STATES = new Set(['DRAINING', 'UNLOADING', 'UNAVAILABLE', 'LOADING']);
const PROBE_PROMPT = 'Reply with the single word OK.';
const TOOL_NAME = 'report_status';

const key = (modelId: string, instanceId: string) => `${modelId}\u0000${instanceId}`;

class ProbeTimeout extends Error {
  constructor(ms: number) {
    super(`probe timed out after ${ms}ms`);
  }
}

/**
 * Verifies that a model instance can actually generate (and optionally call a
 * tool) by sending a tiny real request through its local runtime adapter.
 *
 * A worker or runtime reporting "healthy" is never treated as readiness: only a
 * completed generation with non-empty answer text is. Hosted (paid) runtimes are
 * never probed; their readiness can only come from external evidence such as a
 * successful routed execution (`record()`).
 */
export class RuntimeReadinessProbe implements ReadinessProbe {
  readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;
  private readonly clock: () => Date;
  private readonly records = new Map<string, ReadinessRecord>();
  private readonly inflight = new Map<string, Promise<ReadinessRecord>>();
  private seq = 0;

  constructor(private readonly options: RuntimeReadinessProbeOptions) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxTokens = options.maxTokens ?? 32;
    this.clock = options.clock ?? (() => new Date());
    if (!(this.ttlMs > 0)) throw new Error('readiness ttlMs must be > 0');
    if (!(this.timeoutMs > 0)) throw new Error('readiness timeoutMs must be > 0');
  }

  isFresh(record: ReadinessRecord | undefined): boolean {
    if (!record || !record.ready) return false;
    const age = this.clock().getTime() - Date.parse(record.checkedAt);
    return Number.isFinite(age) && age >= 0 && age <= this.ttlMs;
  }

  status(modelId: string, instanceId?: string): ReadinessRecord | undefined {
    if (instanceId) return this.records.get(key(modelId, instanceId));
    const all = [...this.records.values()].filter((r) => r.modelId === modelId);
    all.sort((a, b) => Number(this.isFresh(b)) - Number(this.isFresh(a)) || Date.parse(b.checkedAt) - Date.parse(a.checkedAt) || a.instanceId.localeCompare(b.instanceId));
    return all[0];
  }

  record(record: ReadinessRecord): void {
    const existing = this.records.get(key(record.modelId, record.instanceId));
    // Never let an older observation overwrite a newer one (e.g. hydration after a live probe).
    if (existing && Date.parse(existing.checkedAt) > Date.parse(record.checkedAt)) return;
    this.records.set(key(record.modelId, record.instanceId), { ...record });
    this.options.onRecord?.({ ...record });
  }

  invalidate(modelId: string, instanceId?: string, reason = 'invalidated'): void {
    const now = this.clock().toISOString();
    for (const [k, r] of this.records) {
      if (r.modelId !== modelId || (instanceId && r.instanceId !== instanceId)) continue;
      const next: ReadinessRecord = { ...r, ready: false, checkedAt: now, reason: `readiness invalidated: ${reason}`, latencyMs: undefined };
      this.records.set(k, next);
      this.options.onRecord?.({ ...next });
    }
  }

  list(): ReadinessRecord[] {
    return [...this.records.values()].sort((a, b) => a.modelId.localeCompare(b.modelId) || a.instanceId.localeCompare(b.instanceId));
  }

  /** The instance a model-level probe targets: local, probeable, resident first. */
  selectInstance(modelId: string): ModelInstance | undefined {
    const record = this.options.models.get(modelId);
    return this.options.models
      .instancesOf(modelId)
      .filter((i) => !isHostedInstance(i, this.options.runtimes?.get(i.runtimeId), record))
      .filter((i) => !UNPROBEABLE_STATES.has(i.state ?? '') && i.health !== 'unavailable')
      .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0];
  }

  async probe(target: { modelId: string; instanceId?: string }, options: ProbeOptions = {}): Promise<ReadinessRecord> {
    const record = this.options.models.get(target.modelId);
    const instance = target.instanceId
      ? this.options.models.instancesOf(target.modelId).find((i) => i.id === target.instanceId)
      : this.selectInstance(target.modelId);
    const now = () => this.clock().toISOString();
    const base = (inst: Pick<ModelInstance, 'id' | 'runtimeId' | 'computerId' | 'runtimeModelId'> | undefined, ready: boolean, reason: string): ReadinessRecord => ({
      modelId: target.modelId,
      instanceId: inst?.id ?? target.instanceId ?? '(none)',
      runtimeId: inst?.runtimeId ?? '(none)',
      runtimeModelId: inst?.runtimeModelId,
      computerId: inst?.computerId,
      ready,
      checkedAt: now(),
      source: 'probe',
      generation: 'untested',
      toolUse: 'untested',
      reason,
    });

    if (!record) return base(undefined, false, `model '${target.modelId}' is not registered`);
    if (!instance) return base(undefined, false, target.instanceId ? `instance '${target.instanceId}' is not registered` : 'no probeable local instance');

    const runtime = this.options.runtimes?.get(instance.runtimeId);
    const adapter = resolveAdapter(this.options.adapters, instance.runtimeId);
    // Hosted guard: never a paid call, not even for readiness. Not cached, so external evidence stays authoritative.
    if (isHostedInstance(instance, runtime, record) || isHostedAdapter(adapter) || (runtime && runtime.runtimeKind === 'hosted')) {
      return base(instance, false, 'hosted runtime not probed: readiness probes never call paid/hosted providers');
    }
    if (UNPROBEABLE_STATES.has(instance.state ?? '')) return base(instance, false, `instance is ${instance.state}`);
    if (!adapter) return base(instance, false, `no runtime adapter for '${instance.runtimeId}'`);

    const wantTools = options.tools ?? record.toolCalling;
    const k = key(target.modelId, instance.id);
    const cached = this.records.get(k);
    if (!options.force && this.isFresh(cached) && (!wantTools || cached!.toolUse !== 'untested')) return { ...cached! };
    const running = this.inflight.get(k);
    if (running) return running;

    const task = this.runProbe(adapter, instance, base(instance, false, 'probing'), wantTools && record.toolCalling).then((result) => {
      this.record(result);
      return result;
    }).finally(() => this.inflight.delete(k));
    this.inflight.set(k, task);
    return task;
  }

  private async runProbe(adapter: ProbeAdapter, instance: ModelInstance, result: ReadinessRecord, withTools: boolean): Promise<ReadinessRecord> {
    const started = Date.now();
    try {
      const gen = await this.collect(adapter, instance, false);
      result.latencyMs = Date.now() - started;
      if (gen.error && !gen.completed) {
        return { ...result, checkedAt: this.clock().toISOString(), generation: 'failed', ready: false, error: gen.error, reason: `generation failed: ${gen.error}` };
      }
      const text = gen.text.trim();
      if (!gen.completed || text.length === 0) {
        const why = !gen.completed ? 'stream ended without completion' : gen.reasoning ? 'model produced reasoning but no answer text' : 'empty answer text';
        return { ...result, checkedAt: this.clock().toISOString(), generation: 'failed', ready: false, reason: `generation failed: ${why}`, outputExcerpt: gen.reasoning.slice(0, 120) || undefined };
      }
      result.generation = 'verified';
      result.ready = true;
      result.outputExcerpt = text.slice(0, 120);
      result.reason = `generated ${text.length} chars in ${result.latencyMs}ms`;
      if (withTools) {
        try {
          const tool = await this.collect(adapter, instance, true);
          result.toolUse = tool.toolCalled ? 'verified' : 'failed';
          result.reason += tool.toolCalled ? '; tool call verified' : `; tool call not produced${tool.error ? ` (${tool.error})` : ''}`;
        } catch (error) {
          result.toolUse = 'failed';
          result.reason += `; tool probe failed: ${errorMessage(error)}`;
        }
      }
      result.checkedAt = this.clock().toISOString();
      return result;
    } catch (error) {
      return {
        ...result,
        checkedAt: this.clock().toISOString(),
        latencyMs: Date.now() - started,
        ready: false,
        generation: 'failed',
        error: errorMessage(error),
        reason: `generation failed: ${errorMessage(error)}`,
      };
    }
  }

  private async collect(adapter: ProbeAdapter, instance: ModelInstance, tools: boolean): Promise<{ text: string; reasoning: string; completed: boolean; toolCalled: boolean; error?: string }> {
    const controller = new AbortController();
    const deadlineAt = Date.now() + this.timeoutMs;
    const out = { text: '', reasoning: '', completed: false, toolCalled: false, error: undefined as string | undefined };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ProbeTimeout(this.timeoutMs));
      }, this.timeoutMs);
      timer.unref?.();
    });
    const consume = (async () => {
      const stream = adapter.generate({
        modelId: instance.runtimeModelId || instance.modelId,
        messages: [{ role: 'user', content: tools ? `Call the ${TOOL_NAME} tool with status "ok". Do not answer in text.` : PROBE_PROMPT }],
        maxTokens: tools ? Math.max(this.maxTokens, 128) : this.maxTokens,
        temperature: 0,
        seed: 1,
        stream: false,
        enableThinking: false,
        signal: controller.signal,
        requestId: `goal-studio-probe-${++this.seq}`,
        executionLimits: { maxModelCalls: 1, deadlineAt },
        resourceContext: { workload: 'deterministic', agent: 'goal-studio-readiness-probe' },
        ...(tools
          ? {
              tools: [{ name: TOOL_NAME, description: 'Report probe status.', parameters: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } }],
              toolChoice: 'auto' as const,
            }
          : {}),
      });
      for await (const event of stream as AsyncIterable<ProbeGenerationEvent>) {
        if (event.type === 'token' && event.content) out.text += event.content;
        else if (event.type === 'reasoning' && event.content) out.reasoning += event.content;
        else if (event.type === 'tool_call' && event.toolName === TOOL_NAME) out.toolCalled = true;
        else if (event.type === 'error') out.error = event.error ?? 'runtime reported an error';
        else if (event.type === 'completed') {
          out.completed = true;
          if (!out.text && event.content) out.text = event.content;
        }
      }
    })();
    try {
      await Promise.race([consume, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      consume.catch(() => undefined);
    }
    return out;
  }
}

function rank(i: ModelInstance): number {
  if (i.loaded && i.state === 'READY') return 0;
  if (i.loaded) return 1;
  return 2;
}

export function createReadinessProbe(options: RuntimeReadinessProbeOptions): RuntimeReadinessProbe {
  return new RuntimeReadinessProbe(options);
}
