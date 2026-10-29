#!/usr/bin/env node
// ==============================================================================
// Wazir Automated Release Validation Gate
// (scripts/release-gate.mjs)
// Generates automated release validation matrix across platforms & architectures.
// ==============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const VALID_STATUSES = ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'UNSUPPORTED'];

const CATEGORIES = ['Installation', 'Build', 'CLI', 'Agents', 'Persistence', 'TUI', 'Fleet', 'Recovery'];

// Derive status from evidence; a cached summary must never override failed checks.
export function normalizeEvaluation(evaluation = {}) {
  const row = Object.fromEntries(CATEGORIES.map((key) => [key,
    VALID_STATUSES.includes(evaluation[key]) ? evaluation[key] : 'NOT_RUN',
  ]));
  row.Status = ['FAIL', 'BLOCKED', 'NOT_RUN', 'UNSUPPORTED'].find(
    (status) => Object.values(row).includes(status),
  ) ?? 'PASS';
  return row;
}

export function blockingPlatforms(results, hostId = getHostPlatformId(), strict = false) {
  return TARGET_PLATFORMS.filter((target) => target.id === hostId || (strict && target.required))
    .filter((target) => {
      const row = results.find((r) => r.Platform === target.platform && r.Architecture === target.architecture);
      return !row || normalizeEvaluation(row).Status !== 'PASS' || row.Status !== 'PASS';
    });
}

// Target platforms and architectures
const TARGET_PLATFORMS = [
  { platform: 'Linux', architecture: 'arm64', id: 'linux-arm64', required: true },
  { platform: 'Linux', architecture: 'x64', id: 'linux-x64', required: true },
  { platform: 'macOS', architecture: 'arm64', id: 'darwin-arm64', required: true },
  { platform: 'macOS', architecture: 'x64', id: 'darwin-x64', required: true },
  { platform: 'Windows', architecture: 'x64', id: 'win32-x64', required: true },
  { platform: 'Windows', architecture: 'arm64', id: 'win32-arm64', required: false, unsupported: true },
];

function getHostPlatformId() {
  const plat = process.platform;
  const arch = process.arch;
  return `${plat}-${arch}`;
}

