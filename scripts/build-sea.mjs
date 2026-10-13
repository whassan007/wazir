#!/usr/bin/env node
// Builds a standalone `wa` executable (Node.js Single Executable Application) for the current
// platform and packs it as dist/sea/wazir-<version>-<os>-<arch>.zip (Windows) or .tar.gz.
// Cross-platform successor of scripts/build-binary.sh, and the artifact Scoop, WinGet and
// scripts/install.ps1 install. The executable embeds the Node runtime it was built with
// (>= 22.13); native optional modules (node-pty, @napi-rs/keyring) are not available inside
// it and their features report themselves unavailable.
//
//   node scripts/build-sea.mjs [--skip-bundle]
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const version = process.env.WAZIR_BUILD_VERSION || JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform] ?? process.platform;
const out = path.join(root, 'dist/sea');
const exe = path.join(out, win ? 'wa.exe' : 'wa');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: win && /\.cmd$/.test(cmd), ...opts });

if (!process.argv.includes('--skip-bundle')) run(process.execPath, [path.join(root, 'scripts/bundle.mjs')]);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The SEA main must not start with a shebang line.
const main = path.join(out, 'main.cjs');
writeFileSync(main, readFileSync(path.join(root, 'bin/wa.js'), 'utf8').replace(/^#!.*\n/, ''));
const config = path.join(out, 'sea-config.json');
const blob = path.join(out, 'sea-prep.blob');
writeFileSync(config, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
run(process.execPath, ['--experimental-sea-config', config]);

copyFileSync(process.execPath, exe);
if (!win) chmodSync(exe, 0o755);
if (process.platform === 'darwin') run('codesign', ['--remove-signature', exe]);
const npx = win ? 'npx.cmd' : 'npx';
run(npx, ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', blob,
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', exe]);

const reported = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
if (reported !== version) throw new Error(`built executable reports ${reported}, expected ${version}`);

for (const f of [main, config, blob]) rmSync(f);
for (const f of ['README.md', 'LICENSE']) copyFileSync(path.join(root, f), path.join(out, f));
const archive = path.join(out, `wazir-${version}-${os}-${process.arch}.${win ? 'zip' : 'tar.gz'}`);
if (win) {
  run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${exe}','${path.join(out, 'README.md')}','${path.join(out, 'LICENSE')}' -DestinationPath '${archive}' -Force`]);
} else {
  run('tar', ['-czf', archive, '-C', out, 'wa', 'README.md', 'LICENSE']);
}
console.log(archive);
