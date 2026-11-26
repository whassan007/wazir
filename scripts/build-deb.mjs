#!/usr/bin/env node
/**
 * scripts/build-deb.mjs
 *
 * Builds Debian/Ubuntu packages (.deb) for Wazir (contract C2,
 * reports/v0.4.3/INTEGRATION-CONTRACTS.md).
 *
 * Usage:
 *   node scripts/build-deb.mjs                                   # CLI-only, Architecture: all
 *   node scripts/build-deb.mjs --arch arm64 --shell-bin <path>   # per-arch, ships native GUI
 *   node scripts/build-deb.mjs --arch amd64 --shell-bin <path> --version 0.4.3
 *
 * Options:
 *   --arch <all|arm64|amd64>  Debian architecture (default: all). Non-`all` requires --shell-bin.
 *   --shell-bin <path>        Linux ELF of apps/shell (Tauri v2) built for --arch; installed at
 *                             /usr/lib/wazir/wazir-shell-bin.
 *   --version <x.y.z>         Package version (default: root package.json "version"). Lets a
 *                             release be packaged before package.json files are bumped.
 *   --out-dir <dir>           Output directory for the final .deb (default: <repo>/dist).
 *
 * Output: <out-dir>/wazir_<version>_<arch>.deb (staging under dist/deb/).
 *
 * Layout:
 *  - /usr/bin/wa, /usr/bin/wazir           -> node /usr/lib/wazir/wa.js
 *  - /usr/bin/wazir-shell                  -> GUI (/usr/lib/wazir/wazir-shell-bin) or terminal fallback
 *  - /usr/lib/wazir/wazir-shell-terminal   -> helper run inside x-terminal-emulator
 *  - /lib/systemd/system/*.service         -> system units (User=wazir), never enabled on install
 *  - /usr/lib/systemd/user/*.service       -> generated user units (%h paths, default.target)
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync, existsSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { arch: 'all', shellBin: undefined, version: undefined, outDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${flag}`);
      return v;
    };
    switch (flag) {
      case '--arch': out.arch = value(); break;
      case '--shell-bin': out.shellBin = value(); break;
      case '--version': out.version = value(); break;
      case '--out-dir': out.outDir = value(); break;
      case '-h':
      case '--help':
        console.log(readFileSync(__filename, 'utf8').split('\n').slice(1, 29).join('\n'));
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument '${a}'`);
    }
  }
  return out;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`build-deb: ${err.message}`);
  process.exit(2);
}

const SUPPORTED_ARCHES = ['all', 'arm64', 'amd64'];
if (!SUPPORTED_ARCHES.includes(args.arch)) {
  console.error(`build-deb: --arch must be one of ${SUPPORTED_ARCHES.join(', ')} (got '${args.arch}')`);
  process.exit(2);
}
const arch = args.arch;
const shipsGui = arch !== 'all';
if (shipsGui && !args.shellBin) {
  console.error(`build-deb: --arch ${arch} requires --shell-bin <path to Linux ${arch} wazir-shell ELF>`);
  process.exit(2);
}
if (!shipsGui && args.shellBin) {
  console.error('build-deb: --shell-bin requires --arch arm64|amd64 (the `all` package is CLI-only)');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
const version = args.version ?? pkg.version;
if (!/^[0-9][A-Za-z0-9.+~-]*$/.test(version)) {
  console.error(`build-deb: invalid Debian version '${version}'`);
  process.exit(2);
}

// Validate the GUI binary: must be an ELF for the requested machine.
let shellBinPath;
if (shipsGui) {
  shellBinPath = path.resolve(process.cwd(), args.shellBin);
  if (!existsSync(shellBinPath) || !statSync(shellBinPath).isFile()) {
    console.error(`build-deb: --shell-bin '${shellBinPath}' does not exist`);
    process.exit(2);
  }
  const head = readFileSync(shellBinPath).subarray(0, 20);
  if (head.length < 20 || head.readUInt32BE(0) !== 0x7f454c46) {
    console.error(`build-deb: --shell-bin '${shellBinPath}' is not an ELF binary`);
    process.exit(2);
  }
  const eMachine = head.readUInt16LE(18);
  const expected = { arm64: 0xb7 /* EM_AARCH64 */, amd64: 0x3e /* EM_X86_64 */ }[arch];
  if (eMachine !== expected) {
    console.error(`build-deb: --shell-bin ELF e_machine=0x${eMachine.toString(16)} does not match --arch ${arch} (expected 0x${expected.toString(16)})`);
    process.exit(2);
  }
}

