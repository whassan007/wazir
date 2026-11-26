#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORTAL = path.join(ROOT, 'apps/portal');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
if (!version) {
  throw new Error('package.json is missing version');
}

let sourceCommit = 'unknown';
try {
  sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch {
  // ignore outside git checkout
}

fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(path.join(PORTAL, 'releases'), { recursive: true });

// 1. Archive macOS .app bundles if present
const shellApp = path.join(ROOT, 'apps/shell/src-tauri/target/release/bundle/macos/Wazir Shell.app');
if (fs.existsSync(shellApp)) {
  const out = path.join(DIST, `Wazir-Shell-${version}-macos-arm64.tar.gz`);
  execSync(`tar -czf "${out}" -C "${path.dirname(shellApp)}" "Wazir Shell.app"`, { stdio: 'inherit' });
}

const mcApp = path.join(ROOT, 'apps/desktop/src-tauri/target/release/bundle/macos/Wazir Mission Control.app');
if (fs.existsSync(mcApp)) {
  const out = path.join(DIST, `Wazir-Mission-Control-${version}-macos-arm64.tar.gz`);
  execSync(`tar -czf "${out}" -C "${path.dirname(mcApp)}" "Wazir Mission Control.app"`, { stdio: 'inherit' });
}

// 2. CLI standalone bundle archive
const waJs = path.join(ROOT, 'bin/wa.js');
if (fs.existsSync(waJs)) {
  const out = path.join(DIST, `wazir-cli-${version}-any.tar.gz`);
  execSync(`tar -czf "${out}" -C "${ROOT}" bin/wa.js LICENSE NOTICE AUTHORS`, { stdio: 'inherit' });
}

// 3. Android debug APK if built
const debugApk = path.join(ROOT, 'apps/android/app/build/outputs/apk/debug/app-debug.apk');
if (fs.existsSync(debugApk)) {
  fs.copyFileSync(debugApk, path.join(DIST, `wazir-mobile-${version}-android-debug.apk`));
}

// 4. Collect release artifacts & compute SHA-256 (never equating SHA-256 with publisher signing)
const candidates = [
  {
    file: `Wazir-Shell-${version}-macos-arm64.tar.gz`,
    artifactType: 'app-bundle',
    os: 'macos',
    platform: 'macOS Apple Silicon (Wazir Shell.app)',
    arch: 'arm64',
    channel: 'development',
    requirements: 'macOS 14+ (Apple Silicon); xattr -cr required for unsigned bundle',
    signingStatus: 'unsigned',
    signing: 'Unsigned development build (Apple Developer ID not configured)',
    installCommand: `tar -xzf Wazir-Shell-${version}-macos-arm64.tar.gz -C /Applications && xattr -cr "/Applications/Wazir Shell.app"`,
    verifyCommand: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`,
    license: 'AGPL-3.0-only',
  },
  {
    file: `Wazir-Mission-Control-${version}-macos-arm64.tar.gz`,
    artifactType: 'app-bundle',
    os: 'macos',
    platform: 'macOS Apple Silicon (Mission Control.app)',
    arch: 'arm64',
    channel: 'development',
    requirements: 'macOS 14+ (Apple Silicon); Node.js >= 22.13.0 for local API/Web',
    signingStatus: 'unsigned',
    signing: 'Unsigned development build (Apple Developer ID not configured)',
    installCommand: `tar -xzf Wazir-Mission-Control-${version}-macos-arm64.tar.gz -C /Applications && xattr -cr "/Applications/Wazir Mission Control.app"`,
    verifyCommand: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`,
    license: 'AGPL-3.0-only',
  },
  {
    file: `wazir-cli-${version}-any.tar.gz`,
    artifactType: 'cli-archive',
    os: 'universal',
    platform: 'Universal CLI (macOS / Linux / Termux ARM64)',
    arch: 'x86_64 / arm64',
    channel: 'preview',
    requirements: 'Node.js >= 22.13.0',
    signingStatus: 'unsigned',
    signing: 'Unsigned archive (SHA-256 integrity checksum only)',
    installCommand: `tar -xzf wazir-cli-${version}-any.tar.gz && node bin/wa.js about && node bin/wa.js doctor`,
    verifyCommand: `shasum -a 256 -c SHA256SUMS.txt --ignore-missing`,
    license: 'AGPL-3.0-only',
  },
  {
    file: `wazir_${version}_arm64.deb`,
    artifactType: 'deb',
    os: 'linux',
    platform: 'Debian / Ubuntu ARM64 (.deb + native wazir-shell GUI)',
    arch: 'arm64',
    channel: 'preview',
    requirements: 'Ubuntu 22.04+/Debian 12+ (arm64), Node.js >= 22.13.0',
    signingStatus: 'unsigned',
    signing: 'Unsigned .deb (SHA-256 checksum only)',
    installCommand: `sudo dpkg -i wazir_${version}_arm64.deb && wa about && wa doctor`,
    verifyCommand: `sha256sum -c SHA256SUMS.txt --ignore-missing`,
    license: 'AGPL-3.0-only',
  },
  {
    file: `wazir_${version}_all.deb`,
    artifactType: 'deb',
    os: 'linux',
    platform: 'Debian / Ubuntu (.deb)',
    arch: 'all (x86_64 / arm64)',
    channel: 'preview',
    requirements: 'Ubuntu 24.04+ / Debian 12+, nodejs >= 22.13.0',
    signingStatus: 'unsigned',
    signing: 'Unsigned .deb package (SHA-256 integrity checksum only)',
    installCommand: `sudo dpkg -i wazir_${version}_all.deb && wa about && wa doctor`,
    verifyCommand: `sha256sum -c SHA256SUMS.txt --ignore-missing`,
    license: 'AGPL-3.0-only',
  },
  {
    file: `rpmbuild/SOURCES/wazir-${version}.tar.gz`,
    artifactType: 'source-tarball',
    os: 'linux',
    platform: 'Linux Source Tarball & RPM Spec',
    arch: 'x86_64 / arm64',
    channel: 'preview',
    requirements: 'Fedora / RHEL, rpmbuild, nodejs >= 22.13.0',
    signingStatus: 'unsigned',
    signing: 'Unsigned source tarball (SHA-256 integrity checksum only)',
    installCommand: `rpmbuild -tb wazir-${version}.tar.gz`,
    verifyCommand: `sha256sum -c SHA256SUMS.txt --ignore-missing`,
    license: 'AGPL-3.0-only',
  },
  {
    file: `wazir-mobile-${version}-android-debug.apk`,
    artifactType: 'apk',
    os: 'android',
    platform: 'GrapheneOS / Android Companion (APK)',
    arch: 'arm64-v8a / universal',
    channel: 'development',
    requirements: 'Android 8.0+ / GrapheneOS (API 26-35), zero root',
    signingStatus: 'debug-signed',
    signing: 'Debug-key signed (development evaluation only; not Play/release signed)',
    installCommand: `adb install -r wazir-mobile-${version}-android-debug.apk`,
    verifyCommand: `sha256sum -c SHA256SUMS.txt --ignore-missing`,
    license: 'AGPL-3.0-only',
  },
];

const generatedAt = new Date().toISOString();
const artifacts = [];
const shaLines = [];
const activePortalFiles = new Set(['SHA256SUMS.txt', 'sbom.cdx.json']);

for (const c of candidates) {
  const full = path.join(DIST, c.file);
  if (!fs.existsSync(full)) continue;
  const buf = fs.readFileSync(full);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const basename = path.basename(full);
  if (!basename.includes(version)) {
    throw new Error(`Version mismatch: artifact '${basename}' does not match package.json version '${version}'`);
  }
  const sizeHuman = `${(buf.length / (1024 * 1024)).toFixed(2)} MB`;
  shaLines.push(`${sha256}  ${basename}`);
  // Copy artifacts <= 24MB into portal/releases (Cloudflare Pages 25MB per-file limit)
  let url = `https://github.com/whassan007/wazir/releases/tag/v${version}`;
  if (buf.length <= 24 * 1024 * 1024) {
    fs.copyFileSync(full, path.join(PORTAL, 'releases', basename));
    activePortalFiles.add(basename);
    url = `/releases/${basename}`;
  }
  artifacts.push({
    filename: basename,
    artifactType: c.artifactType,
    os: c.os,
    platform: c.platform,
    arch: c.arch,
    channel: c.channel,
    requirements: c.requirements,
    sizeBytes: buf.length,
    sizeHuman,
    sha256,
    integrity: 'sha256',
    signingStatus: c.signingStatus,
    signing: c.signing,
    license: c.license,
    url,
    installCommand: c.installCommand,
    verifyCommand: c.verifyCommand,
    provenance: {
      version,
      sourceCommit,
      generatedAt,
    },
  });
}

// Prune stale/version-mismatched files from apps/portal/releases/
for (const entry of fs.readdirSync(path.join(PORTAL, 'releases'))) {
  if (!activePortalFiles.has(entry)) {
    fs.rmSync(path.join(PORTAL, 'releases', entry), { force: true });
  }
}

fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), `${shaLines.join('\n')}\n`);
fs.copyFileSync(path.join(DIST, 'SHA256SUMS.txt'), path.join(PORTAL, 'releases/SHA256SUMS.txt'));

