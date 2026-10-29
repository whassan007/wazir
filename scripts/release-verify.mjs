#!/usr/bin/env node
// Verify the staged distribution rather than packing the development manifest.
// package-check covers contents, metadata, secrets, global/local installs,
// optional dependency fallback, upgrade state preservation, and uninstall.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
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
console.log('✓ release:verify PASSED — distribution packaging and installation verified.');
