import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOAL_STUDIO_CONTRACT_VERSION, TERMINAL_TARGET_STATUSES } from '../../../packages/goals/src/contracts.js';
import * as Shell from '../public/goal-studio/shell.js';
import * as M from '../public/goal-studio/graph-model.js';
import { mountGraphStudio } from '../public/goal-studio/graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.resolve(__dirname, '..');
const PUBLIC_GS_DIR = path.join(WEB_DIR, 'public', 'goal-studio');

const NOBEL_TARGETS = [
  { id: 'Y1.1', stage: 'foundational_research', title: 'Define a bounded formal safety claim', depends_on: [], priority: 100, executor: 'axiomatize', artifacts: ['scope.md'], acceptance: ['Formal assumptions explicit'] },
  { id: 'Y1.2', stage: 'foundational_research', title: 'Encode invariants and produce checkable proof artifacts', depends_on: ['Y1.1'], priority: 98, executor: 'formal_verify', artifacts: ['model.smt2'], acceptance: ['Solver outputs checked'] },
  { id: 'Y1.3', stage: 'foundational_research', title: 'Prototype enforcement gate and adversarial bypass suite', depends_on: ['Y1.2'], priority: 94, executor: 'fleet_harness', artifacts: ['reference-gate/'], acceptance: ['All actions pass gate'] },
  { id: 'Y1.4', stage: 'foundational_research', title: 'Produce and independently review research manuscript', depends_on: ['Y1.2', 'Y1.3'], priority: 90, executor: 'research_author', artifacts: ['paper.md'], acceptance: ['Grounded in proofs'], external_dependency: true },
  { id: 'Y2.1', stage: 'open_protocol', title: 'Specify interoperable authorization and evidence protocol', depends_on: ['Y1.2', 'Y1.3'], priority: 88, executor: 'protocol_design', artifacts: ['protocol.md'], acceptance: ['Wire schemas defined'] },
  { id: 'Y2.2', stage: 'open_protocol', title: 'Build independent implementations and conformance tests', depends_on: ['Y2.1'], priority: 85, executor: 'fleet_harness', artifacts: ['conformance-tests/'], acceptance: ['Two implementations pass'] },
  { id: 'Y2.3', stage: 'open_protocol', title: 'Prepare standards submission and adoption evidence', depends_on: ['Y2.2'], priority: 80, executor: 'standards_strategy', artifacts: ['standards-draft.md'], acceptance: ['Venue verified'], external_dependency: true, requires_approval: true },
  { id: 'Y3.1', stage: 'institutionalization', title: 'Analyze international institutional and treaty feasibility', depends_on: ['Y2.1'], priority: 70, executor: 'treaty_strategy', artifacts: ['feasibility.md'], acceptance: ['Jurisdiction addressed'] },
  { id: 'Y3.2', stage: 'institutionalization', title: 'Draft voluntary multilateral verification framework', depends_on: ['Y3.1', 'Y2.2'], priority: 65, executor: 'treaty_strategy', artifacts: ['framework-draft.md'], acceptance: ['Treaty text distinguishes obligations'], requires_approval: true },
  { id: 'Y3.3', stage: 'institutionalization', title: 'Record genuine external endorsement or legal adoption', depends_on: ['Y3.2', 'Y2.3'], priority: 60, executor: 'external_evidence', artifacts: ['adoption-ledger.md'], acceptance: ['Endorsement verified'], external_dependency: true, requires_approval: true },
];

