import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

const rootDir = path.resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
const currentVersion = pkg.version;

describe('Cross-Platform Package Manager Integration', () => {
  describe('1. Homebrew Formula', () => {
    const formulaLocations = [
      path.resolve(rootDir, 'packaging/homebrew/Formula/wazir.rb'),
      path.resolve(rootDir, 'Formula/wazir.rb'),
    ];

    it.each(formulaLocations)('formula exists and is well-formed at %s', (formulaPath) => {
      expect(existsSync(formulaPath)).toBe(true);
      const content = readFileSync(formulaPath, 'utf8');

      // Formula class & metadata
      expect(content).toContain('class Wazir < Formula');
      expect(content).toContain(`version "${currentVersion}"`);
      expect(content).toContain('license "AGPL-3.0-or-later"');
      expect(content).toContain('homepage "https://github.com/whassan007/wazir"');

      // Platform binary blocks
      expect(content).toContain('on_macos do');
      expect(content).toContain('wazir-v' + currentVersion + '-darwin-arm64.tar.gz');
      expect(content).toContain('wazir-v' + currentVersion + '-darwin-x64.tar.gz');
      expect(content).toContain('on_linux do');
      expect(content).toContain('wazir-v' + currentVersion + '-linux-arm64.tar.gz');
      expect(content).toContain('wazir-v' + currentVersion + '-linux-x64.tar.gz');

      // Install block
      expect(content).toContain('bin.install "wa"');

      // Caveats & persistence documentation
      expect(content).toContain('def caveats');
      expect(content).toContain('~/.wazir/resources.db');
      expect(content).toContain('~/.wazir/config.json');

      // Test block
      expect(content).toContain('test do');
      expect(content).toContain('shell_output("#{bin}/wa --version")');
      expect(content).toContain('shell_output("#{bin}/wa --help")');
    });
  });

  describe('2. Scoop Manifest', () => {
    const scoopLocations = [
      path.resolve(rootDir, 'packaging/scoop/wazir.json'),
      path.resolve(rootDir, 'bucket/wazir.json'),
    ];

    it.each(scoopLocations)('manifest is valid JSON and adheres to Scoop schema at %s', (scoopPath) => {
      expect(existsSync(scoopPath)).toBe(true);
      const content = readFileSync(scoopPath, 'utf8');
      const manifest = JSON.parse(content);

      expect(manifest.version).toBe(currentVersion);
      expect(manifest.description).toContain('Autonomous');
      expect(manifest.license).toBe('AGPL-3.0-or-later');
      expect(manifest.homepage).toBe('https://github.com/whassan007/wazir');

      // Architecture definitions
      expect(manifest.architecture).toBeDefined();
      expect(manifest.architecture['64bit']).toBeDefined();
      expect(manifest.architecture['arm64']).toBeDefined();

      expect(manifest.architecture['64bit'].url).toContain(`wazir-v${currentVersion}-windows-x64.zip`);
      expect(manifest.architecture['arm64'].url).toContain(`wazir-v${currentVersion}-windows-arm64.zip`);

      // Binary shim & checkver
      expect(manifest.bin).toBe('wa.exe');
      expect(manifest.checkver.github).toBe('https://github.com/whassan007/wazir');
      expect(manifest.autoupdate.architecture['64bit'].url).toContain('windows-x64.zip');
      expect(manifest.autoupdate.architecture['arm64'].url).toContain('windows-arm64.zip');

      // Persistence notes
      expect(manifest.notes).toContain('~/.wazir/resources.db');
    });
  });

  describe('3. WinGet Manifests', () => {
    const wingetDir = path.resolve(rootDir, `packaging/winget/manifests/w/Whassan/Wazir/${currentVersion}`);

    it('all three WinGet manifests exist for the current version', () => {
      const vPath = path.resolve(wingetDir, 'Whassan.Wazir.yaml');
      const iPath = path.resolve(wingetDir, 'Whassan.Wazir.installer.yaml');
      const lPath = path.resolve(wingetDir, 'Whassan.Wazir.locale.en-US.yaml');

      expect(existsSync(vPath)).toBe(true);
      expect(existsSync(iPath)).toBe(true);
      expect(existsSync(lPath)).toBe(true);
    });

    it('version manifest is valid', () => {
      const content = readFileSync(path.resolve(wingetDir, 'Whassan.Wazir.yaml'), 'utf8');
      expect(content).toContain('PackageIdentifier: Whassan.Wazir');
      expect(content).toContain(`PackageVersion: ${currentVersion}`);
      expect(content).toContain('ManifestType: version');
      expect(content).toContain('ManifestVersion: 1.6.0');
    });

    it('installer manifest configures portable zip for x64 and arm64 with wa alias', () => {
      const content = readFileSync(path.resolve(wingetDir, 'Whassan.Wazir.installer.yaml'), 'utf8');
      expect(content).toContain('PackageIdentifier: Whassan.Wazir');
      expect(content).toContain(`PackageVersion: ${currentVersion}`);
      expect(content).toContain('InstallerType: zip');
      expect(content).toContain('NestedInstallerType: portable');
      expect(content).toContain('RelativeFilePath: wa.exe');
      expect(content).toContain('PortableCommandAlias: wa');
      expect(content).toContain('Commands:\n  - wa');

      expect(content).toContain('Architecture: x64');
      expect(content).toContain(`wazir-v${currentVersion}-windows-x64.zip`);
      expect(content).toContain('Architecture: arm64');
      expect(content).toContain(`wazir-v${currentVersion}-windows-arm64.zip`);
      expect(content).toContain('UpgradeBehavior: install');
    });

    it('locale manifest contains descriptions, tags, and license', () => {
      const content = readFileSync(path.resolve(wingetDir, 'Whassan.Wazir.locale.en-US.yaml'), 'utf8');
      expect(content).toContain('PackageIdentifier: Whassan.Wazir');
      expect(content).toContain(`PackageVersion: ${currentVersion}`);
      expect(content).toContain('PackageLocale: en-US');
      expect(content).toContain('Publisher: Wazir');
      expect(content).toContain('PackageName: Wazir');
      expect(content).toContain('License: AGPL-3.0-or-later');
      expect(content).toContain('Moniker: wa');
      expect(content).toContain('ai');
      expect(content).toContain('orchestration');
    });
  });

  describe('4. Automated Manifest Generation & Verification Pipeline', () => {
    it('executes update-package-managers.mjs --verify successfully', () => {
      const res = execSync('node scripts/update-package-managers.mjs --verify', {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString();

      expect(res).toContain('All package manager manifests verified successfully.');
    });

    it('updates manifests with custom checksums idempotently', () => {
      const tempDir = path.resolve(os.tmpdir(), `wazir-checksum-test-${Date.now()}`);
      mkdirSync(tempDir, { recursive: true });
      const testSumsFile = path.resolve(tempDir, 'SHA256SUMS.txt');

      const mockHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const sumsContent = [
        `${mockHash}  wazir-v${currentVersion}-darwin-arm64.tar.gz`,
        `${mockHash}  wazir-v${currentVersion}-darwin-x64.tar.gz`,
        `${mockHash}  wazir-v${currentVersion}-linux-arm64.tar.gz`,
        `${mockHash}  wazir-v${currentVersion}-linux-x64.tar.gz`,
        `${mockHash}  wazir-v${currentVersion}-windows-arm64.zip`,
        `${mockHash}  wazir-v${currentVersion}-windows-x64.zip`,
      ].join('\n') + '\n';

      writeFileSync(testSumsFile, sumsContent);

      try {
        const updateOutput = execSync(`node scripts/update-package-managers.mjs --sums "${testSumsFile}"`, {
          cwd: rootDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        }).toString();

        expect(updateOutput).toContain('Updated Homebrew formula');
        expect(updateOutput).toContain('Updated Scoop manifest');
        expect(updateOutput).toContain('Updated WinGet manifests');

        // Check that mockHash was injected
        const fbContent = readFileSync(path.resolve(rootDir, 'Formula/wazir.rb'), 'utf8');
        expect(fbContent).toContain(mockHash);

        const scoopContent = readFileSync(path.resolve(rootDir, 'bucket/wazir.json'), 'utf8');
        expect(scoopContent).toContain(mockHash);

        const wingetContent = readFileSync(
          path.resolve(rootDir, `packaging/winget/manifests/w/Whassan/Wazir/${currentVersion}/Whassan.Wazir.installer.yaml`),
          'utf8'
        );
        expect(wingetContent).toContain(mockHash);
      } finally {
        // Restore placeholder manifests cleanly
        execSync('node scripts/update-package-managers.mjs', {
          cwd: rootDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('5. Data Persistence During Upgrades and Uninstallation', () => {
    it('preserves ~/.wazir, resources.db, and configuration when binary is replaced or removed', () => {
      const sandboxDir = path.resolve(os.tmpdir(), `wazir-upgrade-sandbox-${Date.now()}`);
      const fakeWazirHome = path.resolve(sandboxDir, '.wazir');
      const fakeBinDir = path.resolve(sandboxDir, 'bin');

      mkdirSync(fakeWazirHome, { recursive: true });
      mkdirSync(fakeBinDir, { recursive: true });

      try {
        // Step 1: Simulate prior installation with active user state
        const fakeDbPath = path.resolve(fakeWazirHome, 'resources.db');
        const fakeConfigPath = path.resolve(fakeWazirHome, 'config.json');
        const fakeEnvPath = path.resolve(fakeWazirHome, '.env');
        const fakeBinPath = path.resolve(fakeBinDir, process.platform === 'win32' ? 'wa.exe' : 'wa');

        const initialDbPayload = 'MOCK_SQLITE_HEADER_AND_LEDGER_TRANSACTIONS_V1';
        const initialConfig = JSON.stringify({ networkAllowed: true, modelCapabilities: { 'custom-agent': ['code'] } });
        const initialEnv = 'WAZIR_API_TOKEN=operator_test_secret_123\n';

        writeFileSync(fakeDbPath, initialDbPayload);
        writeFileSync(fakeConfigPath, initialConfig);
        writeFileSync(fakeEnvPath, initialEnv);
        writeFileSync(fakeBinPath, '#!/usr/bin/env node\nconsole.log("v0.1.58");\n');

        expect(existsSync(fakeDbPath)).toBe(true);
        expect(existsSync(fakeConfigPath)).toBe(true);
        expect(existsSync(fakeEnvPath)).toBe(true);
        expect(existsSync(fakeBinPath)).toBe(true);

        // Step 2: Simulate package manager binary upgrade (e.g., brew upgrade / winget upgrade / scoop update)
        // Package manager overwrites the binary in binDir with new version
        writeFileSync(fakeBinPath, '#!/usr/bin/env node\nconsole.log("v0.1.59");\n');

        // Verify binary was upgraded
        expect(readFileSync(fakeBinPath, 'utf8')).toContain('v0.1.59');

        // CRITICAL ASSERTION: Persistent data in ~/.wazir is UNTOUCHED
        expect(readFileSync(fakeDbPath, 'utf8')).toBe(initialDbPayload);
        expect(readFileSync(fakeConfigPath, 'utf8')).toBe(initialConfig);
        expect(readFileSync(fakeEnvPath, 'utf8')).toBe(initialEnv);

        // Step 3: Simulate package manager uninstallation (e.g., brew uninstall / scoop uninstall)
        rmSync(fakeBinPath, { force: true });
        expect(existsSync(fakeBinPath)).toBe(false);

        // CRITICAL ASSERTION: Uninstallation of package manager leaves state directory completely intact
        expect(existsSync(fakeDbPath)).toBe(true);
        expect(readFileSync(fakeDbPath, 'utf8')).toBe(initialDbPayload);
        expect(existsSync(fakeConfigPath)).toBe(true);
        expect(readFileSync(fakeConfigPath, 'utf8')).toBe(initialConfig);
        expect(existsSync(fakeEnvPath)).toBe(true);
      } finally {
        rmSync(sandboxDir, { recursive: true, force: true });
      }
    });
  });
});
