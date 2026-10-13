import { AgentConfigurationDiscovery, isPreflightFresh } from '@wazir/agents';
import { checkAgents, loadPreflightCache } from './agentPreflight.js';
import type { RookEngine } from './engine.js';

/** Coordinates the existing registry, account mappings and preflight; never owns credentials. */
export class AgentConnectionManager {
  constructor(private readonly engine: Pick<RookEngine, 'agents' | 'projectRoot' | 'resources'>) {}

  discover(trustedProject = false) {
    const discovery = new AgentConfigurationDiscovery();
    const configurations = discovery.discover({ cwd: this.engine.projectRoot, trustedProject });
    for (const account of this.engine.resources.accounts.list()) {
      for (const instance of account.agents ?? []) {
        if (!instance.includes('@')) continue;
        const found = discovery.discover({ cwd: this.engine.projectRoot, env: { ...process.env, ...account.env }, trustedProject }).find(a => a.agent === instance.split('@')[0]);
        if (found) configurations.push({ ...found, agent: instance });
      }
    }
    const cache = loadPreflightCache();
    return configurations.map(config => {
      const cached = cache[config.agent];
      const valid = cached?.fingerprint === config.fingerprint && isPreflightFresh(cached);
      const state = valid ? cached.status : config.state;
      const account = this.engine.resources.accounts.candidates({ agent: config.agent })[0];
      return {
        ...config, state, authentication: valid && state === 'READY' ? 'VERIFIED' : 'UNKNOWN',
        registered: !!this.engine.agents.get(config.agent),
        routingEligible: valid && state === 'READY' && !!this.engine.agents.get(config.agent) && !!account,
        account: account ? { id: account.id, label: account.label, kind: account.kind } : undefined,
        connection: valid ? cached : undefined,
        precedence: 'Wazir preserves explicit agent/account selection. The vendor CLI resolves native model, policy and instruction precedence; discovery reports declarations only.',
      };
    });
  }

  async connect(names: string[], options: { timeoutMs?: number; fresh?: boolean } = {}) {
    return checkAgents(this.engine, names, options);
  }
}
