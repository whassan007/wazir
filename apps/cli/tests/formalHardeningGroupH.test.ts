import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { compareSemver, downloadAndVerifyAsset } from '../src/updater/releases.js';
import { DEFAULT_UPDATE_CONFIG, journalPath, historyPath, saveUpdateConfig, updateDir } from '../src/updater/storage.js';
import {
  applyStagedUpdate,
  checkForUpdates,
  recoverInterruptedAttempt,
  rollbackUpdate,
  targetExecutablePath,
} from '../src/updater/service.js';
import type { GitHubRelease, UpdateConfig } from '../src/updater/types.js';

const dirs: string[] = [];

function isolate(): { home: string; binDir: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wazir-fh-home-'));
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'wazir-fh-bin-'));
  dirs.push(home, binDir);
  vi.stubEnv('WAZIR_HOME', home);
  return { home, binDir };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function createDummyExecutable(destPath: string, versionOutput: string, exitCode = 0): void {
  const script = exitCode === 0
    ? `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf "%s\\n" "${versionOutput}"\n  exit 0\nfi\nexit 0\n`
    : `#!/bin/sh\nprintf "%s\\n" "${versionOutput}" >&2\nexit ${exitCode}\n`;
  writeFileSync(destPath, script, { mode: 0o755 });
  chmodSync(destPath, 0o755);
}

function createStandaloneArchive(archivePath: string, binaryDir: string, artifactBaseName: string, executableContent: string): string {
  const packageDir = path.join(binaryDir, artifactBaseName);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, 'wa'), executableContent, { mode: 0o755 });
  chmodSync(path.join(packageDir, 'wa'), 0o755);
  writeFileSync(path.join(packageDir, 'README.md'), '# Wazir CLI\n');
  writeFileSync(path.join(packageDir, 'LICENSE'), 'Apache-2.0\n');
  const packed = spawnSync('tar', ['-czf', archivePath, '-C', binaryDir, artifactBaseName]);
  if (packed.status !== 0) throw new Error(`Failed to create tar archive: ${packed.stderr?.toString()}`);
  return createHash('sha256').update(readFileSync(archivePath)).digest('hex');
}

function enabledConfig(): UpdateConfig {
  const config = { ...DEFAULT_UPDATE_CONFIG, enabled: true, automaticRollback: true };
  saveUpdateConfig(config);
  return config;
}

