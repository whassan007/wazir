#!/usr/bin/env node
// Stages and packs the publishable npm package from the private monorepo.
//
// The repository root stays `private: true` (it is the development workspace); the published
// package is generated in dist/npm/package with its own minimal package.json: the bundled CLI,
// README and LICENSE, and the native modules the bundle keeps external as optionalDependencies.
// No lifecycle scripts are published: installing never touches ~/.wazir or shell profiles;
// `wa init` / `wa doctor` are the explicit first-run steps.
//
//   node scripts/pack-npm.mjs [--name <npm-name>] [--skip-bundle]
// WAZIR_BUILD_VERSION=<v> stamps a different version into the bundle and manifest (upgrade tests).
// Prints the tarball path. WAZIR_NPM_NAME overrides the package name (default: wazir).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const name = arg('--name') ?? process.env.WAZIR_NPM_NAME ?? 'wazir';
const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Native modules kept external by scripts/bundle.mjs, pinned to the versions the build was tested with.
const installed = (m) => JSON.parse(readFileSync(path.join(root, 'node_modules', m, 'package.json'), 'utf8')).version;
const optionalDependencies = { '@napi-rs/keyring': installed('@napi-rs/keyring'), 'node-pty': installed('node-pty') };

if (!args.includes('--skip-bundle')) execFileSync(process.execPath, [path.join(root, 'scripts/bundle.mjs')], { stdio: 'inherit' });
const bundle = path.join(root, 'bin/wa.js');
if (!existsSync(bundle)) throw new Error('bin/wa.js is missing; run npm run build first');

const stage = path.join(root, 'dist/npm/package');
rmSync(path.join(root, 'dist/npm'), { recursive: true, force: true });
mkdirSync(path.join(stage, 'bin'), { recursive: true });
copyFileSync(bundle, path.join(stage, 'bin/wa.js'));
for (const f of ['README.md', 'LICENSE']) copyFileSync(path.join(root, f), path.join(stage, f));

const pkg = {
  name,
  version: process.env.WAZIR_BUILD_VERSION || rootPkg.version,
  description: rootPkg.description,
  license: rootPkg.license,
  homepage: 'https://github.com/whassan007/wazir#readme',
  repository: { type: 'git', url: 'git+https://github.com/whassan007/wazir.git' },
  bugs: { url: 'https://github.com/whassan007/wazir/issues' },
  bin: { wa: 'bin/wa.js' },
  files: ['bin/wa.js', 'README.md', 'LICENSE'],
  engines: rootPkg.engines,
  optionalDependencies,
  publishConfig: { access: 'public', provenance: true },
};
writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

const out = path.join(root, 'dist/npm');
const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', out], { cwd: stage, encoding: 'utf8', shell: process.platform === 'win32' }));
const tarball = path.join(out, packed.filename);
writeFileSync(path.join(out, 'pack.json'), JSON.stringify({ ...packed, tarball, bytes: statSync(tarball).size }, null, 2));
console.log(tarball);
