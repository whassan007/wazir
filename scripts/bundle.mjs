#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { chmodSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
let commit = process.env.WAZIR_BUILD_COMMIT || '';
if (!commit) {
  try {
    commit = execSync('git rev-parse HEAD', { cwd: rootDir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    commit = 'unknown';
  }
}
const buildDate = process.env.WAZIR_BUILD_DATE || new Date().toISOString();

const entryPoint = resolve(rootDir, 'apps/cli/src/index.ts');
const outDir = resolve(rootDir, 'bin');
const outFile = resolve(outDir, 'wa.js');

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

console.log('==> Bundling Wazir CLI into standalone executable: bin/wa.js');

try {
  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: outFile,
    external: ['pg-native', '@napi-rs/keyring'],
    sourcemap: true,
    minify: false,
    logLevel: 'info',
    define: {
      '__WAZIR_VERSION__': JSON.stringify(pkg.version),
      '__WAZIR_COMMIT__': JSON.stringify(commit),
      '__WAZIR_BUILD_DATE__': JSON.stringify(buildDate),
    },
  });

  try {
    chmodSync(outFile, 0o755);
  } catch {
    // best-effort on Windows
  }
  console.log(`✓ Standalone CLI bundle created at: ${outFile}`);
} catch (error) {
  console.error('Bundle failed:', error);
  process.exit(1);
}