const modelManifestPath = path.join(ROOT, 'assets/models/wazir-shell-mini/manifest.json');
const embeddedModelManifest = fs.existsSync(modelManifestPath)
  ? JSON.parse(fs.readFileSync(modelManifestPath, 'utf8'))
  : undefined;

const manifest = {
  name: 'Wazir AI OS',
  version,
  sourceCommit,
  releasedAt: generatedAt,
  repository: 'https://github.com/whassan007/wazir',
  checksumsUrl: '/releases/SHA256SUMS.txt',
  sbomUrl: '/releases/sbom.cdx.json',
  ...(embeddedModelManifest ? { bundledModel: embeddedModelManifest } : {}),
  artifacts,
};
fs.writeFileSync(path.join(DIST, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(PORTAL, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 5. Generate CycloneDX 1.5 SBOM from resolved package-lock.json, Cargo.lock, and bundled assets
const sbomComponents = [];
const seenPurls = new Set();

const lockPath = path.join(ROOT, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  for (const [pkgPath, entry] of Object.entries(lock.packages || {})) {
    if (!pkgPath || entry.dev) continue;
    const name = entry.name || pkgPath.replace(/^node_modules\//, '');
    const ver = entry.version;
    if (!name || !ver) continue;
    const purl = `pkg:npm/${name.startsWith('@') ? name.replace('/', '%2F') : name}@${ver}`;
    if (seenPurls.has(purl)) continue;
    seenPurls.add(purl);
    sbomComponents.push({
      type: 'library',
      name,
      version: ver,
      purl,
      ...(entry.license ? { licenses: [{ license: { id: String(entry.license) } }] } : {}),
    });
  }
}

for (const cargoLockRel of ['apps/shell/src-tauri/Cargo.lock', 'apps/desktop/src-tauri/Cargo.lock']) {
  const cargoLockPath = path.join(ROOT, cargoLockRel);
  if (!fs.existsSync(cargoLockPath)) continue;
  const raw = fs.readFileSync(cargoLockPath, 'utf8');
  const blocks = raw.split('[[package]]').slice(1);
  for (const block of blocks) {
    const nameMatch = /^name\s*=\s*"([^"]+)"/m.exec(block);
    const verMatch = /^version\s*=\s*"([^"]+)"/m.exec(block);
    if (!nameMatch || !verMatch) continue;
    const purl = `pkg:cargo/${nameMatch[1]}@${verMatch[1]}`;
    if (seenPurls.has(purl)) continue;
    seenPurls.add(purl);
    sbomComponents.push({
      type: 'library',
      name: nameMatch[1],
      version: verMatch[1],
      purl,
    });
  }
}

if (embeddedModelManifest?.modelArtifact) {
  sbomComponents.push({
    type: 'machine-learning-model',
    name: embeddedModelManifest.wazirModelId || 'wazir-shell-mini',
    version: embeddedModelManifest.upstream?.pinnedRevision || version,
    hashes: [{ alg: 'SHA-256', content: embeddedModelManifest.modelArtifact.sha256 }],
  });
}

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: generatedAt,
    component: {
      name: 'wazir',
      version,
      type: 'application',
      licenses: [{ license: { id: 'AGPL-3.0-only' } }],
    },
  },
  components: sbomComponents,
};
fs.writeFileSync(path.join(DIST, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);
fs.copyFileSync(path.join(DIST, 'sbom.cdx.json'), path.join(PORTAL, 'releases/sbom.cdx.json'));

console.log(`Generated release manifest (${artifacts.length} artifacts), SHA256SUMS.txt, and sbom.cdx.json (${sbomComponents.length} resolved components).`);
