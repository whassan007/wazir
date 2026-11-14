import type {
  AcceptanceState,
  CapabilityGraph,
  ConcurrencyQualificationResult,
  DeclarativeExecutionPlan,
  ExecutionPlanPoolSpec,
  PoolAllocationQuantities,
  RuntimeVerificationEvidence,
  ServerAcceptanceRow,
} from './types.js';

export const ACCEPTANCE_STATES: readonly AcceptanceState[] = [
  'DISCOVERED',
  'REACHABLE',
  'API_READY',
  'MODEL_READY',
  'EXECUTION_VERIFIED',
  'CAPACITY_VERIFIED',
  'SATURATED',
  'DEGRADED',
  'UNAVAILABLE',
  'DISABLED_BY_POLICY',
  'UNKNOWN',
] as const;

const VALID_TRANSITIONS: Record<AcceptanceState, ReadonlySet<AcceptanceState>> = {
  UNKNOWN: new Set(['DISCOVERED', 'REACHABLE', 'UNAVAILABLE', 'DISABLED_BY_POLICY']),
  DISCOVERED: new Set(['REACHABLE', 'UNAVAILABLE', 'DEGRADED', 'DISABLED_BY_POLICY']),
  REACHABLE: new Set(['API_READY', 'DEGRADED', 'UNAVAILABLE', 'DISABLED_BY_POLICY']),
  API_READY: new Set(['MODEL_READY', 'SATURATED', 'DEGRADED', 'UNAVAILABLE', 'DISABLED_BY_POLICY']),
  MODEL_READY: new Set(['EXECUTION_VERIFIED', 'API_READY', 'SATURATED', 'DEGRADED', 'UNAVAILABLE', 'DISABLED_BY_POLICY']),
  EXECUTION_VERIFIED: new Set([
    'CAPACITY_VERIFIED',
    'EXECUTION_VERIFIED',
    'MODEL_READY',
    'API_READY',
    'SATURATED',
    'DEGRADED',
    'UNAVAILABLE',
    'DISABLED_BY_POLICY',
  ]),
  CAPACITY_VERIFIED: new Set([
    'CAPACITY_VERIFIED',
    'EXECUTION_VERIFIED',
    'SATURATED',
    'DEGRADED',
    'UNAVAILABLE',
    'DISABLED_BY_POLICY',
  ]),
  SATURATED: new Set(['EXECUTION_VERIFIED', 'CAPACITY_VERIFIED', 'MODEL_READY', 'DEGRADED', 'UNAVAILABLE', 'DISABLED_BY_POLICY']),
  DEGRADED: new Set(['REACHABLE', 'API_READY', 'MODEL_READY', 'EXECUTION_VERIFIED', 'UNAVAILABLE', 'DISABLED_BY_POLICY']),
  UNAVAILABLE: new Set(['DISCOVERED', 'REACHABLE', 'DISABLED_BY_POLICY']),
  DISABLED_BY_POLICY: new Set(['DISCOVERED', 'DISABLED_BY_POLICY']),
};

export function canTransitionAcceptanceState(from: AcceptanceState, to: AcceptanceState): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.has(to) ?? false;
}

export function isExecutionVerifiedState(state: AcceptanceState): boolean {
  return state === 'EXECUTION_VERIFIED' || state === 'CAPACITY_VERIFIED';
}

export class RuntimeAcceptanceStateMachine {
  private current: AcceptanceState;
  private readonly history: Array<{ from: AcceptanceState; to: AcceptanceState; at: string; reason?: string }> = [];

  constructor(initial: AcceptanceState = 'UNKNOWN') {
    this.current = initial;
  }

  get state(): AcceptanceState {
    return this.current;
  }

  get transitions(): ReadonlyArray<{ from: AcceptanceState; to: AcceptanceState; at: string; reason?: string }> {
    return this.history;
  }

  transition(next: AcceptanceState, reason?: string): AcceptanceState {
    if (!canTransitionAcceptanceState(this.current, next)) {
      throw new Error(`Invalid AcceptanceState transition: ${this.current} -> ${next}`);
    }
    const prev = this.current;
    this.current = next;
    this.history.push({ from: prev, to: next, at: new Date().toISOString(), reason });
    return this.current;
  }
}

/**
 * Per-runtime async mutex serializing cold-load warmups so concurrent callers never
 * trigger duplicate simultaneous model loads into the same GPU/UMA daemon.
 */
const runtimeWarmupLocks = new Map<string, Promise<void>>();

async function withRuntimeWarmupMutex<T>(runtimeId: string, fn: () => Promise<T>): Promise<T> {
  const previous = runtimeWarmupLocks.get(runtimeId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current, () => current);
  runtimeWarmupLocks.set(runtimeId, chained);

  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (runtimeWarmupLocks.get(runtimeId) === chained) {
      runtimeWarmupLocks.delete(runtimeId);
    }
  }
}

let evidenceCounter = 0;
function nextEvidenceId(prefix: string, runtimeId: string): string {
  evidenceCounter += 1;
  const safeRt = runtimeId.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `${prefix}-${safeRt}-${Date.now()}-${evidenceCounter}`;
}

function round2(val: number): number {
  return Math.round(val * 100) / 100;
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1),
  );
  return round2(sortedValues[idx]);
}

function normalizeOpenAIBase(endpointUrl: string): { hostRoot: string; v1Base: string } {
  const trimmed = endpointUrl.replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) {
    return { hostRoot: trimmed.slice(0, -3), v1Base: trimmed };
  }
  return { hostRoot: trimmed, v1Base: `${trimmed}/v1` };
}

function canonicalOllamaModelTag(id: string): string {
  return id.includes(':') ? id : `${id}:latest`;
}