console.log(`==> Building Debian (.deb) package for Wazir v${version} (${arch}${shipsGui ? ', native GUI' : ', CLI-only'})...`);

// Ensure bundle exists
const waBundle = path.resolve(rootDir, 'bin/wa.js');
if (!existsSync(waBundle)) {
  console.log('Generating CLI bundle first...');
  execSync('node scripts/bundle.mjs', { cwd: rootDir, stdio: 'inherit' });
}

const debOutputDir = path.resolve(rootDir, 'dist/deb');
const stagingDir = path.resolve(debOutputDir, `wazir_${version}_${arch}`);
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
// Runtime libraries the Tauri v2 binary links directly (readelf -d NEEDED on the
// Ubuntu 24.04 arm64 build). Alternatives cover the 24.04 t64 renames.
const GUI_DEPENDS = [
  'libwebkit2gtk-4.1-0',
  'libjavascriptcoregtk-4.1-0',
  'libgtk-3-0t64 | libgtk-3-0',
  'libsoup-3.0-0',
  'libglib2.0-0t64 | libglib2.0-0',
  'libdbus-1-3',
];
// python3-dbus/python3-gi: GNOME search provider; python3-nautilus: Nautilus extension;
// dconf-cli: reversible GNOME profile script (contract C2 change request from Agent 03).
const DESKTOP_INTEGRATION_RECOMMENDS = ['python3-dbus', 'python3-gi', 'python3-nautilus', 'dconf-cli'];
const GUI_RECOMMENDS = ['libayatana-appindicator3-1', 'libsecret-1-0', 'libnotify-bin', 'xdg-utils', ...DESKTOP_INTEGRATION_RECOMMENDS];
const CLI_RECOMMENDS = ['libwebkit2gtk-4.1-0', 'libgtk-3-0t64 | libgtk-3-0', ...GUI_RECOMMENDS];

function setField(text, field, value) {
  const re = new RegExp(`^${field}: .*$`, 'm');
  return re.test(text) ? text.replace(re, `${field}: ${value}`) : text.replace(/^(Description: )/m, `${field}: ${value}\n$1`);
}

let control = readFileSync(path.resolve(rootDir, 'packaging/deb/debian/control'), 'utf8');
const baseDepends = (control.match(/^Depends: (.*)$/m)?.[1] ?? '').trim();
control = setField(control, 'Version', version);
control = setField(control, 'Architecture', arch);
if (shipsGui) {
  // GUI libraries move from Recommends to Depends: the arch package ships the binary that links them.
  control = setField(control, 'Depends', [baseDepends, ...GUI_DEPENDS].filter(Boolean).join(', '));
  control = setField(control, 'Recommends', GUI_RECOMMENDS.join(', '));
} else {
  control = setField(control, 'Recommends', CLI_RECOMMENDS.join(', '));
}
if (!control.endsWith('\n')) control += '\n';
writeFileSync(path.join(stagingDir, 'DEBIAN/control'), control, 'utf8');

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

// /usr/bin/wazir-shell — contract C1 launcher. Arguments are always forwarded as
// "$@" (never re-joined or passed through `sh -c`).
const shellLauncherScript = readFileSync(path.resolve(rootDir, 'packaging/linux/wazir-shell.sh'), 'utf8');
writeFileSync(path.join(stagingDir, 'usr/bin/wazir-shell'), shellLauncherScript, 'utf8');
chmodSync(path.join(stagingDir, 'usr/bin/wazir-shell'), 0o755);
const terminalHelper = readFileSync(path.resolve(rootDir, 'packaging/linux/wazir-shell-terminal.sh'), 'utf8');
writeFileSync(path.join(stagingDir, 'usr/lib/wazir/wazir-shell-terminal'), terminalHelper, 'utf8');
chmodSync(path.join(stagingDir, 'usr/lib/wazir/wazir-shell-terminal'), 0o755);

