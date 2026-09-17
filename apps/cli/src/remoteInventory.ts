import type {
  ComputerRegistration,
  ComputerRegistry,
  ModelInstance,
  ModelRecord,
  ModelRegistry,
  RuntimeRegistration,
  RuntimeRegistry,
} from '@wazir/core';

export interface RemoteInventorySyncResult {
  computers: number;
  runtimes: number;
  models: number;
  instances: number;
  errors: string[];
}

/**
 * Pulls the control plane's known computers, runtimes, models and model
 * instances into this process's local registries, so the `Scheduler` can
 * consider remote computers as placement targets instead of only the one
 * this CLI invocation is running on.
 *
 * Best-effort by design: a CLI run must still work standalone (local-only)
 * if the API is unreachable or misconfigured, so every fetch failure is
 * collected as a warning string rather than thrown.
 */
export async function syncRemoteInventory(
  apiUrl: string,
  localComputerId: string,
  registries: { computers: ComputerRegistry; runtimes: RuntimeRegistry; models: ModelRegistry },
): Promise<RemoteInventorySyncResult> {
  const base = apiUrl.replace(/\/+$/, '');
  const result: RemoteInventorySyncResult = { computers: 0, runtimes: 0, models: 0, instances: 0, errors: [] };

  const computersResponse = await fetchJson<{ computers: ComputerRegistration[] }>(`${base}/api/v1/computers`, result.errors);
  for (const computer of computersResponse?.computers ?? []) {
    // This process already owns its own local registration; never let a
    // remote snapshot of "myself" (e.g. same default id on another host)
    // clobber the live local entry.
    if (computer.id === localComputerId) continue;
    registries.computers.register({ ...computer, local: false });
    result.computers++;
  }

  const runtimesResponse = await fetchJson<{ runtimes: RuntimeRegistration[] }>(`${base}/api/v1/runtimes`, result.errors);
  for (const runtime of runtimesResponse?.runtimes ?? []) {
    if (runtime.computerId === localComputerId) continue;
    registries.runtimes.register(runtime);
    result.runtimes++;
  }

  const modelsResponse = await fetchJson<{ models: ModelRecord[] }>(`${base}/api/v1/models`, result.errors);
  for (const model of modelsResponse?.models ?? []) {
    registries.models.register({ ...model, local: false });
    result.models++;
  }

  // Model *records* alone are not schedulable — the Scheduler only places a
  // model on a computer that has a registered ModelInstance for it.
  const instancesResponse = await fetchJson<{ instances: ModelInstance[] }>(`${base}/api/v1/model-instances`, result.errors);
  for (const instance of instancesResponse?.instances ?? []) {
    if (instance.computerId === localComputerId) continue;
    registries.models.upsertInstance(instance);
    result.instances++;
  }

  return result;
}

async function fetchJson<T>(url: string, errors: string[]): Promise<T | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      errors.push(`${url}: HTTP ${response.status}`);
      return undefined;
    }
    return (await response.json()) as T;
  } catch (error) {
    errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
