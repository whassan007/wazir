#!/usr/bin/env node
/**
 * Builds every workspace the Wazir CLI actually needs, then bundles `bin/wa.js`.
 *
 * `npm run build` (the full monorepo build used by release CI, which provisions a
 * Rust toolchain on its runners) also builds `@wazir/desktop` via `tauri build`,
 * which requires Cargo and network access to crates.io. A CLI-only install or test
 * run has no use for the desktop app and must not fail or stall because of it
 * (observed repeatedly: source installs and local dev/test loops on sandboxes
 * without Cargo/network access fail the entire build over an unrelated app).
 *
 * This script builds every workspace with a `build` script except ones that opt
 * out via `"wazir": { "excludeFromCliBuild": true }` in their own package.json
 * (currently only @wazir/desktop). Set WAZIR_BUILD_DESKTOP=1 to include it anyway.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function cliWorkspaces(root = rootDir, env = process.env) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const groups = (pkg.workspaces ?? []).map((pattern) => pattern.replace(/\/\*$/, ''));
  const names = [];
  for (const group of groups) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(groupDir, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      let manifest;
      try { manifest = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { continue; }
      if (!manifest.name || !manifest.scripts?.build) continue;
      if (manifest.wazir?.excludeFromCliBuild && env.WAZIR_BUILD_DESKTOP !== '1') continue;
      names.push(manifest.name);
    }
  }
  return names;
}

function main() {
  const names = cliWorkspaces();
  if (names.length === 0) throw new Error('No buildable workspaces were discovered.');
  const args = ['run', 'build', '--if-present', ...names.flatMap((name) => ['--workspace', name])];
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const options = { cwd: rootDir, stdio: 'inherit', shell: process.platform === 'win32' };
  const result = spawnSync(npm, args, options);
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
  const bundle = spawnSync(npm, ['run', 'bundle'], options);
  if (bundle.error) console.error(bundle.error.message);
  process.exit(bundle.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
