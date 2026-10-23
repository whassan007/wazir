import { HOSTED_RUNTIME_TYPES, type ModelInstance, type ModelRecord, type RuntimeRecord, type RuntimeRegistry } from '@wazir/core';
import type { ProbeAdapter, ProbeAdapterResolver } from './types.js';

const HOSTED_ADAPTER_TYPES = new Set<string>([...HOSTED_RUNTIME_TYPES, 'anthropic', 'openai', 'google', 'nvidia']);

/**
 * Whether serving through this instance is hosted (paid / third-party) inference.
 * Conservative: anything without a computer, on a hosted runtime kind/type, or a
 * model explicitly marked non-local counts as hosted.
 */
export function isHostedInstance(
  instance: Pick<ModelInstance, 'computerId' | 'runtimeId'>,
  runtime: RuntimeRecord | undefined,
  record?: Pick<ModelRecord, 'local' | 'runtimeCompatibility'>,
): boolean {
  if (!instance.computerId) return true;
  if (runtime?.runtimeKind === 'hosted') return true;
  if (runtime && HOSTED_RUNTIME_TYPES.has(runtime.type)) return true;
  if (!runtime && HOSTED_ADAPTER_TYPES.has(instance.runtimeId.toLowerCase())) return true;
  if (record?.local === false) return true;
  if (
    record &&
    Array.isArray(record.runtimeCompatibility) &&
    record.runtimeCompatibility.length > 0 &&
    record.runtimeCompatibility.every((t) => HOSTED_RUNTIME_TYPES.has(t))
  ) {
    return true;
  }
  return false;
}

export function isHostedAdapter(adapter: ProbeAdapter | undefined): boolean {
  return !!adapter?.type && HOSTED_ADAPTER_TYPES.has(adapter.type.toLowerCase());
}

export function resolveAdapter(resolver: ProbeAdapterResolver | undefined, runtimeId: string): ProbeAdapter | undefined {
  if (!resolver) return undefined;
  if (typeof resolver === 'function') return resolver(runtimeId);
  if (resolver instanceof Map) return resolver.get(runtimeId);
  return Object.prototype.hasOwnProperty.call(resolver, runtimeId) ? (resolver as Record<string, ProbeAdapter>)[runtimeId] : undefined;
}

export function runtimeOf(runtimes: RuntimeRegistry | undefined, runtimeId: string): RuntimeRecord | undefined {
  return runtimes?.get(runtimeId);
}

export function errorMessage(error: unknown): string {
  if (error === undefined || error === null) return 'unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && 'message' in (error as Record<string, unknown>)) {
    const e = error as { code?: unknown; message?: unknown };
    return typeof e.code === 'string' ? `${e.code}: ${String(e.message)}` : String(e.message);
  }
  return String(error);
}
