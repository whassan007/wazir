#!/usr/bin/env node
/**
 * Executable test plan — agent execution & orchestration safety (the model
 * turn loop, job orchestrator, policy engine and sandbox — everything below
 * the terminal surface covered by tui-test-plan.mjs). The case matrix below
 * is the single source of truth; the plan document
 * (docs/test-plans/agent-execution.md) describes the same cases.
 *
 * Every case here exists because a real job got stuck, crashed, or silently
 * did the wrong thing, and was traced back to a specific gap. The point of
 * this plan is to make sure the fix for each one stays fixed.
 *
 *   node scripts/agent-execution-test-plan.mjs               # run the full plan
 *   node scripts/agent-execution-test-plan.mjs --skip-build  # trust existing dist/
 *   node scripts/agent-execution-test-plan.mjs --only AGT-001,AGT-010
 *
 * Exit code: 0 when every case is PASS/SKIP, 1 otherwise (FAIL or MISSING).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TURN_TIMEOUT = 'packages/agents/tests/codingAgent.turnTimeout.test.ts';
const PROSE_BAILOUT = 'packages/agents/tests/codingAgent.proseBailout.test.ts';
const CIRCUIT_BREAKER = 'packages/agents/tests/codingAgent.circuitBreaker.test.ts';
const CONTEXT_COMPACTION = 'packages/agents/tests/codingAgent.contextCompaction.test.ts';
const MAX_TURNS = 'packages/agents/tests/codingAgent.maxTurns.test.ts';
const PARSE_ACTION = 'packages/agents/tests/parseAction.test.ts';
const JOB_ORCHESTRATOR = 'packages/core/tests/jobOrchestrator.test.ts';
const JOB_LIFECYCLE = 'packages/core/tests/jobLifecycleAndValidation.test.ts';
const POLICY_SHELL = 'packages/core/tests/policyEngineShell.test.ts';
const POLICY_HARDENING = 'packages/core/tests/policyEngineHardening.test.ts';
const SANDBOX = 'packages/tools/tests/sandbox.test.ts';
const FLEET_TUI = 'apps/cli/tests/fleetTui.test.ts';

// level: L1 unit (pure function) | L2 component (fake runtime/engine) | L3 e2e
// priority: B = blocking (a stuck/crashed/corrupted job), R = regression, F = feature
const CASES = [
  // A. Model turn safety — timeouts and malformed action recovery
  { id: 'AGT-001', section: 'A', name: 'a hung model turn is cancelled by its own timeout, not the job timeout', file: TURN_TIMEOUT, test: 'cancels a turn that exceeds modelTurnTimeoutMs instead of hanging until the job-level timeout', level: 'L2', priority: 'B' },
  { id: 'AGT-002', section: 'A', name: 'a normal fast turn is never cancelled', file: TURN_TIMEOUT, test: 'never cancels a turn that completes well within the timeout', level: 'L2', priority: 'R' },
  { id: 'AGT-003', section: 'A', name: 'argv-array shell command is joined into one quoted string', file: PARSE_ACTION, test: 'joins an argv-array shell command into a single quoted string', level: 'L1', priority: 'B' },
  { id: 'AGT-004', section: 'A', name: 'cmd is accepted as an alias for command on the shell tool', file: PARSE_ACTION, test: 'accepts cmd as an alias for command on the shell tool', level: 'L1', priority: 'R' },
  { id: 'AGT-005', section: 'A', name: 'a flat shell command missing the input wrapper is rescued', file: PARSE_ACTION, test: 'rescues a flat shell command when the model forgets the input wrapper', level: 'L1', priority: 'B' },
  { id: 'AGT-006', section: 'A', name: 'arguments under parameters/arguments/args are rescued into input', file: PARSE_ACTION, test: 'rescues arguments from a parameters/arguments/args container', level: 'L1', priority: 'R' },
  { id: 'AGT-007', section: 'A', name: 'JSON action parsing tolerates fences, unbalanced brackets, raw newlines, stacked objects', file: PARSE_ACTION, level: 'L1', priority: 'R' },
  { id: 'AGT-008', section: 'A', name: 'a turn that streams a lot of prose without ever opening its JSON object is cancelled early', file: PROSE_BAILOUT, test: 'cancels a turn that streams a lot of prose without ever opening a JSON object', level: 'L2', priority: 'B' },
  { id: 'AGT-009', section: 'A', name: 'a short, normal preamble before the JSON action does not trigger the bailout', file: PROSE_BAILOUT, test: 'does not bail on a short, normal preamble before the JSON action', level: 'L2', priority: 'R' },

  // B. Stuck-loop detection
  { id: 'AGT-010', section: 'B', name: 'circuit breaker trips after the same tool call repeats toolRepeatLimit times', file: CIRCUIT_BREAKER, test: 'stops after the same tool call repeats toolRepeatLimit times, instead of grinding to maxTurns', level: 'L2', priority: 'B' },
  { id: 'AGT-011', section: 'B', name: 'circuit breaker does not false-positive on varying tool input', file: CIRCUIT_BREAKER, test: 'does not trip when consecutive tool calls use different input', level: 'L2', priority: 'R' },
  { id: 'AGT-012', section: 'B', name: 'maxTurns hard-caps the loop regardless of constructor vs per-request override', file: MAX_TURNS, level: 'L2', priority: 'B' },

  // C. Context management
  { id: 'AGT-020', section: 'C', name: 'context compaction bounds prompt growth once the ratio threshold is crossed', file: CONTEXT_COMPACTION, test: 'collapses older turns into a summary once the estimated token usage crosses the compaction ratio', level: 'L2', priority: 'B' },
  { id: 'AGT-021', section: 'C', name: 'compaction never activates when the host reports no contextTokens ceiling', file: CONTEXT_COMPACTION, test: 'never compacts when the host does not report a contextTokens ceiling', level: 'L2', priority: 'R' },

  // D. Job orchestration — timeout, cancellation, persistence
  { id: 'AGT-030', section: 'D', name: 'a task that runs past its timeout is auto-stopped with a clear reason', file: JOB_ORCHESTRATOR, test: 'automatically stops a task that runs past its timeout, marking it failed with a clear reason', level: 'L2', priority: 'B' },
  { id: 'AGT-031', section: 'D', name: 'a job finishing within its timeout is left untouched', file: JOB_ORCHESTRATOR, test: 'does not touch a job that finishes comfortably within its timeout', level: 'L2', priority: 'R' },
  { id: 'AGT-032', section: 'D', name: 'cancelling one task does not terminate sibling tasks', file: JOB_ORCHESTRATOR, test: 'supports single-task cancellation without terminating sibling tasks', level: 'L2', priority: 'B' },
  { id: 'AGT-033', section: 'D', name: 'job-level terminal status persists, surviving a process restart', file: JOB_ORCHESTRATOR, test: 'persists the job-level terminal status, not just task status, so it survives a process restart', level: 'L2', priority: 'B' },
  { id: 'AGT-034', section: 'D', name: 'self-heals a job record stuck at running from before the persistence fix', file: JOB_ORCHESTRATOR, test: 'self-heals job records already stuck at running from before the persistence fix', level: 'L2', priority: 'R' },
  { id: 'AGT-035', section: 'D', name: 'a genuinely orphaned running task is marked failed on load', file: JOB_ORCHESTRATOR, test: 'marks a genuinely orphaned running task as failed on load, instead of stuck running forever', level: 'L2', priority: 'B' },
  { id: 'AGT-036', section: 'D', name: 'a merely pending (never started) job is left alone on load', file: JOB_ORCHESTRATOR, test: 'leaves a merely pending (never started) job alone on load — that is not an orphan', level: 'L2', priority: 'R' },
  { id: 'AGT-037', section: 'D', name: 'deleteJob refuses to delete a still-running job', file: JOB_ORCHESTRATOR, test: 'deleteJob removes a finished job from memory and the store, and refuses one still running', level: 'L2', priority: 'R' },
  { id: 'AGT-038', section: 'D', name: 'cancelTask transitions task and agent state to cancelled with a reason', file: JOB_LIFECYCLE, test: 'cancelTask transitions task and agent state to cancelled with "Cancelled by user"', level: 'L2', priority: 'B' },
  { id: 'AGT-039', section: 'D', name: 'a cancelled job never later races back to completed', file: JOB_LIFECYCLE, test: 'once cancelled, a job must never later transition to completed (race condition test)', level: 'L2', priority: 'B' },
  { id: 'AGT-040', section: 'D', name: 'invalid status transitions out of a terminal state are rejected', file: JOB_LIFECYCLE, test: 'rejects invalid transitions: completed -> running', level: 'L2', priority: 'R' },
  { id: 'AGT-041', section: 'D', name: 'invalid status transitions out of failed are rejected', file: JOB_LIFECYCLE, test: 'rejects invalid transitions: failed -> running', level: 'L2', priority: 'R' },
  { id: 'AGT-042', section: 'D', name: 'invalid status transitions out of cancelled are rejected', file: JOB_LIFECYCLE, test: 'rejects invalid transitions: cancelled -> running', level: 'L2', priority: 'R' },

  // E. Cross-job / cross-task isolation
  { id: 'AGT-050', section: 'E', name: 'concurrent tasks get independent contexts with no cross-leak', file: JOB_LIFECYCLE, test: 'provides independent contexts to concurrent tasks with no cross-leak', level: 'L2', priority: 'B' },
  { id: 'AGT-051', section: 'E', name: 'no token leakage between jobs that would otherwise share a default task id', file: FLEET_TUI, test: 'does not leak tokens between jobs that would otherwise share the same default task id', level: 'L2', priority: 'B' },
  { id: 'AGT-052', section: 'E', name: 'cancelling an already-finished job errors instead of crashing the process', file: FLEET_TUI, test: 'pressing c on an already-finished job reports an error instead of crashing the process', level: 'L2', priority: 'B' },

  // F. Shell policy safety
  { id: 'AGT-060', section: 'F', name: 'shell classification: chaining/substitution/redirection bypass attempts, compiled-binary trust scoping', file: POLICY_SHELL, level: 'L1', priority: 'B' },
  { id: 'AGT-061', section: 'F', name: 'policy hardening review items (newline injection, host reads, code-exec flags, output flags, git verbs, protected paths, env dumps, MCP allow-list)', file: POLICY_HARDENING, level: 'L1', priority: 'B' },

  // G. Sandbox isolation
  { id: 'AGT-070', section: 'G', name: 'bwrap masks the home directory but re-exposes toolchain/cache dirs (incl. macOS Library/Caches)', file: SANDBOX, test: 'bwrap: read-only root, masked home with toolchains re-exposed, writable project, no network by default', level: 'L1', priority: 'B' },
  { id: 'AGT-071', section: 'G', name: 'seatbelt denies home except project/tmp/toolchain-cache allowlist (incl. macOS Library/Caches)', file: SANDBOX, test: 'seatbelt: denies home, allows project + tmp writes, denies network by default', level: 'L1', priority: 'B' },
  { id: 'AGT-072', section: 'G', name: 'sandbox fails closed under WAZIR_SANDBOX=required when no backend is usable', file: SANDBOX, test: 'refuses to run tool processes when no backend is usable', level: 'L2', priority: 'B' },

  // H. Retry / graph correctness
  { id: 'AGT-080', section: 'H', name: 'a policy denial never triggers a retry attempt', file: JOB_LIFECYCLE, test: 'policy denial never triggers a retry attempt', level: 'L2', priority: 'B' },
  { id: 'AGT-081', section: 'H', name: 'the retry loop stops at maxRetries instead of looping forever', file: JOB_LIFECYCLE, test: 'stops after reaching maxRetries without infinite loop', level: 'L2', priority: 'B' },
  { id: 'AGT-082', section: 'H', name: 'cyclical/duplicate/dangling task graphs are rejected before they can run', file: JOB_LIFECYCLE, level: 'L2', priority: 'R' },
];

const argv = process.argv.slice(2);
const skipBuild = argv.includes('--skip-build');
let only = null;
const onlyEq = argv.find((a) => a.startsWith('--only='));
if (onlyEq) {
  only = onlyEq.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
} else if (argv.includes('--only')) {
  const next = argv[argv.indexOf('--only') + 1];
  if (!next) {
    console.error('--only requires a comma-separated case id list');
    process.exit(2);
  }
  only = next.split(',').map((s) => s.trim()).filter(Boolean);
}
const cases = only ? CASES.filter((c) => only.includes(c.id)) : CASES;

if (only && only.some((id) => !CASES.some((c) => c.id === id))) {
  console.error(`unknown case id(s): ${only.filter((id) => !CASES.some((c) => c.id === id)).join(', ')}`);
  process.exit(2);
}

const activeFiles = [...new Set(cases.map((c) => c.file))];
for (const f of activeFiles) {
  if (!existsSync(join(root, f))) {
    console.error(`plan broken: missing test file ${f}`);
    process.exit(2);
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  return r.status ?? 1;
}

console.log(`Wazir test plan — agent execution & orchestration safety (${cases.length} cases, ${activeFiles.length} suites)`);

// Phase 0: dist freshness
if (skipBuild) {
  console.log('[phase 0] dist freshness check skipped (--skip-build)');
} else {
  console.log('[phase 0] checking workspace dist/ freshness');
  if (run('node', ['scripts/check-dist-fresh.mjs', '--quiet']) !== 0) {
    console.log('[phase 0] stale dist/ — running npm run build');
    if (run('npm', ['run', 'build']) !== 0) {
      console.error('plan aborted: workspace build failed');
      process.exit(1);
    }
  }
}

// Phase 1: run the suites
const jsonPath = join(root, '.test-plan-vitest-agent.json');
console.log('[phase 1] running suites');
run('npx', ['vitest', 'run', ...activeFiles, '--reporter=json', `--outputFile=${jsonPath}`]);

// Phase 2: map onto the matrix
console.log('[phase 2] mapping results onto the test plan matrix');
let report;
try {
  report = JSON.parse(readFileSync(jsonPath, 'utf8'));
} catch (err) {
  console.error(`plan aborted: could not read vitest JSON report (${err.message})`);
  process.exit(1);
}

const resultsByFile = new Map(report.testResults.map((tr) => [tr.name.replace(/\\/g, '/'), tr.assertionResults]));

function matchTest(file, title) {
  const rel = file.replace(/\\/g, '/');
  const results = [...resultsByFile.entries()]
    .filter(([name]) => name.split('/').slice(-rel.split('/').length).join('/') === rel)
    .flatMap(([, a]) => a);
  return results.find((t) => t.title === title) ?? results.find((t) => t.fullName.endsWith(title));
}

const rows = [];
for (const c of cases) {
  const row = { id: c.id, section: c.section, name: c.name, file: c.file, level: c.level, priority: c.priority, status: '', detail: '' };
  if (c.test) {
    const t = matchTest(c.file, c.test);
    if (!t) {
      row.status = 'MISSING';
      row.detail = 'test not found in suite (plan/code drift)';
    } else if (t.status === 'passed') {
      row.status = 'PASS';
      row.detail = `${(t.duration ?? 0).toFixed(1)}ms`;
    } else if (t.status === 'pending' || t.status === 'skipped') {
      row.status = 'SKIP';
      row.detail = 'skipped';
    } else {
      row.status = 'FAIL';
      row.detail = (t.failureMessages?.[0] ?? 'failed').split('\n')[0].slice(0, 120);
    }
  } else {
    const rel = c.file.replace(/\\/g, '/');
    const results = [...resultsByFile.entries()]
      .filter(([name]) => name.split('/').slice(-rel.split('/').length).join('/') === rel)
      .flatMap(([, a]) => a);
    if (results.length === 0) {
      row.status = 'MISSING';
      row.detail = 'suite produced no results (plan/code drift)';
    } else {
      const failed = results.filter((t) => t.status === 'failed');
      const skipped = results.filter((t) => t.status === 'pending' || t.status === 'skipped');
      if (failed.length === 0) {
        row.status = 'PASS';
        row.detail = `${results.length} tests${skipped.length ? `, ${skipped.length} skipped` : ''}`;
      } else {
        row.status = 'FAIL';
        row.detail = `${failed.length}/${results.length} failed: ${failed.map((t) => t.title).slice(0, 2).join(' | ').slice(0, 120)}`;
      }
    }
  }
  rows.push(row);
}

const pad = (s, n) => String(s).padEnd(n);
console.log('');
console.log(`${pad('ID', 9)} ${pad('PR', 3)} ${pad('LVL', 4)} ${pad('STATUS', 9)} ${pad('CASE', 78)} DETAIL`);
console.log('-'.repeat(140));
for (const r of rows) {
  const mark = r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : r.status === 'MISSING' ? 'MISSING' : 'FAIL';
  console.log(`${pad(r.id, 9)} ${pad(r.priority, 3)} ${pad(r.level, 4)} ${pad(mark, 9)} ${pad(r.name, 78)} ${r.detail}`);
}

const counts = { PASS: 0, FAIL: 0, SKIP: 0, MISSING: 0 };
for (const r of rows) counts[r.status] += 1;
const blocked = rows.filter((r) => r.priority === 'B' && (r.status === 'FAIL' || r.status === 'MISSING'));

console.log('');
console.log(`total ${rows.length}  |  PASS ${counts.PASS}  FAIL ${counts.FAIL}  SKIP ${counts.SKIP}  MISSING ${counts.MISSING}`);
if (blocked.length) console.log(`blocking (priority B) failures: ${blocked.map((r) => r.id).join(', ')}`);
console.log(report.success ? 'vitest suite result: success' : 'vitest suite result: failures present');

writeFileSync(
  join(root, 'agent-execution-test-plan-report.json'),
  JSON.stringify(
    {
      plan: 'agent-execution',
      generatedAt: new Date().toISOString(),
      vitest: {
        success: report.success,
        numTotalTests: report.numTotalTests,
        numPassedTests: report.numPassedTests,
        numFailedTests: report.numFailedTests,
      },
      summary: counts,
      cases: rows,
    },
    null,
    2,
  ),
);
console.log('report: agent-execution-test-plan-report.json');

process.exit(counts.FAIL === 0 && counts.MISSING === 0 ? 0 : 1);