function runStep(name, cmd, args, cwd = rootDir) {
  process.stdout.write(`  [TEST] ${name}... `);
  const start = Date.now();
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${process.env.PATH}` },
    shell: process.platform === 'win32' && /\.cmd$/i.test(cmd),
    timeout: 120000,
  });
  const elapsed = Date.now() - start;
  if (res.status === 0) {
    console.log(`PASS (${elapsed}ms)`);
    return 'PASS';
  } else {
    console.log(`FAIL (${elapsed}ms) - code ${res.status}`);
    if (res.error) console.error(`    ${res.error.message}`);
    if (res.stderr) console.error(`    ${res.stderr.trim().slice(-1000)}`);
    if (res.stdout) console.error(`    ${res.stdout.trim().slice(-2000)}`);
    return 'FAIL';
  }
}

function testHostPlatform() {
  console.log(`==> Evaluating Release Gate checks on current host (${process.platform} ${process.arch})...`);
  const nodeBin = process.execPath;
  // Run the installed test runner directly; npx can fetch unpinned code if absent.
  const vitest = path.join(rootDir, 'node_modules', 'vitest', 'vitest.mjs');

  // 1. Installation
  const installResult = runStep(
    'Installation',
    nodeBin,
    ['scripts/package-check.mjs']
  );

  // 2. Build
  const buildResult = runStep(
    'Build & Dist Freshness',
    nodeBin,
    ['scripts/check-dist-fresh.mjs', '--quiet']
  );

  // 3. CLI
  const cliResult = runStep(
    'CLI Smoke',
    nodeBin,
    ['bin/wa.js', '--help']
  );

  // 4. Agents
  const agentsResult = runStep(
    'Agents Execution & Discovery',
    nodeBin,
    [vitest, 'run', 'packages/agents/tests/externalAgent.test.ts']
  );

  // 5. Persistence
  const persistenceResult = runStep(
    'Persistence & Storage Integrity',
    nodeBin,
    [vitest, 'run', 'packages/core/tests/offloadStore.test.ts', 'packages/core/tests/checkpointService.test.ts']
  );

  // 6. TUI
  const tuiResult = runStep(
    'TUI & Terminal Integrity',
    nodeBin,
    [vitest, 'run', 'apps/cli/tests/terminalIntegrity.test.ts']
  );

  // 7. Fleet
  const fleetResult = runStep(
    'Heterogeneous Fleet Scheduling & Dispatch',
    nodeBin,
    [vitest, 'run', 'packages/core/tests/schedulerHeterogeneousFleet.test.ts', 'test/integration/crossPlatformFleet.test.ts']
  );

  // 8. Recovery
  const recoveryResult = runStep(
    'Durable Recovery & Lease Fencing',
    nodeBin,
    [vitest, 'run', 'test/integration/crossPlatformRecovery.test.ts']
  );

  const categories = [
    installResult,
    buildResult,
    cliResult,
    agentsResult,
    persistenceResult,
    tuiResult,
    fleetResult,
    recoveryResult,
  ];

  let status = 'PASS';
  if (categories.includes('FAIL')) {
    status = 'FAIL';
  } else if (categories.includes('BLOCKED')) {
    status = 'BLOCKED';
  } else if (categories.includes('NOT_RUN')) {
    status = 'NOT_RUN';
  }

  return {
    Installation: installResult,
    Build: buildResult,
    CLI: cliResult,
    Agents: agentsResult,
    Persistence: persistenceResult,
    TUI: tuiResult,
    Fleet: fleetResult,
    Recovery: recoveryResult,
    Status: status,
  };
}

function generateReport() {
  const hostId = getHostPlatformId();
  const hostEvaluation = testHostPlatform();

  // Load cached multi-platform matrix results if available (e.g. from CI artifacts)
  const matrixDir = path.join(rootDir, 'dist', 'release-gate');
  const results = [];

  for (const target of TARGET_PLATFORMS) {
    if (target.id === hostId) {
      results.push({
        Platform: target.platform,
        Architecture: target.architecture,
        ...hostEvaluation,
      });
      continue;
    }

    const artifactFile = path.join(matrixDir, `${target.id}.json`);
    if (existsSync(artifactFile)) {
      try {
        const cached = JSON.parse(readFileSync(artifactFile, 'utf8'));
        results.push({
          Platform: target.platform,
          Architecture: target.architecture,
          ...normalizeEvaluation(cached),
        });
        continue;
      } catch (e) {
        // fall back to default
      }
    }

    if (target.unsupported) {
      results.push({
        Platform: target.platform,
        Architecture: target.architecture,
        Installation: 'UNSUPPORTED',
        Build: 'UNSUPPORTED',
        CLI: 'UNSUPPORTED',
        Agents: 'UNSUPPORTED',
        Persistence: 'UNSUPPORTED',
        TUI: 'UNSUPPORTED',
        Fleet: 'UNSUPPORTED',
        Recovery: 'UNSUPPORTED',
        Status: 'UNSUPPORTED',
      });
    } else {
      results.push({
        Platform: target.platform,
        Architecture: target.architecture,
        Installation: 'NOT_RUN',
        Build: 'NOT_RUN',
        CLI: 'NOT_RUN',
        Agents: 'NOT_RUN',
        Persistence: 'NOT_RUN',
        TUI: 'NOT_RUN',
        Fleet: 'NOT_RUN',
        Recovery: 'NOT_RUN',
        Status: 'NOT_RUN',
      });
    }
  }

  // Save current host results for aggregation
  if (!existsSync(matrixDir)) {
    mkdirSync(matrixDir, { recursive: true });
  }
  writeFileSync(
    path.join(matrixDir, `${hostId}.json`),
    JSON.stringify(hostEvaluation, null, 2),
    'utf8'
  );

  return results;
}

function formatMarkdownTable(results) {
  const headers = [
    'Platform',
    'Architecture',
    'Installation',
    'Build',
    'CLI',
    'Agents',
    'Persistence',
    'TUI',
    'Fleet',
    'Recovery',
    'Status',
  ];

  const colWidths = headers.map((h) => h.length);
  for (const row of results) {
    for (let i = 0; i < headers.length; i++) {
      const val = String(row[headers[i]] || '');
      if (val.length > colWidths[i]) colWidths[i] = val.length;
    }
  }

  const pad = (s, len) => s + ' '.repeat(Math.max(0, len - s.length));

  const headerLine = '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';
  const sepLine = '|-' + colWidths.map((w) => '-'.repeat(w)).join('-|-') + '-|';
  const dataLines = results.map(
    (row) => '| ' + headers.map((h, i) => pad(String(row[h] || ''), colWidths[i])).join(' | ') + ' |'
  );

  return [headerLine, sepLine, ...dataLines].join('\n');
}

async function main() {
  console.log('\n==============================================================================');
  console.log('                 WAZIR AUTOMATED RELEASE VALIDATION GATE');
  console.log('==============================================================================\n');

  const results = generateReport();
  const table = formatMarkdownTable(results);

  console.log('\n' + table + '\n');

  const reportPath = path.join(rootDir, 'dist', 'release-gate-report.md');
  writeFileSync(reportPath, `# Wazir Automated Release Validation Report\n\nGenerated: ${new Date().toISOString()}\n\n${table}\n`, 'utf8');
  console.log(`✓ Release gate report written to ${reportPath}\n`);

  // Release Gate policy check:
  // Current host MUST be PASS.
  const hostId = getHostPlatformId();
  const hostTarget = TARGET_PLATFORMS.find((target) => target.id === hostId);
  const hostRow = hostTarget && results.find((r) => r.Platform === hostTarget.platform && r.Architecture === hostTarget.architecture);
  
  const strict = process.argv.includes('--strict');
  const blocking = blockingPlatforms(results, hostId, strict);
  if (!hostRow || blocking.length > 0) {
    console.error(`✗ RELEASE BLOCKED: Missing or unsuccessful quality gates: ${blocking.map((t) => t.id).join(', ') || hostId}`);
    process.exitCode = 1;
    return;
  }

  console.log('✓ Release gate passed for current host!');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((err) => {
  console.error(`Release gate execution failed: ${err.message}`);
  process.exit(1);
});