// /usr/lib/wazir/wazir-shell-bin (per-arch packages only)
if (shipsGui) {
  const dst = path.join(stagingDir, 'usr/lib/wazir/wazir-shell-bin');
  copyFileSync(shellBinPath, dst);
  chmodSync(dst, 0o755);
}

// /usr/lib/wazir/wa.js
writeFileSync(path.join(stagingDir, 'usr/lib/wazir/wa.js'), readFileSync(waBundle, 'utf8'), 'utf8');
chmodSync(path.join(stagingDir, 'usr/lib/wazir/wa.js'), 0o755);

// /usr/lib/wazir/package.json
const minPkg = {
  name: pkg.name,
  version,
  description: pkg.description,
  license: pkg.license,
  author: pkg.author,
  main: 'wa.js',
};
writeFileSync(path.join(stagingDir, 'usr/lib/wazir/package.json'), JSON.stringify(minPkg, null, 2), 'utf8');

// 4. Systemd services (never auto-enabled by maintainer scripts; self-improvement
// has no unit at all and is only started explicitly by the user).
const systemdWorker = readFileSync(path.resolve(rootDir, 'scripts/systemd/wazir-worker.service'), 'utf8')
  .replace('/usr/bin/node /opt/wazir/apps/worker/dist/index.js', '/usr/bin/wa worker start')
  .replace('WorkingDirectory=/opt/wazir', 'WorkingDirectory=/var/lib/wazir')
  .replace('ReadWritePaths=/opt/wazir', 'ReadWritePaths=/var/lib/wazir');

const systemdApi = readFileSync(path.resolve(rootDir, 'scripts/systemd/wazir-api.service'), 'utf8')
  .replace('/usr/bin/node /opt/wazir/apps/api/dist/main.js', '/usr/bin/wa dashboard --no-open --host 0.0.0.0 --port 4800')
  .replace('WorkingDirectory=/opt/wazir', 'WorkingDirectory=/var/lib/wazir')
  .replace('ReadWritePaths=/opt/wazir', 'ReadWritePaths=/var/lib/wazir');

/**
 * Derives a systemd *user* unit from a system unit: drops directives that are
 * invalid or meaningless for `systemd --user` (User/Group, ProtectSystem,
 * ReadWritePaths, PrivateTmp, the system WorkingDirectory, and
 * network-online.target, which does not exist in the user manager), moves state
 * under %h, binds the API to loopback, and installs into default.target.
 */
function toUserUnit(systemUnit) {
  const dropKeys = new Set(['User', 'Group', 'ProtectSystem', 'ReadWritePaths', 'PrivateTmp', 'WorkingDirectory']);
  const lines = [];
  for (const raw of systemUnit.split('\n')) {
    const line = raw.trimEnd();
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      lines.push(line);
      if (sec[1] === 'Service') {
        lines.push('WorkingDirectory=%h');
        lines.push('Environment=WAZIR_HOME=%h/.wazir');
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z]+)=(.*)$/);
    if (kv) {
      const [, key, value] = kv;
      if (dropKeys.has(key)) continue;
      if ((key === 'After' || key === 'Wants') && value.includes('network-online.target')) continue;
      if (key === 'WantedBy') { lines.push('WantedBy=default.target'); continue; }
      if (key === 'Environment' && value.startsWith('WAZIR_HOST=')) { lines.push('Environment=WAZIR_HOST=127.0.0.1'); continue; }
      if (key === 'ExecStart') { lines.push(`ExecStart=${value.replace('--host 0.0.0.0', '--host 127.0.0.1')}`); continue; }
    }
    if (/^# (Basic hardening|Adjust both paths)/.test(line)) continue;
    lines.push(line);
  }
  const header =
    '# Generated by scripts/build-deb.mjs from the system unit, for `systemctl --user`.\n' +
    '# Not enabled by the package. Opt in per user: systemctl --user enable --now <unit>\n';
  return header + lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

