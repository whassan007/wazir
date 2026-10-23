/**
 * Resolves the context/output limits of a registered model (optionally a
 * loaded instance) into one ModelContextLimits view with provenance.
 *
 * Pure function: no I/O. Inputs are the ModelRecord the registry holds and,
 * when known, the loaded ModelInstance.
 */
import type { ModelInstance, ModelRecord } from '../types/model.js';
import type {
  ContextLimitSource,
  ModelContextLimits,
  ReasoningAccounting,
} from '../types/contextAllocation.js';

export interface ResolveModelContextLimitsOptions {
  /** Overrides the default (`model.local`). Local runtimes accept num_ctx / n_ctx; hosted providers do not. */
  runtimeContextConfigurable?: boolean;
}

export function resolveModelContextLimits(
  model: ModelRecord,
  instance?: Pick<ModelInstance, 'contextTokens' | 'runtimeId'>,
  opts: ResolveModelContextLimitsOptions = {},
): ModelContextLimits {
  const notes: string[] = [];

  // Legacy records predate provenance tracking; treat them as documented values.
  const source: ContextLimitSource = model.contextLimitSource ?? 'provider-documented';
  if (model.contextLimitSource === undefined) {
    notes.push("source: no contextLimitSource on record (legacy); treated as 'provider-documented'");
  } else {
    notes.push(`source: ${source}`);
  }

  const known = source !== 'default-unknown';
  let contextWindowTokens: number | undefined;
  if (known) {
    contextWindowTokens = model.contextMax;
    notes.push(`contextWindowTokens: ${model.contextMax} from record contextMax`);
  } else {
    notes.push('contextWindowTokens: undefined; the record window is a default guess, not a model capability');
  }

  const runtimeContextTokens = instance?.contextTokens ?? model.configuredContext;
  if (instance?.contextTokens !== undefined) {
    notes.push(`runtimeContextTokens: ${instance.contextTokens} from loaded instance`);
  } else if (model.configuredContext !== undefined) {
    notes.push(`runtimeContextTokens: ${model.configuredContext} from configured context`);
  } else {
    notes.push('runtimeContextTokens: undefined; no loaded instance or configured context');
  }

  const runtimeContextConfigurable = opts.runtimeContextConfigurable ?? model.local;
  notes.push(
    runtimeContextConfigurable
      ? 'runtimeContextConfigurable: true (local runtime accepts a per-load context size)'
      : 'runtimeContextConfigurable: false (hosted provider does not accept a per-request context size)',
  );

  const accounting = model.contextAccounting ?? 'unknown';
  notes.push(
    model.contextAccounting === undefined
      ? "accounting: 'unknown' (not recorded; allocator treats it as shared)"
      : `accounting: ${accounting} from record`,
  );

  const reasoningAccounting: ReasoningAccounting = model.reasoning ? 'unknown' : 'not-supported';
  notes.push(
    model.reasoning
      ? 'reasoningAccounting: unknown (model supports reasoning; accounting not verified)'
      : 'reasoningAccounting: not-supported (model does not reason)',
  );

  if (model.maxInputTokens !== undefined) notes.push(`maxInputTokens: ${model.maxInputTokens} from record`);
  if (model.maxOutputTokens !== undefined) notes.push(`maxOutputTokens: ${model.maxOutputTokens} from record`);

  return {
    modelId: model.id,
    contextWindowTokens,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    runtimeContextTokens,
    runtimeContextConfigurable,
    accounting,
    reasoningAccounting,
    source,
    known,
    notes,
  };
}
