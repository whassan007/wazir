#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { chmodSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { syncFleetUpstream } from './sync-fleet-upstream.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

syncFleetUpstream({ ifPresent: true, quiet: true });

const version = process.env.WAZIR_BUILD_VERSION || JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8')).version;

// Runs before any bundled module: fail with a clear message on an unsupported runtime
// instead of a stack trace from deep inside the ledger, and fast-path version queries.
const RUNTIME_GUARD = `
(() => {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    process.stderr.write('wa: Node.js >= 22.13.0 with node:sqlite is required (found ' + process.versions.node + ').\\n');
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V' || argv[0] === 'version')) {
    process.stdout.write(${JSON.stringify(version)} + '\\n');
    process.exit(0);
  }
  if (argv.length === 2 && argv[0] === 'version' && (argv[1] === '--json' || argv[1] === '-j')) {
    process.stdout.write(${JSON.stringify(JSON.stringify({ version }))} + '\\n');
    process.exit(0);
  }
})();`;

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
const workerEntryPoint = resolve(rootDir, 'apps/worker/src/index.ts');
const outDir = resolve(rootDir, 'bin');
const outFile = resolve(outDir, 'wa.js');
const workerOutFile = resolve(outDir, 'wazir-worker.js');

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

console.log('==> Bundling Wazir CLI into standalone executable: bin/wa.js');

try {
  await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    // Must match package.json engines: node:sqlite (the resource ledger) needs >= 22.13 unflagged.
    target: 'node22.13',
    format: 'cjs',
    outfile: outFile,
    // to their own package directory. They ship as optionalDependencies of the published
    // package and every call site loads them lazily, so a missing one disables only its
    // feature (PTY terminal tool, OS keychain, native Postgres driver).
    external: ['pg-native', '@napi-rs/keyring', 'node-pty'],
    banner: { js: RUNTIME_GUARD },
    sourcemap: true,
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    logLevel: 'info',
    define: {
      '__WAZIR_VERSION__': JSON.stringify(version),
      '__WAZIR_COMMIT__': JSON.stringify(commit),
      '__WAZIR_BUILD_DATE__': JSON.stringify(buildDate),
    },
  });

    // Sanitize outFile if it contains os.homedir()
    const bundled = readFileSync(outFile, 'utf8');
    if (bundled.includes(os.homedir())) {
      let sanitized = bundled;
      sanitized = sanitized.replace(new RegExp(`(\\.\\./)+${os.homedir().replace(/^\/+/, '')}/[^"\n]*?/node_modules/`, 'g'), 'node_modules/');
      sanitized = sanitized.split(os.homedir()).join('~');
      writeFileSync(outFile, sanitized, 'utf8');
    }
    try {
      chmodSync(outFile, 0o755);
    } catch {
      // best-effort on Windows
    }
    console.log(`✓ Standalone CLI bundle created at: ${outFile}`);

    if (existsSync(workerEntryPoint)) {
      console.log('==> Bundling Wazir Worker into standalone executable: bin/wazir-worker.js');
      await esbuild.build({
        entryPoints: [workerEntryPoint],
        bundle: true,
        platform: 'node',
        target: 'node22.13',
        format: 'cjs',
        outfile: workerOutFile,
        external: ['pg-native', '@napi-rs/keyring', 'node-pty'],
        banner: { js: RUNTIME_GUARD },
        sourcemap: true,
        minifyWhitespace: true,
        minifySyntax: true,
        minifyIdentifiers: false,
        logLevel: 'info',
        define: {
          '__WAZIR_VERSION__': JSON.stringify(version),
          '__WAZIR_COMMIT__': JSON.stringify(commit),
          '__WAZIR_BUILD_DATE__': JSON.stringify(buildDate),
        },
      });
      try {
        chmodSync(workerOutFile, 0o755);
      } catch {
        // best-effort on Windows
      }
      console.log(`✓ Standalone Worker bundle created at: ${workerOutFile}`);
    }
  } catch (error) {
    console.error('Bundle failed:', error);
    process.exit(1);
  }
