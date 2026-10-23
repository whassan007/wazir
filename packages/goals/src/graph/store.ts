import type { KeyValueStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  GoalStudioFailure,
  type GoalGraphDefinition,
  type GoalGraphRevisionRecord,
  type GoalGraphStore,
  type GoalStudioDeps,
  type GraphId,
  type GraphRevision,
  type GraphValidationResult,
  type ProjectId,
} from '../contracts.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { diffRevisions, type GoalGraphDiff } from './diff.js';
import { parseGoalGraphYaml, type GoalGraphImportExtras, type PromptSeed } from './importer.js';
import { criticalPath, topologicalOrder, validateGoalGraph, type CriticalPathResult } from './validation.js';

/** Graph ids and project ids appear in store keys and URL paths. */
export const GRAPH_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Head/index record at GOAL_STORE_KEYS.graph(graphId). Revision records are the source of truth. */
export interface GoalGraphHead {
  graphId: GraphId;
  projectId: ProjectId;
  name: string;
  latestRevision: GraphRevision;
  latestDigest: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

/**
 * Persisted form of a revision. The definition is stored as its canonical
 * JSON string so neither key reordering (Postgres JSONB) nor the stores' ISO
 * date revival can alter the digested bytes; reads re-verify the digest.
 */
interface StoredRevision {
  format: 1;
  graphId: GraphId;
  projectId: ProjectId;
  revision: GraphRevision;
  digest: string;
  createdAt: string;
  createdBy: string;
  parentRevision?: GraphRevision;
  canonicalDefinition: string;
}

export interface GoalGraphImportResult {
  record?: GoalGraphRevisionRecord;
  validation: GraphValidationResult;
  /** false when an identical definition was already the latest revision (idempotent re-import). */
  created?: boolean;
  extras?: GoalGraphImportExtras;
  prompts?: PromptSeed[];
}

export interface GoalGraphSummary {
  graphId: GraphId;
  projectId: ProjectId;
  name: string;
  latestRevision: GraphRevision;
}

/** Contract store plus graph-workstream extensions used by the UI routes. */
export interface GoalGraphStoreExtended extends GoalGraphStore {
  importYaml(projectId: ProjectId, yaml: string, actor: string): Promise<GoalGraphImportResult>;
  getGraph(graphId: GraphId): Promise<GoalGraphHead | undefined>;
  diff(graphId: GraphId, fromRevision: GraphRevision, toRevision: GraphRevision): Promise<GoalGraphDiff>;
  criticalPath(graphId: GraphId, revision?: GraphRevision): Promise<CriticalPathResult & { graphId: GraphId; revision: GraphRevision; order: string[] }>;
}

export interface GoalGraphStoreDeps extends GoalStudioDeps {
  /** Called after a revision is durably written (e.g. to emit a `graph.revision` event). Errors are swallowed. */
  onRevision?: (record: GoalGraphRevisionRecord) => void | Promise<void>;
}

/** Deterministic graph id for (project, graph name). */
export function deriveGraphId(projectId: ProjectId, name: string): GraphId {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'graph';
  return `${slug(projectId)}--${slug(name)}`;
}

const REVISION_PREFIX = (graphId: GraphId) => `${GOAL_STORE_KEYS.graph(graphId)}/rev/`;
const GRAPH_PREFIX = GOAL_STORE_KEYS.graph('');

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export function createGoalGraphStore(deps: GoalGraphStoreDeps): GoalGraphStoreExtended {
  const store = deps.store;
  const now = () => (deps.clock ? deps.clock() : new Date()).toISOString();
  const atomic = atomicUpdater(store);

  function checkGraphId(graphId: unknown): asserts graphId is GraphId {
    if (typeof graphId !== 'string' || !GRAPH_ID_PATTERN.test(graphId)) throw new GoalStudioFailure('VALIDATION', `invalid graph id ${JSON.stringify(graphId)}`);
  }
  function checkActor(actor: unknown): asserts actor is string {
    if (typeof actor !== 'string' || actor.trim() === '' || actor.length > 200) throw new GoalStudioFailure('VALIDATION', 'actor must be a non-empty string');
  }

  function toRecord(stored: StoredRevision, key: string): GoalGraphRevisionRecord {
    const expectedKey = GOAL_STORE_KEYS.graphRevision(stored.graphId, stored.revision);
    if (stored.format !== 1 || typeof stored.canonicalDefinition !== 'string' || expectedKey !== key || sha256Hex(stored.canonicalDefinition) !== stored.digest) {
      throw new GoalStudioFailure('INTERNAL', `graph revision integrity check failed for ${key}`, { details: { key } });
    }
    const record: GoalGraphRevisionRecord = {
      graphId: stored.graphId,
      projectId: stored.projectId,
      revision: stored.revision,
      definition: JSON.parse(stored.canonicalDefinition) as GoalGraphDefinition,
      digest: stored.digest,
      createdAt: iso(stored.createdAt),
      createdBy: stored.createdBy,
    };
    if (stored.parentRevision !== undefined && stored.parentRevision !== null) record.parentRevision = stored.parentRevision;
    return record;
  }

  async function readStored(graphId: GraphId, revision: GraphRevision): Promise<StoredRevision | undefined> {
    return store.get<StoredRevision>(GOAL_STORE_KEYS.graphRevision(graphId, revision));
  }

  /** Latest revision: head pointer, rolled forward past any revision written before a crash left the head stale. */
  async function latestRevisionOf(graphId: GraphId, head?: GoalGraphHead): Promise<GraphRevision> {
    let latest = head?.latestRevision ?? 0;
    while (await readStored(graphId, latest + 1)) latest++;
    return latest;
  }

  /** Atomically writes revision `revision` iff it does not exist yet. This is the concurrency guard. */
  async function claimRevision(stored: StoredRevision): Promise<void> {
    const key = GOAL_STORE_KEYS.graphRevision(stored.graphId, stored.revision);
    await atomic<StoredRevision>(key, (current) => {
      if (current !== undefined && current !== null) {
        throw new GoalStudioFailure('LEDGER_CONFLICT', `graph ${stored.graphId} revision ${stored.revision} already exists (stale parentRevision ${stored.revision - 1})`, {
          retryable: true,
          details: { graphId: stored.graphId, parentRevision: stored.revision - 1 },
        });
      }
      return stored;
    });
  }

  async function advanceHead(stored: StoredRevision, name: string): Promise<void> {
    await atomic<GoalGraphHead>(GOAL_STORE_KEYS.graph(stored.graphId), (current) => {
      if (!current) {
        return { graphId: stored.graphId, projectId: stored.projectId, name, latestRevision: stored.revision, latestDigest: stored.digest, createdAt: stored.createdAt, createdBy: stored.createdBy, updatedAt: stored.createdAt };
      }
      const head = { ...current, createdAt: iso(current.createdAt), updatedAt: iso(current.updatedAt) };
      if (stored.revision <= head.latestRevision) return head;
      return { ...head, name, latestRevision: stored.revision, latestDigest: stored.digest, updatedAt: stored.createdAt };
    });
  }

  async function writeRevision(graphId: GraphId, projectId: ProjectId, definition: GoalGraphDefinition, actor: string, revision: GraphRevision, parentRevision?: GraphRevision): Promise<GoalGraphRevisionRecord> {
    const canonicalDefinition = canonicalJson(definition);
    const stored: StoredRevision = {
      format: 1,
      graphId,
      projectId,
      revision,
      digest: sha256Hex(canonicalDefinition),
      createdAt: now(),
      createdBy: actor,
      canonicalDefinition,
    };
    if (parentRevision !== undefined) stored.parentRevision = parentRevision;
    await claimRevision(stored);
    await advanceHead(stored, definition.name);
    const record = toRecord(stored, GOAL_STORE_KEYS.graphRevision(graphId, revision));
    if (deps.onRevision) {
      try {
        await deps.onRevision(record);
      } catch {
        // Notification failures never undo a durable revision.
      }
    }
    return record;
  }

  function assertValid(definition: GoalGraphDefinition): GraphValidationResult {
    const validation = validateGoalGraph(definition);
    if (!validation.valid) {
      throw new GoalStudioFailure('VALIDATION', `invalid goal graph: ${validation.issues[0].message}`, { details: { issues: validation.issues } });
    }
    return validation;
  }

  const api: GoalGraphStoreExtended = {
    validate(definition) {
      return validateGoalGraph(definition);
    },

    async importYaml(projectId, yaml, actor) {
      if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) throw new GoalStudioFailure('VALIDATION', `invalid project id ${JSON.stringify(projectId)}`);
      checkActor(actor);
      if (typeof yaml !== 'string' || yaml.trim() === '') throw new GoalStudioFailure('VALIDATION', 'yaml must be a non-empty string');
      const parsed = parseGoalGraphYaml(yaml);
      if (!parsed.definition || !parsed.validation.valid) return { validation: parsed.validation, extras: parsed.extras, prompts: parsed.prompts };
      const definition = parsed.definition;
      const graphId = deriveGraphId(projectId, definition.name);
      const head = await store.get<GoalGraphHead>(GOAL_STORE_KEYS.graph(graphId));
      const latest = await latestRevisionOf(graphId, head);
      if (latest > 0) {
        const current = await api.getRevision(graphId, latest);
        if (current && current.digest === sha256Hex(canonicalJson(definition))) {
          return { record: current, validation: parsed.validation, created: false, extras: parsed.extras, prompts: parsed.prompts };
        }
        const record = await writeRevision(graphId, projectId, definition, actor, latest + 1, latest);
        return { record, validation: parsed.validation, created: true, extras: parsed.extras, prompts: parsed.prompts };
      }
      const record = await writeRevision(graphId, projectId, definition, actor, 1);
      return { record, validation: parsed.validation, created: true, extras: parsed.extras, prompts: parsed.prompts };
    },

    async createRevision(graphId, definition, actor, parentRevision) {
      checkGraphId(graphId);
      checkActor(actor);
      if (!Number.isSafeInteger(parentRevision) || parentRevision < 1) throw new GoalStudioFailure('VALIDATION', 'parentRevision must be a positive integer');
      assertValid(definition);
      const head = await store.get<GoalGraphHead>(GOAL_STORE_KEYS.graph(graphId));
      const latest = await latestRevisionOf(graphId, head);
      if (latest === 0) throw new GoalStudioFailure('NOT_FOUND', `graph ${graphId} not found`);
      if (parentRevision !== latest) {
        throw new GoalStudioFailure('LEDGER_CONFLICT', `stale parentRevision ${parentRevision}; latest revision of ${graphId} is ${latest}`, {
          retryable: true,
          details: { graphId, parentRevision, latestRevision: latest },
        });
      }
      const parent = await readStored(graphId, parentRevision);
      const projectId = head?.projectId ?? parent!.projectId;
      return writeRevision(graphId, projectId, structuredClone(definition), actor, parentRevision + 1, parentRevision);
    },

    async getRevision(graphId, revision) {
      checkGraphId(graphId);
      let rev = revision;
      if (rev === undefined) {
        const head = await store.get<GoalGraphHead>(GOAL_STORE_KEYS.graph(graphId));
        rev = await latestRevisionOf(graphId, head);
        if (rev === 0) return undefined;
      }
      if (!Number.isSafeInteger(rev) || rev < 1) throw new GoalStudioFailure('VALIDATION', 'revision must be a positive integer');
      const stored = await readStored(graphId, rev);
      return stored ? toRecord(stored, GOAL_STORE_KEYS.graphRevision(graphId, rev)) : undefined;
    },

    async listRevisions(graphId) {
      checkGraphId(graphId);
      const entries = await store.list(REVISION_PREFIX(graphId));
      return entries
        .map(({ value }) => value as StoredRevision)
        .filter((s) => s && s.graphId === graphId && typeof s.revision === 'number')
        .sort((a, b) => a.revision - b.revision)
        .map((s) => ({ graphId: s.graphId, revision: s.revision, digest: s.digest, createdAt: iso(s.createdAt), createdBy: s.createdBy }));
    },

    async listGraphs(projectId) {
      const entries = await store.list(GRAPH_PREFIX);
      const heads = new Map<string, GoalGraphHead>();
      const maxRev = new Map<string, StoredRevision>();
      for (const { key, value } of entries) {
        const rest = key.slice(GRAPH_PREFIX.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          heads.set(rest, value as GoalGraphHead);
        } else if (rest.slice(slash).startsWith('/rev/')) {
          const s = value as StoredRevision;
          const graphId = rest.slice(0, slash);
          if ((maxRev.get(graphId)?.revision ?? 0) < s.revision) maxRev.set(graphId, s);
        }
      }
      const out: GoalGraphSummary[] = [];
      for (const [graphId, latestStored] of maxRev) {
        const head = heads.get(graphId);
        const pid = head?.projectId ?? latestStored.projectId;
        if (projectId !== undefined && pid !== projectId) continue;
        const latestRevision = Math.max(head?.latestRevision ?? 0, latestStored.revision);
        let name = head?.name ?? '';
        if (!head || latestStored.revision > head.latestRevision) {
          try {
            name = (JSON.parse(latestStored.canonicalDefinition) as GoalGraphDefinition).name;
          } catch {
            /* keep head name */
          }
        }
        out.push({ graphId, projectId: pid, name, latestRevision });
      }
      return out.sort((a, b) => (a.graphId < b.graphId ? -1 : a.graphId > b.graphId ? 1 : 0));
    },

    async getGraph(graphId) {
      checkGraphId(graphId);
      const head = await store.get<GoalGraphHead>(GOAL_STORE_KEYS.graph(graphId));
      const latest = await latestRevisionOf(graphId, head);
      if (latest === 0) return undefined;
      if (head && head.latestRevision === latest) return { ...head, createdAt: iso(head.createdAt), updatedAt: iso(head.updatedAt) };
      const record = (await api.getRevision(graphId, latest))!;
      return {
        graphId,
        projectId: record.projectId,
        name: record.definition.name,
        latestRevision: latest,
        latestDigest: record.digest,
        createdAt: head ? iso(head.createdAt) : record.createdAt,
        createdBy: head?.createdBy ?? record.createdBy,
        updatedAt: record.createdAt,
      };
    },

    async diff(graphId, fromRevision, toRevision) {
      const [a, b] = await Promise.all([api.getRevision(graphId, fromRevision), api.getRevision(graphId, toRevision)]);
      if (!a) throw new GoalStudioFailure('NOT_FOUND', `graph ${graphId} revision ${fromRevision} not found`);
      if (!b) throw new GoalStudioFailure('NOT_FOUND', `graph ${graphId} revision ${toRevision} not found`);
      return diffRevisions(a, b);
    },

    async criticalPath(graphId, revision) {
      const record = await api.getRevision(graphId, revision);
      if (!record) throw new GoalStudioFailure('NOT_FOUND', revision === undefined ? `graph ${graphId} not found` : `graph ${graphId} revision ${revision} not found`);
      return { graphId, revision: record.revision, ...criticalPath(record.definition), order: topologicalOrder(record.definition) };
    },
  };
  return api;
}

/**
 * `KeyValueStore.update` when the store provides it (atomic in MemoryStore,
 * JsonFileStore and PostgresStore); otherwise a per-key in-process mutex over
 * get/put, which is only safe for a single process.
 */
function atomicUpdater(store: KeyValueStore): <T>(key: string, mutate: (current: T | undefined) => T) => Promise<T> {
  if (typeof store.update === 'function') return (key, mutate) => store.update!(key, mutate);
  const chains = new Map<string, Promise<unknown>>();
  return async <T>(key: string, mutate: (current: T | undefined) => T): Promise<T> => {
    const prev = chains.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(async () => {
      const value = mutate(await store.get<T>(key));
      await store.put(key, value);
      return value;
    });
    chains.set(key, run);
    try {
      return await run;
    } finally {
      if (chains.get(key) === run) chains.delete(key);
    }
  };
}
