#!/usr/bin/env node
// Builds dist/linux/wazir_<v>_<arch>.deb and wazir-<v>-1.<arch>.rpm from the standalone
// executable in dist/sea/wa (run scripts/build-sea.mjs first, on the target architecture),
// using nfpm (https://nfpm.goreleaser.com) from PATH or its pinned container image.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NFPM_IMAGE = 'goreleaser/nfpm:v2.43.1';
const version = process.env.WAZIR_BUILD_VERSION || JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
if (process.platform !== 'linux' || !arch) throw new Error('build Linux packages on linux x64 or arm64');
if (!existsSync(path.join(root, 'dist/sea/wa'))) throw new Error('dist/sea/wa missing: run node scripts/build-sea.mjs');
const reported = execFileSync(path.join(root, 'dist/sea/wa'), ['--version'], { encoding: 'utf8' }).trim();
if (reported !== version) throw new Error(`dist/sea/wa is ${reported}, expected ${version}`);
const out = path.join(root, 'dist/linux');
mkdirSync(out, { recursive: true });
const env = { ...process.env, WAZIR_VERSION: version, WAZIR_ARCH: arch };
const local = spawnSync('nfpm', ['--version'], { encoding: 'utf8' }).status === 0;
for (const packager of ['deb', 'rpm']) {
  const args = ['package', '--config', 'packaging/linux/nfpm.yaml', '--packager', packager, '--target', 'dist/linux/'];
  if (local) execFileSync('nfpm', args, { cwd: root, env, stdio: 'inherit' });
  else execFileSync('docker', ['run', '--rm', '-u', `${process.getuid()}:${process.getgid()}`, '-v', `${root}:/src`, '-w', '/src',
    '-e', `WAZIR_VERSION=${version}`, '-e', `WAZIR_ARCH=${arch}`, NFPM_IMAGE, ...args], { stdio: 'inherit' });
}
for (const f of readdirSync(out)) console.log(path.join(out, f));
