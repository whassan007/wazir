#!/usr/bin/env node
// Verify the staged distribution rather than packing the development manifest.
// package-check covers contents, metadata, secrets, global/local installs,
// optional dependency fallback, upgrade state preservation, and uninstall.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log('==> Running release:verify — end-to-end distribution verification...');
for (const [script, args] of [
  ['build-cli.mjs', []],
  ['package-check.mjs', ['--skip-build']],
]) {
  const result = spawnSync(process.execPath, [path.join(rootDir, 'scripts', script), ...args], {
    cwd: rootDir,
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Verify the staged distribution from a clean directory outside the checkout.
const work = mkdtempSync(path.join(os.tmpdir(), 'wazir-release-verify-'));
try {
  const packed = run(process.execPath, [path.join(rootDir, 'scripts/pack-npm.mjs'), '--skip-bundle'], { cwd: rootDir });
  const tarball = packed.stdout.trim().split(/\r?\n/).at(-1);
  const prefix = path.join(work, 'prefix');
  const home = path.join(work, 'home');
  mkdirSync(home);
  const env = { ...process.env, WAZIR_HOME: home, WAZIR_SECRETS_BACKEND: 'encrypted-file', WAZIR_LMS_DISABLE: '1', NO_COLOR: '1' };
  delete env.WAZIR_IN_MEMORY;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, ['install', '-g', '--prefix', prefix, tarball, '--no-audit', '--no-fund'], { cwd: work, env });
  const wa = process.platform === 'win32' ? path.join(prefix, 'wa.cmd') : path.join(prefix, 'bin/wa');
  const checks = [
    ['--version'], ['--help'], ['version', '--json'], ['agents', 'list'],
    ['models', 'list'], ['resources'], ['doctor', '--json'], ['update', 'status', '--json'],
  ];
  for (const args of checks) {
    const result = run(wa, args, { cwd: work, env, allowedStatuses: args[0] === 'doctor' ? [0, 1] : [0] });
    if (args.includes('--json')) JSON.parse(result.stdout);
    console.log(`✓ wa ${args.join(' ')} (outside repository)`);
  }
  run(npm, ['uninstall', '-g', '--prefix', prefix, 'wazir', '--no-audit', '--no-fund'], { cwd: work, env });
  if (existsSync(wa)) throw new Error(`CLI executable remains after uninstall: ${wa}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('✓ release:verify PASSED — packaging, outside-repository commands, and uninstall verified.');

function run(command, args, { allowedStatuses = [0], ...options } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32' && /\.cmd$/.test(command), ...options,
  });
  if (result.error || !allowedStatuses.includes(result.status)) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.error?.message ?? result.stderr}`);
  }
  return result;
}
