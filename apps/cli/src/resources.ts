import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  AccountRegistry,
  ResourceConfigError,
  ResourceLedger,
  ResourceRouter,
  TokenBudgetManager,
  validateResourceConfig,
  type AccountConfig,
  type ResourcePolicy,
} from '@wazir/core';

export interface ResourceSystem {
  ledger: ResourceLedger;
  accounts: AccountRegistry;
  budget: TokenBudgetManager;
  router: ResourceRouter;
  policy: ResourcePolicy;
  configPath: string;
  ledgerPath: string;
  /** Set when resources.json exists but is invalid; cloud dispatch is then stopped. */
  configError?: string;
  resolveAccount: (runtimeId: string, modelId: string) => string | undefined;
  resolveAgentAccount: (agent: string) => string | undefined;
}

/**
 * Builds the resource system from `<configDir>/resources.json` (optional) and the ledger
 * `<configDir>/resources.db` (`:memory:` when WAZIR_IN_MEMORY=1, matching the KV store).
 * An invalid config never takes Wazir down: it falls back to implicit accounts with cloud
 * dispatch stopped, and the error is shown by `wa resources`.
 */
export function createResourceSystem(configDir: string): ResourceSystem {
  const configPath = path.join(configDir, 'resources.json');
  const ledgerPath = process.env.WAZIR_IN_MEMORY === '1' ? ':memory:' : path.join(configDir, 'resources.db');
  let configError: string | undefined;
  let policy: ResourcePolicy;
  let accounts: AccountConfig[] = [];
  try {
    const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    ({ policy, accounts } = validateResourceConfig(raw));
  } catch (error) {
    configError = error instanceof ResourceConfigError ? error.message : `cannot read ${configPath}: ${(error as Error).message}`;
    ({ policy } = validateResourceConfig({}));
  }
  const ledger = new ResourceLedger(ledgerPath);
  const registry = new AccountRegistry(accounts);
  const budget = new TokenBudgetManager(ledger, registry, policy);
  if (configError && !budget.stopped()) budget.emergencyStop('resources.json is invalid; fix it and run `wa resources resume`');

  const resolveAccount = (runtimeId: string, modelId: string) => registry.candidates({ runtimeId, modelId })[0]?.id;
  const resolveAgentAccount = (agent: string) => registry.candidates({ agent })[0]?.id;
  const router = new ResourceRouter({ budget, resolveAccount });
  return { ledger, accounts: registry, budget, router, policy, configPath, ledgerPath, configError, resolveAccount, resolveAgentAccount };
}
