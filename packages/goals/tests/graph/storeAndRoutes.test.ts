import http from 'node:http';
import express from 'express';
import { MemoryStore } from '@wazir/shared';
import { describe, expect, it } from 'vitest';
import { ApiAuth } from '../../../../apps/api/src/auth.js';
import { registerGraphRoutes } from '../../../../apps/api/src/goalStudio/graphRoutes.js';
import { GOAL_STORE_KEYS, GoalStudioFailure } from '../../src/contracts.js';
import { createGoalGraphStore, graphDigest } from '../../src/graph/index.js';
import { NOBEL_YAML, tinyDefinition } from './helpers.js';

describe('GoalGraphStore persistence, immutability, and concurrency', () => {
  it('imports YAML into immutable revisions with SHA-256 canonical JSON digests and preserves prior revisions', async () => {
    const store = new MemoryStore();
    let tick = 0;
    const clock = () => new Date(1700000000000 + tick++ * 1000);
    const graphs = createGoalGraphStore({ store, clock, workspaceRoot: '/tmp' });

    // Import Nobel graph -> revision 1
    const first = await graphs.importYaml('proj-1', NOBEL_YAML, 'user:alice');
    expect(first.validation.valid).toBe(true);
    expect(first.created).toBe(true);
    expect(first.record).toBeDefined();
    const rev1 = first.record!;
    expect(rev1.revision).toBe(1);
    expect(rev1.projectId).toBe('proj-1');
    expect(rev1.createdBy).toBe('user:alice');
    expect(rev1.digest).toBe(graphDigest(rev1.definition));
    expect(rev1.parentRevision).toBeUndefined();

    // Re-importing identical YAML is idempotent (created: false, stays at revision 1)
    const duplicate = await graphs.importYaml('proj-1', NOBEL_YAML, 'user:bob');
    expect(duplicate.created).toBe(false);
    expect(duplicate.record?.revision).toBe(1);
    expect(duplicate.record?.digest).toBe(rev1.digest);

    // Mutate definition and create revision 2
    const nextDef = structuredClone(rev1.definition);
    nextDef.purpose = 'Amended purpose for revision 2';
    nextDef.targets[0].priority = 120;

    const rev2 = await graphs.createRevision(rev1.graphId, nextDef, 'user:bob', 1);
    expect(rev2.revision).toBe(2);
    expect(rev2.parentRevision).toBe(1);
    expect(rev2.digest).toBe(graphDigest(nextDef));
    expect(rev2.digest).not.toBe(rev1.digest);

    // Mutating the caller's object after createRevision must not affect stored revision 2
    nextDef.purpose = 'Caller mutated in-place';
    const fetchedRev2 = await graphs.getRevision(rev1.graphId, 2);
    expect(fetchedRev2?.definition.purpose).toBe('Amended purpose for revision 2');

    // Revision 1 remains strictly immutable and unchanged
    const fetchedRev1 = await graphs.getRevision(rev1.graphId, 1);
    expect(fetchedRev1).toEqual(rev1);

    // Latest revision defaults to 2
    const latest = await graphs.getRevision(rev1.graphId);
    expect(latest?.revision).toBe(2);

    // listRevisions and listGraphs
    const revisions = await graphs.listRevisions(rev1.graphId);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);

    const allGraphs = await graphs.listGraphs('proj-1');
    expect(allGraphs).toEqual([
      {
        graphId: rev1.graphId,
        projectId: 'proj-1',
        name: 'nobel-governance-continuous-goal-graph',
        latestRevision: 2,
      },
    ]);
    expect(await graphs.listGraphs('other-project')).toEqual([]);

    // Diff between revision 1 and 2
    const diff = await graphs.diff(rev1.graphId, 1, 2);
    expect(diff.identical).toBe(false);
    expect(diff.fromRevision).toBe(1);
    expect(diff.toRevision).toBe(2);
    expect(diff.targets.changed).toEqual([
      { targetId: 'Y1.1', changes: [{ path: 'priority', before: 100, after: 120 }] },
    ]);
  });

  it('rejects stale parentRevision with LEDGER_CONFLICT and detects tampered stored digests', async () => {
    const store = new MemoryStore();
    const graphs = createGoalGraphStore({ store, workspaceRoot: '/tmp' });

    const { record: r1 } = await graphs.importYaml('proj-1', NOBEL_YAML, 'user:alice');
    const graphId = r1!.graphId;
    const def2 = structuredClone(r1!.definition);
    def2.purpose = 'rev 2';
    await graphs.createRevision(graphId, def2, 'user:alice', 1);

    // Trying to branch from revision 1 again when latest is 2 must throw LEDGER_CONFLICT
    await expect(graphs.createRevision(graphId, def2, 'user:bob', 1)).rejects.toMatchObject({
      code: 'LEDGER_CONFLICT',
      retryable: true,
    });

    // Tamper with stored canonical JSON -> integrity check fails with INTERNAL
    const rev1Key = GOAL_STORE_KEYS.graphRevision(graphId, 1);
    const raw = await store.get<Record<string, unknown>>(rev1Key);
    await store.put(rev1Key, { ...raw, canonicalDefinition: '{"tampered":true}' });
    await expect(graphs.getRevision(graphId, 1)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
});

describe('Goal Studio graph HTTP routes (apps/api/src/goalStudio/graphRoutes.ts)', () => {
  async function withTestServer(
    configureStore = true,
    fn: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const store = new MemoryStore();
    const auth = new ApiAuth({
      operatorToken: 'op-secret-token',
      viewerToken: 'view-secret-token',
      allowUnauthenticated: false,
      store,
    });
    const graphs = configureStore ? createGoalGraphStore({ store, workspaceRoot: '/tmp' }) : undefined;
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    registerGraphRoutes(app, {
      auth,
      store,
      services: { graphs },
    });

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}/api/v1/goal-studio/graphs`;
    try {
      await fn(baseUrl);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  const headers = (token?: string): Record<string, string> => {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (token) h.authorization = `Bearer ${token}`;
    return h;
  };

  it('enforces viewer/operator RBAC and handles import, validate, list, get, createRevision, critical-path, and diff', async () => {
    await withTestServer(true, async (base) => {
      // Unauthenticated read -> 401
      const unauthRes = await fetch(base);
      expect(unauthRes.status).toBe(401);

      // Viewer cannot mutate (POST /graphs/import -> 403)
      const viewerImport = await fetch(`${base}/import`, {
        method: 'POST',
        headers: headers('view-secret-token'),
        body: JSON.stringify({ projectId: 'p1', yaml: NOBEL_YAML }),
      });
      expect(viewerImport.status).toBe(403);

      // Operator imports Nobel YAML -> 201
      const importRes = await fetch(`${base}/import`, {
        method: 'POST',
        headers: headers('op-secret-token'),
        body: JSON.stringify({ projectId: 'p1', yaml: NOBEL_YAML }),
      });
      expect(importRes.status).toBe(201);
      const imported = (await importRes.json()) as {
        created: boolean;
        record: { graphId: string; revision: number; definition: ReturnType<typeof tinyDefinition> };
      };
      expect(imported.created).toBe(true);
      expect(imported.record.revision).toBe(1);
      const graphId = imported.record.graphId;

      // Re-import unchanged -> 200 created: false
      const reimportRes = await fetch(`${base}/import`, {
        method: 'POST',
        headers: headers('op-secret-token'),
        body: JSON.stringify({ projectId: 'p1', yaml: NOBEL_YAML }),
      });
      expect(reimportRes.status).toBe(200);

      // Viewer can list graphs, get latest graph, list revisions, and get specific revision
      const listRes = await fetch(`${base}?projectId=p1`, { headers: headers('view-secret-token') });
      expect(listRes.status).toBe(200);
      const listed = (await listRes.json()) as { graphs: Array<{ graphId: string; latestRevision: number }> };
      expect(listed.graphs).toHaveLength(1);
      expect(listed.graphs[0].graphId).toBe(graphId);

      const getRes = await fetch(`${base}/${graphId}`, { headers: headers('view-secret-token') });
      expect(getRes.status).toBe(200);

      // Operator creates revision 2 via POST /graphs/:graphId/revisions
      const nextDef = structuredClone(imported.record.definition);
      nextDef.purpose = 'Revision 2 via HTTP';
      const createRevRes = await fetch(`${base}/${graphId}/revisions`, {
        method: 'POST',
        headers: headers('op-secret-token'),
        body: JSON.stringify({ definition: nextDef, parentRevision: 1 }),
      });
      expect(createRevRes.status).toBe(201);

      // Stale parentRevision -> 409 LEDGER_CONFLICT
      const conflictRes = await fetch(`${base}/${graphId}/revisions`, {
        method: 'POST',
        headers: headers('op-secret-token'),
        body: JSON.stringify({ definition: nextDef, parentRevision: 1 }),
      });
      expect(conflictRes.status).toBe(409);
      const conflictBody = (await conflictRes.json()) as { error: { code: string } };
      expect(conflictBody.error.code).toBe('LEDGER_CONFLICT');

      // Viewer reads revisions list, specific revision, critical path, and diff
      const revsRes = await fetch(`${base}/${graphId}/revisions`, { headers: headers('view-secret-token') });
      expect(revsRes.status).toBe(200);
      const revsBody = (await revsRes.json()) as { revisions: Array<{ revision: number }> };
      expect(revsBody.revisions.map((r) => r.revision)).toEqual([1, 2]);

      const rev1Res = await fetch(`${base}/${graphId}/revisions/1`, { headers: headers('view-secret-token') });
      expect(rev1Res.status).toBe(200);

      const cpRes = await fetch(`${base}/${graphId}/critical-path?revision=1`, { headers: headers('view-secret-token') });
      expect(cpRes.status).toBe(200);
      const cpBody = (await cpRes.json()) as { path: string[]; weight: number };
      expect(cpBody.path[0]).toBe('Y1.1');

      const diffRes = await fetch(`${base}/${graphId}/diff?from=1&to=2`, { headers: headers('view-secret-token') });
      expect(diffRes.status).toBe(200);
      const diffBody = (await diffRes.json()) as { diff: { identical: boolean; metadata: unknown[] } };
      expect(diffBody.diff.identical).toBe(false);
      expect(diffBody.diff.metadata).toHaveLength(1);

      // Dry-run validate endpoint (POST /graphs/validate)
      const valRes = await fetch(`${base}/validate`, {
        method: 'POST',
        headers: headers('op-secret-token'),
        body: JSON.stringify({ definition: tinyDefinition() }),
      });
      expect(valRes.status).toBe(200);
      const valBody = (await valRes.json()) as { validation: { valid: boolean } };
      expect(valBody.validation.valid).toBe(true);

      // Missing graph -> 404 NOT_FOUND
      const notFoundRes = await fetch(`${base}/unknown-graph`, { headers: headers('view-secret-token') });
      expect(notFoundRes.status).toBe(404);
    });
  });

  it('returns 503 when graphs service is not configured in route context', async () => {
    await withTestServer(false, async (base) => {
      const res = await fetch(base, { headers: headers('view-secret-token') });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('INTERNAL');
    });
  });
});
