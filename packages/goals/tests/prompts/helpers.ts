import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore, type KeyValueStore } from '@wazir/shared';
import { createPromptStore, type PromptSeed, type PromptStoreOptions } from '../../src/prompts/index.js';

export const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/nobel_goal_graph.yaml');

/**
 * Test-only extractor for the fixture's `prompts:` section (Agent 02 owns real
 * YAML import). Handles exactly the shape the fixture uses:
 *   <2sp>key:\n<4sp>role: x\n<4sp>template: |-\n<6sp>lines...
 */
export function fixturePromptSeeds(file = FIXTURE): PromptSeed[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line === 'prompts:');
  if (start < 0) throw new Error('fixture has no prompts: section');
  const seeds: PromptSeed[] = [];
  let current: { executorKey: string; role?: string; template: string[] } | undefined;
  let inTemplate = false;
  const flush = () => {
    if (current?.role) seeds.push({ executorKey: current.executorKey, role: current.role, template: current.template.join('\n') });
  };
  for (const line of lines.slice(start + 1)) {
    if (line.length && !line.startsWith(' ')) break; // next top-level key
    const key = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (key) {
      flush();
      current = { executorKey: key[1], template: [] };
      inTemplate = false;
      continue;
    }
    if (!current) continue;
    const role = /^ {4}role:\s*(.+)$/.exec(line);
    if (role) { current.role = role[1].trim(); inTemplate = false; continue; }
    if (/^ {4}template:\s*\|-?\s*$/.test(line)) { inTemplate = true; continue; }
    if (inTemplate && (line.startsWith('      ') || line === '')) { current.template.push(line.slice(6)); continue; }
    inTemplate = false;
  }
  flush();
  for (const seed of seeds) seed.template = seed.template.replace(/\n+$/, '');
  return seeds;
}

export function fixedClock(start = Date.parse('2026-10-22T10:00:00.000Z'), stepMs = 1000): () => Date {
  let now = start;
  return () => {
    const value = new Date(now);
    now += stepMs;
    return value;
  };
}

export function makeStudio(options: PromptStoreOptions & { store?: KeyValueStore } = {}) {
  const store = options.store ?? new MemoryStore();
  const studio = createPromptStore({ store, workspaceRoot: '/tmp/unused', clock: fixedClock(), ...options });
  return { store, studio };
}

/** A KeyValueStore without `update`, to exercise the in-process mutex fallback. */
export function storeWithoutUpdate(): KeyValueStore {
  const inner = new MemoryStore();
  return {
    put: (key, value) => inner.put(key, value),
    get: (key) => inner.get(key),
    list: (prefix) => inner.list(prefix),
    delete: (key) => inner.delete(key),
    clear: () => inner.clear(),
  };
}

export const SELECT_DRAFT = {
  executorKey: 'select_target',
  role: 'portfolio_scheduler',
  template: 'From {{target_ledger}}, choose a target within {{resource_limits}}.\nReturn {target_id, rationale}.',
  inputSchema: {
    type: 'object',
    required: ['target_ledger', 'resource_limits'],
    properties: { target_ledger: { type: 'object' }, resource_limits: { type: 'object' } },
  },
  outputSchema: {
    type: 'object',
    required: ['target_id', 'rationale'],
    properties: { target_id: { type: 'string' }, rationale: { type: 'string' } },
  },
  requiredCapabilities: ['reasoning', 'generalChat'],
};
