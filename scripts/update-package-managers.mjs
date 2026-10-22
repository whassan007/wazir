#!/usr/bin/env node
/**
 * scripts/update-package-managers.mjs
 *
 * Automates manifest updates across native package managers:
 * 1. Homebrew Formula (packaging/homebrew/Formula/wazir.rb & Formula/wazir.rb)
 * 2. Scoop Manifest (packaging/scoop/wazir.json & bucket/wazir.json)
 * 3. WinGet Manifests (packaging/winget/manifests/w/Whassan/Wazir/<version>/)
 *
 * Usage:
 *   node scripts/update-package-managers.mjs [--version <v>] [--sums <path>] [--verify]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Parse CLI flags
const args = process.argv.slice(2);
let targetVersion = '';
let sumsPath = '';
let verifyOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--version' && args[i + 1]) {
    targetVersion = args[++i].replace(/^v/, '');
  } else if (args[i] === '--sums' && args[i + 1]) {
    sumsPath = path.resolve(process.cwd(), args[++i]);
  } else if (args[i] === '--verify') {
    verifyOnly = true;
  }
}

if (!targetVersion) {
  const pkg = JSON.parse(readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
  targetVersion = pkg.version;
}

if (!sumsPath) {
  const defaultSums = path.resolve(rootDir, 'dist/release/SHA256SUMS.txt');
  if (existsSync(defaultSums)) {
    sumsPath = defaultSums;
  }
}

console.log(`==> Package manager manifest management for Wazir v${targetVersion}`);

// Load checksums map if available
const hashes = {
  'darwin-arm64': '0000000000000000000000000000000000000000000000000000000000000000',
  'darwin-x64': '0000000000000000000000000000000000000000000000000000000000000000',
  'linux-arm64': '0000000000000000000000000000000000000000000000000000000000000000',
  'linux-x64': '0000000000000000000000000000000000000000000000000000000000000000',
  'windows-arm64': '0000000000000000000000000000000000000000000000000000000000000000',
  'windows-x64': '0000000000000000000000000000000000000000000000000000000000000000',
};

if (sumsPath && existsSync(sumsPath)) {
  console.log(`✓ Reading checksums from: ${sumsPath}`);
  const content = readFileSync(sumsPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const hash = parts[0];
      const filename = parts[1];
      for (const target of Object.keys(hashes)) {
        if (filename.includes(target)) {
          hashes[target] = hash;
        }
      }
    }
  }
} else {
  console.log('ℹ No SHA256SUMS.txt found; no hashes were loaded.');
}
const missingHashes = Object.entries(hashes).filter(([, hash]) => !/^[a-f0-9]{64}$/i.test(hash) || /^0{64}$/.test(hash)).map(([target]) => target);
if (!verifyOnly && missingHashes.length) {
  throw new Error(`Refusing to generate manifests without verified checksums for: ${missingHashes.join(', ')}`);
}

// 1. Generate Homebrew Formula content
function generateHomebrewFormula(ver, h) {
  return `class Wazir < Formula
  desc "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator"
  homepage "https://github.com/whassan007/wazir"
  version "${ver}"
  license "AGPL-3.0-only"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v${ver}/wazir-v${ver}-darwin-arm64.tar.gz"
      sha256 "${h['darwin-arm64']}"
    else
      url "https://github.com/whassan007/wazir/releases/download/v${ver}/wazir-v${ver}-darwin-x64.tar.gz"
      sha256 "${h['darwin-x64']}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/whassan007/wazir/releases/download/v${ver}/wazir-v${ver}-linux-arm64.tar.gz"
      sha256 "${h['linux-arm64']}"
    else
      url "https://github.com/whassan007/wazir/releases/download/v${ver}/wazir-v${ver}-linux-x64.tar.gz"
      sha256 "${h['linux-x64']}"
    end
  end

  def install
    bin.install "wa"
  end

  def caveats
    <<~EOS
      Wazir stores persistent state, databases, and logs in ~/.wazir:
        - Resource ledger: ~/.wazir/resources.db
        - Configuration:   ~/.wazir/config.json
        - Environment:     ~/.wazir/.env

      Upgrades will replace the CLI binary without modifying your state or configuration.
      To inspect system and agent status, run:
        wa doctor
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/wa --version")
    assert_match "Wazir", shell_output("#{bin}/wa --help")
  end
end
`;
}

// 2. Generate Scoop Manifest content
function generateScoopManifest(ver, h) {
  return JSON.stringify({
    version: ver,
    description: "Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator",
    homepage: "https://github.com/whassan007/wazir",
    license: "AGPL-3.0-only",
    architecture: {
      "64bit": {
        url: `https://github.com/whassan007/wazir/releases/download/v${ver}/wazir-v${ver}-windows-x64.zip`,
        hash: h['windows-x64'],
      },
      "arm64": {
        url: `https://github.com/whassan007/wazir/releases/download/v${ver}/wazir-v${ver}-windows-arm64.zip`,
        hash: h['windows-arm64'],
      }
    },
    bin: "wa.exe",
    checkver: {
      github: "https://github.com/whassan007/wazir",
    },
    autoupdate: {
      architecture: {
        "64bit": {
          url: "https://github.com/whassan007/wazir/releases/download/v$version/wazir-v$version-windows-x64.zip",
        },
        "arm64": {
          url: "https://github.com/whassan007/wazir/releases/download/v$version/wazir-v$version-windows-arm64.zip",
        }
      }
    },
    notes: "Wazir state, resource ledger (~/.wazir/resources.db), and configuration (~/.wazir/config.json) persist across upgrades and uninstalls."
  }, null, 2) + '\n';
}

// 3. Generate WinGet Manifests
function generateWinGetVersion(ver) {
  return `# Created using Wazir release pipeline
# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json

PackageIdentifier: Whassan.Wazir
PackageVersion: ${ver}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`;
}

function generateWinGetInstaller(ver, h) {
  return `# Created using Wazir release pipeline
# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json

PackageIdentifier: Whassan.Wazir
PackageVersion: ${ver}
Platform:
  - Windows.Desktop
MinimumOSVersion: 10.0.17763.0
InstallerType: zip
NestedInstallerType: portable
NestedInstallerFiles:
  - RelativeFilePath: wa.exe
    PortableCommandAlias: wa
Commands:
  - wa
Installers:
  - Architecture: x64
    InstallerUrl: https://github.com/whassan007/wazir/releases/download/v${ver}/wazir-v${ver}-windows-x64.zip
    InstallerSha256: ${h['windows-x64']}
    UpgradeBehavior: install
  - Architecture: arm64
    InstallerUrl: https://github.com/whassan007/wazir/releases/download/v${ver}/wazir-v${ver}-windows-arm64.zip
    InstallerSha256: ${h['windows-arm64']}
    UpgradeBehavior: install
ManifestType: installer
ManifestVersion: 1.6.0
`;
}

function generateWinGetLocale(ver) {
  return `# Created using Wazir release pipeline
# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json

PackageIdentifier: Whassan.Wazir
PackageVersion: ${ver}
PackageLocale: en-US
Publisher: Wazir
PublisherUrl: https://github.com/whassan007/wazir
PublisherSupportUrl: https://github.com/whassan007/wazir/issues
Author: Wazir Contributors
PackageName: Wazir
PackageUrl: https://github.com/whassan007/wazir
License: AGPL-3.0-only
LicenseUrl: https://raw.githubusercontent.com/whassan007/wazir/main/LICENSE
Copyright: Copyright (c) 2026 Wazir Contributors
ShortDescription: Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator
Description: |
  Wazir is a cross-platform, resource-governed autonomous agent orchestration platform.
  It enables scalable AI coding execution across local nodes, edge devices, and compute fleets,
  featuring intelligent resource admission, multi-process memory management, and deterministic recovery.
Moniker: wa
Tags:
  - ai
  - agent
  - coding
  - orchestration
  - cli
  - developer-tools
ReleaseNotesUrl: https://github.com/whassan007/wazir/releases/tag/v${ver}
PurchaseUrl: https://github.com/whassan007/wazir
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`;
}

if (!verifyOnly) {
  // Update Homebrew files
  const formulaContent = generateHomebrewFormula(targetVersion, hashes);
  const formulaPaths = [
    path.resolve(rootDir, 'packaging/homebrew/Formula/wazir.rb'),
    path.resolve(rootDir, 'Formula/wazir.rb'),
  ];
  for (const fp of formulaPaths) {
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, formulaContent);
    console.log(`✓ Updated Homebrew formula: ${path.relative(rootDir, fp)}`);
  }

  // Update Scoop files
  const scoopContent = generateScoopManifest(targetVersion, hashes);
  const scoopPaths = [
    path.resolve(rootDir, 'packaging/scoop/wazir.json'),
    path.resolve(rootDir, 'bucket/wazir.json'),
  ];
  for (const sp of scoopPaths) {
    mkdirSync(path.dirname(sp), { recursive: true });
    writeFileSync(sp, scoopContent);
    console.log(`✓ Updated Scoop manifest: ${path.relative(rootDir, sp)}`);
  }

  // Update WinGet manifests
  const wingetDir = path.resolve(rootDir, `packaging/winget/manifests/w/Whassan/Wazir/${targetVersion}`);
  mkdirSync(wingetDir, { recursive: true });

  const wgVersionPath = path.resolve(wingetDir, 'Whassan.Wazir.yaml');
  const wgInstallerPath = path.resolve(wingetDir, 'Whassan.Wazir.installer.yaml');
  const wgLocalePath = path.resolve(wingetDir, 'Whassan.Wazir.locale.en-US.yaml');

  writeFileSync(wgVersionPath, generateWinGetVersion(targetVersion));
  writeFileSync(wgInstallerPath, generateWinGetInstaller(targetVersion, hashes));
  writeFileSync(wgLocalePath, generateWinGetLocale(targetVersion));
  console.log(`✓ Updated WinGet manifests in: ${path.relative(rootDir, wingetDir)}/`);
}

// Verification Routine
console.log('\n--- Verifying package manager manifests ---');
let hasError = false;

// Verify Homebrew
const hbPath = path.resolve(rootDir, 'Formula/wazir.rb');
if (existsSync(hbPath)) {
  const content = readFileSync(hbPath, 'utf8');
  if (!content.includes(`version "${targetVersion}"`)) {
    console.error(`✗ Homebrew formula version mismatch! Expected ${targetVersion}`);
    hasError = true;
  } else if (!content.includes('class Wazir < Formula')) {
    console.error('✗ Homebrew formula missing class definition!');
    hasError = true;
  } else {
    const found = [...content.matchAll(/sha256 "([a-f0-9]{64})"/gi)].map((match) => match[1]);
    if (found.length < 4 || found.some((hash) => /^0{64}$/i.test(hash))) {
      console.error('✗ Homebrew formula contains missing or placeholder checksums');
      hasError = true;
    }
    console.log('✓ Homebrew formula valid and matches target version.');
  }
} else {
  console.error(`✗ Missing Homebrew formula at ${hbPath}`);
  hasError = true;
}

// Verify Scoop
const scoopPath = path.resolve(rootDir, 'bucket/wazir.json');
if (existsSync(scoopPath)) {
  try {
    const parsed = JSON.parse(readFileSync(scoopPath, 'utf8'));
    if (parsed.version !== targetVersion) {
      console.error(`✗ Scoop manifest version mismatch! Expected ${targetVersion}, found ${parsed.version}`);
      hasError = true;
    } else if (parsed.bin !== 'wa.exe') {
      console.error('✗ Scoop manifest missing wa.exe bin mapping!');
      hasError = true;
    } else {
      const hashesInManifest = [parsed.architecture?.['64bit']?.hash, parsed.architecture?.arm64?.hash];
      if (hashesInManifest.some((hash) => !/^[a-f0-9]{64}$/i.test(hash ?? '') || /^0{64}$/i.test(hash))) {
        console.error('✗ Scoop manifest contains missing or placeholder checksums');
        hasError = true;
      }
      console.log('✓ Scoop manifest valid JSON and matches target version.');
    }
  } catch (err) {
    console.error(`✗ Scoop manifest JSON parse error: ${err.message}`);
    hasError = true;
  }
} else {
  console.error(`✗ Missing Scoop manifest at ${scoopPath}`);
  hasError = true;
}

// Verify WinGet
const wgVersionPath = path.resolve(rootDir, `packaging/winget/manifests/w/Whassan/Wazir/${targetVersion}/Whassan.Wazir.yaml`);
const wgInstallerPath = path.resolve(rootDir, `packaging/winget/manifests/w/Whassan/Wazir/${targetVersion}/Whassan.Wazir.installer.yaml`);
const wgLocalePath = path.resolve(rootDir, `packaging/winget/manifests/w/Whassan/Wazir/${targetVersion}/Whassan.Wazir.locale.en-US.yaml`);

if (existsSync(wgVersionPath) && existsSync(wgInstallerPath) && existsSync(wgLocalePath)) {
  const vContent = readFileSync(wgVersionPath, 'utf8').replace(/\r\n/g, '\n');
  const iContent = readFileSync(wgInstallerPath, 'utf8').replace(/\r\n/g, '\n');
  const lContent = readFileSync(wgLocalePath, 'utf8').replace(/\r\n/g, '\n');

  if (!vContent.includes(`PackageVersion: ${targetVersion}`) ||
      !iContent.includes(`PackageVersion: ${targetVersion}`) ||
      !lContent.includes(`PackageVersion: ${targetVersion}`)) {
    console.error(`✗ WinGet manifest version mismatch! Expected ${targetVersion}`);
    hasError = true;
  } else if (!iContent.includes('wa.exe') || !iContent.includes('Commands:\n  - wa')) {
    console.error('✗ WinGet installer manifest missing command alias mapping!');
    hasError = true;
  } else {
    const installerHashes = [...iContent.matchAll(/InstallerSha256: ([a-f0-9]{64})/gi)].map((match) => match[1]);
    if (installerHashes.length < 2 || installerHashes.some((hash) => /^0{64}$/i.test(hash))) {
      console.error('✗ WinGet installer manifest contains missing or placeholder checksums');
      hasError = true;
    }
    console.log('✓ WinGet manifests valid and match target version.');
  }
} else {
  console.error('✗ WinGet manifests missing!');
  hasError = true;
}

if (hasError) {
  process.exit(1);
} else {
  console.log('✓ All package manager manifests verified successfully.');
}
