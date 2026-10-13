#!/usr/bin/env node
import * as esbuild from 'esbuild';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// Runs before any bundled module: fail with a clear message on an unsupported runtime
// instead of a stack trace from deep inside the ledger.
const RUNTIME_GUARD = `
(() => {
  // node:sqlite is still flagged experimental; that one warning would print on every command.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type;
    if (type === 'ExperimentalWarning' && /SQLite/.test(String(warning))) return;
    return emit.call(this, warning, ...rest);
  };
  const [maj, min] = process.versions.node.split('.').map(Number);
  let sqlite = false;
  try { sqlite = !!(process.getBuiltinModule && process.getBuiltinModule('node:sqlite')); } catch {}
  if (maj < 22 || (maj === 22 && min < 13) || !sqlite) {
    process.stderr.write('wa: Node.js >= 22.13.0 with node:sqlite is required (found ' + process.versions.node + ').\\n');
    process.exit(1);
  }
})();`;

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
    // Must match package.json engines: node:sqlite (the resource ledger) needs >= 22.13 unflagged.
    target: 'node22.13',
    format: 'cjs',
    outfile: outFile,
    // Native modules cannot be inlined: their loaders find a platform .node binary relative
    // to their own package directory. They ship as optionalDependencies of the published
    // package and every call site loads them lazily, so a missing one disables only its
    // feature (PTY terminal tool, OS keychain, native Postgres driver).
    external: ['pg-native', '@napi-rs/keyring', 'node-pty'],
    banner: { js: RUNTIME_GUARD },
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
