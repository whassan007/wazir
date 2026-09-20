#!/usr/bin/env node
/**
 * Executable test plan — terminal interface (wa chat / wa fleet TUI + terminal
 * primitives). The case matrix below is the single source of truth; the plan
 * document (docs/test-plans/terminal-interface.md) describes the same cases.
 *
 * Phases:
 *   0. verify workspace dist/ is fresh (build if stale)
 *   1. run every suite referenced by the matrix (vitest, JSON report)
 *   2. map results onto the matrix, print the TC table, write test-plan-report.json
 *
 *   node scripts/tui-test-plan.mjs               # run the full plan
 *   node scripts/tui-test-plan.mjs --skip-build  # trust existing dist/
 *   node scripts/tui-test-plan.mjs --only TUI-001,TUI-002
 *
 * Exit code: 0 when every case is PASS/SKIP, 1 otherwise (FAIL or MISSING).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FLEET = 'apps/cli/tests/fleetTui.test.ts';
const LIFECYCLE = 'apps/cli/tests/tuiSessionLifecycle.test.ts';
const FLEETRUNNER = 'apps/cli/tests/fleetRunner.e2e.test.ts';
const SPINNER = 'apps/cli/tests/spinner.test.ts';
const DOCTOR = 'apps/cli/tests/doctor.test.ts';
const EXECUTE = 'apps/cli/tests/executeTask.e2e.test.ts';

// level: L1 primitives | L2 harness | L3 e2e | L4 CLI surface
// priority: B = blocking (session safety / correctness), R = regression, F = feature
const CASES = [
  // A. Session lifecycle & terminal hygiene
  { id: 'TUI-001', section: 'A', name: '/exit exits, restores terminal, detaches input listeners', file: LIFECYCLE, test: 'exits the session on /exit, restores the terminal, and detaches all input listeners', level: 'L2', priority: 'B' },
  { id: 'TUI-002', section: 'A', name: '/quit exits and resolves waitForExit', file: LIFECYCLE, test: 'exits the session on /quit and resolves waitForExit exactly once', level: 'L2', priority: 'B' },
  { id: 'TUI-003', section: 'A', name: 'bare q at the prompt exits the session', file: LIFECYCLE, test: 'exits the session on a bare q at the prompt', level: 'L2', priority: 'R' },
  { id: 'TUI-004', section: 'A', name: 'Ctrl+C terminates cleanly with exit code 0', file: LIFECYCLE, test: 'terminates cleanly on Ctrl+C with exit code 0 and full cleanup', level: 'L2', priority: 'B' },
  { id: 'TUI-005', section: 'A', name: 'stop() clears timer, subscriptions, rejection guard', file: LIFECYCLE, test: 'stop() clears the render timer, resize and event subscriptions, and the rejection guard', level: 'L2', priority: 'B' },
  { id: 'TUI-006', section: 'A', name: 'raw mode and keypress binding on TerminalScreen', file: FLEET, test: 'verifies raw mode and keypress binding on TerminalScreen', level: 'L1', priority: 'R' },

  // B. Navigation & view management
  { id: 'TUI-010', section: 'B', name: 'initial dashboard, view cycling, help pane', file: FLEET, test: 'renders initial dashboard, transitions between views via keyboard shortcuts, and displays help', level: 'L2', priority: 'B' },
  { id: 'TUI-011', section: 'B', name: 'Up/Down navigation across nav categories', file: FLEET, test: 'supports generalized Up/Down navigation across categories with status glyphs and cursor', level: 'L2', priority: 'R' },
  { id: 'TUI-012', section: 'B', name: 'Shift-Tab, Ctrl+L, Ctrl+R, ? keybindings', file: FLEET, test: 'supports Tier 2 navigation keybindings: Shift-Tab reverse traversal, Ctrl+L repaint, Ctrl+R refresh, and ? help toggle', level: 'L2', priority: 'R' },
  { id: 'TUI-013', section: 'B', name: 'clean view transition, no residual buffer leakage', file: FLEET, test: 'clean view transition: Tab triggers clean redraw without leaking job ID fragments or residual buffer characters into active log pane', level: 'L2', priority: 'R' },
  { id: 'TUI-014', section: 'B', name: 'independent view templates, no text ghosting', file: FLEET, test: 'clears screen on view switch to prevent text ghosting, renders independent view templates, and updates view title without clipping', level: 'L2', priority: 'R' },
  { id: 'TUI-015', section: 'B', name: 'Tab focus isolation with early return', file: FLEET, test: 'isolates Tab key events in global keypress listener and toggles target focus with early return', level: 'L2', priority: 'R' },

  // C. Job & agent management
  { id: 'TUI-020', section: 'C', name: 'fanout job, live agent states, tail view', file: FLEET, test: 'submits a multi-agent fanout job, displays live agent states, and tails an agent stream', level: 'L2', priority: 'B' },
  { id: 'TUI-021', section: 'C', name: 'no token leakage between jobs sharing task ids', file: FLEET, test: 'does not leak tokens between jobs that would otherwise share the same default task id', level: 'L2', priority: 'B' },
  { id: 'TUI-022', section: 'C', name: 'cancel selected job via c and /cancel', file: FLEET, test: 'cancels a selected job via the c key and /cancel, even one not launched this session', level: 'L2', priority: 'R' },
  { id: 'TUI-023', section: 'C', name: 'cancel pending job by explicit id', file: LIFECYCLE, test: 'cancels a pending job by explicit id via /cancel <job-id>', level: 'L2', priority: 'R' },
  { id: 'TUI-024', section: 'C', name: 'cancelling finished job errors instead of crashing', file: FLEET, test: 'pressing c on an already-finished job reports an error instead of crashing the process', level: 'L2', priority: 'B' },
  { id: 'TUI-025', section: 'C', name: 'delete completed job from JOBS list', file: FLEET, test: 'deletes a completed job from the JOBS list via the Delete key', level: 'L2', priority: 'R' },
  { id: 'TUI-026', section: 'C', name: 'x/Delete on non-JOBS item gives feedback', file: FLEET, test: 'gives feedback instead of silently no-oping when x/Delete is pressed on a non-JOBS item', level: 'L2', priority: 'F' },
  { id: 'TUI-027', section: 'C', name: 'worktrees pane shows per-agent branch names', file: LIFECYCLE, test: 'renders the worktrees view with per-agent isolated branch names', level: 'L2', priority: 'F' },
  { id: 'TUI-028', section: 'C', name: 'event-stream pane with typed lifecycle states', file: FLEET, test: 'renders scrollable event-stream activity pane with typed lifecycle states (PLAN, ROUTE, TOOL, TEST, COMPLETE, ERROR)', level: 'L2', priority: 'F' },

  // D. Approvals & policy
  { id: 'TUI-030', section: 'D', name: 'non-blocking approval queue + mid-run steering', file: FLEET, test: 'handles in-TUI non-blocking approval queue and mid-run steering', level: 'L2', priority: 'B' },
  { id: 'TUI-031', section: 'D', name: 'policy modal with A/D/V/I actions', file: FLEET, test: 'displays overlaid policy approval modal with [A], [D], [V], [I] actions', level: 'L2', priority: 'B' },
  { id: 'TUI-032', section: 'D', name: 'Ctrl+A / Ctrl+D approve-deny all', file: FLEET, test: 'supports Ctrl+A / Ctrl+D to approve or deny all queued policy requests at once', level: 'L2', priority: 'R' },
  { id: 'TUI-033', section: 'D', name: 'approval view dedicated layout', file: FLEET, test: 'renders approval view with dedicated layout template that does not collide with execution table columns', level: 'L2', priority: 'F' },

  // E. Input & text editing
  { id: 'TUI-040', section: 'E', name: 'backspace, Ctrl+W, Ctrl+U buffer editing', file: FLEET, test: 'correctly handles backspace, delete, Ctrl+W, and Ctrl+U in the input buffer', level: 'L2', priority: 'R' },
  { id: 'TUI-041', section: 'E', name: 'backspace/delete re-render prompt immediately', file: FLEET, test: 'correctly handles backspace and delete key events, slicing buffer and re-rendering prompt immediately', level: 'L2', priority: 'R' },
  { id: 'TUI-042', section: 'E', name: 'Tab never leaks into the input buffer', file: FLEET, test: 'intercepts Tab key without leaking control characters or literal \\t into the input buffer', level: 'L2', priority: 'B' },
  { id: 'TUI-043', section: 'E', name: 'no stream echo of nav keys / ANSI codes', file: FLEET, test: 'prevents stream echo: navigation keys and unparsed ANSI codes never bind into input buffer or log streams', level: 'L2', priority: 'R' },

  // F. Layout & rendering fidelity
  { id: 'TUI-050', section: 'F', name: '2-pane layout with <100 column collapse', file: FLEET, test: 'renders persistent 2-pane layout when columns >= 100 and collapses when < 100', level: 'L2', priority: 'F' },
  { id: 'TUI-051', section: 'F', name: 'token budget indicator in status bar', file: FLEET, test: 'wires up real-time token budget context indicator in status bar', level: 'L2', priority: 'F' },
  { id: 'TUI-052', section: 'F', name: 'structured error card rendering', file: FLEET, test: 'renders structured error card with phase, reason, required, available, and suggested resolution steps', level: 'L2', priority: 'R' },
  { id: 'TUI-053', section: 'F', name: 'history strip + block details modal', file: FLEET, test: 'renders history strip wired to blocks and expands block details modal', level: 'L2', priority: 'R' },
  { id: 'TUI-054', section: 'F', name: '@ reference fuzzy picker with Tab completion', file: FLEET, test: 'triggers @ reference fuzzy picker and completes candidate on Tab', level: 'L2', priority: 'R' },
  { id: 'TUI-055', section: 'F', name: 'Ctrl+P quick actions palette', file: FLEET, test: 'supports Ctrl+P quick actions palette modal navigation, filtering, and selection', level: 'L2', priority: 'F' },

  // G. Terminal feedback primitives (spinner / status loader)
  { id: 'TUI-060', section: 'G', name: 'braille frame rotation', file: SPINNER, test: 'uses standard Unicode braille pattern animation frames (§1)', level: 'L1', priority: 'F' },
  { id: 'TUI-061', section: 'G', name: 'in-place updates, no scrollback flood', file: SPINNER, test: 'performs in-place terminal updates without flooding scrollback history (§2)', level: 'L1', priority: 'R' },
  { id: 'TUI-062', section: 'G', name: 'spinner bound to execution phases, clean stop', file: SPINNER, test: 'binds spinner activation to active execution phases and safely stops/clears on completion (§3)', level: 'L1', priority: 'R' },
  { id: 'TUI-063', section: 'G', name: 'withSpinner success lifecycle', file: SPINNER, test: 'supports withSpinner helper for automatic lifecycle binding (§3)', level: 'L1', priority: 'F' },
  { id: 'TUI-064', section: 'G', name: 'withSpinner error marks failure', file: SPINNER, test: 'handles errors inside withSpinner safely and marks failure (§3)', level: 'L1', priority: 'R' },
  { id: 'TUI-065', section: 'G', name: 'spinner non-TTY fallback, no escape sequences', file: SPINNER, test: 'provides clean non-TTY stream fallback without flooding or escape sequences', level: 'L1', priority: 'B' },

  // H. End-to-end terminal paths
  { id: 'TUI-070', section: 'H', name: 'fleetRunner reports each tool call once', file: FLEETRUNNER, test: 'reports each tool call to onProgress exactly once, not twice', level: 'L3', priority: 'B' },
  { id: 'TUI-071', section: 'H', name: 'TerminalScreen non-TTY stream fallback', file: FLEET, test: 'provides non-TTY and stream fallback in TerminalScreen', level: 'L1', priority: 'B' },
  { id: 'TUI-072', section: 'H', name: 'wa doctor diagnostics suite (all checks)', file: DOCTOR, level: 'L4', priority: 'R' },
  { id: 'TUI-073', section: 'H', name: 'one-shot task execution terminal path (all cases)', file: EXECUTE, level: 'L3', priority: 'B' },
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

console.log(`Wazir test plan — terminal interface (${cases.length} cases, ${activeFiles.length} suites)`);

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
const jsonPath = join(root, '.test-plan-vitest.json');
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
console.log(`${pad('ID', 9)} ${pad('PR', 3)} ${pad('LVL', 4)} ${pad('STATUS', 9)} ${pad('CASE', 58)} DETAIL`);
console.log('-'.repeat(118));
for (const r of rows) {
  const mark = r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : r.status === 'MISSING' ? 'MISSING' : 'FAIL';
  console.log(`${pad(r.id, 9)} ${pad(r.priority, 3)} ${pad(r.level, 4)} ${pad(mark, 9)} ${pad(r.name, 58)} ${r.detail}`);
}

const counts = { PASS: 0, FAIL: 0, SKIP: 0, MISSING: 0 };
for (const r of rows) counts[r.status] += 1;
const blocked = rows.filter((r) => r.priority === 'B' && (r.status === 'FAIL' || r.status === 'MISSING'));

console.log('');
console.log(`total ${rows.length}  |  PASS ${counts.PASS}  FAIL ${counts.FAIL}  SKIP ${counts.SKIP}  MISSING ${counts.MISSING}`);
if (blocked.length) console.log(`blocking (priority B) failures: ${blocked.map((r) => r.id).join(', ')}`);
console.log(report.success ? 'vitest suite result: success' : 'vitest suite result: failures present');

writeFileSync(
  join(root, 'test-plan-report.json'),
  JSON.stringify(
    {
      plan: 'terminal-interface',
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
console.log('report: test-plan-report.json');

process.exit(counts.FAIL === 0 && counts.MISSING === 0 ? 0 : 1);
