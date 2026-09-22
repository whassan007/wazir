#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

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
    target: 'node20',
    format: 'cjs',
    outfile: outFile,
    external: ['pg-native', '@napi-rs/keyring'],
    sourcemap: true,
    minify: false,
    logLevel: 'info',
  });

  chmodSync(outFile, 0o755);
  console.log(`✓ Standalone CLI bundle created at: ${outFile}`);
} catch (error) {
  console.error('Bundle failed:', error);
  process.exit(1);
}
