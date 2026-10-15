#!/usr/bin/env node
/**
 * scripts/build-deb.mjs
 *
 * Builds production Debian/Ubuntu package (.deb) for Wazir.
 * Includes:
 *  - /usr/bin/wa
 *  - /usr/lib/wazir/wa.js
 *  - /lib/systemd/system/wazir-api.service
 *  - /lib/systemd/system/wazir-worker.service
 *  - systemd maintainer scripts (postinst, prerm, postrm)
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;

console.log(`==> Building Debian (.deb) package for Wazir v${version}...`);

// Ensure bundle exists
const waBundle = path.resolve(rootDir, 'bin/wa.js');
if (!existsSync(waBundle)) {
  console.log('Generating CLI bundle first...');
  execSync('node scripts/bundle.mjs', { cwd: rootDir, stdio: 'inherit' });
}

const debOutputDir = path.resolve(rootDir, 'dist/deb');
const stagingDir = path.resolve(debOutputDir, `wazir_${version}_all`);
if (existsSync(stagingDir)) {
  rmSync(stagingDir, { recursive: true, force: true });
}
mkdirSync(stagingDir, { recursive: true });

// 1. Create directory hierarchy
const dirs = [
  'DEBIAN',
  'usr/bin',
  'usr/lib/wazir',
  'lib/systemd/system',
  'usr/share/doc/wazir',
];

for (const d of dirs) {
  mkdirSync(path.join(stagingDir, d), { recursive: true });
}

// 2. Control files & maintainer scripts
const controlTmpl = readFileSync(path.resolve(rootDir, 'packaging/deb/debian/control'), 'utf8')
  .replace(/Version: .*/, `Version: ${version}`);
writeFileSync(path.join(stagingDir, 'DEBIAN/control'), controlTmpl, 'utf8');

const maintainerScripts = ['postinst', 'prerm', 'postrm'];
for (const script of maintainerScripts) {
  const src = path.resolve(rootDir, `packaging/deb/debian/${script}`);
  const dst = path.join(stagingDir, 'DEBIAN', script);
  writeFileSync(dst, readFileSync(src, 'utf8'), 'utf8');
  chmodSync(dst, 0o755);
}

// 3. Application files
// /usr/bin/wa
const launcherScript = `#!/bin/sh
exec node /usr/lib/wazir/wa.js "$@"
`;
writeFileSync(path.join(stagingDir, 'usr/bin/wa'), launcherScript, 'utf8');
chmodSync(path.join(stagingDir, 'usr/bin/wa'), 0o755);

// /usr/lib/wazir/wa.js
writeFileSync(path.join(stagingDir, 'usr/lib/wazir/wa.js'), readFileSync(waBundle, 'utf8'), 'utf8');
chmodSync(path.join(stagingDir, 'usr/lib/wazir/wa.js'), 0o755);

// /usr/lib/wazir/package.json
const minPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  main: 'wa.js',
};
writeFileSync(path.join(stagingDir, 'usr/lib/wazir/package.json'), JSON.stringify(minPkg, null, 2), 'utf8');

// 4. Systemd services
const systemdWorker = readFileSync(path.resolve(rootDir, 'scripts/systemd/wazir-worker.service'), 'utf8')
  .replace('/usr/bin/node /opt/wazir/apps/worker/dist/index.js', '/usr/bin/wa worker start')
  .replace('WorkingDirectory=/opt/wazir', 'WorkingDirectory=/var/lib/wazir')
  .replace('ReadWritePaths=/opt/wazir', 'ReadWritePaths=/var/lib/wazir');

const systemdApi = readFileSync(path.resolve(rootDir, 'scripts/systemd/wazir-api.service'), 'utf8')
  .replace('/usr/bin/node /opt/wazir/apps/api/dist/main.js', '/usr/bin/wa api start')
  .replace('WorkingDirectory=/opt/wazir', 'WorkingDirectory=/var/lib/wazir')
  .replace('ReadWritePaths=/opt/wazir', 'ReadWritePaths=/var/lib/wazir');

writeFileSync(path.join(stagingDir, 'lib/systemd/system/wazir-worker.service'), systemdWorker, 'utf8');
writeFileSync(path.join(stagingDir, 'lib/systemd/system/wazir-api.service'), systemdApi, 'utf8');

// 5. Documentation & License
writeFileSync(path.join(stagingDir, 'usr/share/doc/wazir/README.md'), readFileSync(path.resolve(rootDir, 'README.md'), 'utf8'), 'utf8');
writeFileSync(path.join(stagingDir, 'usr/share/doc/wazir/copyright'), readFileSync(path.resolve(rootDir, 'LICENSE'), 'utf8'), 'utf8');

// 6. Build .deb package
const debFile = path.resolve(debOutputDir, `wazir_${version}_all.deb`);

let dpkgAvailable = false;
try {
  execSync('which dpkg-deb', { stdio: 'ignore' });
  dpkgAvailable = true;
} catch {}

if (dpkgAvailable) {
  console.log(`Building package using dpkg-deb -> ${debFile}...`);
  execSync(`dpkg-deb --build --root-owner-group "${stagingDir}" "${debFile}"`, { stdio: 'inherit' });
} else {
  console.log('dpkg-deb not available in environment; archiving package structure.');
  execSync(`tar -czf "${debFile}.tar.gz" -C "${debOutputDir}" "wazir_${version}_all"`, { stdio: 'inherit' });
}

if (existsSync(debFile)) {
  console.log(`✓ Debian package created: ${debFile}`);
  if (dpkgAvailable) {
    try {
      const info = execSync(`dpkg-deb -I "${debFile}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      console.log('\nPackage information:');
      console.log(info.split('\n').slice(0, 10).join('\n'));
    } catch {}
  }
}
