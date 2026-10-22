import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { GIT_NO_HOOKS, type KeyValueStore } from '@wazir/shared';
import { WorktreeManager, type WorktreeInfo } from './worktreeManager.js';
import { VerifiedIntegrationCoordinator } from './verifiedIntegrationCoordinator.js';

const exec = promisify(execFile);
export const RACE_PREFIX = 'competitive:v1:';
export type RaceState = 'CREATED' | 'SCHEDULING' | 'PREPARING' | 'RUNNING' | 'VERIFYING' | 'COMPARING' | 'WINNER_SELECTED' | 'AWAITING_MERGE' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED' | 'NO_VALID_WINNER' | 'RECOVERY_REQUIRED';
export type RoutingPreference = 'auto' | 'cheapest' | 'highest-quality';
export interface RaceConfiguration {
  id: string; agent: string; model: string; provider: string;
  /** A configured upper bound enforced by the runtime, never an invented charge. */
  maxCostUsd?: number;
  pricing: 'metered' | 'local' | 'subscription' | 'unknown';
  version?: string;
  agentVersion?: string;
  providerVersion?: string;
  allowHosted?: boolean;
}
export interface RaceCheck {
  name: string; passed: boolean; exitCode: number; durationMs: number; outputHash: string; output: string;
}
export interface RacePolicy {
  version: 1;
  /** Explicit source ownership. Empty ownership cannot produce a winner. */
  writablePaths: string[];
  protectedPaths: string[];
  checks: Array<{ name: string; oracle: 'BUILD' | 'TEST' | 'LINT' | 'TYPECHECK' | 'STATIC_ANALYSIS' | 'ACCEPTANCE'; file: string; args: string[] }>;
  /** Generated verifier outputs only; must not overlap tracked inputs. */
  verificationWritablePaths?: string[];
  maxConcurrency: number; timeoutMs: number; maxTurns: number; maxTokens: number;
  maxCostUsd?: number;
  progressive?: boolean;
}
export interface AttemptMeasurement {
  inputTokens?: number; outputTokens?: number; estimatedCostUsd?: number; quotaRequests?: number;
  firstOutputMs?: number; toolCalls?: number; toolFailures?: number;
}
export interface RaceAttempt {
  id: string; configuration: RaceConfiguration;
  state: 'CREATED' | 'RUNNING' | 'VERIFYING' | 'VERIFIED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED' | 'SKIPPED' | 'RECOVERY_REQUIRED';
  worktree?: WorktreeInfo; startedAt?: string; completedAt?: string; durationMs?: number;
  measurement?: AttemptMeasurement; headSha?: string; patch?: string; patchHash?: string;
  checks?: RaceCheck[]; violations?: string[]; failure?: string; reservedCostUsd?: number;
}
export interface RaceRecord {
  schemaVersion: 1; id: string; parentTaskId: string; task: string; repository: string; baselineCommit: string; targetBranch: string;
  state: RaceState; revision: number; owner: { pid: number; host: string };
  environment: { platform: string; architecture: string; nodeVersion: string; informationExchange: 'independent' };
  policy: RacePolicy; policyHash: string; configurations: RaceConfiguration[]; attempts: RaceAttempt[];
  createdAt: string; updatedAt: string; events: Array<{ at: string; state: RaceState; detail: string }>;
  winnerId?: string; explanation?: string; cancelRequested?: boolean;
  replayOf?: string; reproduction?: 'approximate'; routingRationale: string[];
  promotion?: { targetSha: string; rollbackSha: string; worktree: WorktreeInfo; checks: RaceCheck[]; patchHash: string; ready: boolean };
}
export interface CompetitiveExecutionDependencies {
  store: KeyValueStore; worktrees: WorktreeManager;
  /** Trusted controller adapter. Must stop all I/O before settling after cancellation. */
  run: (input: { attempt: RaceAttempt; task: string; policy: RacePolicy; signal: AbortSignal; event: (kind: string, detail: Record<string, unknown>) => Promise<void> }) => Promise<AttemptMeasurement>;
  /** Runs only controller-owned commands, in an independent clean baseline + candidate patch. */
  verify: (cwd: string, policy: RacePolicy, signal: AbortSignal) => Promise<RaceCheck[]>;
  finalize?: (race: RaceRecord, attempt: RaceAttempt) => Promise<void>;
}
const terminal = new Set<RaceState>(['AWAITING_MERGE', 'COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'NO_VALID_WINNER', 'RECOVERY_REQUIRED']);
const next: Partial<Record<RaceState, RaceState[]>> = {
  CREATED: ['SCHEDULING'], SCHEDULING: ['PREPARING'], PREPARING: ['RUNNING'], RUNNING: ['VERIFYING'],
  VERIFYING: ['COMPARING'], COMPARING: ['WINNER_SELECTED', 'NO_VALID_WINNER'], WINNER_SELECTED: ['AWAITING_MERGE'], AWAITING_MERGE: ['COMPLETED'],
};
export const raceHash = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Abort is a request, not proof of termination. Unsettled adapters retain their workspaces. */
async function settleOnAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => { timer = setTimeout(() => reject(new Error('RECOVERY_REQUIRED: adapter did not settle within cancellation grace')), 1000); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
export async function raceGit(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', [...GIT_NO_HOOKS, '-c', 'diff.external=', ...args], { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })).stdout.trim();
}
function within(file: string, prefix: string): boolean { return file === prefix || file.startsWith(prefix.replace(/\/$/, '') + '/'); }
export function protectedRacePath(file: string, policy: RacePolicy): boolean {
  return /(^|\/)(?:\.git[^/]*|\.wazir[^/]*|\.env[^/]*|tests?|__tests__|fixtures?|scripts|node_modules)(\/|$)|(?:^|\/)(?:package[^/]*\.json|[^/]*lock[^/]*|[^/]*config[^/]*|AGENTS\.md|SKILL\.md)$|\.(?:test|spec)\.[^/]+$/i.test(file)
    || policy.protectedPaths.some(p => within(file, p));
}
export function validateRacePolicy(p: RacePolicy): void {
  if (p.version !== 1 || !p.checks?.length || !p.writablePaths?.length || !Array.isArray(p.protectedPaths)) throw new Error('race requires versioned trusted checks and explicit writablePaths/protectedPaths');
  for (const n of [p.timeoutMs, p.maxTurns, p.maxTokens, p.maxConcurrency]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error('race resource limits must be positive integers');
  if (p.maxConcurrency > 8) throw new Error('race concurrency exceeds hard limit 8');
  if (p.maxCostUsd !== undefined && (!Number.isFinite(p.maxCostUsd) || p.maxCostUsd < 0)) throw new Error('invalid dollar budget');
  const names = new Set<string>();
  for (const check of p.checks) {
    if (!check.name || names.has(check.name) || !check.file || !Array.isArray(check.args) || check.args.some(a => typeof a !== 'string') || !['BUILD', 'TEST', 'LINT', 'TYPECHECK', 'STATIC_ANALYSIS', 'ACCEPTANCE'].includes(check.oracle)) throw new Error('checks require unique names and executable/argument arrays');
    names.add(check.name);
  }
  for (const file of [...p.writablePaths, ...p.protectedPaths, ...(p.verificationWritablePaths ?? [])]) if (!file || file === '.' || path.isAbsolute(file) || file.split(/[\\/]/).some(p => p === '..' || p === '.git') || file.includes('\\')) throw new Error('ownership paths must be normalized repository-relative paths');
}
export function eligibleAttempt(attempt: RaceAttempt, policy: RacePolicy): boolean {
  return attempt.state === 'VERIFIED' && !!attempt.patchHash && !!attempt.headSha && !attempt.violations?.length
    && policy.checks.every(c => attempt.checks?.filter(e => e.name === c.name && e.passed && e.exitCode === 0 && !!e.outputHash).length === 1);
}
/** Hard gates first; equivalent trusted gates tie on comparable observed cost, then latency and id.
 * Patch size is never used as a quality proxy. Missing prices are never treated as zero. */
export function rankRace(attempts: RaceAttempt[], policy: RacePolicy): RaceAttempt[] {
  const valid = attempts.filter(a => eligibleAttempt(a, policy));
  const costsComparable = valid.every(a => a.measurement?.estimatedCostUsd !== undefined);
  return valid.sort((a, b) => (costsComparable ? a.measurement!.estimatedCostUsd! - b.measurement!.estimatedCostUsd! : 0)
    || (a.durationMs ?? Infinity) - (b.durationMs ?? Infinity) || a.id.localeCompare(b.id));
}

export class CompetitiveExecution {
  constructor(private readonly deps: CompetitiveExecutionDependencies) {
    if (!deps.store.update) throw new Error('competitive execution requires atomic KeyValueStore.update');
  }
  async get(id: string): Promise<RaceRecord> {
    if (!/^race-[0-9a-f-]{36}$/.test(id)) throw new Error('invalid race id');
    const record = await this.deps.store.get<RaceRecord>(RACE_PREFIX + id);
    if (!record || record.schemaVersion !== 1) throw new Error('race not found or unsupported schema');
    return record;
  }
  async list(): Promise<RaceRecord[]> { return (await this.deps.store.list(RACE_PREFIX)).map(e => e.value as RaceRecord); }
  private async mutate(id: string, fn: (record: RaceRecord) => void): Promise<RaceRecord> {
    return this.deps.store.update!<RaceRecord>(RACE_PREFIX + id, record => {
      if (!record || record.schemaVersion !== 1) throw new Error('race not found');
      fn(record); record.revision++; record.updatedAt = new Date().toISOString(); return record;
    });
  }
  private async transition(id: string, state: RaceState, detail: string): Promise<RaceRecord> {
    return this.mutate(id, r => {
      if (r.state === state) return;
      if (terminal.has(r.state) && !(r.state === 'AWAITING_MERGE' && state === 'COMPLETED')) throw new Error(`race already stopped: ${r.state}`);
      if (!['FAILED', 'CANCELLED', 'TIMED_OUT', 'RECOVERY_REQUIRED'].includes(state) && !next[r.state]?.includes(state)) throw new Error(`invalid transition ${r.state} -> ${state}`);
      r.state = state; r.events.push({ at: new Date().toISOString(), state, detail });
    });
  }
  private async attempt(id: string, attemptId: string, update: Partial<RaceAttempt>): Promise<void> {
    await this.mutate(id, r => { Object.assign(r.attempts.find(a => a.id === attemptId)!, update); });
  }
  async create(input: { repository: string; task: string; configurations: RaceConfiguration[]; policy: RacePolicy; parentTaskId?: string; baselineCommit?: string; replayOf?: string; routingRationale?: string[] }): Promise<RaceRecord> {
    validateRacePolicy(input.policy);
    if (!input.task.trim() || !input.configurations.length || input.configurations.length > 8) throw new Error('race requires 1 to 8 configurations and a task');
    const ids = new Set<string>();
    for (const c of input.configurations) {
      if (!c.id || ids.has(c.id) || !c.model || !c.agent || !c.provider || !['metered', 'local', 'subscription', 'unknown'].includes(c.pricing)) throw new Error('invalid or duplicate agent configuration');
      ids.add(c.id);
      if (c.maxCostUsd !== undefined && (!Number.isFinite(c.maxCostUsd) || c.maxCostUsd < 0)) throw new Error('invalid configured reservation');
      if (input.policy.maxCostUsd !== undefined && c.pricing !== 'local' && (c.pricing !== 'metered' || c.maxCostUsd === undefined)) throw new Error('dollar budget requires usable pricing and an enforced upper bound; subscription quota is separate');
    }
    const repository = await fs.realpath(input.repository);
    const baselineCommit = await raceGit(repository, ['rev-parse', '--verify', `${input.baselineCommit ?? 'HEAD'}^{commit}`]);
    const targetBranch = await this.deps.worktrees.getCurrentBranch(repository);
    const id = `race-${randomUUID()}`; const now = new Date().toISOString();
    const record: RaceRecord = {
      schemaVersion: 1, id, parentTaskId: input.parentTaskId ?? id, task: input.task, repository, baselineCommit, targetBranch,
      state: 'CREATED', revision: 0, owner: { pid: process.pid, host: os.hostname() }, policy: structuredClone(input.policy), policyHash: raceHash(JSON.stringify(input.policy)),
      environment: { platform: process.platform, architecture: process.arch, nodeVersion: process.version, informationExchange: 'independent' },
      configurations: structuredClone(input.configurations), attempts: input.configurations.map((configuration, i) => ({ id: `${id}-${i}`, configuration: structuredClone(configuration), state: 'CREATED' })),
      createdAt: now, updatedAt: now, events: [{ at: now, state: 'CREATED', detail: 'immutable task baseline and trusted policy captured; independent mode' }],
      replayOf: input.replayOf, reproduction: input.replayOf ? 'approximate' : undefined, routingRationale: input.routingRationale ?? ['existing scheduler eligibility; independent racing'],
    };
    await this.deps.store.put(RACE_PREFIX + id, record); return record;
  }
  async run(id: string): Promise<RaceRecord> {
    // Atomic claim prevents two coordinators from dispatching a CREATED race twice.
    const claimed = await this.mutate(id, r => {
      if (r.state !== 'CREATED') throw new Error('race already claimed; recover interrupted races without re-dispatch');
      r.state = 'SCHEDULING'; r.owner = { pid: process.pid, host: os.hostname() };
      r.events.push({ at: new Date().toISOString(), state: r.state, detail: 'coordinator claimed race' });
    });
    const controller = new AbortController();
    if (claimed.cancelRequested) controller.abort(new Error('CANCELLED'));
    const deadline = setTimeout(() => controller.abort(new Error('TIMED_OUT')), claimed.policy.timeoutMs);
    let polling = false;
    const poll = setInterval(() => {
      if (polling) return; polling = true;
      void this.get(id).then(r => { if (r.cancelRequested) controller.abort(new Error('CANCELLED')); }).catch(() => controller.abort(new Error('persistence unavailable'))).finally(() => { polling = false; });
    }, 100);
    try {
      await this.transition(id, 'PREPARING', 'creating worktrees at the captured commit');
      // Persist intent before each filesystem mutation. Unique ids prevent branch reuse.
      for (const a of claimed.attempts) {
        controller.signal.throwIfAborted();
        const worktree = await this.deps.worktrees.createWorktree(claimed.repository, id, a.id.slice(-1), claimed.baselineCommit);
        await this.attempt(id, a.id, { worktree });
      }
      await this.transition(id, 'RUNNING', 'isolated attempts dispatched with bounded concurrency');
      let cursor = 0; let reserved = 0; let stop = false;
      const worker = async () => {
        for (;;) {
          const index = cursor++; const a = (await this.get(id)).attempts[index];
          if (!a) break;
          if (stop || controller.signal.aborted) { await this.attempt(id, a.id, { state: 'SKIPPED', failure: 'escalation stopped or race aborted' }); continue; }
          const reserve = a.configuration.maxCostUsd ?? 0;
          if (claimed.policy.maxCostUsd !== undefined && reserved + reserve > claimed.policy.maxCostUsd) { await this.attempt(id, a.id, { state: 'SKIPPED', failure: 'BUDGET_EXCEEDED' }); continue; }
          // Conservatively retain reservations until the race ends, even on missing usage.
          reserved += reserve;
          await this.attempt(id, a.id, { reservedCostUsd: a.configuration.maxCostUsd });
          await this.executeAttempt(claimed, a, controller.signal);
          if (claimed.policy.progressive && eligibleAttempt((await this.get(id)).attempts[index], claimed.policy)) stop = true;
        }
      };
      const workers = await Promise.allSettled(Array.from({ length: claimed.policy.progressive ? 1 : Math.min(claimed.policy.maxConcurrency, claimed.attempts.length) }, () => worker().catch(e => { controller.abort(e); throw e; })));
      const failedWorker = workers.find((w): w is PromiseRejectedResult => w.status === 'rejected');
      if (failedWorker) throw failedWorker.reason;
      controller.signal.throwIfAborted();
      const observed = await this.get(id);
      if (observed.attempts.some(a => a.state === 'RECOVERY_REQUIRED')) return this.transition(id, 'RECOVERY_REQUIRED', 'an adapter did not settle after cancellation; worktrees retained');
      await this.transition(id, 'VERIFYING', 'independent evidence collected for all completed attempts');
      await this.transition(id, 'COMPARING', 'mandatory evidence gates precede ranking');
      const ranked = rankRace((await this.get(id)).attempts, claimed.policy);
      if (!ranked.length) return this.transition(id, 'NO_VALID_WINNER', 'no candidate satisfied every mandatory gate');
      await this.mutate(id, r => { r.winnerId = ranked[0].id; r.explanation = 'Passed all mandatory trusted checks and ownership policy. Among equally verified candidates: comparable measured cost, then measured duration, then lexicographic attempt id. No diff-size or model-claimed quality score.'; });
      await this.transition(id, 'WINNER_SELECTED', `selected ${ranked[0].id}`);
      return this.transition(id, 'AWAITING_MERGE', 'candidate branch and patch retained; target unchanged; promotion requires new verification');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const r = await this.get(id);
      if (terminal.has(r.state)) return r;
      const state = r.attempts.some(a => a.state === 'RECOVERY_REQUIRED') ? 'RECOVERY_REQUIRED' : controller.signal.aborted ? (r.cancelRequested ? 'CANCELLED' : String(controller.signal.reason).includes('TIMED_OUT') ? 'TIMED_OUT' : 'FAILED') : 'FAILED';
      return this.transition(id, state, message);
    } finally { clearTimeout(deadline); clearInterval(poll); }
  }
  private async executeAttempt(r: RaceRecord, a: RaceAttempt, signal: AbortSignal): Promise<void> {
    const started = Date.now(); const cwd = a.worktree!.worktreeDir;
    await this.attempt(r.id, a.id, { state: 'RUNNING', startedAt: new Date(started).toISOString() });
    try {
      const measurement = await settleOnAbort(this.deps.run({ attempt: a, task: r.task, policy: r.policy, signal, event: async (kind, detail) => {
        // Adapters emit metadata only; never credentials, tool inputs or raw prompts.
        await this.deps.store.put(`competitive-event:v1:${a.id}:${randomUUID()}`, { attemptId: a.id, at: new Date().toISOString(), kind, detail });
      } }), signal);
      signal.throwIfAborted();
      if (r.policy.maxCostUsd !== undefined && a.configuration.pricing === 'metered' && (measurement.estimatedCostUsd === undefined || measurement.estimatedCostUsd > a.configuration.maxCostUsd!)) throw new Error('missing cost evidence or configured upper bound exceeded');
      for (const value of Object.values(measurement)) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('invalid telemetry');
      await this.attempt(r.id, a.id, { measurement });
      // Agent tools cannot access Git. Controller captures all tracked/untracked changes.
      await raceGit(cwd, ['add', '-A', '--', '.']);
      const files = (await raceGit(cwd, ['diff', '--cached', '--name-only', '-z', r.baselineCommit])).split('\0').filter(Boolean);
      const violations = files.filter(f => protectedRacePath(f, r.policy) || !r.policy.writablePaths.some(p => within(f, p)));
      const modes = await raceGit(cwd, ['diff', '--cached', '--raw', r.baselineCommit]);
      if (/\b(?:120000|160000)\b/.test(modes)) violations.push('symlinks and submodules are prohibited');
      if (!files.length) violations.push('no candidate patch');
      await this.attempt(r.id, a.id, { violations });
      if (violations.length) throw new Error('POLICY_VIOLATION: protected or unauthorized modifications');
      await raceGit(cwd, ['-c', 'user.name=Wazir', '-c', 'user.email=wazir@localhost', 'commit', '--no-gpg-sign', '-m', `Competitive attempt ${a.id}`]);
      const headSha = await raceGit(cwd, ['rev-parse', 'HEAD']);
      // Do not trim patch bytes (Git's binary patch format is byte-sensitive).
      const patch = (await exec('git', [...GIT_NO_HOOKS, 'diff', '--no-ext-diff', '--no-textconv', '--binary', r.baselineCommit, headSha], { cwd, maxBuffer: 16 * 1024 * 1024 })).stdout;
      const patchHash = raceHash(patch);
      await this.attempt(r.id, a.id, { state: 'VERIFYING', headSha, patch, patchHash });
      const checks = await this.verifyPatch(r, patch, r.baselineCommit, signal);
      const passes = r.policy.checks.every(c => checks.filter(e => e.name === c.name && e.passed && e.exitCode === 0 && !!e.outputHash).length === 1);
      await this.attempt(r.id, a.id, { checks, state: passes ? 'VERIFIED' : 'FAILED', failure: passes ? undefined : 'VERIFICATION_FAILED' });
    } catch (e) {
      const failure = e instanceof Error ? e.message : String(e);
      await this.attempt(r.id, a.id, { state: failure.startsWith('RECOVERY_REQUIRED:') ? 'RECOVERY_REQUIRED' : signal.aborted ? (String(signal.reason).includes('CANCELLED') ? 'CANCELLED' : String(signal.reason).includes('TIMED_OUT') ? 'TIMED_OUT' : 'FAILED') : 'FAILED', failure });
    } finally {
      await this.attempt(r.id, a.id, { completedAt: new Date().toISOString(), durationMs: Date.now() - started });
      await this.deps.finalize?.(r, (await this.get(r.id)).attempts.find(result => result.id === a.id)!);
    }
  }
  private async verifyPatch(r: RaceRecord, patch: string, baseline: string, signal: AbortSignal): Promise<RaceCheck[]> {
    const info = await this.deps.worktrees.createWorktree(r.repository, `verify-${randomUUID()}`, undefined, baseline);
    try {
      const patchFile = path.join(info.worktreeDir, '.wazir', 'candidate.patch');
      await fs.writeFile(patchFile, patch, { mode: 0o600 });
      await raceGit(info.worktreeDir, ['apply', '--index', '--whitespace=nowarn', patchFile]);
      // The verifier owns process termination. Never destroy a directory under a live verifier.
      return await this.deps.verify(info.worktreeDir, structuredClone(r.policy), signal);
    } finally { await this.deps.worktrees.removeWorktree(info); }
  }
  async cancel(id: string): Promise<RaceRecord> {
    return this.mutate(id, r => { if (!terminal.has(r.state)) r.cancelRequested = true; });
  }
  /** Fail closed after a dead coordinator. Never rerun uncertain side effects. */
  async recover(id: string): Promise<RaceRecord> {
    const r = await this.get(id); if (terminal.has(r.state)) return r;
    if (r.owner.host !== os.hostname()) throw new Error('foreign owner; explicit host fencing is required');
    try { process.kill(r.owner.pid, 0); throw new Error('coordinator is still alive; recovery refused'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    return this.transition(id, 'RECOVERY_REQUIRED', 'owner is dead; uncertain attempts retained; no duplicate execution. Fence orphan processes before cleanup or replay.');
  }
  async cleanup(id: string): Promise<void> {
    const r = await this.get(id);
    if (!terminal.has(r.state) || r.state === 'RECOVERY_REQUIRED') throw new Error('active or uncertain executions cannot be cleaned');
    for (const a of r.attempts) if (a.worktree) await this.deps.worktrees.removeWorktree(a.worktree);
    if (r.promotion) await this.deps.worktrees.removeWorktree(r.promotion.worktree);
    await this.mutate(id, record => { record.events.push({ at: new Date().toISOString(), state: record.state, detail: 'worktrees removed; candidate branches, patches, telemetry and rollback refs retained' }); });
  }
  async replay(id: string, configurations: RaceConfiguration[]): Promise<RaceRecord> {
    const r = await this.get(id);
    const copy = await this.create({ repository: r.repository, task: r.task, configurations, policy: r.policy, parentTaskId: r.parentTaskId, baselineCommit: r.baselineCommit, replayOf: id });
    return this.run(copy.id);
  }
  /** Prepare for approval only. Never update the target branch or push. */
  async promote(id: string): Promise<RaceRecord> {
    const r = await this.get(id);
    if (r.state !== 'AWAITING_MERGE') throw new Error('race is not awaiting review');
    const winner = r.attempts.find(a => a.id === r.winnerId)!;
    if (!eligibleAttempt(winner, r.policy) || raceHash(winner.patch!) !== winner.patchHash) throw new Error('winner evidence or patch is invalid');
    const targetSha = await raceGit(r.repository, ['rev-parse', '--verify', `${r.targetBranch}^{commit}`]);
    // Reuse the integration coordinator's manifests, merge conflict checks, drift
    // fencing, and fresh combined-result evidence rather than a second merge workflow.
    const coordinator = new VerifiedIntegrationCoordinator({
      candidateRootDir: path.join(os.tmpdir(), 'wazir-race-integration', '.wazir', 'worktrees', raceHash(r.repository).slice(0, 16)),
      requiredChecks: r.policy.checks.map(c => c.name), protectedPaths: r.policy.protectedPaths,
    });
    const manifestTree = await this.deps.worktrees.createWorktree(r.repository, `manifest-${randomUUID()}`, undefined, winner.headSha);
    try {
      const manifest = await coordinator.createManifest(manifestTree.worktreeDir, {
        taskId: winner.id, agentId: winner.configuration.agent, targetBranch: r.targetBranch,
        declaredOwnership: r.policy.writablePaths, fileChanges: [], outstandingRisks: [],
        testsExecuted: winner.checks!.map(c => ({ name: c.name, command: c.name, status: c.passed ? 'PASS' : 'FAIL', sourceSha: winner.headSha!, runId: winner.id, runnerId: 'competitive-verifier', exitCode: c.exitCode, resultSha256: c.outputHash, startedAt: winner.startedAt!, completedAt: winner.completedAt! })),
        verificationEvidence: winner.checks!.map(c => ({ id: `${winner.id}:${c.name}`, status: c.passed ? 'PASS' : 'FAIL', sourceSha: winner.headSha!, resultSha256: c.outputHash })),
      });
      let checks: RaceCheck[] = [];
      const report = await coordinator.qualify(r.repository, {
        targetBranch: r.targetBranch, expectedTargetSha: targetSha, candidates: [{ branch: manifest.branch, manifest }],
        verifyCandidate: async cwd => {
          // Coordinator candidates do not create private HOME/TMP directories by default.
          for (const name of ['home', 'tmp']) await fs.mkdir(path.join(cwd, '.wazir', name), { recursive: true });
          checks = await this.deps.verify(cwd, structuredClone(r.policy), AbortSignal.timeout(r.policy.timeoutMs));
          const sourceSha = await raceGit(cwd, ['rev-parse', 'HEAD']);
          return checks.map(c => ({ name: c.name, status: c.passed ? 'PASS' as const : 'FAIL' as const, sourceSha, executionId: `${r.id}:promotion`, completedAt: new Date().toISOString(), resultSha256: c.outputHash }));
        },
      });
      const worktree: WorktreeInfo = { jobId: report.integrationId, worktreeDir: report.candidatePath, branch: 'HEAD', baseBranch: r.targetBranch, baseSha: targetSha, isGit: true, createdAt: new Date() };
      return this.mutate(id, record => {
        record.promotion = { targetSha, rollbackSha: targetSha, worktree, checks, patchHash: winner.patchHash!, ready: report.state === 'READY' };
        record.events.push({ at: new Date().toISOString(), state: record.state, detail: `integration ${report.integrationId}: ${report.state}; ${report.error ?? 'fresh verification passed; human approval required; target unchanged'}` });
      });
    } finally { await this.deps.worktrees.removeWorktree(manifestTree); }
  }

  async export(id: string, format: 'json' | 'csv'): Promise<string> {
    const r = await this.get(id);
    if (format === 'json') return JSON.stringify({ ...r, toolEvents: (await this.deps.store.list('competitive-event:v1:')).filter(e => (e.value as { attemptId: string }).attemptId.startsWith(r.id)) }, null, 2);
    const quote = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;
    return [['race', 'attempt', 'agent', 'model', 'state', 'durationMs', 'inputTokens', 'outputTokens', 'estimatedCostUsd', 'winner'], ...r.attempts.map(a => [r.id, a.id, a.configuration.agent, a.configuration.model, a.state, a.durationMs, a.measurement?.inputTokens, a.measurement?.outputTokens, a.measurement?.estimatedCostUsd, a.id === r.winnerId])].map(row => row.map(quote).join(',')).join('\n');
  }
}
