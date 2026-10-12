export type {
  CacheMetricStatus,
  CacheMetricValue,
  PromptCacheMetrics,
  RawTelemetryInput,
} from '@wazir/runtimes-interfaces';
export {
  promptCacheSource,
  promptCacheReuse,
  normalizePromptCacheTelemetry,
} from '@wazir/runtimes-interfaces';

/**
 * Normalized telemetry structure for upstream and local runtime prompt-cache events and metrics.
 * Missing cache metrics must remain UNKNOWN. Never convert missing provider telemetry into zero.
 */
export interface PromptCacheTelemetry {
  runtimeId: string;
  modelId: string;
  executionId: string;

  inputTokens: import('@wazir/runtimes-interfaces').CacheMetricValue;
  cacheReadTokens: import('@wazir/runtimes-interfaces').CacheMetricValue;
  cacheWriteTokens: import('@wazir/runtimes-interfaces').CacheMetricValue;

  cacheHits?: import('@wazir/runtimes-interfaces').CacheMetricValue;
  cacheMisses?: import('@wazir/runtimes-interfaces').CacheMetricValue;

  source: import('@wazir/runtimes-interfaces').CacheMetricStatus;
  confidence?: 'high' | 'medium' | 'low' | 'unknown';

  observedAt: Date;
}

/**
 * Converts a PromptCacheMetrics object (e.g. from runtime adapter) to PromptCacheTelemetry.
 */
export function toPromptCacheTelemetry(params: {
  runtimeId: string;
  modelId: string;
  executionId: string;
  metrics: import('@wazir/runtimes-interfaces').PromptCacheMetrics;
  observedAt?: Date;
  confidence?: 'high' | 'medium' | 'low' | 'unknown';
}): PromptCacheTelemetry {
  const m = params.metrics;
  const source = m.source ?? (m.cacheReadTokens.status === 'OBSERVED' ? 'OBSERVED' : m.cacheReadTokens.status);
  return {
    runtimeId: params.runtimeId,
    modelId: params.modelId,
    executionId: params.executionId,
    inputTokens: normalizeCacheMetricValue(m.inputTokens),
    cacheReadTokens: normalizeCacheMetricValue(m.cacheReadTokens),
    cacheWriteTokens: normalizeCacheMetricValue(m.cacheWriteTokens),
    cacheHits: m.hit !== undefined
      ? { value: m.hit ? 1 : 0, status: source }
      : undefined,
    source,
    confidence: params.confidence ?? (source === 'OBSERVED' ? 'high' : source === 'ESTIMATED' ? 'medium' : 'unknown'),
    observedAt: params.observedAt ?? new Date(),
  };
}


/**
 * Creates an empty or default PromptCacheTelemetry record with all metric fields marked UNKNOWN.
 */
export function createUnknownPromptCacheTelemetry(params: {
  runtimeId: string;
  modelId: string;
  executionId: string;
  observedAt?: Date;
  source?: import('@wazir/runtimes-interfaces').CacheMetricStatus;
}): PromptCacheTelemetry {
  return {
    runtimeId: params.runtimeId,
    modelId: params.modelId,
    executionId: params.executionId,
    inputTokens: { status: 'UNKNOWN' },
    cacheReadTokens: { status: 'UNKNOWN' },
    cacheWriteTokens: { status: 'UNKNOWN' },
    cacheHits: { status: 'UNKNOWN' },
    cacheMisses: { status: 'UNKNOWN' },
    source: params.source ?? 'UNKNOWN',
    confidence: 'unknown',
    observedAt: params.observedAt ?? new Date(),
  };
}

/**
 * Creates a PromptCacheTelemetry record representing a runtime/provider that does NOT support prompt caching.
 * Explicitly marks metrics as UNSUPPORTED, never 0.
 */
