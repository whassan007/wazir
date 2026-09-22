import type { CodingAgentOptions } from './codingAgent.js';

export interface RuntimePreset {
  name: string;
  description: string;
  tools: string[] | 'all';
  agentOptions: Partial<CodingAgentOptions>;
}

export const RUNTIME_PRESETS: Record<string, RuntimePreset> = {
  standard: {
    name: 'standard',
    description: 'Default full toolset',
    tools: 'all',
    agentOptions: {},
  },
  minimal: {
    name: 'minimal',
    description: 'Shell + edit only, for reproducible leaderboard-style benchmarking',
    tools: ['shell', 'edit'],
    agentOptions: { contextCompactionRatio: 1, maxRepairCycles: 1 },
  },
};

export function resolvePreset(name?: string): RuntimePreset {
  if (!name || name.trim() === '' || name.toLowerCase() === 'standard') {
    return RUNTIME_PRESETS.standard;
  }
  const key = name.trim().toLowerCase();
  const preset = RUNTIME_PRESETS[key];
  if (!preset) {
    throw new Error(
      `Unknown runtime preset '${name}'. Available presets: ${Object.keys(RUNTIME_PRESETS).join(', ')}`,
    );
  }
  return preset;
}
