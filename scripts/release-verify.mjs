#!/usr/bin/env node
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('==> Running release:verify — end-to-end smoke test of distribution package...');

// 1. Build and verify package metadata
console.log('--- Step 1: Building workspaces and checking package metadata ---');
execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });
execSync('npm run package:check', { cwd: rootDir, stdio: 'inherit' });

// 2. Pack tarball into a temporary directory
console.log('\n--- Step 2: Generating npm tarball ---');
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wazir-release-verify-'));
const packOutput = execSync(`npm pack --pack-destination="${tmpDir}"`, { cwd: rootDir, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const tarballName = packOutput.split('\n').filter(Boolean).pop();
const tarballPath = path.join(tmpDir, tarballName);

if (!existsSync(tarballPath)) {
  console.error(`✗ Tarball was not created at expected location: ${tarballPath}`);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}
console.log(`✓ Created tarball: ${tarballPath}`);

// 3. Isolated install in a clean environment
console.log('\n--- Step 3: Installing tarball into clean isolated prefix ---');
const installPrefix = path.join(tmpDir, 'install-prefix');
execSync(`npm install -g "${tarballPath}" --prefix="${installPrefix}"`, { stdio: 'inherit' });

const binDir = process.platform === 'win32'
  ? installPrefix
  : path.join(installPrefix, 'bin');
const waBin = process.platform === 'win32'
  ? path.join(binDir, 'wa.cmd')
  : path.join(binDir, 'wa');

if (!existsSync(waBin)) {
  console.error(`✗ Installed CLI executable not found at: ${waBin}`);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}
console.log(`✓ CLI installed at: ${waBin}`);

// 4. Run CLI smoke tests from completely outside the repo
console.log('\n--- Step 4: Running CLI smoke tests outside repository context ---');
const runOutside = (args, options = {}) => {
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  return spawnSync(waBin, args, {
    cwd: tmpDir,
    env,
    encoding: 'utf8',
    timeout: 30000,
    // npm installs Windows `bin` entries as `.cmd` wrappers. Node cannot spawn
    // those directly without a command shell, even though the wrapper exists.
    shell: process.platform === 'win32',
    ...options,
  });
};

const checks = [
  { name: 'wa --version', args: ['--version'] },
  { name: 'wa --help', args: ['--help'] },
  { name: 'wa version --json', args: ['version', '--json'] },
  { name: 'wa agents list', args: ['agents', 'list'] },
  { name: 'wa models list', args: ['models', 'list'] },
  { name: 'wa resources', args: ['resources'] },
  { name: 'wa doctor --json', args: ['doctor', '--json'] },
];

let failed = 0;
for (const check of checks) {
  process.stdout.write(`Testing: ${check.name} ... `);
  const res = runOutside(check.args);
  if (res.status !== 0 && res.status !== 1 /* doctor can exit 1 if external runtimes unavailable */) {
    console.log(`FAILED (exit code ${res.status})`);
    if (res.stderr) console.error(`  stderr: ${res.stderr.trim()}`);
    if (res.stdout) console.error(`  stdout: ${res.stdout.trim()}`);
    failed++;
  } else {
    console.log('PASS');
  }
}

// 5. Test uninstall
console.log('\n--- Step 5: Testing package uninstallation ---');
execSync(`npm uninstall -g wazir --prefix="${installPrefix}"`, { stdio: 'inherit' });
if (existsSync(waBin)) {
  console.error(`✗ wa executable still exists after uninstall at: ${waBin}`);
  failed++;
} else {
  console.log('✓ wa executable cleanly removed upon uninstall');
}

// Clean up
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {}

if (failed > 0) {
  console.error(`\n✗ release:verify FAILED with ${failed} failure(s)`);
  process.exit(1);
}

console.log('\n✓ release:verify PASSED — npm distribution package installs, runs, and uninstalls cleanly outside repo context.');