export function createUnsupportedPromptCacheTelemetry(params: {
  runtimeId: string;
  modelId: string;
  executionId: string;
  inputTokens?: number;
  observedAt?: Date;
}): PromptCacheTelemetry {
  return {
    runtimeId: params.runtimeId,
    modelId: params.modelId,
    executionId: params.executionId,
    inputTokens: typeof params.inputTokens === 'number'
      ? { value: params.inputTokens, status: 'OBSERVED' }
      : { status: 'UNKNOWN' },
    cacheReadTokens: { status: 'UNSUPPORTED' },
    cacheWriteTokens: { status: 'UNSUPPORTED' },
    cacheHits: { status: 'UNSUPPORTED' },
    cacheMisses: { status: 'UNSUPPORTED' },
    source: 'UNSUPPORTED',
    confidence: 'high',
    observedAt: params.observedAt ?? new Date(),
  };
}

/**
 * Normalizes metric value input ensuring missing values remain UNKNOWN (or UNSUPPORTED)
 * and never coerced into zero.
 */
export function normalizeCacheMetricValue(
  value: unknown,
  statusOverride?: import('@wazir/runtimes-interfaces').CacheMetricStatus,
): import('@wazir/runtimes-interfaces').CacheMetricValue {
  if (value && typeof value === 'object' && 'status' in value) {
    const cmv = value as import('@wazir/runtimes-interfaces').CacheMetricValue;
    return {
      value: typeof cmv.value === 'number' && Number.isFinite(cmv.value) ? cmv.value : undefined,
      status: cmv.status,
    };
  }

  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return {
      value,
      status: statusOverride ?? 'OBSERVED',
    };
  }

  return {
    value: undefined,
    status: statusOverride ?? 'UNKNOWN',
  };
}

/**
 * Aggregates two CacheMetricValues preserving UNKNOWN / UNSUPPORTED semantics.
 * If both are missing, remains missing. If one is OBSERVED/ESTIMATED, takes the observed.
 * If both observed, sums them.
 */
export function aggregateCacheMetricValues(
  a?: import('@wazir/runtimes-interfaces').CacheMetricValue,
  b?: import('@wazir/runtimes-interfaces').CacheMetricValue,
): import('@wazir/runtimes-interfaces').CacheMetricValue {
  if (!a && !b) return { status: 'UNKNOWN' };
  if (!a) return b!;
  if (!b) return a!;

  const hasA = a.value !== undefined && Number.isFinite(a.value);
  const hasB = b.value !== undefined && Number.isFinite(b.value);

  if (hasA && hasB) {
    const status: import('@wazir/runtimes-interfaces').CacheMetricStatus =
      a.status === 'ESTIMATED' || b.status === 'ESTIMATED' ? 'ESTIMATED' : 'OBSERVED';
    return {
      value: a.value! + b.value!,
      status,
    };
  }

  if (hasA) {
    return {
      value: a.value,
      status: a.status,
    };
  }

  if (hasB) {
    return {
      value: b.value,
      status: b.status,
    };
  }

  if (a.status === 'UNSUPPORTED' && b.status === 'UNSUPPORTED') {
    return { status: 'UNSUPPORTED' };
  }

  return { status: 'UNKNOWN' };
}

/**
 * Aggregates multiple PromptCacheTelemetry instances into an aggregated summary.
 * Correctly distinguishes UNSUPPORTED, UNKNOWN, OBSERVED, and ESTIMATED.
 */
