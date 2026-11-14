#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const manifestPath = resolve(root, 'tests/wazir-functional/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const args = process.argv.slice(2);
const shouldRun = args.includes('--run');
const shouldBuild = !args.includes('--no-build');

if (args.some((arg) => !['--run', '--no-build'].includes(arg))) {
  console.error('Usage: node tests/wazir-functional/run.mjs [--run] [--no-build]');
  process.exit(2);
}

const ids = new Set();
const deterministicFiles = new Set();
const errors = [];
for (const item of manifest.cases) {
  if (!item.id || ids.has(item.id)) errors.push(`Missing or duplicate case id: ${item.id ?? '(missing)'}`);
  ids.add(item.id);
  if (!item.area || !['deterministic', 'live'].includes(item.kind)) errors.push(`${item.id}: invalid area or kind`);
  if (!Array.isArray(item.tests)) errors.push(`${item.id}: tests must be an array`);
  for (const testPath of item.tests ?? []) {
    if (!existsSync(resolve(root, testPath))) errors.push(`${item.id}: test file does not exist: ${testPath}`);
    if (item.kind === 'deterministic') deterministicFiles.add(testPath);
  }
  if (item.kind === 'deterministic' && item.tests.length === 0) errors.push(`${item.id}: deterministic case needs at least one test`);
  if (item.kind === 'live' && !item.liveRequirement) errors.push(`${item.id}: live case needs an explicit evidence requirement`);
}

if (manifest.cases.length !== 20) errors.push(`Expected 20 cases, found ${manifest.cases.length}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`Wazir functional manifest v${manifest.schemaVersion}: ${manifest.cases.length} cases`);
for (const item of manifest.cases) {
  console.log(`${item.id} [${item.kind}] ${item.area}`);
  if (item.liveRequirement) console.log(`  Live evidence required: ${item.liveRequirement}`);
}

if (!shouldRun) {
  const liveEvidenceCases = manifest.cases.filter((item) => item.liveRequirement).length;
  console.log(`\nManifest valid. ${deterministicFiles.size} unique deterministic test files; ${liveEvidenceCases} cases specify additional live evidence.`);
  console.log('Use --run to build and execute the deterministic tests.');
  process.exit(0);
}

if (shouldBuild) {
  const build = spawnSync('npm', ['run', 'build:cli'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const vitest = resolve(root, 'node_modules/vitest/vitest.mjs');
if (!existsSync(vitest)) {
  console.error('Vitest is not installed at the repository root. Install the project dependencies, then rerun this command.');
  process.exit(1);
}
const result = spawnSync(process.execPath, [vitest, 'run', ...deterministicFiles], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
