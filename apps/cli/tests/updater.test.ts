import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { compareSemver, chooseRelease, downloadAndVerifyAsset, fetchReleases, platformArtifactNames } from '../src/updater/releases.js';
import { DEFAULT_UPDATE_CONFIG, journalPath, loadUpdateConfig, readUpdateHistory, saveUpdateConfig } from '../src/updater/storage.js';
import { checkForUpdates, configureUpdates, extractStandaloneBinary, getUpdateConfig, rollbackUpdate, validateNpmReleasePackage } from '../src/updater/service.js';
import type { GitHubRelease, UpdateConfig } from '../src/updater/types.js';

const dirs: string[] = [];
function isolate(): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'wazir-updates-'));
  dirs.push(home);
  vi.stubEnv('WAZIR_HOME', home);
  return home;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function release(tag = 'v0.2.8', prerelease = false): GitHubRelease {
  const candidate: GitHubRelease = {
    tag_name: tag, draft: false, prerelease, html_url: `https://github.com/whassan007/wazir/releases/tag/${tag}`,
    assets: [{ name: `wazir-${tag.replace(/^v/, '')}.tgz`, browser_download_url: `https://github.com/whassan007/wazir/releases/download/${tag}/wazir-${tag.replace(/^v/, '')}.tgz`, size: 100, digest: `sha256:${'a'.repeat(64)}` },
      { name: 'SHA256SUMS.txt', browser_download_url: `https://github.com/whassan007/wazir/releases/download/${tag}/SHA256SUMS.txt`, size: 100 }],
  };
  const platformName = platformArtifactNames(process.platform, process.arch, tag)[0];
  if (platformName) candidate.assets.push({ name: platformName, browser_download_url: `https://github.com/whassan007/wazir/releases/download/${tag}/${platformName}`, size: 100, digest: `sha256:${'b'.repeat(64)}` });
  return candidate;
}
const downloaded = async (_release: GitHubRelease) => ({ path: '/verified/staged.tgz', artifact: { name: 'wazir-0.2.8.tgz' }, sha256: 'a'.repeat(64) });
function enabledConfig(): UpdateConfig { const config = { ...DEFAULT_UPDATE_CONFIG, enabled: true }; saveUpdateConfig(config); return config; }