export function aggregatePromptCacheTelemetry(
  records: PromptCacheTelemetry[],
  options?: {
    runtimeId?: string;
    modelId?: string;
    executionId?: string;
  },
): PromptCacheTelemetry | undefined {
  if (records.length === 0) return undefined;

  let inputTokens: import('@wazir/runtimes-interfaces').CacheMetricValue = { status: 'UNKNOWN' };
  let cacheReadTokens: import('@wazir/runtimes-interfaces').CacheMetricValue = { status: 'UNKNOWN' };
  let cacheWriteTokens: import('@wazir/runtimes-interfaces').CacheMetricValue = { status: 'UNKNOWN' };
  let cacheHits: import('@wazir/runtimes-interfaces').CacheMetricValue | undefined = undefined;
  let cacheMisses: import('@wazir/runtimes-interfaces').CacheMetricValue | undefined = undefined;

  let latestObservedAt = records[0].observedAt;
  const runtimeIds = new Set<string>();
  const modelIds = new Set<string>();
  const executionIds = new Set<string>();

  let hasObserved = false;
  let hasEstimated = false;
  let hasUnsupported = false;
  let hasUnknown = false;

  for (const r of records) {
    runtimeIds.add(r.runtimeId);
    modelIds.add(r.modelId);
    executionIds.add(r.executionId);

    if (r.observedAt > latestObservedAt) {
      latestObservedAt = r.observedAt;
    }

    if (r.source === 'OBSERVED') hasObserved = true;
    else if (r.source === 'ESTIMATED') hasEstimated = true;
    else if (r.source === 'UNSUPPORTED') hasUnsupported = true;
    else hasUnknown = true;

    inputTokens = aggregateCacheMetricValues(inputTokens, r.inputTokens);
    cacheReadTokens = aggregateCacheMetricValues(cacheReadTokens, r.cacheReadTokens);
    cacheWriteTokens = aggregateCacheMetricValues(cacheWriteTokens, r.cacheWriteTokens);

    if (r.cacheHits) {
      cacheHits = aggregateCacheMetricValues(cacheHits, r.cacheHits);
    }
    if (r.cacheMisses) {
      cacheMisses = aggregateCacheMetricValues(cacheMisses, r.cacheMisses);
    }
  }

  let aggregatedSource: import('@wazir/runtimes-interfaces').CacheMetricStatus;
  if (hasEstimated) {
    aggregatedSource = 'ESTIMATED';
  } else if (hasObserved) {
    aggregatedSource = 'OBSERVED';
  } else if (hasUnsupported && !hasUnknown) {
    aggregatedSource = 'UNSUPPORTED';
  } else {
    aggregatedSource = 'UNKNOWN';
  }

  return {
    runtimeId: options?.runtimeId ?? (runtimeIds.size === 1 ? Array.from(runtimeIds)[0] : 'multiple'),
    modelId: options?.modelId ?? (modelIds.size === 1 ? Array.from(modelIds)[0] : 'multiple'),
    executionId: options?.executionId ?? (executionIds.size === 1 ? Array.from(executionIds)[0] : 'multiple'),
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHits,
    cacheMisses,
    source: aggregatedSource,
    confidence: aggregatedSource === 'OBSERVED' ? 'high' : aggregatedSource === 'ESTIMATED' ? 'medium' : 'unknown',
    observedAt: latestObservedAt,
  };
}

/**
 * Serializes PromptCacheTelemetry into a plain JSON-safe object, ensuring Dates are ISO strings
 * and undefined fields are clean.
 */
export function serializePromptCacheTelemetry(telemetry: PromptCacheTelemetry): Record<string, unknown> {
  return {
    runtimeId: telemetry.runtimeId,
    modelId: telemetry.modelId,
    executionId: telemetry.executionId,
    inputTokens: {
      status: telemetry.inputTokens.status,
      ...(telemetry.inputTokens.value !== undefined ? { value: telemetry.inputTokens.value } : {}),
    },
    cacheReadTokens: {
      status: telemetry.cacheReadTokens.status,
      ...(telemetry.cacheReadTokens.value !== undefined ? { value: telemetry.cacheReadTokens.value } : {}),
    },
    cacheWriteTokens: {
      status: telemetry.cacheWriteTokens.status,
      ...(telemetry.cacheWriteTokens.value !== undefined ? { value: telemetry.cacheWriteTokens.value } : {}),
    },
    ...(telemetry.cacheHits ? {
      cacheHits: {
        status: telemetry.cacheHits.status,
        ...(telemetry.cacheHits.value !== undefined ? { value: telemetry.cacheHits.value } : {}),
      },
    } : {}),
    ...(telemetry.cacheMisses ? {
      cacheMisses: {
        status: telemetry.cacheMisses.status,
        ...(telemetry.cacheMisses.value !== undefined ? { value: telemetry.cacheMisses.value } : {}),
      },
    } : {}),
    source: telemetry.source,
    ...(telemetry.confidence ? { confidence: telemetry.confidence } : {}),
    observedAt: telemetry.observedAt instanceof Date ? telemetry.observedAt.toISOString() : telemetry.observedAt,
  };
}

