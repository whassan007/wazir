#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORTAL = path.join(ROOT, 'apps/portal');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version || '0.3.2';

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

// 4. Collect release artifacts & compute SHA-256
const candidates = [
  { file: `Wazir-Shell-${version}-macos-arm64.tar.gz`, platform: 'macOS Apple Silicon (Wazir Shell.app)', arch: 'arm64', signing: 'Unsigned development build (Apple Developer ID not configured)', license: 'AGPL-3.0-only' },
  { file: `Wazir-Mission-Control-${version}-macos-arm64.tar.gz`, platform: 'macOS Apple Silicon (Mission Control.app)', arch: 'arm64', signing: 'Unsigned development build (Apple Developer ID not configured)', license: 'AGPL-3.0-only' },
  { file: `wazir-cli-${version}-any.tar.gz`, platform: 'Universal CLI (macOS / Linux / Termux ARM64)', arch: 'x86_64 / arm64', signing: 'SHA-256 verified bundle', license: 'AGPL-3.0-only' },
  { file: `wazir_${version}_all.deb`, platform: 'Debian / Ubuntu (.deb)', arch: 'all (x86_64 / arm64)', signing: 'SHA-256 verified (built on Ubuntu 24.04 aarch64)', license: 'AGPL-3.0-only' },
  { file: `rpmbuild/SOURCES/wazir-${version}.tar.gz`, platform: 'Linux Source Tarball & RPM Spec', arch: 'x86_64 / arm64', signing: 'SHA-256 verified', license: 'AGPL-3.0-only' },
  { file: `wazir-mobile-${version}-android-debug.apk`, platform: 'GrapheneOS / Android Companion (APK)', arch: 'arm64-v8a / universal', signing: 'Debug key (unsigned release)', license: 'AGPL-3.0-only' },
];

const artifacts = [];
const shaLines = [];

for (const c of candidates) {
  const full = path.join(DIST, c.file);
  if (!fs.existsSync(full)) continue;
  const buf = fs.readFileSync(full);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const basename = path.basename(full);
  const sizeHuman = `${(buf.length / (1024 * 1024)).toFixed(2)} MB`;
  shaLines.push(`${sha256}  ${c.file}`);
  // Copy smaller/CLI artifacts into portal/releases if <= 20MB (Cloudflare Pages 25MB per-file limit)
  let url = `https://github.com/whassan007/wazir/releases/tag/v${version}`;
  if (buf.length <= 20 * 1024 * 1024) {
    fs.copyFileSync(full, path.join(PORTAL, 'releases', basename));
    url = `/releases/${basename}`;
  }
  artifacts.push({
    filename: basename,
    platform: c.platform,
    arch: c.arch,
    sizeBytes: buf.length,
    sizeHuman,
    sha256,
    signing: c.signing,
    license: c.license,
    url,
  });
}

fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), `${shaLines.join('\n')}\n`);
fs.copyFileSync(path.join(DIST, 'SHA256SUMS.txt'), path.join(PORTAL, 'releases/SHA256SUMS.txt'));

const manifest = {
  name: 'Wazir AI OS',
  version,
  releasedAt: new Date().toISOString(),
  repository: 'https://github.com/whassan007/wazir',
  artifacts,
};
fs.writeFileSync(path.join(DIST, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
fs.writeFileSync(path.join(PORTAL, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// 5. Generate minimal CycloneDX SBOM
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      name: 'wazir',
      version,
      type: 'application',
      licenses: [{ license: { id: 'AGPL-3.0-only' } }],
    },
  },
  components: Object.entries(pkg.devDependencies || {}).map(([name, ver]) => ({
    type: 'library',
    name,
    version: String(ver),
  })),
};
fs.writeFileSync(path.join(DIST, 'sbom.cdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);

console.log(`Generated release manifest (${artifacts.length} artifacts), SHA256SUMS.txt, and sbom.cdx.json.`);
