import { createHash } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';

/**
 * A durable fact shared across the whole fleet, not one agent's session. Unlike
 * `packages/memory`'s per-process conversation store, this is keyed by project
 * (so any agent, on any machine, picking up work in the same repo sees it) and
 * backed by whatever `KeyValueStore` the engine already uses for everything else
 * (JsonFileStore locally, PostgresStore for a shared multi-machine deployment) —
 * no new persistence mechanism, no new trust boundary.
 */
export interface FleetMemoryFact {
  id: string;
  projectKey: string;
  title: string;
  body: string;
  tags?: string[];
  createdAt: string;
  /** Monotonic per-process counter, used only to break ties when two facts share
   *  a millisecond-resolution `createdAt` (e.g. several `remember()` calls in a
   *  tight loop) — `createdAt` alone is not strictly ordered at that resolution. */
  seq: number;
  createdByExecutionId?: string;
  createdByComputerId?: string;
}

export interface RememberFactInput {
  projectRoot: string;
  title: string;
  body: string;
  tags?: string[];
  executionId?: string;
  computerId?: string;
}

export interface RecallFactsOptions {
  /** Keyword relevance filter. Deterministic term-overlap scoring, not embeddings — see recall(). */
  query?: string;
  limit?: number;
}

const DEFAULT_RECALL_LIMIT = 8;
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 4000;
const MAX_TAGS = 10;
/** Oldest facts are dropped once a project accumulates more than this — a cheap
 *  bound against unbounded growth until staleness/supersession is designed properly. */
const MAX_FACTS_PER_PROJECT = 500;

function projectKey(projectRoot: string): string {
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}

let sequenceCounter = 0;
function nextSeq(): number {
  sequenceCounter += 1;
  return sequenceCounter;
}

export class FleetMemoryService {
  constructor(private readonly store: Pick<KeyValueStore, 'put' | 'get' | 'list' | 'delete'>) {}

  private prefix(projectRoot: string): string {
    return `fleet-memory:${projectKey(projectRoot)}:`;
  }

  /** Records a durable fact for this project, visible to every agent that later
   *  recalls facts for the same `projectRoot` — on this machine or any other
   *  sharing the same KeyValueStore. */
  async remember(input: RememberFactInput): Promise<FleetMemoryFact> {
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) throw new Error('remember_fact requires a non-empty title');
    if (!body) throw new Error('remember_fact requires a non-empty body');

    const fact: FleetMemoryFact = {
      id: `fact-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectKey: projectKey(input.projectRoot),
      title: title.slice(0, MAX_TITLE_CHARS),
      body: body.slice(0, MAX_BODY_CHARS),
      tags: input.tags?.map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, MAX_TAGS),
      createdAt: new Date().toISOString(),
      seq: nextSeq(),
      createdByExecutionId: input.executionId,
      createdByComputerId: input.computerId,
    };

    await this.store.put(`${this.prefix(input.projectRoot)}${fact.id}`, fact);
    await this.enforceRetention(input.projectRoot);
    return fact;
  }

  /** Most-recent-first by default; `query` narrows to facts sharing at least one
   *  term with the query (simple, deterministic keyword overlap — no embeddings,
   *  no external dependency, and every ranking decision is inspectable). */
  async recall(projectRoot: string, options: RecallFactsOptions = {}): Promise<FleetMemoryFact[]> {
    const entries = await this.store.list(this.prefix(projectRoot));
    let facts = entries.map((e) => e.value as FleetMemoryFact).filter((f): f is FleetMemoryFact => Boolean(f?.id));

    if (options.query && options.query.trim()) {
      const scored = facts
        .map((fact) => ({ fact, score: relevance(fact, options.query!) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || b.fact.createdAt.localeCompare(a.fact.createdAt) || b.fact.seq - a.fact.seq);
      facts = scored.map((s) => s.fact);
    } else {
      facts = facts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.seq - a.seq);
    }

    return facts.slice(0, options.limit ?? DEFAULT_RECALL_LIMIT);
  }

  async forget(projectRoot: string, factId: string): Promise<void> {
    await this.store.delete(`${this.prefix(projectRoot)}${factId}`);
  }

  private async enforceRetention(projectRoot: string): Promise<void> {
    const entries = await this.store.list(this.prefix(projectRoot));
    if (entries.length <= MAX_FACTS_PER_PROJECT) return;
    const facts = entries
      .map((e) => e.value as FleetMemoryFact)
      .filter((f): f is FleetMemoryFact => Boolean(f?.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.seq - b.seq);
    const overflow = facts.length - MAX_FACTS_PER_PROJECT;
    for (const fact of facts.slice(0, overflow)) await this.forget(projectRoot, fact.id);
  }
}

function relevance(fact: FleetMemoryFact, query: string): number {
  const haystack = `${fact.title} ${fact.body} ${(fact.tags ?? []).join(' ')}`.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const term of terms) if (haystack.includes(term)) score += 1;
  return score;
}

export function createFleetMemoryService(
  store: Pick<KeyValueStore, 'put' | 'get' | 'list' | 'delete'>,
): FleetMemoryService {
  return new FleetMemoryService(store);
}
