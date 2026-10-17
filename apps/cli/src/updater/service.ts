import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statfsSync, statSync, chmodSync, accessSync, constants, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { configDir } from '../config.js';
import { getBuildInfo } from '../version.js';
import { appendUpdateRecord, acquireUpdateLock, journalPath, loadUpdateConfig, readUpdateHistory, saveUpdateConfig, updateDir, validateUpdateConfig } from './storage.js';
import { chooseRelease, compareSemver, downloadAndVerifyAsset, downloadAndVerifyRelease, fetchReleases, platformArtifactNames } from './releases.js';
import { installUpdateScheduler, removeUpdateScheduler, schedulerInstalled } from './scheduler.js';
import type { GitHubRelease, UpdateConfig, UpdatePhase, UpdateRecord } from './types.js';

export interface UpdateStatus {
  host: string;
  platform: string;
  architecture: string;
  installedVersion: string;
  installMethod: string;
  channel: string;
  enabled: boolean;
  intervalSeconds: number;
  schedulerInstalled: boolean;
  lastCheck?: string;
  nextCheck?: string;
  lastUpdate?: string;
  phase?: UpdatePhase;
  availableVersion?: string;
  error?: string;
  jobsPreventActivation: boolean;
  components: Array<{ name: string; state: string; managed: boolean }>;
}

function packageRoot(): string | undefined {
  const arg = process.argv[1];
  if (!arg) return undefined;
  try {
    let current = path.dirname(realpathSync(arg));
    for (let i = 0; i < 5; i++) {
      const file = path.join(current, 'package.json');
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string };
        if (pkg.name === 'wazir') return current;
      }
      current = path.dirname(current);
    }
  } catch {}
  return undefined;
}

export function detectInstallMethod(): string {
  const build = getBuildInfo();
  if (build.channel === 'docker') return 'docker';
  const root = packageRoot();
  if (root && /(?:^|[\\/])node_modules[\\/]wazir(?:[\\/]|$)/.test(root)) {
    return /[\\/]Cellar[\\/]wazir[\\/]/.test(root) ? 'homebrew' : 'npm';
  }
  if (build.channel === 'homebrew') return 'homebrew';
  if (build.channel === 'standalone-binary' || (process as NodeJS.Process & { isSea?: () => boolean }).isSea?.()) return 'standalone-binary';
  if (build.channel === 'deb' || build.channel === 'rpm') return build.channel;
  if (build.channel === 'scoop' || build.channel === 'winget') return build.channel;
  if (process.env.WAZIR_MANAGED_CHECKOUT === '1') return 'managed-source';
  return 'source-checkout';
}

function isJobActive(): boolean {
  // Avoid replacing files used by an interactive session or service. This is intentionally
  // conservative; deployments with remote task leases can add their controller drain hook.
  const probe = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    : spawnSync('ps', ['-axo', 'command='], { encoding: 'utf8', timeout: 5000 });
  if (probe.status !== 0 || !probe.stdout) return true;
  return probe.stdout.split(/\r?\n/).some((line) => /(?:^|[ /\\])wa(?:\.js|\.exe)?\s+(?:chat|fleet|worker\s+start|api\s+start|run|ask|execute)(?:\s|$)/i.test(line));
}

function record(phase: UpdatePhase, version: string, details: Partial<UpdateRecord> = {}): UpdateRecord {
  const message = details.message?.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bnpm_[A-Za-z0-9]{12,}\b/g, '[REDACTED]')
    .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
  const value: UpdateRecord = { at: new Date().toISOString(), phase, installedVersion: version, ...details, ...(message ? { message } : {}) };
  appendUpdateRecord(value);
  return value;
}

async function npmGlobalPrefix(): Promise<string | undefined> {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$npm=(Get-Command npm.cmd -ErrorAction SilentlyContinue).Source; if ($npm) { & $npm prefix -g }"], { encoding: 'utf8', timeout: 10_000, windowsHide: true })
    : spawnSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 10_000 });
  return result.status === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : undefined;
}

function diskSpace(pathname: string): number | undefined {
  try { return statfsSync(pathname).bavail * statfsSync(pathname).bsize; } catch { return undefined; }
}

