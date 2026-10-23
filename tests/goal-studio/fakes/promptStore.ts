/** Reference PromptStore: immutable monotonic versions; `publish` is a fake-only extension. */
import type { KeyValueStore } from '@wazir/shared';
import { GOAL_STORE_KEYS, type PromptDefinition, type PromptId, type PromptStore, type PromptVersion } from '../../../packages/goals/src/contracts.js';
import { parseYamlLite } from './yamlLite.js';
import { clone, getIso, mutexFor, sha256Hex, systemClock, type Clock } from './util.js';

export class MemoryPromptStore implements PromptStore {
  private readonly clock: Clock;
  constructor(private readonly store: KeyValueStore, opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  async latest(executorKey: string): Promise<PromptDefinition | undefined> {
    const head = await getIso<{ promptId: PromptId; version: PromptVersion }>(this.store, GOAL_STORE_KEYS.promptHead(executorKey));
    return head ? this.get(head.promptId, head.version) : undefined;
  }

  async get(promptId: PromptId, version: PromptVersion): Promise<PromptDefinition | undefined> {
    return getIso<PromptDefinition>(this.store, GOAL_STORE_KEYS.prompt(promptId, version));
  }

  /** Writes a new immutable version; never rewrites an existing one. */
  async publish(input: { executorKey: string; role: string; template: string; requiredCapabilities?: string[]; actor: string }): Promise<PromptDefinition> {
    const promptId = `prompt-${input.executorKey}`;
    return mutexFor(this.store).run(`prompt:${promptId}`, async () => {
      const head = await getIso<{ promptId: PromptId; version: PromptVersion }>(this.store, GOAL_STORE_KEYS.promptHead(input.executorKey));
      const version = (head?.version ?? 0) + 1;
      const def: PromptDefinition = {
        id: promptId,
        version,
        executorKey: input.executorKey,
        role: input.role,
        template: input.template,
        requiredCapabilities: input.requiredCapabilities ?? ['text-generation'],
        digest: `sha256:${sha256Hex(`${input.role}\n${input.template}`)}`,
        createdAt: this.clock().toISOString(),
        createdBy: input.actor,
      };
      await this.store.put(GOAL_STORE_KEYS.prompt(promptId, version), def);
      await this.store.put(GOAL_STORE_KEYS.promptHead(input.executorKey), { promptId, version });
      return clone(def);
    });
  }

  /** Seeds one version per prompt in the goal-graph YAML `prompts:` section. */
  async seedFromGraphYaml(yaml: string, actor = 'system:seed'): Promise<PromptDefinition[]> {
    const raw = parseYamlLite(yaml) as { prompts?: Record<string, { role: string; template: string }> };
    const out: PromptDefinition[] = [];
    for (const [key, p] of Object.entries(raw.prompts ?? {})) out.push(await this.publish({ executorKey: key, role: p.role, template: p.template, actor }));
    return out;
  }
}
