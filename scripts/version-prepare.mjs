#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncAllVersions, checkVersionParity } from './version-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const targetVersion = process.argv[2];
if (!targetVersion || !/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(targetVersion)) {
  console.error('Usage: npm run version:prepare -- <semver>');
  process.exit(1);
}

console.log(`==> Preparing release version ${targetVersion}...`);
console.log('1. Synchronizing version across all manifests...');
const updated = syncAllVersions(targetVersion, repoRoot);
console.log(`   Updated ${updated.length} files.`);

console.log('2. Updating package-lock.json...');
execFileSync('npm', ['install', '--package-lock-only'], { cwd: repoRoot, stdio: 'inherit' });

console.log('3. Validating version parity...');
const check = checkVersionParity(repoRoot);
if (!check.isParity) {
  console.error('✗ Version parity validation failed!');
  process.exit(1);
}
console.log('✓ All 37 version declarations match canonical version.');

console.log('4. Rebuilding standalone CLI bundle...');
execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });

console.log(`✓ Version ${targetVersion} preparation complete.`);
