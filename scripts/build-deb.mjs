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
  'usr/libexec',
  'lib/systemd/system',
  'usr/lib/systemd/user',
  'usr/share/applications',
  'usr/share/dbus-1/services',
  'usr/share/gnome-shell/search-providers',
  'usr/share/nautilus-python/extensions',
  'usr/share/icons/hicolor/128x128/apps',
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
// /usr/bin/wa & /usr/bin/wazir
const launcherScript = `#!/bin/sh
exec node /usr/lib/wazir/wa.js "$@"
`;
writeFileSync(path.join(stagingDir, 'usr/bin/wa'), launcherScript, 'utf8');
chmodSync(path.join(stagingDir, 'usr/bin/wa'), 0o755);
writeFileSync(path.join(stagingDir, 'usr/bin/wazir'), launcherScript, 'utf8');
chmodSync(path.join(stagingDir, 'usr/bin/wazir'), 0o755);

const shellLauncherScript = `#!/bin/sh
if [ -x /usr/lib/wazir/wazir-shell-bin ] && { [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; }; then
  exec /usr/lib/wazir/wazir-shell-bin "$@"
fi
exec node /usr/lib/wazir/wa.js shell "$@"
`;
writeFileSync(path.join(stagingDir, 'usr/bin/wazir-shell'), shellLauncherScript, 'utf8');
chmodSync(path.join(stagingDir, 'usr/bin/wazir-shell'), 0o755);

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

// 4. Systemd services (never auto-enable self-improvement on install)
const systemdWorker = readFileSync(path.resolve(rootDir, 'scripts/systemd/wazir-worker.service'), 'utf8')
  .replace('/usr/bin/node /opt/wazir/apps/worker/dist/index.js', '/usr/bin/wa worker start')
  .replace('WorkingDirectory=/opt/wazir', 'WorkingDirectory=/var/lib/wazir')
  .replace('ReadWritePaths=/opt/wazir', 'ReadWritePaths=/var/lib/wazir');

const systemdApi = readFileSync(path.resolve(rootDir, 'scripts/systemd/wazir-api.service'), 'utf8')
  .replace('/usr/bin/node /opt/wazir/apps/api/dist/main.js', '/usr/bin/wa dashboard --no-open --host 0.0.0.0 --port 4800')
  .replace('WorkingDirectory=/opt/wazir', 'WorkingDirectory=/var/lib/wazir')
  .replace('ReadWritePaths=/opt/wazir', 'ReadWritePaths=/var/lib/wazir');

writeFileSync(path.join(stagingDir, 'lib/systemd/system/wazir-worker.service'), systemdWorker, 'utf8');
writeFileSync(path.join(stagingDir, 'lib/systemd/system/wazir-api.service'), systemdApi, 'utf8');
writeFileSync(path.join(stagingDir, 'usr/lib/systemd/user/wazir-worker.service'), systemdWorker, 'utf8');
writeFileSync(path.join(stagingDir, 'usr/lib/systemd/user/wazir-api.service'), systemdApi, 'utf8');

// 4b. Desktop entries and icons for GNOME/XDG
for (const desktopName of ['wazir-shell.desktop', 'wazir-mission-control.desktop', 'wazir.desktop']) {
  const src = path.resolve(rootDir, 'packaging/linux', desktopName);
  if (existsSync(src)) {
    writeFileSync(path.join(stagingDir, 'usr/share/applications', desktopName), readFileSync(src, 'utf8'), 'utf8');
  }
}
const icon128 = path.resolve(rootDir, 'apps/desktop/src-tauri/icons/128x128.png');
if (existsSync(icon128)) {
  writeFileSync(path.join(stagingDir, 'usr/share/icons/hicolor/128x128/apps/wazir-shell.png'), readFileSync(icon128));
  writeFileSync(path.join(stagingDir, 'usr/share/icons/hicolor/128x128/apps/wazir.png'), readFileSync(icon128));
}

