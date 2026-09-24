#!/usr/bin/env node
/**
 * Wazir Acceptance Test Harness
 *
 * Drives the Wazir Acceptance Test Library:
 * 48 acceptance use cases structured into 16 progressive release gates (G0..G15).
 *
 * Strict Release Rule:
 * Gates must be passed progressively (G0 -> G1 -> ... -> G15).
 * A later gate CANNOT compensate for a failure in an earlier prerequisite gate.
 *
 * Usage:
 *   node scripts/acceptance-test-harness.mjs                 # interactive selector (or foundational if non-interactive)
 *   node scripts/acceptance-test-harness.mjs --foundational  # run foundational sequence (20, 17, 18, 1, 9, 3, 4, 2)
 *   node scripts/acceptance-test-harness.mjs --gate G0       # run specific gate (G0..G15)
 *   node scripts/acceptance-test-harness.mjs --test 20       # run specific test ID (1..48)
 *   node scripts/acceptance-test-harness.mjs --all          # run all gates G0..G15 in progressive order
 *   node scripts/acceptance-test-harness.mjs --interactive  # force interactive menu
 *   node scripts/acceptance-test-harness.mjs --live         # enable live runtime/model probing
 *   node scripts/acceptance-test-harness.mjs --skip-build   # skip dist freshness check
 *   node scripts/acceptance-test-harness.mjs --report file  # custom report file path
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = join(root, 'tests/acceptance/acceptanceData.json');

if (!existsSync(catalogPath)) {
  console.error('Acceptance test catalog missing at tests/acceptance/acceptanceData.json');
  process.exit(1);
}

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const { gates: GATES, foundationalSequence: FOUNDATIONAL, tests: TESTS } = catalog;

function printHelp() {
  console.log(`
Wazir Acceptance Test Harness

Usage:
  node scripts/acceptance-test-harness.mjs [options]

Options:
  --foundational        Run foundational sequence: 20 -> 17 -> 18 -> 1 -> 9 -> 3 -> 4 -> 2
  --gate <G0..G68>      Run all tests in specified gate
  --test <1..70>        Run specific test by ID
  --all                 Run all 37 progressive release gates (fail-fast prerequisite order)
  --interactive         Prompt interactively to choose what to test
  --live                Probe and execute against live local models (LM Studio / Ollama)
  --skip-build          Skip dist freshness check and build
  --report <path>       Report JSON output file (default: acceptance-test-report.json)
  --help, -h            Show this help text

Gates:
  G0  Protocol          Test 20          Models can reliably operate Wazir
  G1  Runtime           Tests 1, 17-19   Tools/workspaces actually work
  G2  Agent             Tests 8, 9       Coding + repair works
  G3  Routing           Tests 3, 4, 14, 29 Capability-based routing works
  G4  Fleet             Tests 2, 5, 6, 7 DAG / concurrency / fan-in works
  G5  Multi-Agent       Tests 10-13, 50  Review / delegation / handoff works
  G6  Governance        Tests 15, 16, 24 Policy / audit works
  G7  Resilience        Tests 21-23      Failover / recovery works
  G8  Terminal          Tests 25-28      TUI / history / context are safe
  G9  Golden            Test 30          Full end-to-end Wazir golden path
  G10 Tool Depth        Tests 31-34      Timeout, edit uniqueness, windowed reads, search truncation
  G11 Interop           Tests 35-37      Structured output + MCP discovery/policy, exercised live
  G12 Session Hardening Tests 38-40      Empty completions, compaction fidelity, worktree merge safety
  G13 Terminal Depth    Tests 41-42      Composer history recall, Escape cancellation mid-stream
  G14 Performance       Tests 43-44      PTY throughput/latency, multi-turn overhead growth bounds
  G15 Verify Integrity  Tests 45-48      Evidence-bound completion, revision staleness, false files-changed events, build-tool stalls
  G16 Long Horizon Ctx  Test 49          Sawtooth context bounding, deduplication, superseded elimination, evaluation record
  G29 Self-Improvement  Test 51          Empirical self-improvement cycle: observe, hypothesize, experiment, evaluate, promote
  G30 Regression Guard  Test 52          Zero-regression tolerance: strict rejection of regressions
  G31 Inconclusive      Test 53          Inconclusive determination on insufficient evidence or noisy metrics
  G43 Multi-Obj Meta   Test 59          Empirical Pareto frontier across tokens, wall time, repair cycles
  G46 Canary Deploy     Test 54          Controlled fractional canary deployment (Level 3 Canary)
  G47 Canary Rollback   Test 55          Automated hard regression canary rollback to baseline
  G48 Canary Uncertain  Test 56          Canary uncertainty guard on insufficient evidence
  G44 Distributed Meta  Test 57          Distributed benchmark candidate evaluation across fleet workers
  G45 Distrib Failure   Test 58          Distributed worker failure recovery and deduplication
  G49 Causal Ablation   Test 60          Controlled factorial ablation across multi-mutation candidates
  G50 Causal Interaction Test 61         Non-linear synergy and parameter interaction detection
  G51 Causal Uncertainty Test 62         Epistemic uncertainty guard under sparse samples
  G69 Strategy Transfer Test 63          Cross-repo strategy transfer
  G70 Negative Transfer Test 64          Negative transfer override
  G71 Strategy Learning Test 65          Measured strategy learning efficiency curve
  G61 Cap-Weighted Fleet Test 66         Capability-weighted deterministic fleet placement
  G62 Dynamic Rebalance Test 67          Mid-run worker overload, join, or failure dynamic rebalancing
  G66 Hierarchical Search Test 68        Hierarchical MCTS refactoring across architecture, design, and implementation
  G67 Tree Recovery     Test 69          Authoritative central tree resilience on worker failure mid-branch
  G68 Transposition     Test 70          Workspace state hashing convergence and duplicate evaluation avoidance
`);
}

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

const skipBuild = argv.includes('--skip-build');
const liveMode = argv.includes('--live');
const isInteractiveFlag = argv.includes('--interactive');
const reportArgIdx = argv.indexOf('--report');
const reportFile = reportArgIdx !== -1 && argv[reportArgIdx + 1] ? argv[reportArgIdx + 1] : 'acceptance-test-report.json';

let targetGate = null;
const gateArgIdx = argv.indexOf('--gate');
if (gateArgIdx !== -1 && argv[gateArgIdx + 1]) {
  targetGate = argv[gateArgIdx + 1].toUpperCase();
}

let targetTestId = null;
const testArgIdx = argv.indexOf('--test');
if (testArgIdx !== -1 && argv[testArgIdx + 1]) {
  targetTestId = parseInt(argv[testArgIdx + 1], 10);
}

const runFoundational = argv.includes('--foundational');
const runAll = argv.includes('--all');

async function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function probeLiveEndpoints() {
  console.log('\n[Probe] Checking local model endpoints...');
  const endpoints = [
    { name: 'LM Studio (v1)', url: process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234/v1/models' },
    { name: 'Ollama', url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/tags' },
  ];

  const results = {};
  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const json = await res.json();
        const models = ep.name.startsWith('LM Studio')
          ? (json.data || []).map((m) => m.id)
          : (json.models || []).map((m) => m.name);
        results[ep.name] = { online: true, models };
        console.log(`  ✓ ${ep.name}: ONLINE (${models.length} models detected)`);
        for (const m of models.slice(0, 5)) {
          console.log(`     - ${m}`);
        }
        if (models.length > 5) console.log(`     ... and ${models.length - 5} more`);
      } else {
        results[ep.name] = { online: false, status: res.status };
        console.log(`  ✗ ${ep.name}: responded HTTP ${res.status}`);
      }
    } catch (err) {
      results[ep.name] = { online: false, error: err.message };
      console.log(`  ✗ ${ep.name}: offline (${err.message})`);
    }
  }
  return results;
}

function runCommand(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  return r.status ?? 1;
}

function checkFreshness() {
  if (skipBuild) {
    console.log('[phase 0] dist freshness check skipped (--skip-build)');
    return true;
  }
  console.log('[phase 0] checking workspace dist/ freshness');
  if (runCommand('node', ['scripts/check-dist-fresh.mjs', '--quiet']) !== 0) {
    console.log('[phase 0] stale dist/ — running npm run build');
    if (runCommand('npm', ['run', 'build']) !== 0) {
      console.error('Acceptance run aborted: workspace build failed');
      return false;
    }
  }
  return true;
}

async function resolveExecutionSelection() {
  const hasCliSelection = targetGate || targetTestId || runFoundational || runAll;

  if (hasCliSelection && !isInteractiveFlag) {
    return;
  }

  // If interactive flag or no args in TTY
  if (isInteractiveFlag || (!hasCliSelection && process.stdin.isTTY)) {
    console.log('\n=============================================================');
    console.log('         WAZIR ACCEPTANCE TEST HARNESS — SELECTOR            ');
    console.log('=============================================================');
    console.log('Each time there is an upgrade, select what to test:\n');
    console.log('  1) Foundational Sequence (20, 17, 18, 1, 9, 3, 4, 2) [Recommended]');
    console.log('  2) Release Gate (G0 Protocol, G1 Runtime, G2 Agent, ... G31 Inconclusive)');
    console.log('  3) Specific Acceptance Test (Test 1 through 53)');
    console.log('  4) Full Progressive Acceptance Suite (G0 through G31)');
    console.log('  5) Probe Local Models & Runtimes');
    console.log('  q) Quit\n');

    const choice = await promptUser('Select test mode [1-5, q]: ');

    if (choice === '1' || choice === '') {
      argv.push('--foundational');
    } else if (choice === '2') {
      console.log('\nAvailable Release Gates:');
      for (const g of GATES) {
        console.log(`  ${g.id}) ${g.title}: ${g.description}`);
      }
      const gateChoice = await promptUser('\nEnter Gate ID (e.g. G0, G1, ... G68): ');
      targetGate = gateChoice.trim().toUpperCase();
      if (!GATES.some((g) => g.id === targetGate)) {
        console.error(`Unknown gate ${targetGate}`);
        process.exit(1);
      }
    } else if (choice === '3') {
      const testChoice = await promptUser('\nEnter Test ID (1 to 70): ');
      targetTestId = parseInt(testChoice.trim(), 10);
      if (!TESTS[targetTestId]) {
        console.error(`Unknown test ${targetTestId}`);
        process.exit(1);
      }
    } else if (choice === '4') {
      argv.push('--all');
    } else if (choice === '5') {
      await probeLiveEndpoints();
      process.exit(0);
    } else {
      console.log('Aborted.');
      process.exit(0);
    }
  } else if (!hasCliSelection) {
    // Default non-interactive mode: run foundational sequence
    console.log('[Notice] No arguments specified in non-interactive environment; defaulting to foundational sequence.');
    argv.push('--foundational');
  }
}

async function main() {
  await resolveExecutionSelection();

  console.log('\n=============================================================');
  console.log('              WAZIR ACCEPTANCE TEST LIBRARY                  ');
  console.log('=============================================================');

  if (liveMode) {
    await probeLiveEndpoints();
  }

  if (!checkFreshness()) {
    process.exit(1);
  }

  // Determine tests to run
  let testQueue = [];
  let executionPlanDescription = '';

  if (targetTestId) {
    const t = TESTS[targetTestId];
    if (!t) {
      console.error(`Acceptance test ${targetTestId} not found`);
      process.exit(2);
    }
    testQueue = [t];
    executionPlanDescription = `Single Test: #${t.id} - ${t.title} (Gate ${t.gateId})`;
  } else if (targetGate) {
    const g = GATES.find((g) => g.id === targetGate);
    if (!g) {
      console.error(`Gate ${targetGate} not found. Valid gates: G0..G68`);
      process.exit(2);
    }
    testQueue = g.testIds.map((id) => TESTS[id]);
    executionPlanDescription = `Release Gate: ${g.title} (${testQueue.length} tests)`;
  } else if (argv.includes('--all')) {
    testQueue = Object.values(TESTS).sort((a, b) => {
      const gateOrderA = GATES.find((g) => g.id === a.gateId)?.order ?? 0;
      const gateOrderB = GATES.find((g) => g.id === b.gateId)?.order ?? 0;
      return gateOrderA !== gateOrderB ? gateOrderA - gateOrderB : a.id - b.id;
    });
    executionPlanDescription = `Full Progressive Suite (All ${GATES.length} Gates, ${testQueue.length} tests)`;
  } else {
    // Foundational
    testQueue = FOUNDATIONAL.map((id) => TESTS[id]);
    executionPlanDescription = `Foundational Acceptance Sequence (8 tests: 20 -> 17 -> 18 -> 1 -> 9 -> 3 -> 4 -> 2)`;
  }

  console.log(`Plan: ${executionPlanDescription}`);
  console.log(`Tests to run: ${testQueue.map((t) => t.id).join(', ')}`);
  console.log('-------------------------------------------------------------');

  // Collect unique test files to execute via Vitest
  const testFilesToRun = new Set();
  for (const t of testQueue) {
    for (const s of t.associatedSuites) {
      if (existsSync(join(root, s))) {
        testFilesToRun.add(s);
      }
    }
  }

  // Also include the acceptance catalog unit test
  testFilesToRun.add('tests/acceptance/acceptanceLibrary.test.ts');

  const filesArray = [...testFilesToRun];
  console.log(`[phase 1] executing ${filesArray.length} associated verification suites via vitest`);

  const vitestReportPath = join(root, '.acceptance-vitest-report.json');
  const vitestArgs = ['vitest', 'run', ...filesArray, '--reporter=json', `--outputFile=${vitestReportPath}`];
  
  const vitestStatus = runCommand('npx', vitestArgs);

  let vitestResults = { testResults: [], success: vitestStatus === 0 };
  if (existsSync(vitestReportPath)) {
    try {
      vitestResults = JSON.parse(readFileSync(vitestReportPath, 'utf8'));
    } catch (e) {
      console.warn(`[Warning] Could not parse vitest JSON output: ${e.message}`);
    }
  }

  // Index test results by normalized file path
  const resultsByFile = new Map();
  for (const tr of vitestResults.testResults || []) {
    const norm = tr.name.replace(/\\/g, '/');
    resultsByFile.set(norm, tr);
  }

  // Map results to acceptance tests
  const rows = [];
  const gateStatus = {};
  for (const g of GATES) {
    gateStatus[g.id] = { gateId: g.id, name: g.name, passed: true, testCount: 0, passedCount: 0, failedCount: 0 };
  }

  const passedGates = new Set();
  let prerequisiteBlocked = false;

  for (const test of testQueue) {
    const gateDef = GATES.find((g) => g.id === test.gateId);
    
    // Strict prerequisite gate check:
    // If testing all gates or gate sequences, cannot pass if prerequisite failed
    if (argv.includes('--all') && gateDef && gateDef.prerequisiteGateId && !passedGates.has(gateDef.prerequisiteGateId)) {
      prerequisiteBlocked = true;
      rows.push({
        id: test.id,
        gateId: test.gateId,
        priority: test.priority,
        status: 'BLOCKED',
        name: test.title,
        duration: 0,
        detail: `Prerequisite gate ${gateDef.prerequisiteGateId} not passed`,
      });
      gateStatus[test.gateId].passed = false;
      gateStatus[test.gateId].failedCount += 1;
      continue;
    }

    // Evaluate associated suites for this acceptance test
    let testPassed = true;
    let totalDurationMs = 0;
    let detail = '';
    let executedSuites = 0;

    for (const suitePath of test.associatedSuites) {
      const fullPath = join(root, suitePath).replace(/\\/g, '/');
      const matched = [...resultsByFile.entries()].find(([p]) => p.endsWith(suitePath) || p === fullPath);

      if (matched) {
        executedSuites += 1;
        const [, tr] = matched;
        const failedTests = (tr.assertionResults || []).filter((a) => a.status === 'failed');
        const passTests = (tr.assertionResults || []).filter((a) => a.status === 'passed');
        totalDurationMs += (tr.endTime || 0) - (tr.startTime || 0);

        if (failedTests.length > 0) {
          testPassed = false;
          detail = `${failedTests.length} assertions failed: ${failedTests[0].title.slice(0, 60)}`;
          break;
        } else {
          detail = `${passTests.length} assertions passed`;
        }
      }
    }

    if (executedSuites === 0) {
      testPassed = false;
      detail = 'No associated test suites executed';
    }

    const row = {
      id: test.id,
      gateId: test.gateId,
      priority: test.priority,
      status: testPassed ? 'PASS' : 'FAIL',
      name: test.title,
      duration: Math.max(0, totalDurationMs),
      detail,
    };

    rows.push(row);

    const gStat = gateStatus[test.gateId];
    gStat.testCount += 1;
    if (testPassed) {
      gStat.passedCount += 1;
    } else {
      gStat.failedCount += 1;
      gStat.passed = false;
    }

    // If all tests in gate have passed so far and this gate is completed
    if (gStat.failedCount === 0 && gStat.passedCount === gateDef.testIds.length) {
      passedGates.add(test.gateId);
    }
  }

  // Display results table
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n');
  console.log(
    `${pad('ID', 5)} ${pad('GATE', 6)} ${pad('PR', 4)} ${pad('STATUS', 8)} ${pad('TEST NAME', 45)} ${pad('DURATION', 10)} DETAIL`,
  );
  console.log('-'.repeat(120));

  for (const r of rows) {
    const idStr = String(r.id).padStart(2, '0');
    console.log(
      `${pad(idStr, 5)} ${pad(r.gateId, 6)} ${pad(r.priority, 4)} ${pad(r.status, 8)} ${pad(r.name.slice(0, 43), 45)} ${pad((r.duration).toFixed(1) + 'ms', 10)} ${r.detail}`,
    );
  }

  // Calculate totals
  const total = rows.length;
  const passed = rows.filter((r) => r.status === 'PASS').length;
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  const blocked = rows.filter((r) => r.status === 'BLOCKED').length;

  console.log('\n=============================================================');
  console.log('                      GATE SUMMARY                           ');
  console.log('=============================================================');

  for (const g of GATES) {
    const stat = gateStatus[g.id];
    if (stat.testCount > 0) {
      const mark = stat.passed && stat.failedCount === 0 ? '✓ PASS' : '✗ FAIL';
      console.log(`  ${mark} [${g.id} ${g.name.padEnd(12)}] ${stat.passedCount}/${stat.testCount} tests passed`);
    }
  }

  console.log('-------------------------------------------------------------');
  console.log(`Total: ${total} | PASS: ${passed} | FAIL: ${failed} | BLOCKED: ${blocked}`);

  const foundationalPass = FOUNDATIONAL.every((fid) => rows.some((r) => r.id === fid && r.status === 'PASS'));
  if (argv.includes('--foundational')) {
    console.log(`Foundational Sequence: ${foundationalPass ? '✓ ALL 8 PASSED' : '✗ FAILED'}`);
  }

  const isReady = failed === 0 && blocked === 0;
  console.log('');
  if (isReady) {
    console.log('★ RELEASE VERDICT: WAZIR READY FOR RELEASE ★');
  } else {
    console.log('✖ RELEASE VERDICT: WAZIR NOT READY FOR RELEASE ✖');
    const blockers = rows.filter((r) => r.status !== 'PASS' && r.priority === 'P0');
    if (blockers.length) {
      console.log(`Blocking P0 Failures: ${blockers.map((b) => `#${b.id} (${b.name})`).join(', ')}`);
    }
  }

  // Emit report
  const report = {
    plan: 'wazir-acceptance-library',
    generatedAt: new Date().toISOString(),
    version: '0.1.37',
    mode: liveMode ? 'live' : 'deterministic',
    selection: executionPlanDescription,
    summary: {
      total,
      passed,
      failed,
      blocked,
      ready: isReady,
    },
    gateResults: gateStatus,
    cases: rows,
  };

  const reportOutPath = join(root, reportFile);
  writeFileSync(reportOutPath, JSON.stringify(report, null, 2));
  console.log(`Report written to ${reportFile}`);

  process.exit(isReady ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal harness error:', err);
  process.exit(1);
});
