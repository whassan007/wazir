import { randomUUID } from 'node:crypto';
import type { EpisodicRecord } from './memoryService.js';

export interface SemanticFact {
  id: string;
  repositoryScope: string;
  topic: string;
  statement: string;
  confidence: number;
  supportingEpisodeIds: string[];
  filesInvolved: string[];
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
}

export interface DreamingConsolidationResult {
  consolidatedFacts: SemanticFact[];
  supersededFactIds: string[];
  processedEpisodeCount: number;
}

/**
 * Background "dreaming" consolidation pass (Meta-Harness three-tier memory):
 * distills completed `EpisodicRecord`s into compact `SemanticFact`s grouped by
 * taskType + failure/repair pattern, and supersedes stale lower-confidence facts.
 */
export class MemoryDreamer {
  private readonly facts = new Map<string, SemanticFact>();

  listFacts(repositoryScope?: string, includeSuperseded = false): SemanticFact[] {
    const all = [...this.facts.values()];
    return all.filter((f) => {
      if (repositoryScope && f.repositoryScope !== repositoryScope) return false;
      if (!includeSuperseded && f.supersededBy) return false;
      return true;
    });
  }

  consolidate(episodes: EpisodicRecord[], repositoryScope?: string): DreamingConsolidationResult {
    const filtered = episodes.filter((e) => e.valid && (!repositoryScope || e.repositoryScope === repositoryScope));
    const groups = new Map<string, EpisodicRecord[]>();

    for (const ep of filtered) {
      const key = `${ep.repositoryScope}::${ep.taskType}::${ep.repairStrategy ?? ep.failurePattern ?? ep.attemptOutcome}`;
      const list = groups.get(key) ?? [];
      list.push(ep);
      groups.set(key, list);
    }

    const consolidatedFacts: SemanticFact[] = [];
    const supersededFactIds: string[] = [];
    const now = new Date().toISOString();

    for (const [groupKey, groupEps] of groups) {
      const [scope, taskType, pattern] = groupKey.split('::');
      const successes = groupEps.filter((e) => e.attemptOutcome === 'success').length;
      const total = groupEps.length;
      const confidence = Number((successes / Math.max(1, total)).toFixed(3));
      const files = [...new Set(groupEps.flatMap((e) => e.filesInvolved))];
      const topic = `${taskType}:${pattern}`;

      const statement =
        successes > 0
          ? `For ${taskType}, strategy "${pattern}" succeeded in ${successes}/${total} episode(s).`
          : `For ${taskType}, failure pattern "${pattern}" occurred in ${total} episode(s) without verified repair.`;

      // Supersede any older fact on the same scope + topic
      const newId = `sem-${randomUUID()}`;
      for (const existing of this.facts.values()) {
        if (existing.repositoryScope === scope && existing.topic === topic && !existing.supersededBy) {
          existing.supersededBy = newId;
          supersededFactIds.push(existing.id);
        }
      }

      const fact: SemanticFact = {
        id: newId,
        repositoryScope: scope,
        topic,
        statement,
        confidence,
        supportingEpisodeIds: groupEps.map((e) => e.id),
        filesInvolved: files,
        createdAt: now,
        updatedAt: now,
      };
      this.facts.set(fact.id, fact);
      consolidatedFacts.push(fact);
    }

    return {
      consolidatedFacts,
      supersededFactIds,
      processedEpisodeCount: filtered.length,
    };
  }
}