describe('GROUP H P1: Formal Hardening — Interrupted Updates, Checksum Verification, & Rollback Safety', () => {
  describe('1. Interrupted Update & Crash Recovery (Critical Invariant: Valid Executable Preservation)', () => {
    it('safely recovers an interrupted DOWNLOADING attempt left in journal without modifying installation', async () => {
      const { home } = isolate();
      enabledConfig();
      mkdirSync(path.join(home, 'updates'), { recursive: true });

      writeFileSync(
        journalPath(),
        JSON.stringify({
          at: new Date().toISOString(),
          phase: 'DOWNLOADING',
          installedVersion: '0.2.7',
          availableVersion: '0.2.8',
          installMethod: 'npm',
        }),
      );

      const releasesSpy = vi.fn(async () => [] as GitHubRelease[]);
      const recovered = await checkForUpdates({ scheduled: true }, { releases: releasesSpy, installedVersion: '0.2.7' });

      expect(recovered.phase).toBe('FAILED');
      expect(recovered.message).toContain('Recovered abandoned downloading attempt');
      expect(recovered.installedVersion).toBe('0.2.7');
      expect(releasesSpy).not.toHaveBeenCalled();

      // Ensure journal reflects the recovered failure state
      const currentJournal = JSON.parse(readFileSync(journalPath(), 'utf8'));
      expect(currentJournal.phase).toBe('FAILED');
    });

    it('safely recovers an interrupted VERIFYING attempt left in journal', async () => {
      const { home } = isolate();
      enabledConfig();
      mkdirSync(path.join(home, 'updates'), { recursive: true });

      writeFileSync(
        journalPath(),
        JSON.stringify({
          at: new Date().toISOString(),
          phase: 'VERIFYING',
          installedVersion: '0.2.7',
          availableVersion: '0.2.8',
          installMethod: 'standalone-binary',
        }),
      );

      const recovered = await checkForUpdates({ scheduled: true }, { installedVersion: '0.2.7' });
      expect(recovered.phase).toBe('FAILED');
      expect(recovered.message).toContain('Recovered abandoned verifying attempt');
    });

    it('recovers an interrupted activation where the newly swapped standalone binary is already valid', async () => {
      const { home, binDir } = isolate();
      enabledConfig();
      mkdirSync(path.join(home, 'updates'), { recursive: true });

      const targetBin = path.join(binDir, 'wa');
      createDummyExecutable(targetBin, '0.2.8');
      vi.stubEnv('WAZIR_TARGET_EXECUTABLE', targetBin);

      writeFileSync(
        journalPath(),
        JSON.stringify({
          at: new Date().toISOString(),
          phase: 'INSTALLING',
          installedVersion: '0.2.7',
          availableVersion: '0.2.8',
          installMethod: 'standalone-binary',
        }),
      );

      const recovered = await recoverInterruptedAttempt('0.2.8', 'standalone-binary');
      expect(recovered).toBeDefined();
      expect(recovered?.phase).toBe('COMPLETED');
      expect(recovered?.applied).toBe(true);
      expect(recovered?.installedVersion).toBe('0.2.8');
      expect(recovered?.message).toContain('Recovered a completed activation');
    });

    it('recovers an interrupted standalone INSTALLING attempt by rolling back to verified backup and cleaning temp files', async () => {
      const { home, binDir } = isolate();
      enabledConfig();
      const updatesDir = path.join(home, 'updates');
      mkdirSync(updatesDir, { recursive: true });

      // Target executable was left in a broken/corrupted state during crash
      const targetBin = path.join(binDir, 'wa');
      createDummyExecutable(targetBin, 'BROKEN_CORRUPTED_CRASH', 1);
      vi.stubEnv('WAZIR_TARGET_EXECUTABLE', targetBin);

      // Staged rollback backup exists from previous version 0.2.7
      const backupPath = path.join(updatesDir, 'standalone-0.2.7-1700000000000');
      createDummyExecutable(backupPath, '0.2.7');

      // Abandoned temporary sibling stage left behind by killed process
      const staleStage = `${targetBin}.wazir-stage-99999`;
      writeFileSync(staleStage, 'stale partial bytes');

      writeFileSync(
        journalPath(),
        JSON.stringify({
          at: new Date().toISOString(),
          phase: 'INSTALLING',
          installedVersion: '0.2.7',
          availableVersion: '0.2.8',
          installMethod: 'standalone-binary',
        }),
      );

      const recovered = await recoverInterruptedAttempt('0.2.7', 'standalone-binary');
      expect(recovered).toBeDefined();
      expect(recovered?.phase).toBe('ROLLED_BACK');
      expect(recovered?.installedVersion).toBe('0.2.7');
      expect(recovered?.message).toContain('restoring the last verified installation');

      // Verify physical target executable was restored to working 0.2.7
      const testExec = spawnSync(targetBin, ['--version'], { encoding: 'utf8' });
      expect(testExec.status).toBe(0);
      expect(testExec.stdout.trim()).toBe('0.2.7');

      // Verify stale staging file was cleaned up
      expect(existsSync(staleStage)).toBe(false);
    });

    it('fails closed when an interrupted installation has no rollback backup available', async () => {
      const { home, binDir } = isolate();
      enabledConfig();
      mkdirSync(path.join(home, 'updates'), { recursive: true });

      const targetBin = path.join(binDir, 'wa');
      createDummyExecutable(targetBin, '0.2.7');
      vi.stubEnv('WAZIR_TARGET_EXECUTABLE', targetBin);

      writeFileSync(
        journalPath(),
        JSON.stringify({
          at: new Date().toISOString(),
          phase: 'INSTALLING',
          installedVersion: '0.2.7',
          availableVersion: '0.2.8',
          installMethod: 'standalone-binary',
        }),
      );

      // No standalone-0.2.7-* backup files in updates dir
      const recovered = await recoverInterruptedAttempt('0.2.7', 'standalone-binary');
      expect(recovered).toBeDefined();
      expect(recovered?.phase).toBe('FAILED');
      expect(recovered?.message).toContain('Updater crash recovery failed');
    });
  });

  describe('2. Checksum Mismatch & Missing Artifact Rejection (Alloy Invariant 1)', () => {
    it('fails closed and refuses to enter INSTALLING if staged artifact file was removed or is missing', async () => {
      const { home } = isolate();
      enabledConfig();
      mkdirSync(path.join(home, 'updates'), { recursive: true });

      const nonExistentPath = path.join(home, 'updates', 'v0.2.8-wazir-v0.2.8-darwin-arm64.tar.gz');

      // Record a STAGED entry pointing to nonExistentPath
      writeFileSync(
        journalPath(),
        JSON.stringify({
          at: new Date().toISOString(),
          phase: 'STAGED',
          installedVersion: '0.2.7',
          availableVersion: '0.2.8',
          artifact: 'wazir-v0.2.8-darwin-arm64.tar.gz',
          checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          installMethod: 'standalone-binary',
        }),
      );

      const result = await applyStagedUpdate({
        force: true,
        staged: {
          path: nonExistentPath,
          availableVersion: '0.2.8',
          installedVersion: '0.2.7',
          installMethod: 'standalone-binary',
          artifact: 'wazir-v0.2.8-darwin-arm64.tar.gz',
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        },
      });

      expect(result.phase).toBe('FAILED');
      expect(result.message).toContain('missing from disk');

      // Invariant: Updater MUST NOT have entered INSTALLING phase
      const historyLines = readFileSync(historyPath(), 'utf8').trim().split('\n');
      const phases = historyLines.map((l) => JSON.parse(l).phase);
      expect(phases).not.toContain('INSTALLING');
    });

    it('detects and rejects tampered or corrupted staged artifact, purging it without activating', async () => {
      const { home, binDir } = isolate();
      enabledConfig();
      const updatesDir = path.join(home, 'updates');
      mkdirSync(updatesDir, { recursive: true });

      const artifactName = 'wazir-v0.2.8-darwin-arm64.tar.gz';
      const artifactPath = path.join(updatesDir, artifactName);

      // Create a corrupted file whose content is bogus
      writeFileSync(artifactPath, 'corrupted or tampered binary bytes');
      const expectedSha256 = '1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';

      const result = await applyStagedUpdate({
        force: true,
        staged: {
          path: artifactPath,
          availableVersion: '0.2.8',
          installedVersion: '0.2.7',
          installMethod: 'standalone-binary',
          artifact: artifactName,
          sha256: expectedSha256,
        },
      });

      expect(result.phase).toBe('FAILED');
      expect(result.message).toContain('checksum mismatch');

      // Verify corrupted artifact was purged from disk to protect system
      expect(existsSync(artifactPath)).toBe(false);

      // Verify INSTALLING was never entered
      const historyLines = readFileSync(historyPath(), 'utf8').trim().split('\n');
      const phases = historyLines.map((l) => JSON.parse(l).phase);
      expect(phases).not.toContain('INSTALLING');
    });

    it('rejects an asset whose SHA256SUMS.txt entry does not match authenticated download', async () => {
      const candidate: GitHubRelease = {
        tag_name: 'v0.2.8',
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/whassan007/wazir/releases/tag/v0.2.8',
        assets: [
          {
            name: 'wazir-0.2.8.tgz',
            browser_download_url: 'https://github.com/whassan007/wazir/releases/download/v0.2.8/wazir-0.2.8.tgz',
            size: 14,
            digest: `sha256:${createHash('sha256').update('legitimate tar').digest('hex')}`,
          },
          {
            name: 'SHA256SUMS.txt',
            browser_download_url: 'https://github.com/whassan007/wazir/releases/download/v0.2.8/SHA256SUMS.txt',
            size: 100,
          },
        ],
      };

      const manifestContent = `${'f'.repeat(64)}  wazir-0.2.8.tgz\n`;
      const fakeFetch = vi.fn(async (input: string | URL | Request) => {
        const urlStr = String(input);
        if (urlStr.endsWith('SHA256SUMS.txt')) {
          return new Response(manifestContent, { status: 200 });
        }
        return new Response(Buffer.from('legitimate tar'), { status: 200 });
      }) as unknown as typeof fetch;

      await expect(
        downloadAndVerifyAsset(candidate, 'wazir-0.2.8.tgz', fakeFetch),
      ).rejects.toThrow(/official SHA256SUMS\.txt asset/);
    });
  });

  describe('3. Failed Swap Rollback & Invariant Assurance (Alloy Invariant 3: NoReactivationWithoutRestaging)', () => {
    it.skipIf(process.platform === 'win32')('atomically rolls back to working executable when candidate fails post-swap validation', async () => {
      const { home, binDir } = isolate();
      enabledConfig();
      const updatesDir = path.join(home, 'updates');
      mkdirSync(updatesDir, { recursive: true });

      // Create initial working target executable v0.2.7
      const targetBin = path.join(binDir, 'wa');
      createDummyExecutable(targetBin, '0.2.7');
      vi.stubEnv('WAZIR_TARGET_EXECUTABLE', targetBin);
      vi.stubEnv('WAZIR_INSTALL_CHANNEL', 'standalone-binary');

      // Create a candidate release archive that passes pre-swap staged extraction check
      // but fails post-swap validation when installed as the final binary name
      const baseName = `wazir-v0.2.8-${process.platform}-${process.arch}`;
      const archivePath = path.join(updatesDir, `${baseName}.tar.gz`);
      const defectiveScript =
        '#!/bin/sh\n' +
        'case "$0" in\n' +
        '  *-wa) printf "0.2.8\\n"; exit 0 ;;\n' +
        '  *) printf "POST_SWAP_FAULT\\n" >&2; exit 1 ;;\n' +
        'esac\n';
      const sha256 = createStandaloneArchive(archivePath, binDir, baseName, defectiveScript);

      const result = await applyStagedUpdate({
        force: true,
        staged: {
          path: archivePath,
          availableVersion: '0.2.8',
          installedVersion: '0.2.7',
          installMethod: 'standalone-binary',
          artifact: `${baseName}.tar.gz`,
          sha256,
        },
      });

      // Rollback should have occurred and been recorded
      expect(result.phase).toBe('ROLLED_BACK');
      expect(result.installedVersion).toBe('0.2.7');

      // Target executable must be intact and still execute properly as 0.2.7
      const checkRestored = spawnSync(targetBin, ['--version'], { encoding: 'utf8' });
      expect(checkRestored.status).toBe(0);
      expect(checkRestored.stdout.trim()).toBe('0.2.7');
    });

    it('prevents immediate reactivation of a rolled-back release without a new staging check (Invariant 3)', async () => {
      const { home } = isolate();
      enabledConfig();
      const updatesDir = path.join(home, 'updates');
      mkdirSync(updatesDir, { recursive: true });

      // History has STAGED followed by ROLLED_BACK
      writeFileSync(
        historyPath(),
        `${JSON.stringify({ at: new Date(Date.now() - 60000).toISOString(), phase: 'STAGED', availableVersion: '0.2.8', installedVersion: '0.2.7', installMethod: 'npm' })}\n` +
        `${JSON.stringify({ at: new Date().toISOString(), phase: 'ROLLED_BACK', availableVersion: '0.2.8', installedVersion: '0.2.7', installMethod: 'npm' })}\n`,
      );

      writeFileSync(
        journalPath(),
        JSON.stringify({
          at: new Date().toISOString(),
          phase: 'ROLLED_BACK',
          installedVersion: '0.2.7',
          availableVersion: '0.2.8',
          installMethod: 'npm',
        }),
      );

      // Calling applyStagedUpdate without explicit staged descriptor must reject
      const result = await applyStagedUpdate();
      expect(result.phase).toBe('ACTION_REQUIRED');
      expect(result.message).toContain('No verified staged update is available to apply');
    });

    it('manual rollback safely rejects non-standalone and non-npm installations', async () => {
      isolate();
      vi.stubEnv('WAZIR_INSTALL_CHANNEL', 'homebrew');
      const result = await rollbackUpdate();
      expect(result.phase).toBe('ACTION_REQUIRED');
      expect(result.message).toContain('brew upgrade wazir');
    });
  });

  describe('4. Version Comparison Edge Cases (compareSemver Formal Invariants)', () => {
    it('compares standard major, minor, and patch versions monotonically', () => {
      expect(compareSemver('0.2.10', '0.2.9')).toBeGreaterThan(0);
      expect(compareSemver('0.2.9', '0.2.10')).toBeLessThan(0);
      expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
      expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
      expect(compareSemver('0.0.1', '0.0.1')).toBe(0);
    });

    it('normalizes optional leading v prefix correctly', () => {
      expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
      expect(compareSemver('1.0.0', 'v1.0.0')).toBe(0);
      expect(compareSemver('v0.2.8', 'v0.2.9')).toBeLessThan(0);
      expect(compareSemver('v0.2.10', '0.2.9')).toBeGreaterThan(0);
    });

    it('enforces SemVer 2.0.0 pre-release precedence ladder', () => {
      // SemVer spec section 11:
      // 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-alpha.beta < 1.0.0-beta < 1.0.0-beta.2 < 1.0.0-beta.11 < 1.0.0-rc.1 < 1.0.0
      expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0);
      expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBeLessThan(0);
      expect(compareSemver('1.0.0-alpha.beta', '1.0.0-beta')).toBeLessThan(0);
      expect(compareSemver('1.0.0-beta', '1.0.0-beta.2')).toBeLessThan(0);
      expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.11')).toBeLessThan(0); // numeric comparison 2 < 11
      expect(compareSemver('1.0.0-beta.11', '1.0.0-rc.1')).toBeLessThan(0);
      expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
      expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    });

    it('ranks numeric pre-release identifiers below non-numeric identifiers per SemVer 2.0 spec', () => {
      // 1.0.0-1 < 1.0.0-alpha (numeric identifiers have lower precedence than alphanumeric)
      expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
      expect(compareSemver('1.0.0-alpha', '1.0.0-1')).toBeGreaterThan(0);
    });

    it('ignores build metadata during version precedence comparison', () => {
      expect(compareSemver('1.0.0+build1', '1.0.0+build2')).toBe(0);
      expect(compareSemver('1.0.0-rc.1+sha.111', '1.0.0-rc.1+sha.222')).toBe(0);
      expect(compareSemver('1.0.1+build1', '1.0.0+build2')).toBeGreaterThan(0);
    });

    it('rejects invalid semantic version inputs with descriptive errors', () => {
      expect(() => compareSemver('1.0', '1.0.0')).toThrow(/Invalid semantic version/);
      expect(() => compareSemver('1.0.0.0', '1.0.0')).toThrow(/Invalid semantic version/);
      expect(() => compareSemver('01.2.3', '1.2.3')).toThrow(/Invalid semantic version/); // leading zero rejected
      expect(() => compareSemver('1.0.0', 'invalid')).toThrow(/Invalid semantic version/);
      expect(() => compareSemver('', '1.0.0')).toThrow(/Invalid semantic version/);
    });
  });
});