/**
 * Deserializes JSON or plain object into PromptCacheTelemetry.
 * Preserves UNKNOWN and UNSUPPORTED statuses without ever converting missing values to 0.
 */
export function deserializePromptCacheTelemetry(data: unknown): PromptCacheTelemetry {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid PromptCacheTelemetry data: expected object');
  }

  const d = data as Record<string, any>;
  return {
    runtimeId: String(d.runtimeId ?? ''),
    modelId: String(d.modelId ?? ''),
    executionId: String(d.executionId ?? ''),
    inputTokens: normalizeCacheMetricValue(d.inputTokens),
    cacheReadTokens: normalizeCacheMetricValue(d.cacheReadTokens),
    cacheWriteTokens: normalizeCacheMetricValue(d.cacheWriteTokens),
    cacheHits: d.cacheHits ? normalizeCacheMetricValue(d.cacheHits) : undefined,
    cacheMisses: d.cacheMisses ? normalizeCacheMetricValue(d.cacheMisses) : undefined,
    source: (d.source as import('@wazir/runtimes-interfaces').CacheMetricStatus) ?? 'UNKNOWN',
    confidence: d.confidence,
    observedAt: d.observedAt ? new Date(d.observedAt) : new Date(),
  };
}



export type CostStatus = 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN';

export interface PhysicalComputeUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  modelCalls: number;
  wallTimeMs: number;
  modelTimeMs: number;
  gpuTimeMs?: number;
  peakMemoryBytes: number;
  cpuTimeMs?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  promptCacheMetrics?: import('@wazir/runtimes-interfaces').PromptCacheMetrics;
}

export interface MonetaryCost {
  status: CostStatus;
  currency: 'USD';
  amount?: number;
  breakdown?: {
    inputCostUsd?: number;
    outputCostUsd?: number;
    cachedCostUsd?: number;
  };
}

export interface UsageRecord {
  id: string;
  executionId: string;
  jobId?: string;
  agentId?: string;
  modelId: string;
  runtimeId: string;
  computerId?: string;
  provider: string;
  isLocal: boolean;
  physical: PhysicalComputeUsage;
  monetary: MonetaryCost;
  promptCacheMetrics?: import('@wazir/runtimes-interfaces').PromptCacheMetrics;
  promptCache?: PromptCacheTelemetry;
  timestamp: Date;
}

export interface ModelPricingTier {
  provider: string;
  modelPattern: string; // Regex string or exact name
  inputTokenPricePerMillion: number;
  outputTokenPricePerMillion: number;
  cachedTokenPricePerMillion?: number;
}

export interface AggregatedUsageReport {
  totalExecutions: number;
  totalModelCalls: number;
  physical: {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedTokens: number;
    totalTokens: number;
    totalWallTimeMs: number;
    totalModelTimeMs: number;
    peakMemoryBytes: number;
  };
  monetary: {
    totalActualCostUsd: number;
    totalEstimatedCostUsd: number;
    hasUnknownCost: boolean;
    costStatus: CostStatus;
    byProvider: Record<string, { amountUsd?: number; status: CostStatus }>;
  };
  promptCache?: PromptCacheTelemetry;
  byModel: Record<
    string,
    {
      calls: number;
      tokens: number;
      wallTimeMs: number;
      peakMemoryBytes: number;
      costStatus: CostStatus;
      costUsd?: number;
    }
  >;
}

