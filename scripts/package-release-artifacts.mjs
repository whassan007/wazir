#!/usr/bin/env node
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const pkg = JSON.parse(readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;

const releaseDir = path.resolve(rootDir, 'dist/release');
if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
}

console.log(`==> Packaging release artifacts for Wazir v${version}...`);

// Determine target platform-arch
const platformMap = {
  linux: 'linux',
  darwin: 'darwin',
  win32: 'windows',
};
const archMap = {
  x64: 'x64',
  arm64: 'arm64',
};
const currentPlatform = platformMap[process.platform] || process.platform;
const currentArch = archMap[process.arch] || process.arch;
const targetId = `${currentPlatform}-${currentArch}`;

// 1. Build binary for current platform
console.log(`\n--- 1. Building standalone binary for ${targetId} ---`);
execSync('node scripts/build-binary.mjs', { cwd: rootDir, stdio: 'inherit' });

const binaryName = process.platform === 'win32' ? 'wa.exe' : 'wa';
const binaryPath = path.resolve(rootDir, 'dist', binaryName);

if (!existsSync(binaryPath)) {
  console.error(`✗ Expected binary at ${binaryPath} was not found!`);
  process.exit(1);
}

// 2. Create archive
const archiveBasename = `wazir-v${version}-${targetId}`;
const stagingDir = path.resolve(releaseDir, archiveBasename);
if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

copyFileSync(binaryPath, path.resolve(stagingDir, binaryName));
copyFileSync(path.resolve(rootDir, 'README.md'), path.resolve(stagingDir, 'README.md'));
copyFileSync(path.resolve(rootDir, 'LICENSE'), path.resolve(stagingDir, 'LICENSE'));

if (process.platform === 'win32') {
  const zipFile = path.resolve(releaseDir, `${archiveBasename}.zip`);
  console.log(`Creating ${zipFile}...`);
  // Use PowerShell Compress-Archive
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${stagingDir}\\*' -DestinationPath '${zipFile}' -Force"`, { stdio: 'inherit' });
} else {
  const tarFile = path.resolve(releaseDir, `${archiveBasename}.tar.gz`);
  console.log(`Creating ${tarFile}...`);
  execSync(`tar -czf "${tarFile}" -C "${releaseDir}" "${archiveBasename}"`, { stdio: 'inherit' });
}
rmSync(stagingDir, { recursive: true, force: true });

// 3. Package npm tarball
console.log('\n--- 2. Packaging npm distribution tarball ---');
execSync(`npm pack --pack-destination="${releaseDir}"`, { cwd: rootDir, stdio: 'inherit' });

// 4. Generate SBOM
console.log('\n--- 3. Generating Software Bill of Materials (SBOM) ---');
const sbomPath = path.resolve(releaseDir, `wazir-v${version}-sbom.json`);
try {
  const sbomRaw = execSync('npm sbom --sbom-format cyclonedx', { cwd: rootDir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  writeFileSync(sbomPath, sbomRaw);
  console.log(`✓ SBOM written to ${sbomPath}`);
} catch (err) {
  console.warn(`! npm sbom generation failed: ${err.message}`);
}

// 5. Compute SHA-256 checksums
console.log('\n--- 4. Computing SHA-256 checksums ---');
const releaseFiles = readdirSync(releaseDir).filter(f => !f.endsWith('.txt') && !f.endsWith('.sha256'));
const checksums = [];

for (const file of releaseFiles.sort()) {
  const filePath = path.resolve(releaseDir, file);
  const data = readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  checksums.push(`${hash}  ${file}`);
  writeFileSync(`${filePath}.sha256`, `${hash}  ${file}\n`);
}

const checksumsFile = path.resolve(releaseDir, 'SHA256SUMS.txt');
writeFileSync(checksumsFile, checksums.join('\n') + '\n');
console.log(`✓ Checksums saved to ${checksumsFile}`);
for (const line of checksums) {
  console.log(`   ${line}`);
}

console.log('\n✓ Release artifacts generated successfully in dist/release/');
