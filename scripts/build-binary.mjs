#!/usr/bin/env node
// ==============================================================================
// Cross-Platform Standalone Binary Builder using Node.js SEA
// (scripts/build-binary.mjs)
// Works natively on macOS (Mach-O), Linux (ELF), and Windows (PE .exe).
// ==============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

console.log(`==> Building standalone native binary on ${process.platform} (${process.arch})...`);

// 1. Run setup-env and bundle
console.log('==> Configuring environment files...');
execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'setup-env.mjs')], { stdio: 'inherit', cwd: rootDir });

console.log('==> Bundling CLI bundle...');
execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'bundle.mjs')], { stdio: 'inherit', cwd: rootDir });

const distDir = path.join(rootDir, 'dist');
if (!existsSync(distDir)) {
  mkdirSync(distDir, { recursive: true });
}

const outBin = path.join(distDir, isWin ? 'wa.exe' : 'wa');
const seaConfig = path.join(distDir, 'sea-config.json');
const seaBlob = path.join(distDir, 'sea-prep.blob');

// 2. Write SEA config
const configContent = {
  main: path.join('bin', 'wa.js'),
  output: path.join('dist', 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
};
writeFileSync(seaConfig, JSON.stringify(configContent, null, 2), 'utf8');

// 3. Generate SEA blob
console.log('==> Generating SEA blob...');
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit', cwd: rootDir });

// 4. Copy node executable to output binary
console.log(`==> Copying Node binary (${process.execPath}) -> ${outBin}...`);
copyFileSync(process.execPath, outBin);
try {
  chmodSync(outBin, 0o755);
} catch {
  // best effort on Windows
}

// 5. Inject blob using postject
console.log('==> Injecting SEA blob with postject...');
const postjectArgs = [
  '--yes',
  'postject',
  outBin,
  'NODE_SEA_BLOB',
  seaBlob,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];

if (isMac) {
  // macOS requires removing code signature before postject and re-signing after
  try {
    spawnSync('codesign', ['--remove-signature', outBin], { stdio: 'ignore' });
  } catch {}
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}

const npx = isWin ? 'npx.cmd' : 'npx';
const postjectResult = spawnSync(npx, postjectArgs, { stdio: 'inherit', cwd: rootDir });
if (postjectResult.status !== 0) {
  console.error('error: postject failed to inject SEA blob.');
  process.exit(1);
}

if (isMac) {
  try {
    spawnSync('codesign', ['--sign', '-', outBin], { stdio: 'inherit' });
  } catch {}
}

try {
  chmodSync(outBin, 0o755);
} catch {}

// 6. Cleanup temporary artifacts
rmSync(seaConfig, { force: true });
rmSync(seaBlob, { force: true });

const stat = statSync(outBin);
const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);

console.log('\n==============================================================================');
console.log(`✓ Standalone binary created at: ${outBin} (${sizeMB} MB)`);
console.log('==============================================================================');
