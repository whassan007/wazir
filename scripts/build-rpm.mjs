#!/usr/bin/env node
/**
 * scripts/build-rpm.mjs
 *
 * Prepares and builds RPM package (.rpm) for Fedora / RHEL / CentOS.
 * Uses packaging/rpm/wazir.spec and packages:
 *  - /usr/bin/wa
 *  - /usr/lib/wazir/wa.js
 *  - /usr/lib/systemd/system/wazir-api.service
 *  - /usr/lib/systemd/system/wazir-worker.service
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;

console.log(`==> Preparing RPM package for Wazir v${version}...`);

// Ensure CLI bundle exists
const waBundle = path.resolve(rootDir, 'bin/wa.js');
if (!existsSync(waBundle)) {
  console.log('Generating CLI bundle first...');
  execSync('node scripts/bundle.mjs', { cwd: rootDir, stdio: 'inherit' });
}

const rpmTopDir = path.resolve(rootDir, 'dist/rpmbuild');
const subdirs = ['SPECS', 'SOURCES', 'BUILD', 'RPMS', 'SRPMS'];
for (const sub of subdirs) {
  mkdirSync(path.join(rpmTopDir, sub), { recursive: true });
}

// 1. Prepare source tarball wazir-${version}.tar.gz in SOURCES
const stagingDir = path.resolve(rpmTopDir, `wazir-${version}`);
if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
mkdirSync(path.join(stagingDir, 'bin'), { recursive: true });
mkdirSync(path.join(stagingDir, 'scripts/systemd'), { recursive: true });

// Copy bundle, package.json, readme, license, systemd files
writeFileSync(path.join(stagingDir, 'bin/wa.js'), readFileSync(waBundle));
writeFileSync(path.join(stagingDir, 'package.json'), readFileSync(path.resolve(rootDir, 'package.json')));
writeFileSync(path.join(stagingDir, 'README.md'), readFileSync(path.resolve(rootDir, 'README.md')));
writeFileSync(path.join(stagingDir, 'LICENSE'), readFileSync(path.resolve(rootDir, 'LICENSE')));

const systemdWorker = readFileSync(path.resolve(rootDir, 'scripts/systemd/wazir-worker.service'), 'utf8')
  .replace('/usr/bin/node /opt/wazir/apps/worker/dist/index.js', '/usr/bin/wa improve start --foreground --continuous')
  .replace('WorkingDirectory=/opt/wazir', 'WorkingDirectory=/var/lib/wazir')
  .replace('ReadWritePaths=/opt/wazir', 'ReadWritePaths=/var/lib/wazir');

const systemdApi = readFileSync(path.resolve(rootDir, 'scripts/systemd/wazir-api.service'), 'utf8')
  .replace('/usr/bin/node /opt/wazir/apps/api/dist/main.js', '/usr/bin/wa dashboard --no-open --host 0.0.0.0 --port 4800')
  .replace('WorkingDirectory=/opt/wazir', 'WorkingDirectory=/var/lib/wazir')
  .replace('ReadWritePaths=/opt/wazir', 'ReadWritePaths=/var/lib/wazir');

writeFileSync(path.join(stagingDir, 'scripts/systemd/wazir-worker.service'), systemdWorker);
writeFileSync(path.join(stagingDir, 'scripts/systemd/wazir-api.service'), systemdApi);

const sourceTarball = path.join(rpmTopDir, 'SOURCES', `wazir-${version}.tar.gz`);
execSync(`tar -czf "${sourceTarball}" -C "${rpmTopDir}" "wazir-${version}"`, { stdio: 'inherit' });
rmSync(stagingDir, { recursive: true, force: true });
console.log(`✓ Source tarball created: ${sourceTarball}`);

// 2. Prepare Spec file in SPECS
const specContent = readFileSync(path.resolve(rootDir, 'packaging/rpm/wazir.spec'), 'utf8')
  .replace(/Version:\s+.*/, `Version:        ${version}`);
const targetSpec = path.join(rpmTopDir, 'SPECS/wazir.spec');
writeFileSync(targetSpec, specContent, 'utf8');
console.log(`✓ RPM spec created: ${targetSpec}`);

// 3. Execute rpmbuild if available
let rpmbuildAvailable = false;
try {
  execSync('which rpmbuild', { stdio: 'ignore' });
  rpmbuildAvailable = true;
} catch {}

if (rpmbuildAvailable) {
  console.log('\nRunning rpmbuild...');
  execSync(`rpmbuild --define "_topdir ${rpmTopDir}" -ba "${targetSpec}"`, { stdio: 'inherit' });
  console.log(`✓ RPM build complete in: ${path.join(rpmTopDir, 'RPMS')}`);
} else {
  console.log('\nℹ rpmbuild utility is not installed on this host.');
  console.log(`  To build the binary and source RPM on a Fedora/RHEL host, run:`);
  console.log(`  rpmbuild --define "_topdir ${rpmTopDir}" -ba "${targetSpec}"`);
}