writeFileSync(path.join(stagingDir, 'lib/systemd/system/wazir-worker.service'), systemdWorker, 'utf8');
writeFileSync(path.join(stagingDir, 'lib/systemd/system/wazir-api.service'), systemdApi, 'utf8');
writeFileSync(path.join(stagingDir, 'usr/lib/systemd/user/wazir-worker.service'), toUserUnit(systemdWorker), 'utf8');
writeFileSync(path.join(stagingDir, 'usr/lib/systemd/user/wazir-api.service'), toUserUnit(systemdApi), 'utf8');

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

// 4c. GNOME Search Provider, Nautilus Extension & Reversible Profile (owned by os/wazir-os-ubuntu)
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

// Normalize modes independent of the build host's umask: dirs 0755, executables
// 0755, everything else 0644 (dpkg/lintian expectations).
function normalizeModes(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      chmodSync(p, 0o755);
      normalizeModes(p);
    } else if (entry.isFile()) {
      chmodSync(p, statSync(p).mode & 0o100 ? 0o755 : 0o644);
    }
  }
}
chmodSync(stagingDir, 0o755);
normalizeModes(stagingDir);

// 6. Build .deb package
const debFile = path.resolve(debOutputDir, `wazir_${version}_${arch}.deb`);

let dpkgAvailable = false;
try {
  execSync('command -v dpkg-deb', { stdio: 'ignore', shell: '/bin/sh' });
  dpkgAvailable = true;
} catch {}

if (dpkgAvailable) {
  console.log(`Building package using dpkg-deb -> ${debFile}...`);
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', stagingDir, debFile], { stdio: 'inherit' });
} else {
  // Fallback (e.g. macOS): plain `ar` (no symbol index) with root-owned, metadata-free tarballs.
  console.log(`dpkg-deb not available; assembling ar .deb archive -> ${debFile}...`);
  const arWorkDir = path.join(debOutputDir, `ar-work-${version}-${arch}`);
  rmSync(arWorkDir, { recursive: true, force: true });
  mkdirSync(arWorkDir, { recursive: true });
  writeFileSync(path.join(arWorkDir, 'debian-binary'), '2.0\n', 'utf8');
  const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
  const ownerFlags = ['--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root'];
  execFileSync('tar', [...ownerFlags, '-czf', path.join(arWorkDir, 'control.tar.gz'), '-C', path.join(stagingDir, 'DEBIAN'), '.'], { stdio: 'inherit', env: tarEnv });
  execFileSync('tar', [...ownerFlags, '--exclude', './DEBIAN', '-czf', path.join(arWorkDir, 'data.tar.gz'), '-C', stagingDir, '.'], { stdio: 'inherit', env: tarEnv });
  rmSync(debFile, { force: true });
  // Write the System V `ar` container directly: BSD/macOS `ar` injects a
  // __.SYMDEF member that dpkg rejects.
  const members = ['debian-binary', 'control.tar.gz', 'data.tar.gz'];
  const parts = [Buffer.from('!<arch>\n', 'ascii')];
  const mtime = Math.floor(Date.now() / 1000);
  for (const name of members) {
    const data = readFileSync(path.join(arWorkDir, name));
    const header =
      `${name}/`.padEnd(16) + String(mtime).padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(data.length).padEnd(10) + '`\n';
    parts.push(Buffer.from(header, 'ascii'), data);
    if (data.length % 2 === 1) parts.push(Buffer.from('\n', 'ascii'));
  }
  writeFileSync(debFile, Buffer.concat(parts));
  rmSync(arWorkDir, { recursive: true, force: true });
}

if (existsSync(debFile)) {
  const outDir = path.resolve(process.cwd(), args.outDir ?? path.resolve(rootDir, 'dist'));
  mkdirSync(outDir, { recursive: true });
  const distDeb = path.join(outDir, `wazir_${version}_${arch}.deb`);
  copyFileSync(debFile, distDeb);
  console.log(`✓ Debian package created: ${debFile} (and ${distDeb})`);
  if (dpkgAvailable) {
    try {
      const info = execFileSync('dpkg-deb', ['-I', debFile], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      console.log('\nPackage information:');
      console.log(info.split('\n').slice(0, 16).join('\n'));
    } catch {}
  }
}
