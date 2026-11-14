#!/usr/bin/env node
/**
 * Build a standalone native executable for Wazir using Node.js Single Executable Application (SEA)
 * Supported platforms: Linux, macOS (Darwin), Windows (win32)
 */
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync, statSync, chmodSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

function hasSeaSentinel(binaryPath) {
  try {
    const buf = readFileSync(binaryPath);
    return buf.includes(Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'));
  } catch {
    return false;
  }
}

function isCompatibleStaticNode(binaryPath) {
  if (!binaryPath || !existsSync(binaryPath)) return false;
  if (!hasSeaSentinel(binaryPath)) return false;
  try {
    const probe = spawnSync(
      binaryPath,
      ['-e', 'const [maj,min]=process.versions.node.split(".").map(Number);process.exit((maj>22||(maj===22&&min>=13))&&!process.config?.variables?.node_shared?0:1)'],
      { stdio: 'ignore', timeout: 5000 },
    );
    return probe.status === 0;
  } catch {
    return false;
  }
}

function resolveSeaBaseNode() {
  if (process.env.WAZIR_SEA_NODE_BIN) {
    if (!isCompatibleStaticNode(process.env.WAZIR_SEA_NODE_BIN)) {
      throw new Error(`WAZIR_SEA_NODE_BIN (${process.env.WAZIR_SEA_NODE_BIN}) is not a static Node >= 22.13 binary with NODE_SEA_FUSE.`);
    }
    return process.env.WAZIR_SEA_NODE_BIN;
  }
  if (isCompatibleStaticNode(process.execPath)) {
    return process.execPath;
  }
  const home = os.homedir();
  const candidates = [];
  const collectSubdirNodes = (baseDir, relBin) => {
    if (!existsSync(baseDir)) return;
    try {
      for (const entry of readdirSync(baseDir).sort().reverse()) {
        candidates.push(join(baseDir, entry, ...relBin));
      }
    } catch {}
  };
  const isWin = process.platform === 'win32';
  const nodeExe = isWin ? 'node.exe' : 'node';
  collectSubdirNodes(join(home, '.nvm', 'versions', 'node'), ['bin', nodeExe]);
  collectSubdirNodes(join(home, '.fnm', 'node-versions'), ['installation', 'bin', nodeExe]);
  collectSubdirNodes(join(home, '.volta', 'tools', 'image', 'node'), ['bin', nodeExe]);
  collectSubdirNodes(join(home, '.asdf', 'installs', 'nodejs'), ['bin', nodeExe]);
  collectSubdirNodes(join(home, '.cache', 'codex-runtimes'), ['dependencies', 'node', 'bin', nodeExe]);
  candidates.push('/usr/local/bin/node');

  for (const candidate of candidates) {
    if (isCompatibleStaticNode(candidate)) {
      console.log(`==> Current Node (${process.execPath}) is dynamically linked (--shared, no SEA fuse); using static SEA host runtime: ${candidate}`);
      return candidate;
    }
  }
  throw new Error(
    `Current Node binary (${process.execPath}) was built with --shared (e.g. Homebrew) and lacks NODE_SEA_FUSE. ` +
      `Install official static Node >= 22.13 via nvm/fnm/nodejs.org or set WAZIR_SEA_NODE_BIN=/path/to/node.`,
  );
}

function resolvePostjectInvoker() {
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'postject.cmd' : 'postject';
  const localBin = join(repoRoot, 'node_modules', '.bin', binName);
  if (existsSync(localBin)) {
    return { cmd: localBin, prefixArgs: [] };
  }
  const npxCacheRoot = join(os.homedir(), '.npm', '_npx');
  if (existsSync(npxCacheRoot)) {
    try {
      for (const entry of readdirSync(npxCacheRoot)) {
        const candidate = join(npxCacheRoot, entry, 'node_modules', '.bin', binName);
        if (existsSync(candidate)) {
          return { cmd: candidate, prefixArgs: [] };
        }
      }
    } catch {}
  }
  return { cmd: 'npx', prefixArgs: ['--yes', 'postject'] };
}

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
const outAliasBin = join(distDir, isWin ? 'wazir.exe' : 'wazir');
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

const seaBaseNode = resolveSeaBaseNode();

console.log('==> Generating SEA blob...');
run(seaBaseNode, ['--experimental-sea-config', seaConfig]);

console.log(`==> Packaging standalone binary: ${outBin}...`);
copyFileSync(seaBaseNode, outBin);
if (!isWin) {
  try {
    chmodSync(outBin, 0o755);
  } catch {}
}

const sentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const postject = resolvePostjectInvoker();

if (isMac) {
  // macOS requires removing existing signature before injection, then re-signing
  try {
    spawnSync('codesign', ['--remove-signature', outBin], { stdio: 'ignore' });
  } catch {}
  run(postject.cmd, [
    ...postject.prefixArgs,
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
  run(postject.cmd, [
    ...postject.prefixArgs,
    outBin,
    'NODE_SEA_BLOB',
    seaBlob,
    '--sentinel-fuse',
    sentinelFuse,
  ]);
} else {
  // Linux
  run(postject.cmd, [
    ...postject.prefixArgs,
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

copyFileSync(outBin, outAliasBin);
if (!isWin) {
  try {
    chmodSync(outAliasBin, 0o755);
  } catch {}
}
if (isMac) {
  try {
    spawnSync('codesign', ['--force', '--sign', '-', outAliasBin], { stdio: 'ignore' });
  } catch {}
}

const stats = statSync(outBin);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);

console.log(`\n✓ Standalone binaries created at: ${outBin} and ${outAliasBin} (${sizeMb} MB each)`);
if (isWin) {
  console.log(`  To install: copy ${outBin} and ${outAliasBin} to a directory on your PATH`);
} else {
  console.log(`  To install globally: sudo cp ${outBin} ${outAliasBin} /usr/local/bin/`);
  console.log(`  Or user-local:       cp ${outBin} ${outAliasBin} ~/.local/bin/`);
}