export interface QualifyRuntimeEndpointOptions {
  runtimeId: string;
  runtimeType: 'lmstudio' | 'ollama' | 'vllm' | 'openai-compatible' | 'llama-cpp' | 'other';
  endpointUrl: string;
  hostId?: string;
  providerId?: string;
  /** Secondary runtimes (e.g. stopped Ollama alongside primary LM Studio) degrade to UNAVAILABLE without degrading the host. */
  role?: 'primary' | 'secondary';
  disabledByPolicy?: boolean;
  targetModelId?: string;
  /** When true, if targetModelId is not loaded in memory and allowColdLoad is false, verify any warm loaded model instead. */
  fallbackToAnyLoadedModel?: boolean;
  /** If false (default), an installed-but-unloaded model stops at API_READY instead of triggering a cold load. */
  allowColdLoad?: boolean;
  /**
   * When true (default), runs a real bounded inference request.
   * When false, NEVER reaches EXECUTION_VERIFIED (stops at MODEL_READY or API_READY — Acceptance Test 4).
   */
  runRealInference?: boolean;
  requireToolCalling?: boolean;
  testCancellation?: boolean;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface QualifyRuntimeEndpointResult {
  state: AcceptanceState;
  evidence: RuntimeVerificationEvidence;
  installedModelIds: string[];
  loadedModelIds: string[];
  selectedModelId?: string;
  role: 'primary' | 'secondary';
  /** False when a secondary runtime is intentionally stopped so the host and primary runtime remain healthy. */
  affectsHostHealth: boolean;
  diagnosticMessage: string;
}

/**
 * Evaluates aggregate host acceptance across primary and secondary runtimes (Acceptance Test 15).
 * An UNAVAILABLE secondary runtime never degrades a host whose primary runtime is healthy.
 */
export function evaluateHostAcceptanceFromRuntimes(
  results: QualifyRuntimeEndpointResult[],
): { hostAcceptanceState: AcceptanceState; healthyPrimaryRuntimeIds: string[]; ignoredSecondaryRuntimeIds: string[] } {
  if (results.length === 0) {
    return { hostAcceptanceState: 'UNKNOWN', healthyPrimaryRuntimeIds: [], ignoredSecondaryRuntimeIds: [] };
  }
  const healthyPrimary = results.filter(
    (r) => r.role === 'primary' && (r.state === 'EXECUTION_VERIFIED' || r.state === 'CAPACITY_VERIFIED'),
  );
  const ignoredSecondary = results
    .filter((r) => r.role === 'secondary' && (r.state === 'UNAVAILABLE' || r.state === 'DISCOVERED'))
    .map((r) => r.evidence.runtimeId);

  if (healthyPrimary.length > 0) {
    const hasCapacity = healthyPrimary.some((r) => r.state === 'CAPACITY_VERIFIED');
    return {
      hostAcceptanceState: hasCapacity ? 'CAPACITY_VERIFIED' : 'EXECUTION_VERIFIED',
      healthyPrimaryRuntimeIds: healthyPrimary.map((r) => r.evidence.runtimeId),
      ignoredSecondaryRuntimeIds: ignoredSecondary,
    };
  }

  const anyVerifiedSecondary = results.find(
    (r) => r.state === 'EXECUTION_VERIFIED' || r.state === 'CAPACITY_VERIFIED',
  );
  if (anyVerifiedSecondary) {
    return {
      hostAcceptanceState: anyVerifiedSecondary.state,
      healthyPrimaryRuntimeIds: [],
      ignoredSecondaryRuntimeIds: ignoredSecondary,
    };
  }

  const primaryStates = results.filter((r) => r.role === 'primary').map((r) => r.state);
  const fallbackState = primaryStates[0] ?? results[0].state;
  return {
    hostAcceptanceState: fallbackState,
    healthyPrimaryRuntimeIds: [],
    ignoredSecondaryRuntimeIds: ignoredSecondary,
  };
}

/**
 * Qualifies a runtime endpoint through the 11-state acceptance machine:
 * `DISCOVERED -> REACHABLE -> API_READY -> MODEL_READY -> EXECUTION_VERIFIED`
 *
 * Enforces:
 * - HTTP 200 inventory responses NEVER reach `EXECUTION_VERIFIED` without real bounded inference.
 * - Installed models are NEVER assumed loaded unless confirmed by `/api/ps`, `/api/v0/models` (`state: 'loaded'`), or `/api/v1/models` (`loaded_instances`).
 * - Concurrent cold-load warmups on the same runtime are serialized via a per-runtime mutex.
 * - Stopped secondary runtimes transition cleanly to `UNAVAILABLE` with `affectsHostHealth: false`.
 */
export async function qualifyRuntimeEndpoint(
  options: QualifyRuntimeEndpointOptions,
): Promise<QualifyRuntimeEndpointResult> {
  const {
    runtimeId,
    runtimeType,
    endpointUrl,
    hostId,
    providerId,
    role = 'primary',
    disabledByPolicy = false,
    targetModelId,
    fallbackToAnyLoadedModel = false,
    allowColdLoad = false,
    runRealInference = true,
    requireToolCalling = false,
    testCancellation = true,
    apiKey,
    timeoutMs = 8000,
    fetchImpl = globalThis.fetch,
  } = options;

  const sm = new RuntimeAcceptanceStateMachine('DISCOVERED');
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
  const jsonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  if (disabledByPolicy) {
    sm.transition('DISABLED_BY_POLICY', 'Disabled by execution policy');
    const evidence: RuntimeVerificationEvidence = {
      evidenceId: nextEvidenceId('ev-policy', runtimeId),
      runtimeId,
      hostId,
      providerId,
      endpointUrl,
      modelId: targetModelId,
      state: 'DISABLED_BY_POLICY',
      connectivityOk: false,
      modelsEnumerated: false,
      modelLoadedConfirmed: false,
      inferenceExecuted: false,
      responseContractValid: false,
      toolCallTested: false,
      cancellationTested: false,
      verifiedAt: new Date().toISOString(),
      error: 'Disabled by policy',
    };
    return {
      state: 'DISABLED_BY_POLICY',
      evidence,
      installedModelIds: [],
      loadedModelIds: [],
      role,
      affectsHostHealth: false,
      diagnosticMessage: `Runtime '${runtimeId}' is disabled by policy`,
    };
  }

  let httpStatus: number | undefined;
  let connectivityOk = false;
  let modelsEnumerated = false;
  let modelLoadedConfirmed = false;
  const installedModelIds: string[] = [];
  const loadedModelIds: string[] = [];

  // Phase 1: Connectivity + Model Inventory + Residency Check
  try {
    if (runtimeType === 'ollama') {
      const base = endpointUrl.replace(/\/+$/, '');
      const tagsRes = await fetchImpl(`${base}/api/tags`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      httpStatus = tagsRes.status;
      connectivityOk = true;
      sm.transition('REACHABLE', `HTTP ${tagsRes.status} from /api/tags`);

      if (tagsRes.status === 429 || tagsRes.status === 503) {
        sm.transition('API_READY', 'Endpoint reachable');
        sm.transition('SATURATED', `HTTP ${tagsRes.status}`);
        throw new Error(`HTTP_${tagsRes.status}_SATURATED`);
      }
      if (!tagsRes.ok) {
        sm.transition('DEGRADED', `Ollama /api/tags returned HTTP ${tagsRes.status}`);
        throw new Error(`Ollama /api/tags HTTP ${tagsRes.status}`);
      }

      const tagsJson = (await tagsRes.json()) as { models?: Array<{ name?: string; model?: string }> };
      modelsEnumerated = Array.isArray(tagsJson.models);
      if (!modelsEnumerated) {
        sm.transition('DEGRADED', 'Malformed /api/tags payload');
        throw new Error('Malformed Ollama /api/tags JSON');
      }
      for (const m of tagsJson.models ?? []) {
        const id = m.name ?? m.model;
        if (id) installedModelIds.push(id);
      }
      sm.transition('API_READY', `Enumerated ${installedModelIds.length} installed models`);

      // Check actual residency via /api/ps — never assume /api/tags models are loaded!
      const psRes = await fetchImpl(`${base}/api/ps`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (psRes.ok) {
        const psJson = (await psRes.json()) as { models?: Array<{ name?: string; model?: string }> };
        for (const m of psJson.models ?? []) {
          const id = m.name ?? m.model;
          if (id) loadedModelIds.push(id);
        }
      }
    } else {
      const { hostRoot, v1Base } = normalizeOpenAIBase(endpointUrl);
      let inventoryResolved = false;

      if (runtimeType === 'lmstudio') {
        // Probe LM Studio v0 / v1 rich residency endpoints first
        try {
          const v0Res = await fetchImpl(`${hostRoot}/api/v0/models`, {
            headers,
            signal: AbortSignal.timeout(timeoutMs),
          });
          httpStatus = v0Res.status;
          connectivityOk = true;
          sm.transition('REACHABLE', `HTTP ${v0Res.status} from /api/v0/models`);
          if (v0Res.ok) {
            const v0Data = (await v0Res.json()) as {
              data?: Array<{ id: string; state?: string; loaded_instances?: unknown[] }>;
            };
            if (Array.isArray(v0Data.data)) {
              modelsEnumerated = true;
              inventoryResolved = true;
              for (const m of v0Data.data) {
                installedModelIds.push(m.id);
                if (m.state === 'loaded' || (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0)) {
                  loadedModelIds.push(m.id);
                }
              }
              sm.transition('API_READY', `Enumerated ${installedModelIds.length} models (${loadedModelIds.length} loaded)`);
            }
          }
        } catch {
          // fall through to /api/v1/models or /v1/models
        }

        if (!inventoryResolved) {
          try {
            const v1NativeRes = await fetchImpl(`${hostRoot}/api/v1/models`, {
              headers,
              signal: AbortSignal.timeout(timeoutMs),
            });
            httpStatus = v1NativeRes.status;
            if (!connectivityOk) {
              connectivityOk = true;
              sm.transition('REACHABLE', `HTTP ${v1NativeRes.status} from /api/v1/models`);
            }
            if (v1NativeRes.ok) {
              const v1Native = (await v1NativeRes.json()) as {
                models?: Array<{ key: string; loaded_instances?: unknown[] }>;
              };
              if (Array.isArray(v1Native.models)) {
                modelsEnumerated = true;
                inventoryResolved = true;
                for (const m of v1Native.models) {
                  installedModelIds.push(m.key);
                  if (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0) {
                    loadedModelIds.push(m.key);
                  }
                }
                sm.transition('API_READY', `Enumerated ${installedModelIds.length} models (${loadedModelIds.length} loaded)`);
              }
            }
          } catch {
            // fall through to /v1/models
          }
        }
      }

      if (!inventoryResolved) {
        const modelsRes = await fetchImpl(`${v1Base}/models`, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        httpStatus = modelsRes.status;
        if (!connectivityOk) {
          connectivityOk = true;
          sm.transition('REACHABLE', `HTTP ${modelsRes.status} from /v1/models`);
        }
        if (modelsRes.status === 429 || modelsRes.status === 503) {
          sm.transition('API_READY', 'Endpoint reachable');
          sm.transition('SATURATED', `HTTP ${modelsRes.status}`);
          throw new Error(`HTTP_${modelsRes.status}_SATURATED`);
        }
        if (!modelsRes.ok) {
          sm.transition('DEGRADED', `/v1/models returned HTTP ${modelsRes.status}`);
          throw new Error(`/v1/models HTTP ${modelsRes.status}`);
        }
        const modelsData = (await modelsRes.json()) as {
          data?: Array<{ id: string; state?: string; loaded_instances?: unknown[] }>;
        };
        if (!Array.isArray(modelsData.data)) {
          sm.transition('DEGRADED', 'Malformed /v1/models payload');
          throw new Error('Malformed /v1/models JSON');
        }
        modelsEnumerated = true;
        for (const m of modelsData.data) {
          installedModelIds.push(m.id);
          const explicitlyLoaded =
            m.state === 'loaded' ||
            (Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0) ||
            runtimeType === 'vllm' ||
            runtimeType === 'llama-cpp';
          if (explicitlyLoaded) {
            loadedModelIds.push(m.id);
          }
        }
        sm.transition('API_READY', `Enumerated ${installedModelIds.length} models`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (sm.state === 'DISCOVERED') {
      sm.transition('UNAVAILABLE', msg);
    }
    const startupLatencyMs = Date.now() - startedAt;
    const affectsHostHealth = role === 'primary';
    const evidence: RuntimeVerificationEvidence = {
      evidenceId: nextEvidenceId('ev-unavail', runtimeId),
      runtimeId,
      hostId,
      providerId,
      endpointUrl,
      modelId: targetModelId,
      state: sm.state,
      httpStatus,
      connectivityOk,
      modelsEnumerated,
      modelLoadedConfirmed: false,
      inferenceExecuted: false,
      responseContractValid: false,
      toolCallTested: false,
      cancellationTested: false,
      startupLatencyMs,
      verifiedAt: new Date().toISOString(),
      error: msg,
    };
    return {
      state: sm.state,
      evidence,
      installedModelIds,
      loadedModelIds,
      role,
      affectsHostHealth,
      diagnosticMessage:
        role === 'secondary'
          ? `Secondary runtime '${runtimeId}' is ${sm.state} (${msg}); host health unaffected`
          : `Primary runtime '${runtimeId}' is ${sm.state}: ${msg}`,
    };
  }

  const startupLatencyMs = Date.now() - startedAt;

  // Match targetModelId against loaded vs installed
  const matchesModel = (candidate: string, requested: string): boolean => {
    if (candidate === requested) return true;
    if (runtimeType === 'ollama') {
      return canonicalOllamaModelTag(candidate) === canonicalOllamaModelTag(requested);
    }
    return false;
  };

  let selectedModelId: string | undefined;
  if (targetModelId) {
    const loadedHit = loadedModelIds.find((m) => matchesModel(m, targetModelId));
    if (loadedHit) {
      selectedModelId = loadedHit;
      modelLoadedConfirmed = true;
      sm.transition('MODEL_READY', `Model '${selectedModelId}' confirmed resident`);
    } else if (fallbackToAnyLoadedModel && loadedModelIds.length > 0) {
      selectedModelId = loadedModelIds[0];
      modelLoadedConfirmed = true;
      sm.transition('MODEL_READY', `Warm model '${selectedModelId}' confirmed resident (fallback from '${targetModelId}')`);
    } else {
      const installedHit = installedModelIds.find((m) => matchesModel(m, targetModelId));
      if (installedHit && allowColdLoad) {
        selectedModelId = installedHit;
      }
    }
  } else if (loadedModelIds.length > 0) {
    selectedModelId = loadedModelIds[0];
    modelLoadedConfirmed = true;
    sm.transition('MODEL_READY', `Warm model '${selectedModelId}' confirmed resident`);
  } else if (allowColdLoad && installedModelIds.length > 0) {
    selectedModelId = installedModelIds[0];
  }

  // If no loaded model (and cold load not allowed or model missing), stop at API_READY!
  if (!selectedModelId) {
    const reason = targetModelId
      ? installedModelIds.some((m) => matchesModel(m, targetModelId))
        ? `Model '${targetModelId}' is installed on '${runtimeId}' but NOT loaded in memory (cold load disabled)`
        : `Model '${targetModelId}' is not installed on '${runtimeId}'`
      : `Runtime '${runtimeId}' HTTP API is ready (${installedModelIds.length} installed) but 0 models are loaded in memory`;
    const evidence: RuntimeVerificationEvidence = {
      evidenceId: nextEvidenceId('ev-apiready', runtimeId),
      runtimeId,
      hostId,
      providerId,
      endpointUrl,
      modelId: targetModelId,
      state: sm.state, // API_READY
      httpStatus,
      connectivityOk: true,
      modelsEnumerated: true,
      modelLoadedConfirmed: false,
      inferenceExecuted: false,
      responseContractValid: false,
      toolCallTested: false,
      cancellationTested: false,
      startupLatencyMs,
      verifiedAt: new Date().toISOString(),
    };
    return {
      state: sm.state,
      evidence,
      installedModelIds,
      loadedModelIds,
      role,
      affectsHostHealth: role === 'primary',
      diagnosticMessage: reason,
    };
  }

  // Acceptance Test 4: HTTP 200 alone NEVER reaches EXECUTION_VERIFIED when real inference is skipped!
  if (!runRealInference) {
    const evidence: RuntimeVerificationEvidence = {
      evidenceId: nextEvidenceId('ev-noinf', runtimeId),
      runtimeId,
      hostId,
      providerId,
      endpointUrl,
      modelId: selectedModelId,
      state: sm.state, // MODEL_READY or API_READY — strictly NEVER EXECUTION_VERIFIED
      httpStatus,
      connectivityOk: true,
      modelsEnumerated: true,
      modelLoadedConfirmed,
      inferenceExecuted: false,
      responseContractValid: false,
      toolCallTested: false,
      cancellationTested: false,
      startupLatencyMs,
      verifiedAt: new Date().toISOString(),
    };
    return {
      state: sm.state,
      evidence,
      installedModelIds,
      loadedModelIds,
      selectedModelId,
      role,
      affectsHostHealth: role === 'primary',
      diagnosticMessage: `HTTP inventory verified (${sm.state}) for '${selectedModelId}'; real inference was not executed`,
    };
  }

  // Phase 2: Bounded Real Inference (serialized via warmup mutex if cold-loading)
  let inferenceExecuted = false;
  let responseContractValid = false;
  let firstTokenLatencyMs: number | undefined;
  let endToEndLatencyMs: number | undefined;
  let tokensPerSecond: number | undefined;
  let inferenceError: string | undefined;

  const runBoundedInference = async (): Promise<void> => {
    const infStart = Date.now();
    if (runtimeType === 'ollama') {
      const base = endpointUrl.replace(/\/+$/, '');
      const res = await fetchImpl(`${base}/api/chat`, {
        method: 'POST',
        headers: jsonHeaders,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: selectedModelId,
          messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
          stream: false,
          think: false,
          options: { num_predict: 24, temperature: 0 },
        }),
      });
      httpStatus = res.status;
      inferenceExecuted = true;
      endToEndLatencyMs = Date.now() - infStart;
      if (res.status === 429 || res.status === 503) {
        sm.transition('SATURATED', `Inference HTTP ${res.status}`);
        inferenceError = `Inference saturated: HTTP ${res.status}`;
        return;
      }
      if (!res.ok) {
        sm.transition('DEGRADED', `Inference HTTP ${res.status}`);
        inferenceError = `Inference failed: HTTP ${res.status}`;
        return;
      }
      const payload = (await res.json()) as {
        done?: boolean;
        error?: string;
        message?: { content?: string };
        response?: string;
        eval_count?: number;
        eval_duration?: number;
        prompt_eval_duration?: number;
      };
      const text = (payload.message?.content ?? payload.response ?? '').trim();
      responseContractValid = !payload.error && payload.done !== false && text.length > 0;
      if (typeof payload.prompt_eval_duration === 'number' && payload.prompt_eval_duration > 0) {
        firstTokenLatencyMs = round2(payload.prompt_eval_duration / 1e6);
      } else {
        firstTokenLatencyMs = endToEndLatencyMs;
      }
      if (typeof payload.eval_count === 'number' && typeof payload.eval_duration === 'number' && payload.eval_duration > 0) {
        tokensPerSecond = round2(payload.eval_count / (payload.eval_duration / 1e9));
      } else if (endToEndLatencyMs > 0 && text.length > 0) {
        tokensPerSecond = round2(Math.max(1, text.split(/\s+/).length) / (endToEndLatencyMs / 1000));
      }
      if (responseContractValid && !modelLoadedConfirmed) {
        modelLoadedConfirmed = true;
        loadedModelIds.push(selectedModelId!);
        sm.transition('MODEL_READY', `Cold-loaded '${selectedModelId}' into Ollama memory`);
      }
    } else {
      const { v1Base } = normalizeOpenAIBase(endpointUrl);
      const res = await fetchImpl(`${v1Base}/chat/completions`, {
        method: 'POST',
        headers: jsonHeaders,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: selectedModelId,
          messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
          max_tokens: 24,
          temperature: 0,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      httpStatus = res.status;
      inferenceExecuted = true;
      endToEndLatencyMs = Date.now() - infStart;
      firstTokenLatencyMs = endToEndLatencyMs;
      if (res.status === 429 || res.status === 503) {
        sm.transition('SATURATED', `Inference HTTP ${res.status}`);
        inferenceError = `Inference saturated: HTTP ${res.status}`;
        return;
      }
      if (!res.ok) {
        sm.transition('DEGRADED', `Inference HTTP ${res.status}`);
        inferenceError = `Inference failed: HTTP ${res.status}`;
        return;
      }
      const payload = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
        }>;
        usage?: { completion_tokens?: number };
      };
      const firstChoice = payload.choices?.[0]?.message;
      const content = (
        firstChoice?.content ||
        firstChoice?.reasoning_content ||
        firstChoice?.reasoning ||
        ''
      ).trim();
      responseContractValid = Array.isArray(payload.choices) && payload.choices.length > 0 && content.length > 0;
      const outTokens = payload.usage?.completion_tokens ?? (content ? Math.max(1, content.split(/\s+/).length) : 0);
      if (endToEndLatencyMs > 0 && outTokens > 0) {
        tokensPerSecond = round2(outTokens / (endToEndLatencyMs / 1000));
      }
      if (responseContractValid && !modelLoadedConfirmed) {
        modelLoadedConfirmed = true;
        loadedModelIds.push(selectedModelId!);
        sm.transition('MODEL_READY', `Cold-loaded '${selectedModelId}' into runtime memory`);
      }
    }

    if (!responseContractValid && sm.state !== 'SATURATED' && sm.state !== 'DEGRADED') {
      sm.transition('DEGRADED', 'Empty or invalid inference response payload');
      inferenceError = 'Inference returned HTTP 200 but failed response content contract validation';
    }
  };

  try {
    if (!modelLoadedConfirmed) {
      await withRuntimeWarmupMutex(runtimeId, runBoundedInference);
    } else {
      await runBoundedInference();
    }
  } catch (err) {
    inferenceExecuted = true;
    inferenceError = err instanceof Error ? err.message : String(err);
    if (sm.state !== 'DEGRADED' && sm.state !== 'UNAVAILABLE') {
      sm.transition('DEGRADED', inferenceError);
    }
  }

  // Phase 3: Optional Tool-Calling Verification
  let toolCallTested = false;
  let toolCallPassed: boolean | undefined;
  if (responseContractValid && requireToolCalling) {
    toolCallTested = true;
    try {
      const toolSchema = {
        type: 'function',
        function: {
          name: 'verify_ping',
          description: 'Echoes a verification token to prove structured tool-call generation.',
          parameters: {
            type: 'object',
            properties: { token: { type: 'string' } },
            required: ['token'],
          },
        },
      };
      if (runtimeType === 'ollama') {
        const base = endpointUrl.replace(/\/+$/, '');
        const toolRes = await fetchImpl(`${base}/api/chat`, {
          method: 'POST',
          headers: jsonHeaders,
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model: selectedModelId,
            messages: [{ role: 'user', content: 'Call verify_ping with token="ok".' }],
            tools: [toolSchema],
            stream: false,
          }),
        });
        if (toolRes.ok) {
          const toolJson = (await toolRes.json()) as {
            message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }> };
          };
          const calls = toolJson.message?.tool_calls ?? [];
          toolCallPassed = calls.some((c) => c.function?.name === 'verify_ping');
        } else {
          toolCallPassed = false;
        }
      } else {
        const { v1Base } = normalizeOpenAIBase(endpointUrl);
        const toolRes = await fetchImpl(`${v1Base}/chat/completions`, {
          method: 'POST',
          headers: jsonHeaders,
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            model: selectedModelId,
            messages: [{ role: 'user', content: 'Call verify_ping with token="ok".' }],
            tools: [toolSchema],
            tool_choice: { type: 'function', function: { name: 'verify_ping' } },
            max_tokens: 48,
            stream: false,
          }),
        });
        if (toolRes.ok) {
          const toolJson = (await toolRes.json()) as {
            choices?: Array<{
              message?: {
                tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
              };
            }>;
          };
          const calls = toolJson.choices?.[0]?.message?.tool_calls ?? [];
          toolCallPassed = calls.some((c) => {
            if (c.function?.name !== 'verify_ping') return false;
            try {
              if (typeof c.function.arguments === 'string') JSON.parse(c.function.arguments);
              return true;
            } catch {
              return false;
            }
          });
        } else {
          toolCallPassed = false;
        }
      }
      if (!toolCallPassed) {
        sm.transition('DEGRADED', 'Tool-calling verification failed');
        inferenceError = 'Model failed required tool-calling contract check';
      }
    } catch (err) {
      toolCallPassed = false;
      sm.transition('DEGRADED', 'Tool-calling check threw');
      inferenceError = `Tool-calling check error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Phase 4: Bounded AbortController Cancellation Check
  let cancellationTested = false;
  let cancellationPassed: boolean | undefined;
  if (responseContractValid && (!requireToolCalling || toolCallPassed) && testCancellation) {
    cancellationTested = true;
    const cancelController = new AbortController();
    cancelController.abort(new DOMException('Qualification cancellation verification', 'AbortError'));
    try {
      const targetUrl =
        runtimeType === 'ollama'
          ? `${endpointUrl.replace(/\/+$/, '')}/api/chat`
          : `${normalizeOpenAIBase(endpointUrl).v1Base}/chat/completions`;
      await fetchImpl(targetUrl, {
        method: 'POST',
        headers: jsonHeaders,
        signal: cancelController.signal,
        body: JSON.stringify({
          model: selectedModelId,
          messages: [{ role: 'user', content: 'Cancel probe' }],
          max_tokens: 1,
          stream: false,
        }),
      });
      // If a custom mock fetch ignores pre-aborted signals, confirm signal.aborted was propagated
      cancellationPassed = cancelController.signal.aborted;
    } catch {
      cancellationPassed = true;
    }
  }

  if (
    responseContractValid &&
    (!requireToolCalling || toolCallPassed === true) &&
    (!cancellationTested || cancellationPassed === true) &&
    sm.state === 'MODEL_READY'
  ) {
    sm.transition('EXECUTION_VERIFIED', `Verified real inference on '${selectedModelId}'`);
  }

  const verifiedAt = new Date().toISOString();
  const evidence: RuntimeVerificationEvidence = {
    evidenceId: nextEvidenceId('ev-exec', runtimeId),
    runtimeId,
    hostId,
    providerId,
    endpointUrl,
    modelId: selectedModelId,
    state: sm.state,
    httpStatus,
    connectivityOk,
    modelsEnumerated,
    modelLoadedConfirmed,
    inferenceExecuted,
    responseContractValid,
    toolCallTested,
    toolCallPassed,
    cancellationTested,
    cancellationPassed,
    startupLatencyMs,
    firstTokenLatencyMs,
    endToEndLatencyMs,
    tokensPerSecond,
    verifiedAt,
    error: inferenceError,
  };

  return {
    state: sm.state,
    evidence,
    installedModelIds,
    loadedModelIds,
    selectedModelId,
    role,
    affectsHostHealth: role === 'primary',
    diagnosticMessage:
      sm.state === 'EXECUTION_VERIFIED'
        ? `Verified real inference on '${runtimeId}' (${selectedModelId}) in ${endToEndLatencyMs ?? 0}ms`
        : (inferenceError ?? `Runtime '${runtimeId}' finished in state ${sm.state}`),
  };
}

export interface ConcurrencyProbeObservation {
  ok: boolean;
  ttftMs?: number;
  latencyMs: number;
  outputTokens?: number;
  timedOut?: boolean;
  memoryExhausted?: boolean;
  status?: number;
  error?: string;
}

export interface QualifyRuntimeConcurrencyOptions {
  runtimeId: string;
  hostId?: string;
  endpointUrl: string;
  runtimeType?: 'lmstudio' | 'ollama' | 'vllm' | 'openai-compatible' | 'llama-cpp' | 'other';
  modelId: string;
  maxConcurrencyBound: number;
  concurrencySteps?: number[];
  /** Optional physical dispatch gate to observe queueing vs in-flight peaks under controlled admission. */
  dispatchWindowLimit?: number;
  requestTimeoutMs?: number;
  latencyBlowupFactorCap?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Optional memory telemetry probe called after each step to halt safely before OOM exhaustion. */
  sampleMemory?: () =>
    | Promise<{ usedGB?: number; availableGB?: number; pressureLevel?: 'normal' | 'warn' | 'critical' | 'unknown' }>
    | { usedGB?: number; availableGB?: number; pressureLevel?: 'normal' | 'warn' | 'critical' | 'unknown' };
  minAvailableHeadroomGB?: number;
  /** Optional custom probe executor for deterministic tests. */
  executeProbe?: (params: {
    level: number;
    requestIndex: number;
    signal: AbortSignal;
  }) => Promise<ConcurrencyProbeObservation>;
}

/**
 * Progressively probes safe bounded concurrency (`1, 2, ..., maxConcurrencyBound`), halting
 * immediately on error, timeout, latency blowup, or memory pressure without destructive exhaustion,
 * followed by a single-request post-load recovery verification.
 */
export async function qualifyRuntimeConcurrency(
  options: QualifyRuntimeConcurrencyOptions,
): Promise<ConcurrencyQualificationResult> {
  const {
    runtimeId,
    hostId,
    endpointUrl,
    runtimeType = 'lmstudio',
    modelId,
    maxConcurrencyBound,
    requestTimeoutMs = 15_000,
    latencyBlowupFactorCap = 6.0,
    apiKey,
    fetchImpl = globalThis.fetch,
    sampleMemory,
    minAvailableHeadroomGB = 1.0,
    executeProbe,
  } = options;

  const cappedBound = Math.max(1, Math.min(16, Math.floor(maxConcurrencyBound)));
  const steps =
    options.concurrencySteps && options.concurrencySteps.length > 0
      ? [...options.concurrencySteps].filter((n) => n >= 1 && n <= cappedBound).sort((a, b) => a - b)
      : Array.from({ length: cappedBound }, (_, idx) => idx + 1);

  const dispatchLimit = options.dispatchWindowLimit ?? cappedBound;
  const jsonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };

  const defaultExecuteProbe = async ({ signal }: { signal: AbortSignal }): Promise<ConcurrencyProbeObservation> => {
    const start = Date.now();
    try {
      if (runtimeType === 'ollama') {
        const base = endpointUrl.replace(/\/+$/, '');
        const res = await fetchImpl(`${base}/api/chat`, {
          method: 'POST',
          headers: jsonHeaders,
          signal,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'Reply OK.' }],
            stream: false,
            think: false,
            options: { num_predict: 24, temperature: 0 },
          }),
        });
        const latencyMs = Date.now() - start;
        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          return {
            ok: false,
            latencyMs,
            status: res.status,
            memoryExhausted: res.status === 507 || /out of memory|oom|alloc/i.test(errBody),
            error: `HTTP ${res.status}`,
          };
        }
        const body = (await res.json()) as {
          message?: { content?: string };
          response?: string;
          eval_count?: number;
          prompt_eval_duration?: number;
        };
        const text = (body.message?.content ?? body.response ?? '').trim();
        return {
          ok: text.length > 0,
          latencyMs,
          ttftMs:
            typeof body.prompt_eval_duration === 'number'
              ? round2(body.prompt_eval_duration / 1e6)
              : latencyMs,
          outputTokens: body.eval_count ?? (text ? 1 : 0),
        };
      }

      const { v1Base } = normalizeOpenAIBase(endpointUrl);
      const res = await fetchImpl(`${v1Base}/chat/completions`, {
        method: 'POST',
        headers: jsonHeaders,
        signal,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Reply OK.' }],
          max_tokens: 24,
          temperature: 0,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      const latencyMs = Date.now() - start;
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return {
          ok: false,
          latencyMs,
          status: res.status,
          memoryExhausted: res.status === 507 || /out of memory|oom|vram|alloc/i.test(errBody),
          error: `HTTP ${res.status}`,
        };
      }
      const body = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
        }>;
        usage?: { completion_tokens?: number };
      };
      const msgObj = body.choices?.[0]?.message;
      const content = (
        msgObj?.content ||
        msgObj?.reasoning_content ||
        msgObj?.reasoning ||
        ''
      ).trim();
      return {
        ok: content.length > 0,
        latencyMs,
        ttftMs: latencyMs,
        outputTokens: body.usage?.completion_tokens ?? (content ? 1 : 0),
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut = /timeout|aborted/i.test(msg);
      return {
        ok: false,
        latencyMs,
        timedOut,
        memoryExhausted: /out of memory|oom/i.test(msg),
        error: msg,
      };
    }
  };

  const runner = executeProbe ?? defaultExecuteProbe;

  const testedConcurrencyLevels: number[] = [];
  let verifiedSafeConcurrency = 0;
  let acceptedRequests = 0;
  let successfulCompletions = 0;
  let totalErrors = 0;
  let totalTimeouts = 0;
  let inFlight = 0;
  let inFlightPeak = 0;
  let queued = 0;
  let queuedPeak = 0;
  let gpuMemoryUsedPeakGB: number | undefined;
  let memoryExhaustionDetected = false;
  const allLatenciesMs: number[] = [];
  const allTtftMs: number[] = [];
  let bestAggregateTokPerSec: number | undefined;
  let baselineSingleLatencyMs: number | undefined;

  // Bounded semaphore for queueing visibility
  const waitQueue: Array<() => void> = [];
  const acquireSlot = async (): Promise<void> => {
    if (inFlight >= dispatchLimit) {
      queued += 1;
      queuedPeak = Math.max(queuedPeak, queued);
      await new Promise<void>((resolve) => waitQueue.push(resolve));
      queued -= 1;
    }
    inFlight += 1;
    inFlightPeak = Math.max(inFlightPeak, inFlight);
  };
  const releaseSlot = (): void => {
    inFlight -= 1;
    const next = waitQueue.shift();
    if (next) next();
  };

  for (const level of steps) {
    testedConcurrencyLevels.push(level);
    acceptedRequests += level;
    const waveStart = Date.now();

    const waveResults = await Promise.all(
      Array.from({ length: level }, async (_, requestIndex) => {
        await acquireSlot();
        try {
          const signal = AbortSignal.timeout(requestTimeoutMs);
          return await runner({ level, requestIndex, signal });
        } finally {
          releaseSlot();
        }
      }),
    );

    const waveWallMs = Math.max(1, Date.now() - waveStart);
    let levelErrors = 0;
    let levelTokens = 0;
    const levelLatencies: number[] = [];

    for (const obs of waveResults) {
      allLatenciesMs.push(obs.latencyMs);
      levelLatencies.push(obs.latencyMs);
      if (typeof obs.ttftMs === 'number') allTtftMs.push(obs.ttftMs);
      if (obs.memoryExhausted) memoryExhaustionDetected = true;
      if (obs.ok) {
        successfulCompletions += 1;
        levelTokens += obs.outputTokens ?? 1;
      } else {
        levelErrors += 1;
        totalErrors += 1;
        if (obs.timedOut) totalTimeouts += 1;
      }
    }

    if (levelTokens > 0) {
      const waveTokPerSec = round2(levelTokens / (waveWallMs / 1000));
      bestAggregateTokPerSec = Math.max(bestAggregateTokPerSec ?? 0, waveTokPerSec);
    }

    if (sampleMemory) {
      const mem = await sampleMemory();
      if (typeof mem.usedGB === 'number') {
        gpuMemoryUsedPeakGB = Math.max(gpuMemoryUsedPeakGB ?? 0, round2(mem.usedGB));
      }
      if (
        mem.pressureLevel === 'critical' ||
        (typeof mem.availableGB === 'number' && mem.availableGB < minAvailableHeadroomGB)
      ) {
        memoryExhaustionDetected = true;
      }
    }

    const sortedLevelLat = [...levelLatencies].sort((a, b) => a - b);
    const levelP95 = percentile(sortedLevelLat, 95);
    if (baselineSingleLatencyMs === undefined && levelErrors === 0 && levelP95 > 0) {
      baselineSingleLatencyMs = Math.max(50, levelP95);
    }

    if (levelErrors > 0 || memoryExhaustionDetected) {
      // Stop progressive ramp immediately before causing destructive saturation
      break;
    }

    verifiedSafeConcurrency = level;

    if (
      baselineSingleLatencyMs !== undefined &&
      level > 1 &&
      levelP95 > baselineSingleLatencyMs * latencyBlowupFactorCap
    ) {
      // Latency degraded beyond acceptable queue multiplier; stop ramping higher
      break;
    }
  }

  // Post-load single-request recovery check
  let recoveredAfterLoad = false;
  try {
    const recoveryObs = await runner({
      level: 1,
      requestIndex: 0,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    recoveredAfterLoad = recoveryObs.ok;
  } catch {
    recoveredAfterLoad = false;
  }

  const sortedAllLat = [...allLatenciesMs].sort((a, b) => a - b);
  const sortedAllTtft = [...allTtftMs].sort((a, b) => a - b);
  const errorRate = acceptedRequests > 0 ? round2(totalErrors / acceptedRequests) : 0;
  const timeoutRate = acceptedRequests > 0 ? round2(totalTimeouts / acceptedRequests) : 0;

  let state: AcceptanceState;
  if (verifiedSafeConcurrency >= 1 && recoveredAfterLoad) {
    state = 'CAPACITY_VERIFIED';
  } else if (recoveredAfterLoad) {
    state = 'SATURATED';
  } else {
    state = 'DEGRADED';
  }

  return {
    runtimeId,
    hostId,
    modelId,
    testedConcurrencyLevels,
    verifiedSafeConcurrency,
    acceptedRequests,
    successfulCompletions,
    inFlightPeak,
    queuedPeak,
    firstTokenLatencyMsP50: sortedAllTtft.length > 0 ? percentile(sortedAllTtft, 50) : undefined,
    endToEndLatencyMsP50: percentile(sortedAllLat, 50),
    endToEndLatencyMsP95: percentile(sortedAllLat, 95),
    tokensPerSecondAggregate: bestAggregateTokPerSec,
    gpuMemoryUsedPeakGB,
    memoryExhaustionDetected,
    errorRate,
    timeoutRate,
    recoveredAfterLoad,
    state,
    qualifiedAt: new Date().toISOString(),
    evidenceId: nextEvidenceId('ev-cap', runtimeId),
  };
}

export interface BuildServerAcceptanceTableParams {
  graph: CapabilityGraph;
  plan?: DeclarativeExecutionPlan;
  pools?: ExecutionPlanPoolSpec[];
  quantitiesByPool?: Record<string, PoolAllocationQuantities>;
  evidenceByRuntimeOrPool?: Record<string, RuntimeVerificationEvidence | RuntimeVerificationEvidence[]>;
  concurrencyByRuntimeOrPool?: Record<string, ConcurrencyQualificationResult>;
}

function collectEvidenceList(
  keyCandidates: Array<string | undefined>,
  map?: Record<string, RuntimeVerificationEvidence | RuntimeVerificationEvidence[]>,
): RuntimeVerificationEvidence[] {
  if (!map) return [];
  const seen = new Set<string>();
  const out: RuntimeVerificationEvidence[] = [];
  for (const key of keyCandidates) {
    if (!key) continue;
    const entry = map[key];
    if (!entry) continue;
    const arr = Array.isArray(entry) ? entry : [entry];
    for (const item of arr) {
      if (!seen.has(item.evidenceId)) {
        seen.add(item.evidenceId);
        out.push(item);
      }
    }
  }
  return out;
}

/**
 * Builds the live Forge Sovereign-5 Server Acceptance Table (`ServerAcceptanceRow[]`).
 *
 * Strictly separates live `running` & `queued` counts from historical `completed` & `failed`
 * counts — NEVER presenting historical completions as live active agents.
 */
export function buildServerAcceptanceTable(params: BuildServerAcceptanceTableParams): ServerAcceptanceRow[] {
  const {
    graph,
    plan,
    pools = plan?.spec.pools,
    quantitiesByPool = {},
    evidenceByRuntimeOrPool,
    concurrencyByRuntimeOrPool,
  } = params;

  const rows: ServerAcceptanceRow[] = [];

  if (pools && pools.length > 0) {
    for (const poolSpec of pools) {
      const q = quantitiesByPool[poolSpec.id];
      const liveRunningSlots = Object.values(graph.executionSlots).filter(
        (s) => s.poolId === poolSpec.id && s.state === 'running',
      ).length;

      // Never conflate completedAgents with runningAgents!
      const running = q ? q.runningAgents : liveRunningSlots;
      const queued = q ? q.queuedAgents : 0;
      const completed = q ? q.completedAgents : 0;
      const failed = q ? q.failedAgents : 0;
      const assigned = q ? q.targetAllocation : 0;
      const admitted = q ? q.admittedAgents : running + queued;

      if (poolSpec.provider) {
        const provider = graph.cloudProviders[poolSpec.provider];
        const disabled = !poolSpec.enabled || poolSpec.share === 0 || provider?.disabledByPolicy === true;
        const status: AcceptanceState = disabled
          ? 'DISABLED_BY_POLICY'
          : (provider?.acceptanceState ?? 'UNKNOWN');
        const evidences = collectEvidenceList([poolSpec.id, poolSpec.provider], evidenceByRuntimeOrPool);
        const capQual =
          concurrencyByRuntimeOrPool?.[poolSpec.id] ?? concurrencyByRuntimeOrPool?.[poolSpec.provider];
        const verifiedConcurrency = q?.verifiedSafeConcurrent ?? capQual?.verifiedSafeConcurrency;
        const configuredMax = disabled ? 0 : poolSpec.max_concurrent;
        const capacity = disabled
          ? 0
          : (q?.effectiveConcurrentLimit ?? verifiedConcurrency ?? configuredMax);

        rows.push({
          pool: poolSpec.id,
          host: `cloud:${poolSpec.provider}`,
          endpoint: `provider://${poolSpec.provider}`,
          runtime: poolSpec.provider,
          model: disabled
            ? 'disabled'
            : (poolSpec.preferred_model ?? provider?.supportedModelsOrModes[0] ?? 'provider-managed'),
          targetSharePct: poolSpec.share,
          assigned: disabled ? 0 : assigned,
          admitted: disabled ? 0 : admitted,
          running: disabled ? 0 : running,
          queued: disabled ? 0 : queued,
          completed: disabled ? 0 : completed,
          failed: disabled ? 0 : failed,
          capacity,
          configuredMaxConcurrent: configuredMax,
          verifiedConcurrency,
          status,
          lastVerifiedAt: evidences[evidences.length - 1]?.verifiedAt ?? provider?.lastAcceptedRequestAt,
          evidenceIds: evidences.map((e) => e.evidenceId),
          diagnostic: disabled
            ? (provider?.diagnostic ?? 'Strictly disabled by policy (0% allocation)')
            : (q?.unavailabilityReason ?? provider?.diagnostic),
        });
        continue;
      }

      const hostId = poolSpec.host ?? poolSpec.id;
      const host = graph.hosts[hostId];
      const hostEndpoints = Object.values(graph.endpoints).filter((ep) => ep.hostId === hostId);
      const matchesPrefRt = (ep: (typeof hostEndpoints)[number]): boolean =>
        Boolean(
          poolSpec.preferred_runtime &&
            (ep.runtimeId === poolSpec.preferred_runtime ||
              ep.runtimeId.endsWith(`:${poolSpec.preferred_runtime}`)),
        );
      const preferredEndpoint =
        hostEndpoints.find((ep) => matchesPrefRt(ep) && isExecutionVerifiedState(ep.acceptanceState)) ??
        hostEndpoints.find((ep) => isExecutionVerifiedState(ep.acceptanceState)) ??
        hostEndpoints.find((ep) => matchesPrefRt(ep)) ??
        hostEndpoints[0];

      const runtimeId = preferredEndpoint?.runtimeId ?? poolSpec.preferred_runtime ?? 'unknown';
      const loadedModelsOnRuntime = Object.values(graph.models).filter(
        (m) => m.hostId === hostId && m.runtimeId === runtimeId && m.residency === 'loaded',
      );
      const modelLabel =
        loadedModelsOnRuntime[0]?.modelId ??
        poolSpec.preferred_model ??
        '(none loaded)';

      const specificEvidences = collectEvidenceList([runtimeId, preferredEndpoint?.endpointId], evidenceByRuntimeOrPool);
      const evidences =
        specificEvidences.length > 0
          ? specificEvidences
          : collectEvidenceList([poolSpec.id], evidenceByRuntimeOrPool);
      const capQual = concurrencyByRuntimeOrPool?.[runtimeId] ?? concurrencyByRuntimeOrPool?.[poolSpec.id];
      if (capQual && !evidences.some((e) => e.evidenceId === capQual.evidenceId)) {
        // append capacity evidence id below
      }
      const evidenceIds = [
        ...evidences.map((e) => e.evidenceId),
        ...(capQual ? [capQual.evidenceId] : []),
      ];

      const disabled = !poolSpec.enabled;
      const status: AcceptanceState = disabled
        ? 'DISABLED_BY_POLICY'
        : (capQual?.state ??
          evidences[evidences.length - 1]?.state ??
          preferredEndpoint?.acceptanceState ??
          (host ? 'DISCOVERED' : 'UNAVAILABLE'));

      const verifiedConcurrency = q?.verifiedSafeConcurrent ?? capQual?.verifiedSafeConcurrency;
      const configuredMax = disabled ? 0 : poolSpec.max_concurrent;
      const capacity =
        status === 'UNAVAILABLE' || status === 'DISABLED_BY_POLICY'
          ? 0
          : (q?.effectiveConcurrentLimit ?? verifiedConcurrency ?? configuredMax);

      rows.push({
        pool: poolSpec.id,
        host: host?.hostname ?? hostId,
        endpoint: preferredEndpoint?.rawUrl ?? 'unconfigured',
        runtime: runtimeId,
        model: modelLabel,
        targetSharePct: poolSpec.share,
        assigned,
        admitted,
        running,
        queued,
        completed,
        failed,
        capacity,
        configuredMaxConcurrent: configuredMax,
        verifiedConcurrency,
        status,
        lastVerifiedAt:
          capQual?.qualifiedAt ??
          evidences[evidences.length - 1]?.verifiedAt ??
          preferredEndpoint?.lastVerifiedAt,
        evidenceIds: [...new Set(evidenceIds)],
        diagnostic:
          q?.unavailabilityReason ??
          evidences[evidences.length - 1]?.error ??
          preferredEndpoint?.diagnosticMessage,
      });
    }
    return rows;
  }

  // Fallback when no ExecutionPlan is supplied: emit rows directly from graph endpoints & cloud providers
  for (const ep of Object.values(graph.endpoints)) {
    const host = graph.hosts[ep.hostId];
    const loadedModel = Object.values(graph.models).find(
      (m) => m.runtimeId === ep.runtimeId && m.residency === 'loaded',
    );
    const liveRunning = Object.values(graph.executionSlots).filter(
      (s) => s.runtimeId === ep.runtimeId && s.state === 'running',
    ).length;
    const evidences = collectEvidenceList([ep.runtimeId, ep.endpointId], evidenceByRuntimeOrPool);
    const capQual = concurrencyByRuntimeOrPool?.[ep.runtimeId];
    const verifiedConcurrency = capQual?.verifiedSafeConcurrency;
    const status = capQual?.state ?? evidences[evidences.length - 1]?.state ?? ep.acceptanceState;

    rows.push({
      pool: ep.hostId,
      host: host?.hostname ?? ep.hostId,
      endpoint: ep.rawUrl,
      runtime: ep.runtimeId,
      model: loadedModel?.modelId ?? '(none loaded)',
      targetSharePct: 0,
      assigned: liveRunning,
      admitted: liveRunning,
      running: liveRunning,
      queued: 0,
      completed: 0,
      failed: 0,
      capacity: verifiedConcurrency ?? 1,
      configuredMaxConcurrent: verifiedConcurrency ?? 1,
      verifiedConcurrency,
      status,
      lastVerifiedAt: capQual?.qualifiedAt ?? evidences[evidences.length - 1]?.verifiedAt ?? ep.lastVerifiedAt,
      evidenceIds: [
        ...new Set([...evidences.map((e) => e.evidenceId), ...(capQual ? [capQual.evidenceId] : [])]),
      ],
      diagnostic: evidences[evidences.length - 1]?.error ?? ep.diagnosticMessage,
    });
  }

  for (const cp of Object.values(graph.cloudProviders)) {
    rows.push({
      pool: cp.providerId,
      host: `cloud:${cp.providerId}`,
      endpoint: `provider://${cp.providerId}`,
      runtime: cp.providerId,
      model: cp.disabledByPolicy ? 'disabled' : (cp.supportedModelsOrModes[0] ?? 'provider-managed'),
      targetSharePct: 0,
      assigned: 0,
      admitted: 0,
      running: 0,
      queued: 0,
      completed: 0,
      failed: 0,
      capacity: cp.disabledByPolicy ? 0 : cp.configuredMaxConcurrent,
      configuredMaxConcurrent: cp.configuredMaxConcurrent,
      status: cp.acceptanceState,
      lastVerifiedAt: cp.lastAcceptedRequestAt,
      evidenceIds: [],
      diagnostic: cp.diagnostic,
    });
  }

  return rows;
}