describe('Goal Studio Web Shell & Graph Model (Agent 06)', () => {
  describe('Static HTML & CSS contract verification', () => {
    it('serves index.html with shell.js module and optional modules list', () => {
      const html = fs.readFileSync(path.join(PUBLIC_GS_DIR, 'index.html'), 'utf8');
      expect(html).toContain('/goal-studio/shell.js');
      expect(html).toContain('data-modules="graph,control,prompts,fleet"');
      expect(html).toContain('/goal-studio/goal-studio.css');
    });

    it('defines CSS variables and status rules for all 12 TargetStatus states', () => {
      const css = fs.readFileSync(path.join(PUBLIC_GS_DIR, 'goal-studio.css'), 'utf8');
      expect(M.TARGET_STATUSES).toHaveLength(12);
      for (const status of M.TARGET_STATUSES) {
        expect(css).toContain(`--st-${status}:`);
        expect(css).toContain(`.gs-st-${status}`);
      }
      for (const term of TERMINAL_TARGET_STATUSES) {
        expect(M.TARGET_STATUSES).toContain(term);
      }
    });
  });

  describe('Shell contract (shell.js)', () => {
    it('exports contract version 1 event types and tab definitions', () => {
      expect(GOAL_STUDIO_CONTRACT_VERSION).toBe(1);
      expect(Shell.GOAL_STUDIO_EVENT_TYPES).toContain('run.created');
      expect(Shell.GOAL_STUDIO_EVENT_TYPES).toContain('target.transition');
      expect(Shell.GOAL_STUDIO_EVENT_TYPES).toContain('graph.revision');
      expect(Shell.TABS.map((t: { module: string }) => t.module)).toEqual(['graph', 'control', 'prompts', 'fleet']);
    });

    it('normalizes API paths and rejects cross-origin URLs', () => {
      expect(Shell.apiUrl('graphs')).toBe('/api/v1/goal-studio/graphs');
      expect(Shell.apiUrl('/graphs/g1/revisions')).toBe('/api/v1/goal-studio/graphs/g1/revisions');
      expect(Shell.apiUrl('/api/v1/goal-studio/runs')).toBe('/api/v1/goal-studio/runs');
      expect(() => Shell.apiUrl('https://evil.example/api')).toThrow(/same-origin/);
    });

    it('encodes plain object bodies and sets X-Wazir-Target-Host when non-local', () => {
      const init = Shell.buildInit({ method: 'POST', body: { projectId: 'default' } }, 'dgx-spark');
      const headers = init.headers as Headers;
      expect(headers.get('X-Wazir-Target-Host')).toBe('dgx-spark');
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(init.body).toBe(JSON.stringify({ projectId: 'default' }));
    });

    it('registers modules and validates mount(el, ctx) contract', () => {
      const registered: string[] = [];
      const reg = Shell.createRegistry({ onRegister: (name: string) => registered.push(name) });
      expect(() => reg.register('', { mount() {} })).toThrow(TypeError);
      expect(() => reg.register('graph', {})).toThrow(TypeError);
      const mod = { mount() {}, unmount() {} };
      reg.register('graph', mod);
      expect(reg.has('graph')).toBe(true);
      expect(reg.get('graph')).toBe(mod);
      expect(registered).toEqual(['graph']);
    });

    it('manages observable state and SSE reconnection with sequence deduplication', () => {
      const persisted: unknown[] = [];
      const state = Shell.createState({ graphId: 'g1' }, (s: unknown) => persisted.push(s));
      const seen: unknown[] = [];
      const unsub = state.subscribe((next: unknown) => seen.push(next));
      state.set({ revision: 2 });
      expect(state.graphId).toBe('g1');
      expect(state.revision).toBe(2);
      expect(persisted).toHaveLength(1);
      expect(seen).toHaveLength(1);
      unsub();

      // Fake EventSource to verify deduplication and ?after= reconnect
      const urls: string[] = [];
      let currentEs: any;
      class FakeEventSource {
        static CLOSED = 2;
        readyState = 1;
        onopen?: () => void;
        onmessage?: (msg: { data: string; lastEventId?: string }) => void;
        onerror?: () => void;
        listeners = new Map<string, (msg: { data: string }) => void>();
        constructor(url: string) {
          urls.push(url);
          currentEs = this;
        }
        addEventListener(type: string, fn: (msg: { data: string }) => void) {
          this.listeners.set(type, fn);
        }
        close() {
          this.readyState = 2;
        }
      }

      const received: any[] = [];
      let scheduledFn: (() => void) | undefined;
      const close = Shell.createEventStream('run-42', (ev: any) => received.push(ev), {
        EventSource: FakeEventSource,
        maxNativeRetries: 0,
        setTimeout: (fn: () => void) => { scheduledFn = fn; return 1; },
        clearTimeout: () => {},
      });

      expect(urls).toEqual(['/api/v1/goal-studio/runs/run-42/events']);
      currentEs.onmessage({ data: JSON.stringify({ seq: 1, type: 'run.status', data: { status: 'running' } }) });
      // Duplicate seq 1 must be ignored
      currentEs.onmessage({ data: JSON.stringify({ seq: 1, type: 'run.status', data: { status: 'running' } }) });
      currentEs.onmessage({ data: JSON.stringify({ seq: 2, type: 'target.transition', targetId: 'Y1.1', data: { toState: 'completed' } }) });
      expect(received).toHaveLength(2);
      expect(close.lastSeq()).toBe(2);

      // Simulate connection drop and reconnect with ?after=2
      currentEs.readyState = 2;
      currentEs.onerror();
      expect(scheduledFn).toBeDefined();
      scheduledFn!();
      expect(urls[1]).toBe('/api/v1/goal-studio/runs/run-42/events?after=2');
      close();
    });
  });

  describe('DAG layout, swimlanes, critical path, blockers & immutable draft edits (graph-model.js)', () => {
    const def = M.normalizeDefinition({
      schemaVersion: '1.0',
      name: 'nobel-governance-continuous-goal-graph',
      targets: NOBEL_TARGETS,
    });

    it('normalizes snake_case YAML targets and extracts multi-year stages (Y1, Y2, Y3)', () => {
      expect(def.targets).toHaveLength(10);
      const y14 = def.targets.find((t: any) => t.id === 'Y1.4');
      expect(y14.dependsOn).toEqual(['Y1.2', 'Y1.3']);
      expect(y14.externalDependency).toBe(true);

      const stages = M.extractStages(def.targets);
      expect(stages.map((s: any) => s.stage)).toEqual([
        'foundational_research',
        'open_protocol',
        'institutionalization',
      ]);
      expect(stages[0].label).toContain('Y1');
      expect(stages[1].label).toContain('Y2');
      expect(stages[2].label).toContain('Y3');
    });

    it('computes topological order, DAG layers, node coordinates, dependency edges, and stage swimlanes', () => {
      const layout = M.layoutGraph(def.targets);
      expect(layout.cyclic).toEqual([]);
      expect(layout.nodes).toHaveLength(10);
      expect(layout.edges).toHaveLength(13);
      expect(layout.swimlanes).toHaveLength(3);
      expect(layout.layer.get('Y1.1')).toBe(0);
      expect(layout.layer.get('Y1.2')).toBe(1);
      expect(layout.layer.get('Y1.3')).toBe(2);
      expect(layout.layer.get('Y3.3')).toBe(6);
    });

    it('computes critical path and updates remaining critical path when ledger completes targets', () => {
      const cpInitial = M.criticalPath(def.targets, null);
      expect(cpInitial[0]).toBe('Y1.1');
      expect(cpInitial[cpInitial.length - 1]).toBe('Y3.3');
      expect(cpInitial).toHaveLength(7);

      const ledger = {
        runId: 'run-1',
        graphId: 'g-1',
        graphRevision: 1,
        graphDigest: 'sha256:abc',
        status: 'running',
        targets: {
          'Y1.1': { targetId: 'Y1.1', status: 'completed', attempts: 1, repairs: 0, evidenceIds: ['ev-1'], blockers: [] },
          'Y1.2': { targetId: 'Y1.2', status: 'blocked', attempts: 3, repairs: 3, evidenceIds: [], blockers: ['SMT solver timeout'] },
        },
      };
      const bl = M.blockers(def.targets, ledger);
      expect(bl.some((b: any) => b.targetId === 'Y1.2' && b.kind === 'status')).toBe(true);
      // Y1.3 and Y3.3 are transitively cut off by blocked Y1.2
      expect(bl.some((b: any) => b.targetId === 'Y1.3' && b.kind === 'upstream')).toBe(true);
      expect(bl.some((b: any) => b.targetId === 'Y3.3' && b.kind === 'upstream')).toBe(true);
    });

    it('filters targets by search query, status, and stage', () => {
      const ledger = {
        targets: {
          'Y1.1': { targetId: 'Y1.1', status: 'completed' },
          'Y2.1': { targetId: 'Y2.1', status: 'active' },
        },
      };
      expect([...M.filterTargets(def.targets, ledger, { stage: 'open_protocol' })]).toEqual(['Y2.1', 'Y2.2', 'Y2.3']);
      expect([...M.filterTargets(def.targets, ledger, { status: 'active' })]).toEqual(['Y2.1']);
      expect([...M.filterTargets(def.targets, ledger, { query: 'manuscript' })]).toEqual(['Y1.4']);
    });

    it('enforces cycle prevention in draft editor and builds immutable revision requests without mutating active run pin', () => {
      const baseRecord = {
        graphId: 'nobel-graph',
        projectId: 'default',
        revision: 1,
        digest: 'sha256:1111',
        definition: def,
      };
      let draft = M.createDraft(baseRecord);
      expect(M.isDirty(draft)).toBe(false);

      // Adding Y1.1 -> Y3.3 would create a cycle because Y3.3 transitively depends on Y1.1
      expect(() => M.applyEdit(draft, { op: 'addDependency', targetId: 'Y1.1', dependsOn: 'Y3.3' })).toThrow(/cycle/);

      // Valid edits produce a new immutable draft while leaving baseRecord untouched
      draft = M.applyEdit(draft, { op: 'setTitle', targetId: 'Y1.1', title: 'Updated formal safety claim' });
      draft = M.applyEdit(draft, { op: 'setPriority', targetId: 'Y1.1', priority: 105 });
      expect(M.isDirty(draft)).toBe(true);
      expect(baseRecord.definition.targets[0].title).toBe('Define a bounded formal safety claim');

      const req = M.revisionRequest(draft);
      expect(req.path).toBe('graphs/nobel-graph/revisions');
      expect(req.body.parentRevision).toBe(1);
      expect(req.body.definition.targets[0].title).toBe('Updated formal safety claim');

      // Active run remains pinned to revision 1 even after revision 2 is created
      const run = { runId: 'run-pinned', graphRevision: 1, graphDigest: 'sha256:1111', status: 'running' };
      const pin = M.pinInfo(run, 2, 2);
      expect(pin).toEqual({
        runId: 'run-pinned',
        pinnedRevision: 1,
        digest: 'sha256:1111',
        viewingPinned: false,
        behindLatest: true,
        active: true,
      });
    });

    it('includes the nobel_goal_graph.yaml preset for one-click import', () => {
      expect(M.NOBEL_PRESET_YAML).toContain('name: nobel-governance-continuous-goal-graph');
      expect(M.NOBEL_PRESET_YAML).toContain('id: Y1.1');
      expect(M.NOBEL_PRESET_YAML).toContain('id: Y3.3');
    });

    it('exports mountGraphStudio from graph.js', () => {
      expect(typeof mountGraphStudio).toBe('function');
    });

    it('handles zoom, pan, fit-to-screen, revision diffs, and live event ledger overlays', () => {
      const v0 = M.fitView(1200, 600, 800, 400);
      expect(v0.k).toBeGreaterThanOrEqual(M.ZOOM_MIN);
      expect(v0.k).toBeLessThanOrEqual(M.ZOOM_MAX);
      const vZoom = M.zoomAt(v0, 1.5, 400, 200);
      expect(vZoom.k).toBeGreaterThan(v0.k);
      const vPan = M.panBy(vZoom, 25, -15);
      expect(vPan.x).toBe(vZoom.x + 25);
      expect(vPan.y).toBe(vZoom.y - 15);
      const world = M.screenToWorld(vPan, 400, 200);
      expect(Number.isFinite(world.x)).toBe(true);

      // Revision diff
      const defB = M.clone(def);
      defB.targets[0].title = 'Changed Y1.1 title';
      defB.targets[1].dependsOn.push('Y1.3');
      const diff = M.diffDefinitions(def, defB);
      expect(diff.empty).toBe(false);
      expect(diff.changed.map((c: any) => c.targetId)).toEqual(['Y1.1', 'Y1.2']);

      // Live SSE event application
      const initialLedger = {
        runId: 'run-live',
        status: 'running',
        targets: { 'Y1.1': { targetId: 'Y1.1', status: 'active', attempts: 1, repairs: 0, evidenceIds: [], blockers: [] } },
      };
      const step1 = M.applyEventToLedger(initialLedger, {
        seq: 5,
        type: 'target.transition',
        targetId: 'Y1.1',
        timestamp: '2026-10-23T02:00:00Z',
        data: { toState: 'completed' },
      });
      expect(step1.changed).toBe(true);
      expect(step1.ledger.targets['Y1.1'].status).toBe('completed');

      const step2 = M.applyEventToLedger(step1.ledger, {
        seq: 6,
        type: 'run.idle',
        timestamp: '2026-10-23T02:01:00Z',
        data: {},
      });
      expect(step2.changed).toBe(true);
      expect(step2.ledger.status).toBe('idle');
    });
  });

  describe('Web server routes & API proxy (apps/web/server.js)', () => {
    const children: ChildProcess[] = [];
    const servers: http.Server[] = [];

    afterEach(async () => {
      for (const c of children) {
        c.kill('SIGTERM');
      }
      children.length = 0;
      for (const s of servers) {
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
      servers.length = 0;
    });

    it('serves /goal-studio, /goal-studio/, and /goal-studio/*.js cleanly and proxies /api/* to upstream API', async () => {
      // Start mock upstream API server
      const upstreamRequests: Array<{ method?: string; url?: string }> = [];
      const apiServer = http.createServer((req, res) => {
        upstreamRequests.push({ method: req.method, url: req.url });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ graphs: [{ graphId: 'nobel', name: 'Nobel Graph', latestRevision: 1 }] }));
      });
      servers.push(apiServer);
      await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', () => resolve()));
      const apiPort = (apiServer.address() as { port: number }).port;

      // Pick a free port for the web server
      const probe = http.createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
      const webPort = (probe.address() as { port: number }).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const child = spawn(process.execPath, [path.join(WEB_DIR, 'server.js')], {
        env: {
          ...process.env,
          PORT: String(webPort),
          WAZIR_WEB_HOST: '127.0.0.1',
          WAZIR_API: `http://127.0.0.1:${apiPort}`,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('web server start timeout')), 5000);
        child.stdout?.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('wazir-web listening')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timeout);
          reject(new Error(`web server exited early with code ${code}`));
        });
      });

      const base = `http://127.0.0.1:${webPort}`;

      const resNoSlash = await fetch(`${base}/goal-studio`);
      expect(resNoSlash.status).toBe(200);
      expect(resNoSlash.headers.get('content-type')).toContain('text/html');
      const htmlNoSlash = await resNoSlash.text();
      expect(htmlNoSlash).toContain('Wazir Goal Studio');

      const resSlash = await fetch(`${base}/goal-studio/`);
      expect(resSlash.status).toBe(200);
      const htmlSlash = await resSlash.text();
      expect(htmlSlash).toBe(htmlNoSlash);

      for (const asset of ['shell.js', 'graph.js', 'graph-model.js', 'goal-studio.css']) {
        const assetRes = await fetch(`${base}/goal-studio/${asset}`);
        expect(assetRes.status).toBe(200);
      }

      // Proxy /api/v1/goal-studio/graphs to upstream API
      const apiRes = await fetch(`${base}/api/v1/goal-studio/graphs`);
      expect(apiRes.status).toBe(200);
      const apiBody = await apiRes.json();
      expect(apiBody.graphs[0].graphId).toBe('nobel');
      expect(upstreamRequests.some((r) => r.url === '/api/v1/goal-studio/graphs')).toBe(true);
    });
  });
});