function validateNpmInstall(prefix: string, version: string): boolean {
  const bin = path.join(prefix, process.platform === 'win32' ? 'wa.cmd' : 'bin', process.platform === 'win32' ? '' : '');
  const executable = process.platform === 'win32' ? bin : path.join(bin, 'wa');
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${executable}" --version`], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    : spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  return result.status === 0 && result.stdout.trim().replace(/^v/, '') === version.replace(/^v/, '');
}

function preserveInstalledPackage(root: string, version: string): string {
  const backups = path.join(updateDir(), 'backups');
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const dest = path.join(backups, `npm-${version}-${Date.now()}`);
  cpSync(root, dest, { recursive: true, dereference: false, preserveTimestamps: true });
  return dest;
}

function installNpmTarball(tarball: string, prefix: string): void {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$npm=(Get-Command npm.cmd -ErrorAction Stop).Source; & $npm install --global --prefix ${psQuote(prefix)} ${psQuote(tarball)} --no-audit --no-fund`], { encoding: 'utf8', timeout: 300_000, windowsHide: true })
    : spawnSync('npm', ['install', '--global', '--prefix', prefix, tarball, '--no-audit', '--no-fund'], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`npm update failed${result.status === null ? '' : ` (${result.status})`}: ${(result.stderr || result.error?.message || '').trim()}`);
}

export function validateNpmReleasePackage(tarball: string, expectedVersion: string): void {
  const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error(`Cannot inspect npm release package: ${(listing.stderr || '').trim()}`);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\/$/, ''));
  const allowed = new Set(['package', 'package/bin', 'package/bin/wa.js', 'package/package.json', 'package/LICENSE', 'package/README.md']);
  if (!entries.includes('package/package.json') || !entries.includes('package/bin/wa.js')) throw new Error('npm release package is missing package/package.json or package/bin/wa.js');
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry);
    if (normalized !== entry || normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('\\') || !allowed.has(normalized)) throw new Error(`npm release package contains an unexpected path: ${entry}`);
  }
  const metadata = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (metadata.status !== 0) throw new Error('Cannot read npm release package metadata');
  let pkg: { name?: string; version?: string; bin?: Record<string, string> };
  try { pkg = JSON.parse(metadata.stdout) as typeof pkg; } catch { throw new Error('npm release package metadata is not valid JSON'); }
  if (pkg.name !== 'wazir' || pkg.version !== expectedVersion || pkg.bin?.wa !== './bin/wa.js') throw new Error('npm release package metadata does not match expected Wazir name, version, or executable path');
}

function restoreNpmBackup(backup: string, prefix: string): void {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$npm=(Get-Command npm.cmd -ErrorAction Stop).Source; & $npm install --global --prefix ${psQuote(prefix)} ${psQuote(backup)} --no-audit --no-fund`], { encoding: 'utf8', timeout: 300_000, windowsHide: true })
    : spawnSync('npm', ['install', '--global', '--prefix', prefix, backup, '--no-audit', '--no-fund'], { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (result.status !== 0) throw new Error(`npm rollback failed: ${(result.stderr || result.error?.message || '').trim()}`);
}

function psQuote(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

function pruneUpdateFiles(keep: number): void {
  const entries = readdirSync(updateDir(), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:v?\d+\.\d+\.\d+-.+|wazir-)/.test(entry.name))
    .map((entry) => ({ name: entry.name, mtime: statSync(path.join(updateDir(), entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of entries.slice(Math.max(2, keep))) rmSync(path.join(updateDir(), old.name), { force: true });
}

function pruneBackups(keep: number): void {
  const backupDir = path.join(updateDir(), 'backups');
  if (!existsSync(backupDir)) return;
  const backups = readdirSync(backupDir, { withFileTypes: true }).filter((entry) => entry.name.startsWith('npm-'))
    .map((entry) => ({ name: entry.name, mtime: statSync(path.join(backupDir, entry.name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(Math.max(1, keep))) rmSync(path.join(backupDir, old.name), { recursive: true, force: true });
}

function pruneStandaloneBackups(keep: number): void {
  const files = readdirSync(updateDir(), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.startsWith('standalone-'))
    .map((entry) => ({ name: entry.name, mtime: statSync(path.join(updateDir(), entry.name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  for (const old of files.slice(Math.max(1, keep))) rmSync(path.join(updateDir(), old.name), { force: true });
}

export async function extractStandaloneBinary(archive: string, artifactName: string): Promise<string> {
  if (process.platform === 'win32') throw new Error('Windows standalone activation requires a deferred replacement helper and is not enabled yet.');
  const base = artifactName.replace(/\.(?:tar\.gz|zip)$/, '');
  const expected = `${base}/wa`;
  const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error(`Cannot inspect standalone archive: ${(listing.stderr || '').trim()}`);
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\/$/, ''));
  if (entries.filter((entry) => entry === expected).length !== 1) throw new Error(`Standalone archive must contain exactly one expected executable ${expected}`);
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry);
    if (normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('\\') || normalized !== entry || !(entry === base || entry === expected || entry === `${base}/README.md` || entry === `${base}/LICENSE`)) {
      throw new Error(`Standalone archive contains an unexpected path: ${entry}`);
    }
  }
  const verbose = spawnSync('tar', ['-tvzf', archive], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  if (verbose.status !== 0 || verbose.stdout.split(/\r?\n/).filter(Boolean).some((line) => !['-', 'd'].includes(line[0] ?? ''))) throw new Error('Standalone archive contains an unsupported link or special file');
  mkdirSync(updateDir(), { recursive: true, mode: 0o700 });
  const stage = path.join(updateDir(), `${base}-wa`);
  const child = spawn('tar', ['-xOzf', archive, expected], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = createWriteStream(stage, { mode: 0o700 });
  let size = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk: string) => { stderr += chunk.slice(0, 4096); });
  child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024 * 1024) child.kill('SIGKILL'); });
  child.stdout.pipe(output);
  const [status] = await Promise.all([
    new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (code) => resolve(code ?? -1)); }),
    new Promise<void>((resolve, reject) => { output.once('error', reject); output.once('finish', resolve); }),
  ]);
  if (status !== 0 || size === 0 || size > 1024 * 1024 * 1024) { rmSync(stage, { force: true }); throw new Error(`Could not extract bounded standalone executable: ${stderr.trim()}`); }
  chmodSync(stage, 0o755);
  return stage;
}

async function installStandaloneBinary(archive: string, artifactName: string, version: string, config: UpdateConfig): Promise<void> {
  if (!config.automaticRollback) throw new Error('Automatic standalone activation is disabled because automatic rollback is disabled.');
  const current = realpathSync(process.execPath);
  accessSync(path.dirname(current), constants.W_OK);
  if (typeof process.getuid === 'function' && statSync(current).uid !== process.getuid()) throw new Error('Standalone executable is not owned by the current user; refusing to replace a system-managed binary.');
  const fileSystem = statfsSync(path.dirname(current));
  if (fileSystem.bavail * fileSystem.bsize < Math.max(statSync(current).size * 2, 128 * 1024 * 1024)) throw new Error('Insufficient free disk space to stage and roll back a standalone update.');
  const staged = await extractStandaloneBinary(archive, artifactName);
  const stagedCheck = spawnSync(staged, ['--version'], { encoding: 'utf8', timeout: 20_000 });
  if (stagedCheck.status !== 0 || stagedCheck.stdout.trim().replace(/^v/, '') !== version.replace(/^v/, '')) {
    rmSync(staged, { force: true }); throw new Error(`Staged standalone executable did not report Wazir ${version}`);
  }
  const backup = path.join(updateDir(), `standalone-${getBuildInfo().version}-${Date.now()}`);
  copyFileSync(current, backup);
  chmodSync(backup, 0o700);
  const siblingStage = `${current}.wazir-stage-${process.pid}`;
  try {
    copyFileSync(staged, siblingStage); chmodSync(siblingStage, 0o755);
    renameSync(siblingStage, current);
    const installed = spawnSync(current, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    if (installed.status !== 0 || installed.stdout.trim().replace(/^v/, '') !== version.replace(/^v/, '')) throw new Error(`Activated executable did not report Wazir ${version}`);
  } catch (error) {
    rmSync(siblingStage, { force: true });
    const rollback = `${current}.wazir-rollback-${process.pid}`;
    copyFileSync(backup, rollback); chmodSync(rollback, 0o755); renameSync(rollback, current);
    const restored = spawnSync(current, ['--version'], { encoding: 'utf8', timeout: 20_000 });
    if (restored.status !== 0 || restored.stdout.trim().replace(/^v/, '') !== getBuildInfo().version.replace(/^v/, '')) throw new Error(`Activation failed and rollback could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`Activation failed; previous binary restored and verified: ${error instanceof Error ? error.message : String(error)}`);
  } finally { rmSync(staged, { force: true }); }
}

function actionRequired(method: string): string {
  const commands: Record<string, string> = {
    homebrew: 'brew upgrade wazir',
    deb: 'sudo apt update && sudo apt install --only-upgrade wazir',
    rpm: 'sudo dnf upgrade wazir',
    scoop: 'scoop update wazir',
    winget: 'winget upgrade whassan007.Wazir',
    docker: 'docker compose pull && docker compose up -d',
    'source-checkout': 'Update this checkout manually, or register a clean deployment with WAZIR_MANAGED_CHECKOUT=1.',
    'managed-source': 'Managed source deployment updates are not yet activated automatically; use git pull --ff-only and rebuild.',
    'standalone-binary': 'Standalone binary activation is staged for review; replace it with the verified platform release using your installation owner.',
  };
  return `Automatic installation for ${method} requires an installation-specific safe adapter. Run: ${commands[method] ?? 'use the supported installer for this installation'}`;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const config = loadUpdateConfig();
  const history = readUpdateHistory(100);
  const build = getBuildInfo();
  const latest = history.find((entry) => ['COMPLETED', 'UP_TO_DATE', 'FAILED', 'ROLLED_BACK', 'ACTION_REQUIRED', 'STAGED', 'WAITING_FOR_SAFE_ACTIVATION'].includes(entry.phase));
  const last = history[0];
  return {
    host: os.hostname(), platform: build.platform, architecture: build.arch, installedVersion: build.version, installMethod: detectInstallMethod(), channel: config.channel,
    enabled: config.enabled, intervalSeconds: config.intervalSeconds, schedulerInstalled: schedulerInstalled(),
    lastCheck: latest?.at, nextCheck: config.enabled && latest ? new Date(Date.parse(latest.at) + config.intervalSeconds * 1000).toISOString() : undefined,
    lastUpdate: history.find((entry) => entry.phase === 'COMPLETED')?.at,
    phase: last?.phase, availableVersion: last?.availableVersion, error: last?.phase === 'FAILED' || last?.phase === 'ACTION_REQUIRED' ? last.message : undefined,
    jobsPreventActivation: isJobActive(),
    components: [
      { name: 'CLI', state: 'installed', managed: true },
      { name: 'API / dashboard', state: existsSync(path.join(configDir(), 'deployments', 'api.json')) ? 'managed deployment detected' : 'not installed as managed component', managed: existsSync(path.join(configDir(), 'deployments', 'api.json')) },
      { name: 'Worker', state: existsSync(path.join(configDir(), 'deployments', 'worker.json')) ? 'managed deployment detected' : 'not installed as managed component', managed: existsSync(path.join(configDir(), 'deployments', 'worker.json')) },
      { name: 'Desktop app', state: 'not detected as Wazir-managed', managed: false },
      { name: 'Agent/runtime packages', state: 'bundled with CLI release', managed: true },
    ],
  };
}

async function recoverInterruptedAttempt(version: string, method: string): Promise<UpdateRecord | undefined> {
  if (!existsSync(journalPath())) return undefined;
  let journal: UpdateRecord;
  try { journal = JSON.parse(readFileSync(journalPath(), 'utf8')) as UpdateRecord; } catch { return undefined; }
  if (!['DOWNLOADING', 'VERIFYING', 'INSTALLING', 'VALIDATING', 'ROLLING_BACK'].includes(journal.phase)) return undefined;
  if (journal.availableVersion && version.replace(/^v/, '') === journal.availableVersion.replace(/^v/, '') && ['INSTALLING', 'VALIDATING'].includes(journal.phase)) {
    return record('COMPLETED', version, { availableVersion: journal.availableVersion, installMethod: method, message: 'Recovered a completed activation after restart; the new CLI passed startup validation.' });
  }
  if (!['INSTALLING', 'VALIDATING', 'ROLLING_BACK'].includes(journal.phase)) return record('FAILED', version, { availableVersion: journal.availableVersion, installMethod: method, message: `Recovered abandoned ${journal.phase.toLowerCase()} attempt; active installation was left unchanged.` });
  try {
    if (method === 'npm') {
      const prefix = await npmGlobalPrefix();
      const backupDir = path.join(updateDir(), 'backups');
      const backup = existsSync(backupDir) ? readdirSync(backupDir).filter((name) => name.startsWith(`npm-${journal.installedVersion}-`)).sort().reverse()[0] : undefined;
      if (!prefix || !backup) throw new Error('No package-manager rollback backup is available');
      restoreNpmBackup(path.join(backupDir, backup), prefix);
      if (!validateNpmInstall(prefix, journal.installedVersion)) throw new Error('Recovered npm rollback failed version verification');
    } else if (method === 'standalone-binary') {
      const backup = readdirSync(updateDir()).filter((name) => name.startsWith(`standalone-${journal.installedVersion}-`)).sort().reverse()[0];
      if (!backup) throw new Error('No standalone rollback backup is available');
      const target = realpathSync(process.execPath);
      const temp = `${target}.wazir-recovery-${process.pid}`;
      copyFileSync(path.join(updateDir(), backup), temp); chmodSync(temp, 0o755); renameSync(temp, target);
      const check = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 20_000 });
      if (check.status !== 0 || check.stdout.trim().replace(/^v/, '') !== journal.installedVersion.replace(/^v/, '')) throw new Error('Recovered standalone rollback failed version verification');
    } else throw new Error('No safe rollback adapter exists for this installation method');
    return record('ROLLED_BACK', journal.installedVersion, { availableVersion: journal.availableVersion, installMethod: method, message: `Recovered abandoned ${journal.phase.toLowerCase()} attempt by restoring the last verified installation.` });
  } catch (error) {
    return record('FAILED', version, { availableVersion: journal.availableVersion, installMethod: method, message: `Updater crash recovery failed: ${error instanceof Error ? error.message : String(error)}` });
  }
}

export async function enableAutoUpdates(): Promise<{ config: UpdateConfig; scheduler: { backend: string; path: string } }> {
  const config = loadUpdateConfig();
  config.enabled = true;
  saveUpdateConfig(config);
  try { return { config, scheduler: installUpdateScheduler(config.intervalSeconds) }; }
  catch (error) { config.enabled = false; saveUpdateConfig(config); throw error; }
}

export function disableAutoUpdates(): { config: UpdateConfig; scheduler: { backend: string; path: string } } {
  const config = loadUpdateConfig();
  config.enabled = false;
  saveUpdateConfig(config);
  const scheduler = removeUpdateScheduler();
  return { config, scheduler };
}

export function configureUpdates(patch: Partial<UpdateConfig>): UpdateConfig {
  const config = validateUpdateConfig({ ...loadUpdateConfig(), ...patch });
  if (patch.releaseRepository && patch.releaseRepository !== 'whassan007/wazir') throw new Error('The release repository must remain whassan007/wazir');
  saveUpdateConfig(config);
  return config;
}

export interface UpdateDependencies {
  releases?: (channel: UpdateConfig['channel']) => Promise<GitHubRelease[]>;
  download?: (release: GitHubRelease, method: string) => Promise<{ path: string; artifact: { name: string }; sha256: string }>;
  isJobActive?: () => boolean;
  installedVersion?: string;
  installMethod?: string;
  prefix?: string;
}

export async function checkForUpdates(options: { install?: boolean; scheduled?: boolean; force?: boolean } = {}, deps: UpdateDependencies = {}): Promise<UpdateRecord> {
  const unlock = acquireUpdateLock();
  const initialVersion = deps.installedVersion ?? getBuildInfo().version;
  if (!unlock) return record('ACTION_REQUIRED', initialVersion, { message: 'Another updater process is active; this duplicate attempt was skipped.' });
  try {
    const config = loadUpdateConfig();
    const method = deps.installMethod ?? detectInstallMethod();
    const recovered = await recoverInterruptedAttempt(initialVersion, method);
    if (recovered) return recovered;
    if (!config.enabled && !options.force && !options.install) return record('ACTION_REQUIRED', initialVersion, { message: 'Automatic updates are disabled. Use wa update enable to opt in.' });
    const priorHistory = readUpdateHistory(200);
    let recentFailures = 0;
    for (const entry of priorHistory) {
      if (entry.phase === 'FAILED') recentFailures++;
      else if (entry.phase === 'COMPLETED' || entry.phase === 'UP_TO_DATE') break;
    }
    const lastFailure = priorHistory.find((entry) => entry.phase === 'FAILED');
    if (options.scheduled && !options.force && lastFailure?.retryAfter && Date.now() < Date.parse(lastFailure.retryAfter)) {
      return { ...lastFailure, message: `Network/update retry is backed off until ${lastFailure.retryAfter}.` };
    }
    const recordFailure = (message: string, details: Partial<UpdateRecord> = {}) => {
      const retrySeconds = Math.min(3600, 300 * (2 ** Math.min(Math.max(0, recentFailures), 4)));
      return record('FAILED', initialVersion, { ...details, message, retryAfter: new Date(Date.now() + retrySeconds * 1000).toISOString() });
    };
    record('CHECKING', initialVersion);
    const releases = await (deps.releases ?? fetchReleases)(config.channel);
    const release = chooseRelease(releases, config.channel);
    if (!release) return recordFailure('No eligible Wazir release was returned by the official release source.');
    const available = release.tag_name.replace(/^v/, '');
    if (compareSemver(available, initialVersion) <= 0) return record('UP_TO_DATE', initialVersion, { availableVersion: available, installMethod: deps.installMethod ?? detectInstallMethod() });
    record('UPDATE_AVAILABLE', initialVersion, { availableVersion: available });
    if (!config.automaticDownload && !options.install) return record('UPDATE_AVAILABLE', initialVersion, { availableVersion: available, message: 'Automatic download is disabled.' });
    const artifactName = method === 'npm'
      ? `wazir-${available}.tgz`
      : platformArtifactNames(process.platform, process.arch, release.tag_name)[0];
    const releaseArtifact = artifactName ? release.assets.find((asset) => asset.name === artifactName) : undefined;
    if (!releaseArtifact) return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: `Official release has no compatible artifact for ${method} on ${process.platform}/${process.arch}.` });
    const availableBytes = diskSpace(updateDir());
    const requiredBytes = Math.max(128 * 1024 * 1024, releaseArtifact.size * 2);
    if (availableBytes !== undefined && availableBytes < requiredBytes) return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: `Insufficient free space: need approximately ${Math.ceil(requiredBytes / 1024 / 1024)} MiB to stage the release and preserve rollback data.` });
    record('DOWNLOADING', initialVersion, { availableVersion: available });
    const download = deps.download ?? ((candidate: GitHubRelease, installMethod: string) => {
      if (installMethod === 'npm') {
        const version = candidate.tag_name.replace(/^v/, '');
        const asset = candidate.assets.find((item) => item.name === `wazir-${version}.tgz`);
        if (!asset) throw new Error(`Official release does not include the npm package artifact wazir-${version}.tgz`);
        return downloadAndVerifyAsset(candidate, asset.name);
      }
      const platformName = platformArtifactNames(process.platform, process.arch, candidate.tag_name)[0];
      if (!platformName) throw new Error(`Unsupported update platform ${process.platform}/${process.arch}`);
      return downloadAndVerifyRelease(candidate);
    });
    const downloaded = await download(release, method);
    pruneUpdateFiles(config.retainPreviousVersions);
    record('VERIFYING', initialVersion, { availableVersion: available, artifact: downloaded.artifact.name, checksum: downloaded.sha256 });
    record('STAGED', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256 });
    if ((!config.automaticInstall && !options.install) || (!options.install && !options.scheduled)) return record('STAGED', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256, message: 'Verified release staged. Run wa update now to activate it, or enable automatic installation.' });
    if (config.deferWhileJobsRunning && (deps.isJobActive ?? isJobActive)()) return record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256, message: 'Active Wazir task or interactive session detected; activation deferred.' });
    if (method === 'standalone-binary') {
      if (options.scheduled && !options.install && !config.automaticInstall) return record('STAGED', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256 });
      if (process.platform === 'win32') return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256, message: actionRequired(method) });
      if (!config.automaticRollback) return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256, message: 'Automatic activation is disabled because automatic rollback is disabled.' });
      if (config.deferWhileJobsRunning && (deps.isJobActive ?? isJobActive)()) return record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256, message: 'Active Wazir task or interactive session detected; activation deferred.' });
      record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, { availableVersion: available, installMethod: method, message: 'No active local Wazir session detected; staging a rollback-capable binary replacement.' });
      record('INSTALLING', initialVersion, { availableVersion: available, installMethod: method });
      try {
        await installStandaloneBinary(downloaded.path, downloaded.artifact.name, available, config);
        pruneStandaloneBackups(config.retainPreviousVersions);
        record('VALIDATING', initialVersion, { availableVersion: available, installMethod: method });
        return record('COMPLETED', available, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256, message: `Wazir ${available} passed standalone version verification.` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return record(message.includes('restored and verified') ? 'ROLLED_BACK' : 'FAILED', initialVersion, { availableVersion: available, installMethod: method, message });
      }
    }
    if (method !== 'npm') return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256, message: actionRequired(method) });

    const prefix = deps.prefix ?? await npmGlobalPrefix();
    const root = packageRoot();
    if (!prefix || !root) return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: 'Unable to verify the global npm package ownership and prefix; refusing to write outside the package manager.' });
    if (!config.automaticRollback) return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: 'Automatic activation is disabled because automatic rollback is disabled.' });
    validateNpmReleasePackage(downloaded.path, available);
    const required = Math.max(100 * 1024 * 1024, downloaded.artifact.name.endsWith('.tgz') ? downloaded.sha256.length : 0);
    const free = diskSpace(prefix);
    if (free !== undefined && free < required) return record('ACTION_REQUIRED', initialVersion, { availableVersion: available, installMethod: method, message: 'Insufficient free disk space for a staged npm update and rollback copy.' });
    const backup = preserveInstalledPackage(root, initialVersion);
    record('WAITING_FOR_SAFE_ACTIVATION', initialVersion, { availableVersion: available, installMethod: method, message: 'No active local Wazir session detected; activating through npm.' });
    record('INSTALLING', initialVersion, { availableVersion: available, installMethod: method });
    try {
      installNpmTarball(downloaded.path, prefix);
      record('VALIDATING', initialVersion, { availableVersion: available, installMethod: method });
      if (!validateNpmInstall(prefix, available)) throw new Error(`Installed CLI did not report expected version ${available}`);
      pruneBackups(config.retainPreviousVersions);
      return record('COMPLETED', available, { availableVersion: available, installMethod: method, artifact: downloaded.artifact.name, checksum: downloaded.sha256, message: `Wazir ${available} passed CLI version verification.` });
    } catch (error) {
      record('ROLLING_BACK', initialVersion, { availableVersion: available, installMethod: method, message: error instanceof Error ? error.message : String(error) });
      try {
        restoreNpmBackup(backup, prefix);
        if (!validateNpmInstall(prefix, initialVersion)) throw new Error('Restored package failed version verification');
        return record('ROLLED_BACK', initialVersion, { availableVersion: available, installMethod: method, message: 'Activation failed; previous npm package restored and verified.' });
      } catch (rollbackError) {
        return record('FAILED', initialVersion, { availableVersion: available, installMethod: method, message: `Update failed (${error instanceof Error ? error.message : String(error)}); rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}).` });
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown update failure.';
    let failureStreak = 0;
    for (const entry of readUpdateHistory(200)) {
      if (entry.phase === 'FAILED') failureStreak++;
      else if (entry.phase === 'COMPLETED' || entry.phase === 'UP_TO_DATE') break;
    }
    const retrySeconds = Math.min(3600, 300 * (2 ** Math.min(failureStreak, 4)));
    return record('FAILED', initialVersion, { message: detail, retryAfter: new Date(Date.now() + retrySeconds * 1000).toISOString() });
  } finally { unlock(); }
}

export function listUpdateHistory(limit = 50): UpdateRecord[] { return readUpdateHistory(limit); }

async function rollbackUpdateLocked(): Promise<UpdateRecord> {
  const current = getBuildInfo().version;
  const method = detectInstallMethod();
  if (method === 'standalone-binary') {
    const backups = path.join(updateDir());
    const candidates = (await import('node:fs/promises')).readdir(backups).then((files) => files.filter((file) => file.startsWith('standalone-')).sort().reverse());
    const backup = path.join(backups, (await candidates)[0] ?? '');
    const match = /^standalone-(\d+\.\d+\.\d+)-/.exec(path.basename(backup));
    if (!match || !existsSync(backup)) return record('ACTION_REQUIRED', current, { installMethod: method, message: 'No verified standalone rollback binary is available.' });
    try {
      const target = realpathSync(process.execPath);
      accessSync(path.dirname(target), constants.W_OK);
      const temporary = `${target}.wazir-rollback-${process.pid}`;
      copyFileSync(backup, temporary); chmodSync(temporary, 0o755); renameSync(temporary, target);
      const checked = spawnSync(target, ['--version'], { encoding: 'utf8', timeout: 20_000 });
      if (checked.status !== 0 || checked.stdout.trim().replace(/^v/, '') !== match[1]) throw new Error('Restored standalone version did not pass validation');
      return record('ROLLED_BACK', match[1], { installMethod: method, message: `Restored and verified Wazir ${match[1]}.` });
    } catch (error) { return record('FAILED', current, { installMethod: method, message: error instanceof Error ? error.message : String(error) }); }
  }
  if (method !== 'npm') return record('ACTION_REQUIRED', current, { installMethod: method, message: actionRequired(method) });
  const prefix = await npmGlobalPrefix();
  const backups = path.join(updateDir(), 'backups');
  if (!prefix || !existsSync(backups)) return record('ACTION_REQUIRED', current, { installMethod: method, message: 'No verified npm rollback package is available.' });
  const candidates = (await import('node:fs/promises')).readdir(backups).then((files) => files.filter((file) => file.startsWith('npm-')).sort().reverse());
  const backup = path.join(backups, (await candidates)[0] ?? '');
  if (!existsSync(backup)) return record('ACTION_REQUIRED', current, { installMethod: method, message: 'No verified npm rollback package is available.' });
  const match = /^npm-(\d+\.\d+\.\d+)/.exec(path.basename(backup));
  if (!match) return record('ACTION_REQUIRED', current, { installMethod: method, message: 'Rollback backup version cannot be verified.' });
  try {
    restoreNpmBackup(backup, prefix);
    if (!validateNpmInstall(prefix, match[1]!)) throw new Error('Rollback version verification failed');
    return record('ROLLED_BACK', match[1]!, { installMethod: method, message: `Restored and verified Wazir ${match[1]}.` });
  } catch (error) { return record('FAILED', current, { installMethod: method, message: error instanceof Error ? error.message : String(error) }); }
}

export async function rollbackUpdate(): Promise<UpdateRecord> {
  const unlock = acquireUpdateLock();
  const version = getBuildInfo().version;
  if (!unlock) return record('ACTION_REQUIRED', version, { message: 'Another updater operation is active; rollback was not started.' });
  try {
    if (isJobActive()) return record('WAITING_FOR_SAFE_ACTIVATION', version, { message: 'A local Wazir task or interactive session is active; rollback was deferred.' });
    return await rollbackUpdateLocked();
  } finally { unlock(); }
}

export function getUpdateConfig(): UpdateConfig { return loadUpdateConfig(); }
