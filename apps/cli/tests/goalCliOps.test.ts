import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import {
  goalCreateCommand,
  goalInspectCommand,
  goalLifecycleCommand,
  goalCancelCommand,
  goalResultsCommand,
  goalNobelCommand,
  registerGoalCommands,
} from '../src/commands/goalCommands.js';

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe('Goal Studio CLI Ops Integration (Agent A2)', () => {
  describe('goalCreateCommand', () => {
    it('creates graph with default project and objective matching name', async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        return mockResponse({
          record: {
            graphId: 'graph-auto-1',
            projectId: 'default',
            revision: 1,
            digest: 'sha256:abc1234',
          },
          validation: { valid: true, issues: [] },
        }, 201);
      });

      const res = await goalCreateCommand('my-graph', { fetchImpl });
      expect(res.code).toBe(0);
      expect(res.output).toContain('Goal Graph Created');
      expect(res.output).toContain('graphId:   graph-auto-1');
      expect(res.output).toContain('project:   default');
      expect(res.output).toContain('revision:  1');
      expect(res.output).toContain('digest:    sha256:abc1234');

      expect(calls.length).toBe(1);
      expect(calls[0].url).toContain('/api/v1/goal-studio/graphs/create');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].body).toEqual({
        projectId: 'default',
        name: 'my-graph',
        objective: 'my-graph',
      });
    });

    it('creates graph with custom objective, project, targets, and handles JSON mode', async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        return mockResponse({
          record: {
            graphId: 'graph-spec-2',
            projectId: 'proj-42',
            revision: 2,
            digest: 'sha256:def5678',
          },
          validation: { valid: true },
        }, 201);
      });

      const res = await goalCreateCommand('advance-ai', {
        objective: 'Conduct rigorous benchmark evaluation',
        project: 'proj-42',
        target: ['Setup evaluation harness', 'Run formal verification'],
        json: true,
        fetchImpl,
      });

      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.output);
      expect(parsed.record.graphId).toBe('graph-spec-2');
      expect(parsed.record.projectId).toBe('proj-42');
      expect(calls[0].body).toEqual({
        projectId: 'proj-42',
        name: 'advance-ai',
        objective: 'Conduct rigorous benchmark evaluation',
        targets: [
          { id: 'T1', title: 'Setup evaluation harness' },
          { id: 'T2', title: 'Run formal verification' },
        ],
      });
    });

    it('formats error when graph creation fails', async () => {
      const fetchImpl = vi.fn(async () => {
        return mockResponse({
          error: { code: 'INVALID_GRAPH', message: 'Target definition invalid' },
        }, 400);
      });

      const res = await goalCreateCommand('bad-graph', { fetchImpl });
      expect(res.code).toBe(1);
      expect(res.output).toContain('[INVALID_GRAPH] Target definition invalid');
    });
  });

  describe('goalInspectCommand', () => {
    it('inspects graph without revision and displays metadata, critical path, and target table', async () => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/critical-path')) {
          return mockResponse({
            graphId: 'g-inspect-1',
            revision: 1,
            digest: 'sha256:digest1',
            path: ['Y1.1', 'Y1.2'],
            weight: 198,
            order: ['Y1.1', 'Y1.2'],
          });
        }
        return mockResponse({
          record: {
            graphId: 'g-inspect-1',
            projectId: 'proj-inspect',
            revision: 1,
            digest: 'sha256:digest1',
            definition: {
              name: 'Provable Peace Protocol',
              objective: 'Formal mathematical safety properties',
              targets: [
                {
                  id: 'Y1.1',
                  stage: 'foundational_research',
                  priority: 100,
                  executor: 'axiomatize',
                  dependsOn: [],
                  approval: false,
                  external: false,
                  title: 'Define safety claim',
                },
                {
                  id: 'Y1.2',
                  stage: 'foundational_research',
                  priority: 98,
                  executor: 'formal_verify',
                  dependsOn: ['Y1.1'],
                  approval: true,
                  external: true,
                  title: 'Encode invariants',
                },
              ],
            },
          },
        });
      });

      const res = await goalInspectCommand('g-inspect-1', { fetchImpl });
      expect(res.code).toBe(0);
      expect(res.output).toContain('Goal Graph: g-inspect-1');
      expect(res.output).toContain('Provable Peace Protocol');
      expect(res.output).toContain('sha256:digest1');
      expect(res.output).toContain('critical path: Y1.1 -> Y1.2');

      // Table headers
      expect(res.output).toContain('ID');
      expect(res.output).toContain('STAGE');
      expect(res.output).toContain('PRIORITY');
      expect(res.output).toContain('EXECUTOR');
      expect(res.output).toContain('DEPENDS ON');
      expect(res.output).toContain('APPROVAL');
      expect(res.output).toContain('EXTERNAL');
      expect(res.output).toContain('TITLE');

      // Target rows
      expect(res.output).toContain('Y1.1');
      expect(res.output).toContain('axiomatize');
      expect(res.output).toContain('Define safety claim');
      expect(res.output).toContain('Y1.2');
      expect(res.output).toContain('formal_verify');
      expect(res.output).toContain('Encode invariants');

      expect(calls.some((u) => u.endsWith('/graphs/g-inspect-1'))).toBe(true);
      expect(calls.some((u) => u.endsWith('/graphs/g-inspect-1/critical-path'))).toBe(true);
    });

    it('inspects graph with pinned revision and JSON output', async () => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes('/critical-path')) {
          return mockResponse({
            graphId: 'g-rev-2',
            revision: 3,
            path: ['T1'],
          });
        }
        return mockResponse({
          record: {
            graphId: 'g-rev-2',
            revision: 3,
            digest: 'sha256:rev3hash',
            definition: { name: 'Revision 3 Graph', targets: [] },
          },
        });
      });

      const res = await goalInspectCommand('g-rev-2', { revision: 3, json: true, fetchImpl });
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.output);
      expect(parsed.record.revision).toBe(3);
      expect(parsed.criticalPath.path).toEqual(['T1']);

      expect(calls.some((u) => u.includes('/graphs/g-rev-2/revisions/3'))).toBe(true);
      expect(calls.some((u) => u.includes('/graphs/g-rev-2/critical-path?revision=3'))).toBe(true);
    });

    it('handles graph not found error gracefully', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes('/critical-path')) return mockResponse({}, 404);
        return mockResponse({ error: { code: 'NOT_FOUND', message: 'Graph does not exist' } }, 404);
      });

      const res = await goalInspectCommand('nonexistent', { fetchImpl });
      expect(res.code).toBe(1);
      expect(res.output).toContain('[NOT_FOUND] Graph does not exist');
    });
  });

  describe('goalLifecycleCommand cancel and goalCancelCommand', () => {
    it('executes cancel via goalLifecycleCommand', async () => {
      const calls: Array<{ url: string; method: string }> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET' });
        return mockResponse({
          run: {
            runId: 'run-99',
            status: 'cancelled',
            ledgerRevision: 7,
          },
        });
      });

      const res = await goalLifecycleCommand('cancel', 'run-99', { fetchImpl });
      expect(res.code).toBe(0);
      expect(res.output).toBe('Run run-99 -> cancelled (ledger rev 7)');
      expect(calls[0].url).toContain('/api/v1/goal-studio/runs/run-99/cancel');
      expect(calls[0].method).toBe('POST');
    });

    it('executes cancel via exported goalCancelCommand with JSON mode', async () => {
      const fetchImpl = vi.fn(async () => {
        return mockResponse({
          run: {
            runId: 'run-json-1',
            status: 'cancelled',
            ledgerRevision: 12,
          },
        });
      });

      const res = await goalCancelCommand('run-json-1', { json: true, fetchImpl });
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.output);
      expect(parsed.run.status).toBe('cancelled');
      expect(parsed.run.ledgerRevision).toBe(12);
    });
  });

  describe('goalResultsCommand', () => {
    it('fetches direct results and displays summary, evidence, artifact table, and target statuses', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        expect(url).toContain('/api/v1/goal-studio/runs/run-direct-1/results');
        return mockResponse({
          run: {
            runId: 'run-direct-1',
            graphId: 'graph-direct',
            graphRevision: 2,
            status: 'completed',
            ledgerRevision: 15,
            targets: {
              T1: { targetId: 'T1', status: 'verified' },
              T2: { targetId: 'T2', status: 'verified' },
            },
          },
          graph: { graphId: 'graph-direct', revision: 2 },
          attempts: [
            { targetId: 'T1', attempt: 1, status: 'succeeded' },
            { targetId: 'T2', attempt: 1, status: 'succeeded' },
          ],
          transitions: [],
          evidence: [
            { evidenceId: 'ev-1', targetId: 'T1', validationResult: 'pass', verified: true },
            { evidenceId: 'ev-2', targetId: 'T2', validationResult: 'pass', verified: true },
          ],
          artifacts: [
            { targetId: 'T1', uri: 'file:///tmp/artifact1.smt2', digest: 'sha256:aaa111', size: 1024 },
            { targetId: 'T2', uri: 'file:///tmp/artifact2.smt2', digest: 'sha256:bbb222', size: 2048 },
          ],
        });
      });

      const res = await goalResultsCommand('run-direct-1', { fetchImpl });
      expect(res.code).toBe(0);
      expect(res.output).toContain('Goal Run Results: run-direct-1');
      expect(res.output).toContain('graph:             graph-direct@2');
      expect(res.output).toContain('status:            completed');
      expect(res.output).toContain('ledger:            rev 15');
      expect(res.output).toContain('verified evidence: 2');

      // Artifact digests table
      expect(res.output).toContain('TARGET');
      expect(res.output).toContain('URI');
      expect(res.output).toContain('DIGEST');
      expect(res.output).toContain('SIZE');
      expect(res.output).toContain('sha256:aaa111');
      expect(res.output).toContain('sha256:bbb222');

      // Target final status
      expect(res.output).toContain('Target Status:');
      expect(res.output).toContain('T1');
      expect(res.output).toContain('T2');
      expect(res.output).toContain('verified');
    });

    it('falls back to /runs/:id + /attempts + /evidence when /results returns 404', async () => {
      const calls: string[] = [];
      const fetchImpl = vi.fn(async (url: string) => {
        calls.push(url);
        if (url.endsWith('/results')) {
          return mockResponse({ error: { message: 'Results endpoint not found' } }, 404);
        }
        if (url.endsWith('/attempts')) {
          return mockResponse({
            attempts: [{ targetId: 'T1', attempt: 1, status: 'succeeded' }],
          });
        }
        if (url.endsWith('/evidence')) {
          return mockResponse({
            evidence: [
              {
                evidenceId: 'ev-fb-1',
                targetId: 'T1',
                uri: 'file:///path/proof.json',
                digest: 'sha256:feedbeef',
                size: 512,
                validationResult: 'verified',
              },
            ],
          });
        }
        if (url.includes('/runs/run-fb-404')) {
          return mockResponse({
            run: {
              runId: 'run-fb-404',
              graphId: 'graph-fallback',
              graphRevision: 1,
              status: 'completed',
              ledgerRevision: 4,
              targets: {
                T1: { targetId: 'T1', status: 'verified' },
              },
            },
          });
        }
        return mockResponse({}, 404);
      });

      const res = await goalResultsCommand('run-fb-404', { fetchImpl });
      expect(res.code).toBe(0);
      expect(res.output).toContain('Goal Run Results: run-fb-404');
      expect(res.output).toContain('verified evidence: 1');
      expect(res.output).toContain('sha256:feedbeef');
      expect(res.output).toContain('T1');

      expect(calls.some((u) => u.endsWith('/runs/run-fb-404/results'))).toBe(true);
      expect(calls.some((u) => u.endsWith('/runs/run-fb-404'))).toBe(true);
      expect(calls.some((u) => u.endsWith('/runs/run-fb-404/attempts'))).toBe(true);
      expect(calls.some((u) => u.endsWith('/runs/run-fb-404/evidence'))).toBe(true);
    });

    it('returns JSON representation of results', async () => {
      const fetchImpl = vi.fn(async () => {
        return mockResponse({
          run: {
            runId: 'run-json-res',
            graphId: 'graph-j',
            graphRevision: 1,
            status: 'completed',
            ledgerRevision: 2,
          },
          artifacts: [],
          evidence: [],
        });
      });

      const res = await goalResultsCommand('run-json-res', { json: true, fetchImpl });
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.output);
      expect(parsed.run.runId).toBe('run-json-res');
      expect(parsed.verifiedEvidenceCount).toBe(0);
      expect(parsed.artifacts).toEqual([]);
    });

    it('handles failure when run cannot be found', async () => {
      const fetchImpl = vi.fn(async () => {
        return mockResponse({ error: { code: 'RUN_NOT_FOUND', message: 'Run run-missing not found' } }, 500);
      });

      const res = await goalResultsCommand('run-missing', { fetchImpl });
      expect(res.code).toBe(1);
      expect(res.output).toContain('[RUN_NOT_FOUND] Run run-missing not found');
    });
  });

  describe('goalNobelCommand', () => {
    it('seeds Nobel goal graph via POST /graphs/seed-nobel with default project', async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        return mockResponse({
          record: {
            graphId: 'nobel-governance-continuous-goal-graph',
            projectId: 'nobel-example',
            revision: 1,
            digest: 'sha256:nobeldigest123',
          },
          created: true,
          validation: { valid: true },
        }, 201);
      });

      const res = await goalNobelCommand({ fetchImpl });
      expect(res.code).toBe(0);
      expect(res.output).toContain('Goal Graph Seeded (Nobel)');
      expect(res.output).toContain('graphId:   nobel-governance-continuous-goal-graph');
      expect(res.output).toContain('project:   nobel-example');
      expect(res.output).toContain('revision:  1');
      expect(res.output).toContain('digest:    sha256:nobeldigest123');

      expect(calls.length).toBe(1);
      expect(calls[0].url).toContain('/api/v1/goal-studio/graphs/seed-nobel');
      expect(calls[0].method).toBe('POST');
      expect(calls[0].body).toEqual({ projectId: 'nobel-example' });
    });

    it('seeds and starts run when --start is specified', async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method: init?.method ?? 'GET', body });
        if (url.includes('/graphs/seed-nobel')) {
          return mockResponse({
            record: {
              graphId: 'nobel-governance-continuous-goal-graph',
              projectId: 'nobel-custom',
              revision: 2,
              digest: 'sha256:nobelrev2',
            },
          }, 200);
        }
        if (url.includes('/runs')) {
          return mockResponse({
            run: {
              runId: 'run-nobel-start-1',
              graphId: 'nobel-governance-continuous-goal-graph',
              graphRevision: 2,
              status: 'queued',
              ledgerRevision: 1,
            },
          }, 201);
        }
        return mockResponse({}, 404);
      });

      const res = await goalNobelCommand({ project: 'nobel-custom', start: true, fetchImpl });
      expect(res.code).toBe(0);
      expect(res.output).toContain('Goal Graph Seeded (Nobel)');
      expect(res.output).toContain('Goal Run Started: run-nobel-start-1');
      expect(res.output).toContain('graph:     nobel-governance-continuous-goal-graph@2');
      expect(res.output).toContain('status:    queued');

      expect(calls.length).toBe(2);
      expect(calls[0].url).toContain('/graphs/seed-nobel');
      expect(calls[1].url).toContain('/runs');
      expect(calls[1].body).toEqual({
        graphId: 'nobel-governance-continuous-goal-graph',
        graphRevision: 2,
      });
    });

    it('falls back to importing nobel fixture when seed-nobel endpoint returns 404', async () => {
      const calls: Array<{ url: string; method: string; body: any }> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ url, method: init?.method ?? 'GET', body });
        if (url.includes('/graphs/seed-nobel')) {
          return mockResponse({ error: { message: 'seed-nobel not supported' } }, 404);
        }
        if (url.includes('/graphs/import')) {
          return mockResponse({
            record: {
              graphId: 'nobel-imported-graph',
              projectId: 'nobel-example',
              revision: 1,
              digest: 'sha256:importedfromyaml',
            },
            validation: { valid: true },
          }, 201);
        }
        return mockResponse({}, 404);
      });

      const res = await goalNobelCommand({ fetchImpl });
      expect(res.code).toBe(0);
      expect(res.output).toContain('Goal Graph Seeded (Nobel)');
      expect(res.output).toContain('graphId:   nobel-imported-graph');

      expect(calls.some((c) => c.url.includes('/graphs/seed-nobel'))).toBe(true);
      const importCall = calls.find((c) => c.url.includes('/graphs/import'));
      expect(importCall).toBeDefined();
      expect(importCall?.body.projectId).toBe('nobel-example');
      expect(importCall?.body.yaml).toContain('nobel-governance-continuous-goal-graph');
    });

    it('returns JSON representation when --json is passed', async () => {
      const fetchImpl = vi.fn(async () => {
        return mockResponse({
          record: {
            graphId: 'nobel-json',
            projectId: 'nobel-example',
            revision: 1,
            digest: 'sha256:nobeljson',
          },
        }, 200);
      });

      const res = await goalNobelCommand({ json: true, fetchImpl });
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.output);
      expect(parsed.record.graphId).toBe('nobel-json');
    });
  });

  describe('registerGoalCommands CLI structure', () => {
    it('registers create, inspect, cancel, results, and nobel subcommands on Commander', () => {
      const program = new Command();
      const goalCmd = registerGoalCommands(program);

      const subcommands = goalCmd.commands.map((c) => c.name());
      expect(subcommands).toContain('create');
      expect(subcommands).toContain('inspect');
      expect(subcommands).toContain('cancel');
      expect(subcommands).toContain('pause');
      expect(subcommands).toContain('resume');
      expect(subcommands).toContain('stop');
      expect(subcommands).toContain('results');
      expect(subcommands).toContain('nobel');
      expect(subcommands).toContain('import');
      expect(subcommands).toContain('list');
      expect(subcommands).toContain('start');
      expect(subcommands).toContain('status');
      expect(subcommands).toContain('retry');
      expect(subcommands).toContain('approve');
      expect(subcommands).toContain('reject');

      // Verify create command options
      const createCmd = goalCmd.commands.find((c) => c.name() === 'create');
      const createOpts = createCmd?.options.map((o) => o.name());
      expect(createOpts).toContain('objective');
      expect(createOpts).toContain('project');
      expect(createOpts).toContain('target');
      expect(createOpts).toContain('json');

      // Verify inspect command options
      const inspectCmd = goalCmd.commands.find((c) => c.name() === 'inspect');
      const inspectOpts = inspectCmd?.options.map((o) => o.name());
      expect(inspectOpts).toContain('revision');
      expect(inspectOpts).toContain('json');

      // Verify nobel command options
      const nobelCmd = goalCmd.commands.find((c) => c.name() === 'nobel');
      const nobelOpts = nobelCmd?.options.map((o) => o.name());
      expect(nobelOpts).toContain('project');
      expect(nobelOpts).toContain('start');
      expect(nobelOpts).toContain('json');

      // Verify results command options
      const resultsCmd = goalCmd.commands.find((c) => c.name() === 'results');
      const resultsOpts = resultsCmd?.options.map((o) => o.name());
      expect(resultsOpts).toContain('json');
    });
  });
});
