import type { ContextItem, ContextPart } from '../types/context.js';
import { estimateTokens } from './contextCompiler.js';

export type PromptItemStability = 'STATIC' | 'SEMI_STABLE' | 'VOLATILE';

export type PromptLayoutStrategy =
  | 'CACHE_STABLE_PREFIX'
  | 'RELEVANCE_FIRST'
  | 'HEAD_TAIL'
  | 'STRUCTURAL_EXTRACT';

export interface PlannedPromptLayout {
  strategy: PromptLayoutStrategy;
  stablePrefix: ContextItem[];
  semiStable: ContextItem[];
  volatileTail: ContextItem[];
  orderedItems: ContextItem[];
  tokens: {
    stablePrefix: number;
    semiStable: number;
    volatileTail: number;
    total: number;
  };
}

/**
 * Plans and organizes model prompt layout for optimal prompt caching and token efficiency.
 *
 * Classifies items into:
 * - STATIC: core system prompt, agent identity, root instructions, stable tool definitions.
 * - SEMI_STABLE: package-scoped instructions, architectural context, symbol index.
 * - VOLATILE: active error, current diff, recent tool observations, newest turns.
 *
 * Guarantees:
 * - Deterministic item ordering.
 * - Volatile mutations (e.g. error updates, fresh observations) do NOT alter the stable prefix hash.
 */
export class PromptLayoutPlanner {
  /**
   * Classify an individual context item's stability.
   */
  classifyStability(item: ContextItem): PromptItemStability {
    if (item.category === 'PINNED') {
      if (item.kind === 'system') return 'STATIC';
      if (item.kind === 'tools') return 'STATIC';
      if (item.label.toLowerCase().includes('core')) return 'STATIC';
    }

    if (item.sourceUri?.includes('AGENTS.md') || item.sourceUri?.includes('WAZIR.md')) {
      if (item.scope === 'root' || !item.scope) return 'STATIC';
      return 'SEMI_STABLE';
    }

    if (item.kind === 'repository' && (item.label.includes('Symbols') || item.label.includes('Callers'))) {
      return 'SEMI_STABLE';
    }

    if (item.kind === 'memory' || item.label.toLowerCase().includes('summary')) {
      return 'SEMI_STABLE';
    }

    if (item.category === 'ACTIVE') {
      return 'VOLATILE';
    }

    if (item.kind === 'conversation' || item.kind === 'task' || item.label.toLowerCase().includes('turn')) {
      return 'VOLATILE';
    }

    return 'VOLATILE';
  }

  /**
   * Plans the layout of context items according to the requested strategy.
   */
  plan(items: ContextItem[], strategy: PromptLayoutStrategy = 'CACHE_STABLE_PREFIX'): PlannedPromptLayout {
    const staticItems: ContextItem[] = [];
    const semiStableItems: ContextItem[] = [];
    const volatileItems: ContextItem[] = [];

    for (const item of items) {
      const stability = this.classifyStability(item);
      if (stability === 'STATIC') {
        staticItems.push(item);
      } else if (stability === 'SEMI_STABLE') {
        semiStableItems.push(item);
      } else {
        volatileItems.push(item);
      }
    }

    // Sort deterministically within groups by priority descending, then label
    const sortGroup = (group: ContextItem[]) => {
      group.sort((a, b) => {
        const prioA = typeof a.priority === 'number' ? a.priority : a.priority === 'critical' ? 100 : a.priority === 'important' ? 70 : 40;
        const prioB = typeof b.priority === 'number' ? b.priority : b.priority === 'critical' ? 100 : b.priority === 'important' ? 70 : 40;
        if (prioB !== prioA) return prioB - prioA;
        return a.label.localeCompare(b.label);
      });
    };

    sortGroup(staticItems);
    sortGroup(semiStableItems);
    sortGroup(volatileItems);

    let orderedItems: ContextItem[] = [];

    switch (strategy) {
      case 'CACHE_STABLE_PREFIX':
        // Static -> SemiStable -> Volatile (optimal for KV-cache prefix hits)
        orderedItems = [...staticItems, ...semiStableItems, ...volatileItems];
        break;

      case 'RELEVANCE_FIRST':
        // Highest priority candidates first regardless of stability
        orderedItems = [...items].sort((a, b) => {
          const prioA = typeof a.priority === 'number' ? a.priority : 50;
          const prioB = typeof b.priority === 'number' ? b.priority : 50;
          return prioB - prioA;
        });
        break;

      case 'HEAD_TAIL':
        // Static and pinned at head, recent volatile at tail, compressible in middle
        orderedItems = [...staticItems, ...semiStableItems, ...volatileItems];
        break;

      case 'STRUCTURAL_EXTRACT':
        // System -> Code Intelligence / Symbols -> Instructions -> Volatile
        orderedItems = [
          ...staticItems.filter((i) => i.kind === 'system'),
          ...semiStableItems.filter((i) => i.kind === 'repository'),
          ...staticItems.filter((i) => i.kind !== 'system'),
          ...semiStableItems.filter((i) => i.kind !== 'repository'),
          ...volatileItems,
        ];
        break;
    }

    const countTokens = (group: ContextItem[]) =>
      group.reduce((sum, item) => sum + (item.tokens ?? item.estimatedTokens ?? estimateTokens(item.content)), 0);

    const stableTokens = countTokens(staticItems);
    const semiStableTokens = countTokens(semiStableItems);
    const volatileTokens = countTokens(volatileItems);

    return {
      strategy,
      stablePrefix: staticItems,
      semiStable: semiStableItems,
      volatileTail: volatileItems,
      orderedItems,
      tokens: {
        stablePrefix: stableTokens,
        semiStable: semiStableTokens,
        volatileTail: volatileTokens,
        total: stableTokens + semiStableTokens + volatileTokens,
      },
    };
  }
}
