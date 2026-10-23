#!/usr/bin/env node
/**
 * Build a standalone native executable for Wazir using Node.js Single Executable Application (SEA)
 * Supported platforms: Linux, macOS (Darwin), Windows (win32)
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, statSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

function run(cmd, args, opts = {}) {
  const isWin = process.platform === 'win32';
  const execCmd = isWin && (cmd === 'npm' || cmd === 'npx') ? `${cmd}.cmd` : cmd;
  const res = spawnSync(execCmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: isWin,
    ...opts,
  });
  if (res.status !== 0) {
    throw new Error(`Command failed with exit code ${res.status}: ${cmd} ${args.join(' ')}`);
  }
  return res;
}

if (process.env.WAZIR_SETUP_ENV === '1' || process.argv.includes('--setup-env')) {
  console.log('==> Configuring environment files and shell profiles...');
  run(process.execPath, [join(repoRoot, 'scripts', 'setup-env.mjs')]);
}

console.log('==> Building CLI bundle...');
run(process.execPath, [join(repoRoot, 'scripts', 'bundle.mjs')]);

const distDir = join(repoRoot, 'dist');
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const outBin = join(distDir, isWin ? 'wa.exe' : 'wa');
const seaConfig = join(distDir, 'sea-config.json');
const seaBlob = join(distDir, 'sea-prep.blob');

writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: 'bin/wa.js',
      output: 'dist/sea-prep.blob',
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
  'utf8',
);

console.log('==> Generating SEA blob...');
run(process.execPath, ['--experimental-sea-config', seaConfig]);

console.log(`==> Packaging standalone binary: ${outBin}...`);
copyFileSync(process.execPath, outBin);
if (!isWin) {
  try {
    chmodSync(outBin, 0o755);
  } catch {}
}

const sentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

if (isMac) {
  // macOS requires removing existing signature before injection, then re-signing
  try {
    spawnSync('codesign', ['--remove-signature', outBin], { stdio: 'ignore' });
  } catch {}
  run('npx', [
    '--yes',
    'postject',
    outBin,
    'NODE_SEA_BLOB',
    seaBlob,
    '--sentinel-fuse',
    sentinelFuse,
    '--macho-segment-name',
    'NODE_SEA',
  ]);
  try {
    spawnSync('codesign', ['--sign', '-', outBin], { stdio: 'ignore' });
  } catch {}
} else if (isWin) {
  run('npx', [
    '--yes',
    'postject',
    outBin,
    'NODE_SEA_BLOB',
    seaBlob,
    '--sentinel-fuse',
    sentinelFuse,
  ]);
} else {
  // Linux
  run('npx', [
    '--yes',
    'postject',
    outBin,
    'NODE_SEA_BLOB',
    seaBlob,
    '--sentinel-fuse',
    sentinelFuse,
  ]);
}

try {
  rmSync(seaConfig, { force: true });
  rmSync(seaBlob, { force: true });
} catch {}

if (!isWin) {
  try {
    chmodSync(outBin, 0o755);
  } catch {}
}

const stats = statSync(outBin);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);

console.log(`\n✓ Standalone binary created at: ${outBin} (${sizeMb} MB)`);
if (isWin) {
  console.log(`  To install: copy ${outBin} to a directory on your PATH`);
} else {
  console.log(`  To install globally: sudo cp ${outBin} /usr/local/bin/wa`);
  console.log(`  Or user-local:       cp ${outBin} ~/.local/bin/wa`);
}
