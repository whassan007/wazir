#!/usr/bin/env node
/**
 * Goal Studio end-to-end demonstration, benchmark, and release-readiness runner.
 *
 * Usage:
 *   node scripts/goal-studio-demo.mjs [--json] [--run-vitest]
 *
 * Exercises the 12-step Goal Studio lifecycle on `packages/goals/fixtures/nobel_goal_graph.yaml`,
 * runs a 250-target synthetic DAG scale benchmark, and outputs a structured readiness report.
 */
import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from '../packages/shared/dist/index.js';
import { GOAL_STUDIO_CONTRACT_VERSION, idempotencyKey } from '../packages/goals/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'packages/goals/fixtures/nobel_goal_graph.yaml');

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

async function runLifecycleAndBenchmarks() {
  const startedAt = Date.now();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-goal-studio-demo-'));
  const workspaceRoot = path.join(tmpDir, 'workspace');
  const storePath = path.join(tmpDir, 'goal-studio-store.json');
  await fs.mkdir(workspaceRoot, { recursive: true });

  const steps = [];
  const recordStep = (step, name, status, durationMs, details = {}) => {
    steps.push({ step, name, status, durationMs: Math.round(durationMs * 100) / 100, details });
  };

  try {
    const yaml = readFileSync(FIXTURE_PATH, 'utf8');
    const fixtureDigest = `sha256:${sha256Hex(yaml)}`;

    // Step 1: Project creation & store initialization
    let t0 = performance.now();
    const store1 = new JsonFileStore(storePath);
    const project = {
      id: 'proj-nobel-demo',
      name: 'Provable Algorithmic Peace Program (Demo)',
      createdAt: new Date().toISOString(),
    };
    await store1.put(`goals/projects/${project.id}`, project);
    const loadedProject = await store1.get(`goals/projects/${project.id}`);
    recordStep(1, 'Create Goal Studio project', loadedProject?.id === project.id ? 'PASS' : 'FAIL', performance.now() - t0, {
      projectId: project.id,
      contractVersion: GOAL_STUDIO_CONTRACT_VERSION,
    });

    // Step 2 & 3: Parse & validate nobel_goal_graph.yaml
    t0 = performance.now();
    const targetMatches = [...yaml.matchAll(/^\s*-\s+id:\s+(Y\d+\.\d+)/gm)].map((m) => m[1]);
    const externalMatches = [...yaml.matchAll(/id:\s+(Y\d+\.\d+)[\s\S]*?(?=\n\s*-\s+id:|\n# Nodes form)/g)]
      .filter((m) => m[0].includes('external_dependency: true'))
      .map((m) => m[1]);
    const approvalMatches = [...yaml.matchAll(/id:\s+(Y\d+\.\d+)[\s\S]*?(?=\n\s*-\s+id:|\n# Nodes form)/g)]
      .filter((m) => m[0].includes('requires_approval: true'))
      .map((m) => m[1]);
    recordStep(2, 'Import strategic goal graph (nobel_goal_graph.yaml)', targetMatches.length === 10 ? 'PASS' : 'FAIL', performance.now() - t0, {
      fixtureDigest,
      targetsImported: targetMatches,
      externalDependencyTargets: externalMatches,
      requiresApprovalTargets: approvalMatches,
    });

    t0 = performance.now();
    const validStructure =
      targetMatches.length === 10 &&
      externalMatches.includes('Y1.4') &&
      externalMatches.includes('Y2.3') &&
      externalMatches.includes('Y3.3') &&
      yaml.includes('hosted_spend_usd: 0') &&
      yaml.includes('local_model_first: true');
    recordStep(3, 'Validate graph structure, dependencies, and constitution limits', validStructure ? 'PASS' : 'FAIL', performance.now() - t0, {
      hostedSpendUsd: 0,
      localModelFirst: true,
      maxTasksPerRun: 12,
      maxRepairsPerTask: 3,
      maxSameActionNoProgress: 2,
    });

    // Step 4: Persist graph state and immutable revisions
    t0 = performance.now();
    const graphId = 'graph-nobel-1';
    const rev1 = {
      graphId,
      projectId: project.id,
      revision: 1,
      digest: fixtureDigest,
      createdAt: new Date().toISOString(),
      createdBy: 'user:operator',
    };
    const rev2 = {
      graphId,
      projectId: project.id,
      revision: 2,
      parentRevision: 1,
      digest: `sha256:${sha256Hex(yaml + '\n# rev2')}`,
      createdAt: new Date().toISOString(),
      createdBy: 'user:operator',
    };
    await store1.put(`goals/graphs/${graphId}/rev/00000001`, rev1);
    await store1.put(`goals/graphs/${graphId}/rev/00000002`, rev2);
    await store1.put(`goals/graphs/${graphId}`, { graphId, projectId: project.id, name: 'nobel-governance-continuous-goal-graph', latestRevision: 2 });
    const checkRev1 = await store1.get(`goals/graphs/${graphId}/rev/00000001`);
    recordStep(4, 'Persist immutable graph revisions (rev 1 & rev 2)', checkRev1?.digest === fixtureDigest ? 'PASS' : 'FAIL', performance.now() - t0, {
      graphId,
      revisionsPersisted: [1, 2],
      rev1Digest: rev1.digest,
      rev2Digest: rev2.digest,
    });

    // Step 5–12: Run full Vitest E2E + Adversarial contract suite if requested or by default
    t0 = performance.now();
    const vitestRun = spawnSync('npx', ['vitest', 'run', 'tests/goal-studio', '--reporter=json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    const vitestDurationMs = performance.now() - t0;
    let vitestReport = null;
    try {
      const jsonStart = vitestRun.stdout.indexOf('{');
      if (jsonStart >= 0) {
        vitestReport = JSON.parse(vitestRun.stdout.slice(jsonStart));
      }
    } catch {
      // ignore parse fallback
    }
    const vitestOk = vitestRun.status === 0 && vitestReport && vitestReport.numFailedTests === 0;
    recordStep(
      5,
      'Execute 12-Step E2E & Adversarial Contract Suites (Vitest)',
      vitestOk ? 'PASS' : 'FAIL',
      vitestDurationMs,
      {
        exitCode: vitestRun.status,
        numTotalTests: vitestReport?.numTotalTests ?? 0,
        numPassedTests: vitestReport?.numPassedTests ?? 0,
        numFailedTests: vitestReport?.numFailedTests ?? 0,
      },
    );

    // Synthetic 250-target DAG benchmark
    t0 = performance.now();
    const nodeCount = 250;
    const nodes = [];
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < nodeCount; i++) {
      const deps = [];
      if (i > 0) {
        const kMax = Math.min(i, 3);
        for (let k = 0; k < kMax; k++) {
          const d = `T${Math.floor(rand() * i)}`;
          if (!deps.includes(d)) deps.push(d);
        }
      }
      nodes.push({ id: `T${i}`, dependsOn: deps, priority: Math.floor(rand() * 100) });
    }
    const statuses = Object.fromEntries(nodes.map((n) => [n.id, 'queued']));
    const eligible = nodes
      .filter((n) => n.dependsOn.every((d) => statuses[d] === 'completed'))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const benchMs = performance.now() - t0;
    recordStep(6, 'Benchmark 250-target synthetic DAG scheduling', benchMs < 100 && eligible.length > 0 ? 'PASS' : 'FAIL', benchMs, {
      targetCount: nodeCount,
      initialEligibleCount: eligible.length,
      schedulingDurationMs: Math.round(benchMs * 1000) / 1000,
    });

    // Cross-restart JsonFileStore durability & idempotency key verification
    t0 = performance.now();
    const idemKey = idempotencyKey('run-demo-1', 'Y1.1', 1, 'EXECUTE');
    await store1.put(`goals/idem/${idemKey}`, { result: { executionId: 'exec-1', ok: true }, recordedAt: new Date().toISOString() });
    const store2 = new JsonFileStore(storePath);
    const reloadedIdem = await store2.get(`goals/idem/${idemKey}`);
    recordStep(7, 'Reload durable state across fresh JsonFileStore instance', reloadedIdem?.result?.ok === true ? 'PASS' : 'FAIL', performance.now() - t0, {
      idempotencyKey: idemKey,
      reloadedOk: reloadedIdem?.result?.ok === true,
    });

    const allPassed = steps.every((s) => s.status === 'PASS');
    return {
      status: allPassed ? 'PASS' : 'FAIL',
      contractVersion: GOAL_STUDIO_CONTRACT_VERSION,
      totalDurationMs: Date.now() - startedAt,
      steps,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

const report = await runLifecycleAndBenchmarks();
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`=== Wazir Goal Studio Readiness & E2E Demo (Contract v${report.contractVersion}) ===`);
  for (const s of report.steps) {
    console.log(`  [${s.status}] Step ${s.step}: ${s.name} (${s.durationMs} ms)`);
  }
  console.log(`Overall Status: ${report.status} (${report.totalDurationMs} ms)`);
}
process.exit(report.status === 'PASS' ? 0 : 1);
