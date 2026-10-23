/** Reference GoalGraphStore: immutable monotonic revisions over a KeyValueStore. */
import { randomUUID } from 'node:crypto';
import type { KeyValueStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  type GoalGraphDefinition,
  type GoalGraphRevisionRecord,
  type GoalGraphStore,
  type GraphId,
  type GraphRevision,
  type GraphValidationResult,
  type ProjectId,
} from '../../../packages/goals/src/contracts.js';
import { definitionDigest, parseGraphYaml, referenceValidate } from './graphDefinition.js';
import { clone, fail, getIso, listIso, mutexFor, systemClock, type Clock } from './util.js';

interface GraphHead {
  graphId: GraphId;
  projectId: ProjectId;
  name: string;
  latestRevision: GraphRevision;
}

export class MemoryGoalGraphStore implements GoalGraphStore {
  private readonly clock: Clock;
  constructor(private readonly store: KeyValueStore, opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  validate(definition: GoalGraphDefinition): GraphValidationResult {
    return referenceValidate(definition);
  }

  async importYaml(projectId: ProjectId, yaml: string, actor: string) {
    let definition: GoalGraphDefinition;
    try {
      definition = parseGraphYaml(yaml);
    } catch (error) {
      return { validation: { valid: false, issues: [{ code: 'SCHEMA' as const, message: error instanceof Error ? error.message : String(error) }] } };
    }
    const validation = this.validate(definition);
    if (!validation.valid) return { validation };
    const graphId = `graph-${randomUUID()}`;
    const record = await this.write(graphId, projectId, definition, actor, 1, undefined);
    return { record, validation };
  }

  async createRevision(graphId: GraphId, definition: GoalGraphDefinition, actor: string, parentRevision: GraphRevision): Promise<GoalGraphRevisionRecord> {
    return mutexFor(this.store).run(`graph:${graphId}`, async () => {
      const head = await getIso<GraphHead>(this.store, GOAL_STORE_KEYS.graph(graphId));
      if (!head) fail('NOT_FOUND', `graph ${graphId} not found`);
      if (head.latestRevision !== parentRevision) fail('LEDGER_CONFLICT', `parent revision ${parentRevision} is not latest (${head.latestRevision})`);
      const validation = this.validate(definition);
      if (!validation.valid) fail('VALIDATION', 'graph definition is invalid', { issues: validation.issues });
      return this.writeUnlocked(graphId, head.projectId, definition, actor, parentRevision + 1, parentRevision);
    });
  }

  private async write(graphId: GraphId, projectId: ProjectId, definition: GoalGraphDefinition, actor: string, revision: number, parent?: number) {
    return mutexFor(this.store).run(`graph:${graphId}`, () => this.writeUnlocked(graphId, projectId, definition, actor, revision, parent));
  }

  private async writeUnlocked(graphId: GraphId, projectId: ProjectId, definition: GoalGraphDefinition, actor: string, revision: number, parent?: number) {
    const key = GOAL_STORE_KEYS.graphRevision(graphId, revision);
    if (await this.store.get(key)) fail('DUPLICATE', `revision ${revision} of ${graphId} already exists`);
    const record: GoalGraphRevisionRecord = {
      graphId,
      projectId,
      revision,
      definition: clone(definition),
      digest: definitionDigest(definition),
      createdAt: this.clock().toISOString(),
      createdBy: actor,
      ...(parent !== undefined ? { parentRevision: parent } : {}),
    };
    await this.store.put(key, record);
    const head: GraphHead = { graphId, projectId, name: definition.name, latestRevision: revision };
    await this.store.put(GOAL_STORE_KEYS.graph(graphId), head);
    return clone(record);
  }

  async getRevision(graphId: GraphId, revision?: GraphRevision): Promise<GoalGraphRevisionRecord | undefined> {
    let rev = revision;
    if (rev === undefined) {
      const head = await getIso<GraphHead>(this.store, GOAL_STORE_KEYS.graph(graphId));
      if (!head) return undefined;
      rev = head.latestRevision;
    }
    return getIso<GoalGraphRevisionRecord>(this.store, GOAL_STORE_KEYS.graphRevision(graphId, rev));
  }

  async listRevisions(graphId: GraphId) {
    const entries = await listIso<GoalGraphRevisionRecord>(this.store, `${GOAL_STORE_KEYS.graph(graphId)}/rev/`);
    return entries.map(({ value: r }) => ({ graphId: r.graphId, revision: r.revision, digest: r.digest, createdAt: r.createdAt, createdBy: r.createdBy }));
  }

  async listGraphs(projectId?: ProjectId) {
    const entries = await listIso<GraphHead>(this.store, 'goals/graphs/');
    return entries
      .filter((e) => !e.key.includes('/rev/'))
      .map((e) => e.value)
      .filter((h) => (projectId ? h.projectId === projectId : true))
      .map((h) => ({ graphId: h.graphId, projectId: h.projectId, name: h.name, latestRevision: h.latestRevision }));
  }
}