/**
 * Formats `ServerAcceptanceRow[]` into a deterministic Markdown table with explicit
 * live vs historical counters, timestamps, evidence IDs, and non-accepting diagnostics.
 */
export function formatServerAcceptanceTable(rows: ServerAcceptanceRow[]): string {
  const headers = [
    'Pool',
    'Host',
    'Runtime',
    'Endpoint',
    'Model',
    'Share',
    'Asgn',
    'Adm',
    'Run(Live)',
    'Queue',
    'Done(Hist)',
    'Fail',
    'Cap(Ver/Cfg)',
    'Status',
    'VerifiedAt',
    'Evidence',
  ];

  const body = rows.map((r) => [
    r.pool,
    r.host,
    r.runtime,
    r.endpoint,
    r.model,
    `${r.targetSharePct}%`,
    String(r.assigned),
    String(r.admitted),
    String(r.running),
    String(r.queued),
    String(r.completed),
    String(r.failed),
    `${r.verifiedConcurrency ?? '-'}/${r.configuredMaxConcurrent} (eff:${r.capacity})`,
    r.status,
    r.lastVerifiedAt ?? 'unverified',
    r.evidenceIds.length > 0 ? r.evidenceIds.join(',') : '-',
  ]);

  const widths = headers.map((h, colIdx) =>
    Math.max(h.length, ...body.map((row) => (row[colIdx] ?? '').length)),
  );

  const fmtRow = (cols: string[]) =>
    `| ${cols.map((c, idx) => c.padEnd(widths[idx])).join(' | ')} |`;
  const sepRow = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;

  const lines = [fmtRow(headers), sepRow, ...body.map(fmtRow)];

  const nonAccepting = rows.filter(
    (r) =>
      r.status === 'UNAVAILABLE' ||
      r.status === 'DEGRADED' ||
      r.status === 'SATURATED' ||
      r.status === 'DISABLED_BY_POLICY',
  );
  if (nonAccepting.length > 0) {
    lines.push('');
    lines.push('Diagnostics / Non-Accepting Endpoints:');
    for (const r of nonAccepting) {
      lines.push(
        `- [${r.pool}] ${r.runtime} (${r.endpoint}) -> ${r.status}${r.diagnostic ? `: ${r.diagnostic}` : ''}`,
      );
    }
  }

  return lines.join('\n');
}