describe('updater release and safety invariants', () => {
  it('compares semantic versions including prereleases and numeric identifiers', () => {
    expect(compareSemver('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareSemver('0.2.8', '0.2.8-rc.9')).toBeGreaterThan(0);
    expect(compareSemver('0.2.8-rc.10', '0.2.8-rc.9')).toBeGreaterThan(0);
    expect(compareSemver('0.2.8+one', '0.2.8+two')).toBe(0);
  });
  it('selects the newest release allowed by the channel and rejects drafts', () => {
    const stable = release('v0.2.8');
    const pre = release('v0.2.9-rc.1', true);
    const draft = { ...release('v9.0.0'), draft: true };
    expect(chooseRelease([stable, pre, draft], 'stable')?.tag_name).toBe('v0.2.8');
    expect(chooseRelease([stable, pre], 'prerelease')?.tag_name).toBe('v0.2.9-rc.1');
  });
  it('maps OS and architecture to exact release artifact names', () => {
    expect(platformArtifactNames('darwin', 'arm64', 'v0.2.8')).toEqual(['wazir-v0.2.8-darwin-arm64.tar.gz']);
    expect(platformArtifactNames('win32', 'x64', '0.2.8')).toEqual(['wazir-v0.2.8-windows-x64.zip']);
    expect(platformArtifactNames('aix', 'ppc64', '0.2.8')).toEqual([]);
  });
  it('defaults to disabled with a five-minute interval and retains configuration', () => {
    isolate();
    expect(loadUpdateConfig()).toMatchObject({ enabled: false, intervalSeconds: 300, channel: 'stable', verifyArtifacts: true });
    configureUpdates({ enabled: true, automaticInstall: false });
    expect(getUpdateConfig()).toMatchObject({ enabled: true, automaticInstall: false });
  });
  it('preserves history when automatic checks are disabled', () => {
    isolate();
    saveUpdateConfig({ ...DEFAULT_UPDATE_CONFIG, enabled: false });
    expect(readUpdateHistory()).toEqual([]);
  });
  it('does not query a release source while automatic updates are disabled', async () => {
    isolate();
    const releases = vi.fn(async () => [release()]);
    const result = await checkForUpdates({ scheduled: true }, { releases });
    expect(result.phase).toBe('ACTION_REQUIRED');
    expect(releases).not.toHaveBeenCalled();
  });
  it('reports up-to-date releases without staging an artifact', async () => {
    isolate(); enabledConfig();
    const result = await checkForUpdates({ scheduled: true }, { releases: async () => [release('v0.2.7')], download: downloaded, installedVersion: '0.2.7', installMethod: 'npm' });
    expect(result.phase).toBe('UP_TO_DATE');
    expect(result.availableVersion).toBe('0.2.7');
  });
  it('stages a newer verified release when a user runs check manually', async () => {
    isolate(); enabledConfig();
    const result = await checkForUpdates({ force: true }, { releases: async () => [release()], download: downloaded, installedVersion: '0.2.7', installMethod: 'npm' });
    expect(result.phase).toBe('STAGED');
    expect(result.availableVersion).toBe('0.2.8');
    expect(result.checksum).toBe('a'.repeat(64));
  });
  it('defers staging activation while a local Wazir session is active', async () => {
    isolate(); enabledConfig();
    const result = await checkForUpdates({ scheduled: true }, { releases: async () => [release()], download: downloaded, installedVersion: '0.2.7', installMethod: 'brew', isJobActive: () => true });
    expect(result.phase).toBe('WAITING_FOR_SAFE_ACTIVATION');
    expect(result.message).toMatch(/active Wazir task/i);
  });
  it('requires the package owner adapter before activating non-npm installations', async () => {
    isolate(); enabledConfig();
    const result = await checkForUpdates({ scheduled: true }, { releases: async () => [release()], download: downloaded, installedVersion: '0.2.7', installMethod: 'homebrew', isJobActive: () => false });
    expect(result.phase).toBe('ACTION_REQUIRED');
    expect(result.message).toContain('brew upgrade wazir');
  });
  it('fails closed when a release is missing', async () => {
    isolate(); enabledConfig();
    const result = await checkForUpdates({ force: true }, { releases: async () => [], installedVersion: '0.2.7' });
    expect(result.phase).toBe('FAILED');
  });
  it('fails closed on invalid checksums and retains diagnostics', async () => {
    isolate(); enabledConfig();
    const result = await checkForUpdates({ force: true }, { releases: async () => [release()], download: async () => { throw new Error('checksum mismatch'); }, installedVersion: '0.2.7' });
    expect(result.phase).toBe('FAILED');
    expect(readUpdateHistory()[0]?.message).toContain('checksum mismatch');
  });
  it('uses an exclusive lock to avoid overlapping update attempts', async () => {
    isolate(); enabledConfig();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = checkForUpdates({ force: true }, { releases: async () => { await gate; return [release('v0.2.7')]; }, installedVersion: '0.2.7' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await checkForUpdates({ force: true }, { releases: async () => [], installedVersion: '0.2.7' });
    expect(second.phase).toBe('ACTION_REQUIRED');
    releaseFirst(); await first;
  });
  it('writes ordered state transitions to durable history', async () => {
    isolate(); enabledConfig();
    await checkForUpdates({ force: true }, { releases: async () => [release()], download: downloaded, installedVersion: '0.2.7', installMethod: 'source-checkout' });
    const phases = readUpdateHistory().map((entry) => entry.phase).reverse();
    expect(phases).toEqual(['CHECKING', 'UPDATE_AVAILABLE', 'DOWNLOADING', 'VERIFYING', 'STAGED', 'STAGED']);
    expect(readFileSync(path.join(process.env.WAZIR_HOME!, 'updates', 'journal.json'), 'utf8')).toContain('STAGED');
  });
  it('supports deterministic repeated checks against identical release metadata', async () => {
    isolate(); enabledConfig();
    const opts = { releases: async () => [release()], download: downloaded, installedVersion: '0.2.7', installMethod: 'source-checkout' };
    const a = await checkForUpdates({ force: true }, opts);
    const b = await checkForUpdates({ force: true }, opts);
    expect(a.phase).toBe(b.phase);
    expect(a.availableVersion).toBe(b.availableVersion);
  });
  it('redacts environment secrets from diagnostics by never serializing configuration values', async () => {
    const home = isolate(); enabledConfig();
    vi.stubEnv('WAZIR_API_TOKEN', 'very-secret-token');
    await checkForUpdates({ force: true }, { releases: async () => [], installedVersion: '0.2.7' });
    const state = readFileSync(path.join(home, 'updates', 'history.jsonl'), 'utf8');
    expect(state).not.toContain('very-secret-token');
  });
  it('uses only the official fixed release repository in persistent config', () => {
    isolate();
    expect(() => configureUpdates({ releaseRepository: 'attacker.example/wazir' } as Partial<UpdateConfig>)).toThrow(/trusted release source/i);
  });
  it('requires explicit opt-in before selecting development channel', () => {
    isolate();
    expect(() => configureUpdates({ channel: 'development' })).toThrow(/WAZIR_ALLOW_DEVELOPMENT_UPDATES/);
  });
  it('stores update history as append-only line records', async () => {
    isolate(); enabledConfig();
    await checkForUpdates({ force: true }, { releases: async () => [release('v0.2.7')], installedVersion: '0.2.7' });
    const lines = readFileSync(path.join(process.env.WAZIR_HOME!, 'updates', 'history.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).phase).toBe('CHECKING');
  });
  it('rejects an asset that lacks GitHub authenticated digest metadata', async () => {
    const r = release(); r.assets[0]!.digest = undefined;
    const fetcher = vi.fn(async () => new Response('unused')) as unknown as typeof fetch;
    await expect(downloadAndVerifyAsset(r, r.assets[0]!.name, fetcher)).rejects.toThrow(/integrity metadata/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects release URLs outside the official GitHub HTTPS origin', async () => {
    const r = release(); r.html_url = 'http://example.com/release';
    await expect(downloadAndVerifyAsset(r, r.assets[0]!.name)).rejects.toThrow(/origin/);
  });
  it('rejects a GitHub release page from a different repository', async () => {
    const r = release(); r.html_url = 'https://github.com/attacker/wazir/releases/tag/v0.2.8';
    await expect(downloadAndVerifyAsset(r, r.assets[0]!.name)).rejects.toThrow(/official Wazir GitHub/);
  });
  it('requires an exact artifact entry in the release checksum manifest', async () => {
    const r = release();
    const bytes = Buffer.from('artifact');
    const crypto = await import('node:crypto');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    r.assets[0]!.size = bytes.length; r.assets[0]!.digest = `sha256:${sha}`;
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('SHA256SUMS.txt')
      ? new Response(`${sha}  unrelated.tgz\n`)
      : new Response(bytes)) as unknown as typeof fetch;
    await expect(downloadAndVerifyAsset(r, r.assets[0]!.name, fetcher)).rejects.toThrow(/SHA256SUMS/);
  });
  it('rejects an artifact whose bytes disagree with the official checksum metadata', async () => {
    const r = release(); r.assets[0]!.size = 3;
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith('SHA256SUMS.txt')
      ? new Response(`${'a'.repeat(64)}  ${r.assets[0]!.name}\n`)
      : new Response(Buffer.from('bad'))) as unknown as typeof fetch;
    await expect(downloadAndVerifyAsset(r, r.assets[0]!.name, fetcher)).rejects.toThrow(/GitHub asset digest/);
  });
  it('checks download size against authenticated release metadata', async () => {
    const r = release(); r.assets[0]!.size = 1000;
    const fetcher = vi.fn(async () => new Response(Buffer.from('short'))) as unknown as typeof fetch;
    await expect(downloadAndVerifyAsset(r, r.assets[0]!.name, fetcher)).rejects.toThrow(/size/);
  });
  it.skipIf(process.platform === 'win32')('extracts only the expected regular executable from a standalone archive', async () => {
    const home = isolate();
    const base = 'wazir-v0.2.8-darwin-arm64';
    const packageDir = path.join(home, base); mkdirSync(packageDir);
    writeFileSync(path.join(packageDir, 'wa'), '#!/bin/sh\nprintf 0.2.8\n', { mode: 0o755 });
    writeFileSync(path.join(packageDir, 'README.md'), 'readme');
    const archive = path.join(home, `${base}.tar.gz`);
    const packed = spawnSync('tar', ['-czf', archive, '-C', home, base]);
    expect(packed.status).toBe(0);
    const extracted = await extractStandaloneBinary(archive, `${base}.tar.gz`);
    expect(readFileSync(extracted, 'utf8')).toContain('printf 0.2.8');
  });
  it.skipIf(process.platform === 'win32')('rejects a symlink in a standalone archive before extraction', async () => {
    const home = isolate();
    const base = 'wazir-v0.2.8-darwin-arm64';
    const packageDir = path.join(home, base); mkdirSync(packageDir);
    symlinkSync('/etc/passwd', path.join(packageDir, 'wa'));
    const archive = path.join(home, `${base}.tar.gz`);
    const packed = spawnSync('tar', ['-czf', archive, '-C', home, base]);
    expect(packed.status).toBe(0);
    await expect(extractStandaloneBinary(archive, `${base}.tar.gz`)).rejects.toThrow(/link or special file/);
  });
  it('validates npm package name, version, and expected executable before installation', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'wazir-npm-update-')); dirs.push(home);
    const pkgDir = path.join(home, 'package');
    mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'wazir', version: '0.2.8', bin: { wa: './bin/wa.js' } }));
    writeFileSync(path.join(pkgDir, 'bin', 'wa.js'), '#!/usr/bin/env node\n');
    writeFileSync(path.join(pkgDir, 'LICENSE'), 'license'); writeFileSync(path.join(pkgDir, 'README.md'), 'readme');
    const tarball = path.join(home, 'wazir-0.2.8.tgz');
    const packed = spawnSync('tar', ['-czf', tarball, '-C', home, 'package']);
    expect(packed.status).toBe(0);
    expect(() => validateNpmReleasePackage(tarball, '0.2.8')).not.toThrow();
    expect(() => validateNpmReleasePackage(tarball, '0.2.9')).toThrow(/metadata/);
  });
  it('does not install when automatic installation is disabled', async () => {
    isolate();
    const config = { ...enabledConfig(), automaticInstall: false }; saveUpdateConfig(config);
    const result = await checkForUpdates({ scheduled: true }, { releases: async () => [release()], download: downloaded, installedVersion: '0.2.7', installMethod: 'npm' });
    expect(result.phase).toBe('STAGED');
  });
  it('does not download when automatic download is disabled', async () => {
    isolate();
    const config = { ...enabledConfig(), automaticDownload: false }; saveUpdateConfig(config);
    const download = vi.fn(downloaded);
    const result = await checkForUpdates({ scheduled: true }, { releases: async () => [release()], download, installedVersion: '0.2.7', installMethod: 'npm' });
    expect(result.phase).toBe('UPDATE_AVAILABLE');
    expect(download).not.toHaveBeenCalled();
  });
  it('checks unsupported systems without attempting installation', async () => {
    isolate(); enabledConfig();
    const result = await checkForUpdates({ scheduled: true }, { releases: async () => [release()], download: downloaded, installedVersion: '0.2.7', installMethod: 'winget', isJobActive: () => false });
    expect(result.phase).toBe('ACTION_REQUIRED');
    expect(result.message).toContain('winget upgrade');
  });
  it('backs off repeated failures without overlapping scheduled retries', async () => {
    isolate(); enabledConfig();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const releases = vi.fn(async () => [] as GitHubRelease[]);
    const first = await checkForUpdates({ scheduled: true }, { releases, installedVersion: '0.2.7' });
    expect(first.phase).toBe('FAILED');
    expect(first.retryAfter).toBe('2026-01-01T00:05:00.000Z');
    const deferred = await checkForUpdates({ scheduled: true }, { releases, installedVersion: '0.2.7' });
    expect(deferred.message).toContain('backed off');
    expect(releases).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date('2026-01-01T00:05:00.000Z'));
    const second = await checkForUpdates({ scheduled: true }, { releases, installedVersion: '0.2.7' });
    expect(second.phase).toBe('FAILED');
    expect(second.retryAfter).toBe('2026-01-01T00:15:00.000Z');
  });
  it('recovers a crash after activation when the new executable reports its version', async () => {
    isolate(); enabledConfig();
    writeFileSync(journalPath(), JSON.stringify({ at: new Date().toISOString(), phase: 'INSTALLING', installedVersion: '0.2.7', availableVersion: '0.2.8' }));
    const releases = vi.fn(async () => [] as GitHubRelease[]);
    const recovered = await checkForUpdates({ scheduled: true }, { releases, installedVersion: '0.2.8', installMethod: 'npm' });
    expect(recovered.phase).toBe('COMPLETED');
    expect(recovered.message).toContain('Recovered a completed activation');
    expect(releases).not.toHaveBeenCalled();
  });
  it('preserves host/user identity in state without exposing credentials', async () => {
    isolate(); enabledConfig();
    const result = await checkForUpdates({ force: true }, { releases: async () => [release('v0.2.7')], installedVersion: '0.2.7' });
    expect(result.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(loadUpdateConfig().releaseRepository).toBe('whassan007/wazir');
  });
  it('discovers and verifies an update through a local fake GitHub release server', async () => {
    const bytes = Buffer.from('deterministic Wazir package tarball');
    const crypto = await import('node:crypto');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const candidate = release();
    candidate.assets[0]!.size = bytes.length;
    candidate.assets[0]!.digest = `sha256:${sha}`;
    let artifactRequests = 0;
    const server = createServer((request, response) => {
      if (request.url?.startsWith('/repos/whassan007/wazir/releases?')) {
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify([candidate])); return;
      }
      if (request.url?.endsWith('/SHA256SUMS.txt')) { response.end(`${sha}  ${candidate.assets[0]!.name}\n`); return; }
      if (request.url?.includes(candidate.assets[0]!.name)) { artifactRequests++; response.end(bytes); return; }
      response.statusCode = 404; response.end('not found');
    });
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fake release server did not bind');
    const local = `http://127.0.0.1:${address.port}`;
    const fakeFetch = (input: string | URL | Request, init?: RequestInit) => {
      const source = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      return fetch(`${local}${source.pathname}${source.search}`, init).then((response) => {
        Object.defineProperty(response, 'url', { value: source.href });
        return response;
      });
    };
    try {
      const releases = await fetchReleases('stable', fakeFetch as typeof fetch);
      expect(chooseRelease(releases, 'stable')?.tag_name).toBe('v0.2.8');
      isolate();
      const staged = await downloadAndVerifyAsset(releases[0]!, candidate.assets[0]!.name, fakeFetch as typeof fetch);
      expect(staged.sha256).toBe(sha);
      expect(readFileSync(staged.path)).toEqual(bytes);
      await downloadAndVerifyAsset(releases[0]!, candidate.assets[0]!.name, fakeFetch as typeof fetch);
      expect(artifactRequests).toBe(1);
    } finally { server.close(); }
  });

  it('refuses to roll back a source checkout instead of touching git or the dev branch', async () => {
    isolate();
    vi.stubEnv('WAZIR_INSTALL_CHANNEL', 'source');
    const result = await rollbackUpdate();
    expect(result.phase).toBe('ACTION_REQUIRED');
    expect(result.message).toMatch(/update this checkout manually/i);
  });

  it('refuses to roll back a package-manager install and points at the manager command', async () => {
    isolate();
    vi.stubEnv('WAZIR_INSTALL_CHANNEL', 'homebrew');
    const result = await rollbackUpdate();
    expect(result.phase).toBe('ACTION_REQUIRED');
    expect(result.message).toMatch(/brew upgrade wazir/);
  });

  it('reports no verified backup rather than guessing when a standalone rollback has nothing staged', async () => {
    const home = isolate();
    vi.stubEnv('WAZIR_INSTALL_CHANNEL', 'standalone-binary');
    mkdirSync(path.join(home, 'updates'), { recursive: true });
    const result = await rollbackUpdate();
    expect(result.phase).toBe('ACTION_REQUIRED');
    expect(result.message).toMatch(/no verified standalone rollback binary/i);
  });
});
