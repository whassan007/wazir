#!/usr/bin/env node
// Compares a vitest JSON report against the Goal Studio baseline (docs/goal-studio/baseline-test-results.md).
// Usage: node scripts/goal-studio-baseline-diff.mjs <vitest.json>
// Exit 0 = no new failures; 1 = regressions found; 2 = bad input.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASELINE = {
  commit: 'e20355e',
  totals: { tests: 2792, passed: 2731, failed: 9, skipped: 52 },
  failures: [
    ['test/packaging/serverDistribution.test.ts', 'wa service --help and status execute cleanly via CLI bundle'],
    ['tests/live/realWorldAcceptance.test.ts', 'Journey 1: First installation, initialization and launch in pristine isolated environment'],
    ['tests/live/realWorldAcceptance.test.ts', 'Journey 2: Running `wa doctor` health inspection under isolated environment'],
    ['tests/live/realWorldAcceptance.test.ts', 'Journey 3: Model discovery, registry inspection, and selection filtering'],
    ['tests/live/realWorldAcceptance.test.ts', 'Journey 4: Driving `wa chat` using real pseudo-terminal with simulated keyboard inputs'],
    ['tests/live/realWorldAcceptance.test.ts', 'Journey 5: Creating, modifying source files and verifying real observable filesystem mutations'],
    ['tests/live/realWorldAcceptance.test.ts', 'Journey 6: Executing builds, tests and detecting non-zero exit codes & failures accurately'],
    ['tests/live/realWorldAcceptance.test.ts', 'Journey 7: Handling unavailable models without false positives or silent hangs'],
    ['tests/live/realWorldAcceptance.test.ts', 'Journey 10: Cancellation and retry handling under real lifecycle controls'],
  ],
};

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/goal-studio-baseline-diff.mjs <vitest.json>');
  process.exit(2);
}
let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`cannot read ${file}: ${error.message}`);
  process.exit(2);
}
const root = process.cwd() + path.sep;
const key = (f, title) => `${f} :: ${title}`;
const known = new Set(BASELINE.failures.map(([f, t]) => key(f, t)));
const failing = new Set();
const fileErrors = [];
for (const suite of report.testResults ?? []) {
  const rel = suite.name.startsWith(root) ? suite.name.slice(root.length) : suite.name;
  if (suite.status === 'failed' && (suite.assertionResults ?? []).length === 0) fileErrors.push(`${rel}: ${(suite.message ?? '').split('\n')[0]}`);
  for (const a of suite.assertionResults ?? []) if (a.status === 'failed') failing.add(key(rel, a.title));
}
const regressions = [...failing].filter((k) => !known.has(k));
const fixed = [...known].filter((k) => !failing.has(k));
console.log(`baseline ${BASELINE.commit}: tests ${BASELINE.totals.tests}, passed ${BASELINE.totals.passed}, failed ${BASELINE.totals.failed}, skipped ${BASELINE.totals.skipped}`);
console.log(`current: tests ${report.numTotalTests}, passed ${report.numPassedTests}, failed ${report.numFailedTests}, skipped ${report.numPendingTests}`);
if (fileErrors.length) {
  console.log(`\nFILE-LEVEL ERRORS (${fileErrors.length}) — suites that failed to load:`);
  for (const e of fileErrors) console.log(`  ${e}`);
}
console.log(`\nREGRESSIONS (${regressions.length}):`);
for (const r of regressions) console.log(`  ${r}`);
console.log(`\nBASELINE FAILURES NOW PASSING OR ABSENT (${fixed.length}):`);
for (const r of fixed) console.log(`  ${r}`);
process.exit(regressions.length || fileErrors.length ? 1 : 0);