// 4c. GNOME Search Provider, Nautilus Extension & Reversible Profile
const ubuntuRoot = path.resolve(rootDir, 'os/wazir-os-ubuntu');
if (existsSync(path.join(ubuntuRoot, 'gnome'))) {
  writeFileSync(
    path.join(stagingDir, 'usr/share/gnome-shell/search-providers/org.wazir.SearchProvider.ini'),
    readFileSync(path.join(ubuntuRoot, 'gnome/org.wazir.SearchProvider.ini'), 'utf8'),
    'utf8',
  );
  writeFileSync(
    path.join(stagingDir, 'usr/share/dbus-1/services/org.wazir.SearchProvider.service'),
    readFileSync(path.join(ubuntuRoot, 'gnome/org.wazir.SearchProvider.service'), 'utf8'),
    'utf8',
  );
  writeFileSync(
    path.join(stagingDir, 'usr/lib/systemd/user/wazir-gnome-search.service'),
    readFileSync(path.join(ubuntuRoot, 'gnome/wazir-gnome-search.service'), 'utf8'),
    'utf8',
  );
  const searchPy = path.join(stagingDir, 'usr/libexec/wazir-gnome-search.py');
  writeFileSync(searchPy, readFileSync(path.join(ubuntuRoot, 'gnome/wazir-gnome-search.py'), 'utf8'), 'utf8');
  chmodSync(searchPy, 0o755);
}
if (existsSync(path.join(ubuntuRoot, 'nautilus/wazir_nautilus_extension.py'))) {
  writeFileSync(
    path.join(stagingDir, 'usr/share/nautilus-python/extensions/wazir_nautilus_extension.py'),
    readFileSync(path.join(ubuntuRoot, 'nautilus/wazir_nautilus_extension.py'), 'utf8'),
    'utf8',
  );
}
if (existsSync(path.join(ubuntuRoot, 'profile/wazir-gnome-profile.sh'))) {
  const profDst = path.join(stagingDir, 'usr/lib/wazir/wazir-gnome-profile.sh');
  writeFileSync(profDst, readFileSync(path.join(ubuntuRoot, 'profile/wazir-gnome-profile.sh'), 'utf8'), 'utf8');
  chmodSync(profDst, 0o755);
}

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
  console.log(`dpkg-deb not available; assembling ar .deb archive -> ${debFile}...`);
  const arWorkDir = path.join(debOutputDir, `ar-work-${version}`);
  rmSync(arWorkDir, { recursive: true, force: true });
  mkdirSync(arWorkDir, { recursive: true });
  writeFileSync(path.join(arWorkDir, 'debian-binary'), '2.0\n', 'utf8');
  execSync(`tar -czf "${path.join(arWorkDir, 'control.tar.gz')}" -C "${path.join(stagingDir, 'DEBIAN')}" .`, { stdio: 'inherit' });
  execSync(`tar --exclude='./DEBIAN' -czf "${path.join(arWorkDir, 'data.tar.gz')}" -C "${stagingDir}" .`, { stdio: 'inherit' });
  rmSync(debFile, { force: true });
  execSync(`ar rcs "${debFile}" "${path.join(arWorkDir, 'debian-binary')}" "${path.join(arWorkDir, 'control.tar.gz')}" "${path.join(arWorkDir, 'data.tar.gz')}"`, { stdio: 'inherit' });
  rmSync(arWorkDir, { recursive: true, force: true });
}

if (existsSync(debFile)) {
  const distDeb = path.resolve(rootDir, `dist/wazir_${version}_all.deb`);
  writeFileSync(distDeb, readFileSync(debFile));
  console.log(`✓ Debian package created: ${debFile} (and ${distDeb})`);
  if (dpkgAvailable) {
    try {
      const info = execSync(`dpkg-deb -I "${debFile}"`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      console.log('\nPackage information:');
      console.log(info.split('\n').slice(0, 10).join('\n'));
    } catch {}
  }
}
