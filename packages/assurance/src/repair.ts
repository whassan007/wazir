/**
 * Counterexample-guided repair loop and regression obligations
 * (FORMAL_ASSURANCE.md §2.5, DESIGN.md §2.3, DESIGN_REVIEW.md Finding 8).
 *
 * Acceptance is defined by the spec's obligations, never by agent-written tests:
 *
 *  1. The implementation task produces a commit in its worktree. `specs/` is frozen: its content hash is taken
 *     before every worker turn, the tree is made read-only, and after the turn both the working-tree hash and the
 *     committed diff are checked. Any spec change rejects the attempt (`spec_tampered`), fail closed.
 *  2. Every spec obligation and every stored regression obligation runs against a snapshot of that exact commit.
 *  3. `COUNTEREXAMPLE` / `FALSIFIED` produce a repair task that carries the concrete witness.
 *  4. Before the repair task exists, each witness is written as a permanent regression obligation in a
 *     {@link RegressionObligationStore} rooted outside every disposable worktree.
 *  5. At most `maxRepairAttempts` (k, default 3) repairs; then the loop stops and reports every witness.
 *     The budget is persisted per run id so a restart cannot reset it.
 *  6. A new revision invalidates all prior evidence; everything, including regressions, re-runs on it.
 *  7. VerifAI campaigns are re-checked on the final revision with fresh holdout seeds that were never disclosed
 *     to a repair task. A holdout `FALSIFIED` becomes a regression and re-enters repair; the next final check
 *     draws new seeds.
 *
 * This module never fabricates verdicts: it only routes what adapters return. A missing adapter is `NOT_RUN`.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { FormalTool, Obligation, SolverAdapter, VerificationResult, Verdict } from './contracts';
import { canonicalSerialize, EvidenceLedger, LedgerEntry } from './ledger';

export const DEFAULT_MAX_REPAIR_ATTEMPTS = 3;
export const DEFAULT_HOLDOUT_SEEDS_PER_CHECK = 3;

/** Verdicts that carry a concrete, repairable witness. */
export const REPAIRABLE_VERDICTS: readonly Verdict[] = [Verdict.COUNTEREXAMPLE, Verdict.FALSIFIED];

export function isRepairableVerdict(verdict: Verdict): boolean {
  return REPAIRABLE_VERDICTS.includes(verdict);
}

/** Verdicts an obligation must reach for the loop to accept a revision. Everything else blocks. */
const ACCEPTED_VERDICTS: readonly Verdict[] = [Verdict.PROVED, Verdict.BOUNDED_PASS, Verdict.NOT_FALSIFIED];

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Detach to plain JSON; drops undefined, maps non-finite numbers to strings so the ledger accepts it. */
function toPlainJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v)),
  );
}

// ---------------------------------------------------------------------------
// Spec freezing
// ---------------------------------------------------------------------------

/**
 * Content hash of a directory tree: relative path, entry kind and bytes of every file/symlink, sorted.
 * A missing directory hashes to a distinct marker so creating `specs/` is also a detected change.
 */
export function hashSpecsTree(dir: string): string {
  const h = createHash('sha256');
  if (!existsSync(dir)) return 'sha256:' + sha256Hex('<absent>');
  const visit = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const rel = relative(dir, full).split(sep).join('/');
      const st = lstatSync(full);
      if (st.isSymbolicLink()) h.update(`L\0${rel}\0${readlinkSync(full)}\0`);
      else if (st.isDirectory()) {
        h.update(`D\0${rel}\0`);
        visit(full);
      } else if (st.isFile()) {
        h.update(`F\0${rel}\0${st.mode & 0o111 ? 'x' : '-'}\0`);
        h.update(readFileSync(full));
        h.update('\0');
      } else h.update(`O\0${rel}\0`);
    }
  };
  visit(dir);
  return 'sha256:' + h.digest('hex');
}

/** Make a tree read-only (or writable again). Defence in depth only: the hash check is the enforcement. */
export function setTreeWritable(dir: string, writable: boolean): void {
  if (!existsSync(dir)) return;
  const apply = (path: string) => {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      if (writable) chmodSync(path, st.mode | 0o200);
      for (const name of readdirSync(path)) apply(join(path, name));
      if (!writable) chmodSync(path, st.mode & ~0o222);
    } else chmodSync(path, writable ? st.mode | 0o200 : st.mode & ~0o222);
  };
  apply(dir);
}

export class SpecTamperError extends Error {
  constructor(
    message: string,
    readonly details: { expectedHash: string; observedHash?: string; changedSpecPaths?: string[] },
  ) {
    super(message);
    this.name = 'SpecTamperError';
  }
}

// ---------------------------------------------------------------------------
// Workspace (exact-revision snapshots)
// ---------------------------------------------------------------------------

export interface RevisionRef {
  /** Human label, e.g. `rev-1-buggy`; recorded as the ledger `workspaceRev`. */
  label: string;
  /** Exact commit id; recorded as the ledger `sourceCommit`. */
  commit: string;
}

export interface WorkspaceVcs {
  /** The worker's worktree. */
  readonly dir: string;
  head(): string;
  /** Paths changed between two commits (repo-relative, `/`-separated). */
  changedPaths(fromCommit: string, toCommit: string): string[];
  /** Materialise exactly `commit` into a fresh directory; the caller removes it. */
  snapshot(commit: string): string;
}

function git(cwd: string, args: string[], input?: Buffer): Buffer {
  const r = spawnSync('git', args, { cwd, input, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

/** Git-backed workspace. Snapshots use `git archive`, so uncommitted edits can never leak into evidence. */
export class GitWorkspace implements WorkspaceVcs {
  constructor(readonly dir: string) {}

  static init(dir: string, author = { name: 'wazir-assurance', email: 'assurance@wazir.local' }): GitWorkspace {
    mkdirSync(dir, { recursive: true });
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.name', author.name]);
    git(dir, ['config', 'user.email', author.email]);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    return new GitWorkspace(dir);
  }

  head(): string {
    return git(this.dir, ['rev-parse', 'HEAD']).toString().trim();
  }

  /** Stage everything and commit; returns the new commit id. */
  commitAll(message: string, tag?: string): string {
    git(this.dir, ['add', '-A']);
    git(this.dir, ['commit', '-q', '--allow-empty', '-m', message]);
    if (tag) git(this.dir, ['tag', '-f', tag]);
    return this.head();
  }

  changedPaths(fromCommit: string, toCommit: string): string[] {
    if (fromCommit === toCommit) return [];
    return git(this.dir, ['diff', '--name-only', '--no-renames', fromCommit, toCommit])
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  snapshot(commit: string): string {
    const out = mkdtempSync(join(tmpdir(), 'wazir-rev-'));
    const archive = git(this.dir, ['archive', '--format=tar', commit]);
    const r = spawnSync('tar', ['-x', '-C', out], { input: archive });
    if (r.status !== 0) throw new Error(`tar extract failed: ${r.stderr?.toString()}`);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Regression obligations (permanent, outside worktrees)
// ---------------------------------------------------------------------------

export interface RegressionObligation {
  /** sha256 over the canonical content below (excluding `id`, `contentHash`). */
  id: string;
  propertyId: string;
  specHash: string;
  specVersion: string;
  tool: FormalTool;
  /** Verdict that created it (`COUNTEREXAMPLE` / `FALSIFIED`). */
  originVerdict: Verdict;
  /** Obligation that produced the witness; replayed (with the witness pinned) on every later revision. */
  originObligation: Obligation;
  originRevision: RevisionRef;
  originInputHash: string;
  witness: unknown;
  /** True when the witness came from a withheld holdout seed. */
  fromHoldout: boolean;
  createdAt: string;
  /** sha256 of the canonical record; checked on every read. */
  contentHash: string;
}

export class RegressionStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegressionStoreIntegrityError';
  }
}

export interface RegressionObligationStoreOptions {
  /**
   * Disposable worktrees (and any repo checkout a worker can write). The store root must not be inside any of
   * them; otherwise a repair worker could delete or rewrite its own regressions.
   */
  forbiddenRoots?: readonly string[];
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realOrResolved(parent), relative(parent, path));
  }
}

/**
 * Append-only store of regression obligations, laid out as
 * `<root>/regressions/<propertyId>/<id>.json` with an append-only `index.jsonl`.
 *
 *  - Files are created exclusively (`wx`) and made read-only; an existing id is never overwritten.
 *  - Every read re-hashes each record and checks the index, so an edited or deleted regression is an error,
 *    not a silently shorter list.
 *  - Regressions are bound to `(propertyId, specHash)`; they retire with the spec revision, never by deletion.
 *  - The repair budget and the holdout-seed ledger also live here, so restarts cannot reset either.
 */
export class RegressionObligationStore {
  readonly root: string;

  constructor(root: string, options: RegressionObligationStoreOptions = {}) {
    this.root = resolve(root);
    const realRoot = realOrResolved(this.root);
    for (const forbidden of options.forbiddenRoots ?? []) {
      const realForbidden = realOrResolved(resolve(forbidden));
      if (isInside(realRoot, realForbidden)) {
        throw new Error(`Regression store ${this.root} must live outside disposable worktree ${forbidden}`);
      }
    }
    mkdirSync(join(this.root, 'regressions'), { recursive: true });
  }

  private get indexPath(): string {
    return join(this.root, 'regressions', 'index.jsonl');
  }

  private withLock<T>(fn: () => T): T {
    const lock = join(this.root, '.lock');
    const fd = openSync(lock, 'wx');
    try {
      return fn();
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }

  private static contentOf(r: Omit<RegressionObligation, 'id' | 'contentHash'> | RegressionObligation) {
    const { id: _id, contentHash: _hash, ...content } = r as RegressionObligation;
    return content;
  }

  private static safeSegment(value: string): string {
    return value.replace(/[^A-Za-z0-9_.-]/g, '_');
  }

  /**
   * Save a witness permanently. Idempotent: the same witness for the same property/spec/tool/obligation returns
   * the existing record instead of writing a duplicate.
   */
  save(input: Omit<RegressionObligation, 'id' | 'contentHash' | 'createdAt'> & { createdAt?: string }): RegressionObligation {
    const identity = canonicalSerialize(
      toPlainJson({
        propertyId: input.propertyId,
        specHash: input.specHash,
        tool: input.tool,
        obligationId: input.originObligation.id,
        witness: input.witness,
      }),
    );
    const id = sha256Hex(identity);
    return this.withLock(() => {
      const existing = this.get(input.propertyId, id);
      if (existing) return existing;
      const content = toPlainJson({ ...input, createdAt: input.createdAt ?? new Date().toISOString() }) as Omit<
        RegressionObligation,
        'id' | 'contentHash'
      >;
      const contentHash = 'sha256:' + sha256Hex(canonicalSerialize(content));
      const record: RegressionObligation = { ...content, id, contentHash };
      const dir = join(this.root, 'regressions', RegressionObligationStore.safeSegment(input.propertyId));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${id}.json`);
      writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
      writeFileSync(
        this.indexPath,
        JSON.stringify({ id, propertyId: input.propertyId, contentHash }) + '\n',
        { flag: 'a' },
      );
      return record;
    });
  }

  private readRecord(path: string): RegressionObligation {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RegressionObligation;
    const expected = 'sha256:' + sha256Hex(canonicalSerialize(RegressionObligationStore.contentOf(record)));
    const expectedId = sha256Hex(
      canonicalSerialize(
        toPlainJson({
          propertyId: record.propertyId,
          specHash: record.specHash,
          tool: record.tool,
          obligationId: record.originObligation?.id,
          witness: record.witness,
        }),
      ),
    );
    if (record.contentHash !== expected || record.id !== expectedId || !path.endsWith(`${record.id}.json`)) {
      throw new RegressionStoreIntegrityError(`Regression record tampered: ${path}`);
    }
    return record;
  }

  get(propertyId: string, id: string): RegressionObligation | undefined {
    const path = join(this.root, 'regressions', RegressionObligationStore.safeSegment(propertyId), `${id}.json`);
    return existsSync(path) ? this.readRecord(path) : undefined;
  }

  /** Every stored regression, verified against its own hash and the append-only index. */
  list(filter: { propertyId?: string; specHash?: string } = {}): RegressionObligation[] {
    const index = existsSync(this.indexPath)
      ? readFileSync(this.indexPath, 'utf8')
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as { id: string; propertyId: string; contentHash: string })
      : [];
    const out: RegressionObligation[] = [];
    const seen = new Set<string>();
    for (const entry of index) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const record = this.get(entry.propertyId, entry.id);
      if (!record) throw new RegressionStoreIntegrityError(`Regression ${entry.id} (${entry.propertyId}) was deleted`);
      if (record.contentHash !== entry.contentHash) {
        throw new RegressionStoreIntegrityError(`Regression ${entry.id} does not match its index entry`);
      }
      out.push(record);
    }
    // Files the index does not know about were not written through save(); refuse them.
    const base = join(this.root, 'regressions');
    for (const dir of readdirSync(base)) {
      const full = join(base, dir);
      if (!statSync(full).isDirectory()) continue;
      for (const file of readdirSync(full)) {
        if (file.endsWith('.json') && !seen.has(file.slice(0, -5))) {
          throw new RegressionStoreIntegrityError(`Unindexed regression file: ${join(full, file)}`);
        }
      }
    }
    return out.filter(
      (r) =>
        (filter.propertyId === undefined || r.propertyId === filter.propertyId) &&
        (filter.specHash === undefined || r.specHash === filter.specHash),
    );
  }

  count(filter: { propertyId?: string; specHash?: string } = {}): number {
    return this.list(filter).length;
  }

  // ---- repair budget (persisted per run id; Finding 8) ----

  private budgetPath(runId: string): string {
    return join(this.root, 'budget', `${RegressionObligationStore.safeSegment(runId)}.json`);
  }

  repairAttemptsUsed(runId: string): number {
    const path = this.budgetPath(runId);
    if (!existsSync(path)) return 0;
    const n = (JSON.parse(readFileSync(path, 'utf8')) as { attempts: number }).attempts;
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }

  /** Consume one repair attempt; returns the new count. */
  consumeRepairAttempt(runId: string): number {
    return this.withLock(() => {
      const next = this.repairAttemptsUsed(runId) + 1;
      this.atomicWrite(this.budgetPath(runId), JSON.stringify({ attempts: next }));
      return next;
    });
  }

  // ---- holdout seed ledger ----

  private holdoutPath(propertyId: string): string {
    return join(this.root, 'holdout', `${RegressionObligationStore.safeSegment(propertyId)}.json`);
  }

  /** Seeds already disclosed (repair campaigns, regressions) or consumed by an earlier holdout check. */
  usedSeeds(propertyId: string): Set<number> {
    const path = this.holdoutPath(propertyId);
    if (!existsSync(path)) return new Set();
    return new Set((JSON.parse(readFileSync(path, 'utf8')) as { used: number[] }).used);
  }

  markSeedsUsed(propertyId: string, seeds: Iterable<number>): void {
    this.withLock(() => {
      const used = this.usedSeeds(propertyId);
      for (const s of seeds) used.add(s);
      this.atomicWrite(this.holdoutPath(propertyId), JSON.stringify({ used: [...used].sort((a, b) => a - b) }));
    });
  }

  private atomicWrite(path: string, data: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }
}

/**
 * Fresh holdout seeds per final check. Seeds are derived deterministically from the spec hash and a counter, so
 * the sequence is reproducible, but any seed already disclosed to repair or consumed by an earlier holdout check
 * is skipped. Drawn seeds are marked used *before* they are returned, so a crash cannot re-issue them.
 */
export class HoldoutSeedPool {
  constructor(
    private readonly store: RegressionObligationStore,
    private readonly propertyId: string,
    private readonly specHash: string,
  ) {}

  /** Record seeds that a repair task has seen (or could see), so they are never used as holdout. */
  disclose(seeds: Iterable<number>): void {
    this.store.markSeedsUsed(this.propertyId, seeds);
  }

  draw(n: number): number[] {
    const used = this.store.usedSeeds(this.propertyId);
    const seeds: number[] = [];
    for (let counter = 0; seeds.length < n; counter++) {
      const seed = parseInt(sha256Hex(`${this.specHash}:holdout:${counter}`).slice(0, 8), 16) % 2 ** 31;
      if (!used.has(seed) && !seeds.includes(seed)) seeds.push(seed);
    }
    this.store.markSeedsUsed(this.propertyId, seeds);
    return seeds;
  }
}

// ---------------------------------------------------------------------------
// Witnesses and repair tasks
// ---------------------------------------------------------------------------

export type ObligationRunKind = 'spec' | 'regression' | 'holdout' | 'negative_control';

export interface ObligationRun {
  kind: ObligationRunKind;
  obligation: Obligation;
  result: VerificationResult;
  revision: RevisionRef;
  regressionId?: string;
}

/** Normalised, tool-specific view of a witness, for repair prompts and reports. */
export interface WitnessSummary {
  tool: FormalTool;
  kind: 'z3_model' | 'alloy_instance' | 'dafny_assertion' | 'verifai_trajectory' | 'other';
  summary: string;
  /** Replay data: Z3 assignment, Alloy instance/trace, Dafny diagnostic, VerifAI seed + params + trajectory. */
  data: unknown;
}

export function summarizeWitness(tool: FormalTool, witness: unknown): WitnessSummary {
  const w = (witness ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'z3':
      return {
        tool,
        kind: 'z3_model',
        summary: `Z3 model: ${Object.entries(w)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ')}`,
        data: witness,
      };
    case 'alloy': {
      const list = Array.isArray(witness) ? witness : [witness];
      return {
        tool,
        kind: 'alloy_instance',
        summary: `Alloy counterexample for ${list.map((x) => (x as { command?: string })?.command ?? '?').join(', ')}`,
        data: witness,
      };
    }
    case 'dafny':
      return {
        tool,
        kind: 'dafny_assertion',
        summary: `Dafny failing assertion: ${String(w.diagnostic ?? '').split('\n').find((l) => /Error|error/.test(l)) ?? 'see diagnostic'}`,
        data: witness,
      };
    case 'verifai':
    case 'scenic':
      return {
        tool,
        kind: 'verifai_trajectory',
        summary: `Replayable falsification: seed=${String(w.seed)} sample=${String(w.sampleIndex)} rho=${String(w.rho)} params=${JSON.stringify(w.params)}`,
        data: witness,
      };
    default:
      return { tool, kind: 'other', summary: JSON.stringify(witness), data: witness };
  }
}

export interface RepairWitness {
  propertyId: string;
  obligationId: string;
  tool: FormalTool;
  verdict: Verdict;
  revision: RevisionRef;
  regressionId: string;
  fromHoldout: boolean;
  witness: WitnessSummary;
}

export interface ImplementationTask {
  kind: 'implementation';
  id: string;
  component: string;
  prompt: string;
}

export interface RepairTask {
  kind: 'repair';
  id: string;
  component: string;
  attempt: number;
  maxAttempts: number;
  baseRevision: RevisionRef;
  /** Spec directory, mounted read-only. The worker may read it; any change rejects the attempt. */
  specsPath: string;
  specsHash: string;
  witnesses: RepairWitness[];
  prompt: string;
}

export function buildRepairPrompt(task: Omit<RepairTask, 'prompt'>): string {
  const lines = [
    `Repair ${task.component} (attempt ${task.attempt}/${task.maxAttempts}) at ${task.baseRevision.label} (${task.baseRevision.commit}).`,
    `The specification under ${task.specsPath} is frozen and read-only (${task.specsHash}). Do not edit it: change only the implementation.`,
    'The following formal obligations failed with concrete witnesses. Each is now a permanent regression obligation:',
    ...task.witnesses.map(
      (w, i) => `  ${i + 1}. [${w.propertyId}] ${w.tool} ${w.verdict} (${w.obligationId}, regression ${w.regressionId.slice(0, 12)}): ${w.witness.summary}`,
    ),
    'Acceptance is decided by re-running every spec obligation and every regression on your new commit, not by your own tests.',
  ];
  return lines.join('\n');
}

/**
 * Turns failed verification outcomes into repair tasks, the repair half of the core `TaskReplanner` contract
 * (DESIGN.md §2.3 step 3–5). It writes the regression obligation first, then returns the repair task, or
 * `null` once the persisted budget is exhausted so the job really stops at k.
 */
export class AssuranceReplanner {
  constructor(
    private readonly store: RegressionObligationStore,
    private readonly options: { runId: string; component: string; maxRepairAttempts: number; specsPath: string },
  ) {}

  get attemptsUsed(): number {
    return this.store.repairAttemptsUsed(this.options.runId);
  }

  /** Persist each repairable failure as a regression obligation; returns the witnesses for the repair task. */
  recordFailures(failures: readonly ObligationRun[]): RepairWitness[] {
    const witnesses: RepairWitness[] = [];
    for (const run of failures) {
      if (!isRepairableVerdict(run.result.verdict)) continue;
      // A failing replay is the same counterexample recurring: point at the stored regression, don't mint another.
      const existing = run.kind === 'regression' && run.regressionId ? this.store.get(run.obligation.propertyId, run.regressionId) : undefined;
      const origin = run.kind === 'regression' ? stripRegressionReplay(run.obligation) : run.obligation;
      const regression = existing ?? this.store.save({
        propertyId: run.obligation.propertyId,
        specHash: run.obligation.specHash,
        specVersion: run.obligation.specVersion,
        tool: run.obligation.tool,
        originVerdict: run.result.verdict,
        originObligation: origin,
        originRevision: run.revision,
        originInputHash: run.result.inputHash,
        witness: toPlainJson(run.result.witness) ?? null,
        fromHoldout: run.kind === 'holdout',
      });
      witnesses.push({
        propertyId: run.obligation.propertyId,
        obligationId: run.obligation.id,
        tool: run.obligation.tool,
        verdict: run.result.verdict,
        revision: run.revision,
        regressionId: regression.id,
        fromHoldout: run.kind === 'holdout',
        witness: summarizeWitness(run.obligation.tool, regression.witness),
      });
    }
    return witnesses;
  }

  /** Next repair task, or null when k attempts are used up. Consumes one attempt from the persisted budget. */
  nextRepairTask(baseRevision: RevisionRef, specsHash: string, witnesses: RepairWitness[]): RepairTask | null {
    if (witnesses.length === 0) return null;
    if (this.attemptsUsed >= this.options.maxRepairAttempts) return null;
    const attempt = this.store.consumeRepairAttempt(this.options.runId);
    const base: Omit<RepairTask, 'prompt'> = {
      kind: 'repair',
      id: `${this.options.runId}:repair:${attempt}`,
      component: this.options.component,
      attempt,
      maxAttempts: this.options.maxRepairAttempts,
      baseRevision,
      specsPath: this.options.specsPath,
      specsHash,
      witnesses,
    };
    return { ...base, prompt: buildRepairPrompt(base) };
  }

  /** Shape compatible with core `JobTaskInput` for `JobManager.addTasksToJob(..., { replacesTaskId })`. */
  static toJobTaskInput(task: RepairTask, dependsOn: string[] = []) {
    return {
      task: {
        id: task.id,
        type: 'repair',
        prompt: task.prompt,
        metadata: { assurance: { attempt: task.attempt, witnesses: task.witnesses, specsHash: task.specsHash } },
      },
      dependencies: dependsOn,
    };
  }
}

// ---------------------------------------------------------------------------
// Regression replay
// ---------------------------------------------------------------------------

const REGRESSION_META = 'regressionReplay';

function stripRegressionReplay(obligation: Obligation): Obligation {
  const meta = { ...(obligation.metadata ?? {}) };
  const original = meta[REGRESSION_META] as { originObligation?: Obligation } | undefined;
  if (original?.originObligation) return original.originObligation;
  delete meta[REGRESSION_META];
  return { ...obligation, metadata: meta };
}

export interface RegressionReplayContext {
  revision: RevisionRef;
  snapshotDir: string;
}

/** Tool-specific replay builder; return an obligation that pins the stored witness. */
export type RegressionReplayer = (
  regression: RegressionObligation,
  ctx: RegressionReplayContext,
) => Obligation | Promise<Obligation>;

/**
 * Default replay: the originating obligation, re-run on the new revision. For VerifAI the stored seed is replayed
 * up to and including the falsifying sample (no holdout seeds), which reproduces the exact trajectory.
 */
export const defaultRegressionReplayer: RegressionReplayer = (regression) => {
  const origin = regression.originObligation;
  const metadata: Record<string, unknown> = {
    ...(origin.metadata ?? {}),
    [REGRESSION_META]: { regressionId: regression.id, originObligation: origin },
  };
  let seed = origin.seed;
  if (regression.tool === 'verifai' || regression.tool === 'scenic') {
    const w = (regression.witness ?? {}) as { seed?: number; sampleIndex?: number };
    if (typeof w.seed === 'number') seed = w.seed;
    if (typeof w.sampleIndex === 'number') metadata.samples = w.sampleIndex + 1;
    metadata.holdoutSeeds = [];
  }
  return { ...origin, id: `regression:${regression.id.slice(0, 16)}`, seed, metadata };
};

// ---------------------------------------------------------------------------
// Evidence sink
// ---------------------------------------------------------------------------

export interface EvidenceSink {
  /** Called once per revision before any evidence for it; must invalidate all prior evidence. */
  beginRevision(revision: RevisionRef): void;
  record(run: ObligationRun): void;
}

/** Appends every obligation run to the hash-chained, lease-fenced {@link EvidenceLedger}. */
export class LedgerEvidenceSink implements EvidenceSink {
  private fencingToken: number;
  private revision?: RevisionRef;
  private readonly artifactHashes?: (run: ObligationRun) => Record<string, string>;
  readonly appended: LedgerEntry[] = [];

  constructor(
    readonly ledger: EvidenceLedger,
    options: { initialFencingToken?: number; artifactHashes?: (run: ObligationRun) => Record<string, string> } = {},
  ) {
    this.fencingToken = options.initialFencingToken ?? Math.max(0, ...ledger.entries.map((e) => e.fencingToken + 1));
    this.artifactHashes = options.artifactHashes;
  }

  beginRevision(revision: RevisionRef): void {
    if (this.revision) this.fencingToken += 1;
    this.revision = revision;
    this.ledger.invalidatePriorEvidence(revision.commit);
    this.ledger.setLeaseFence(this.fencingToken, revision.label);
  }

  record(run: ObligationRun): void {
    if (!this.revision || run.revision.commit !== this.revision.commit) {
      throw new Error(`Evidence for ${run.revision.label} after revision ${this.revision?.label ?? '<none>'} began`);
    }
    const { result, obligation } = run;
    const hashes: Record<string, string> = { input: result.inputHash || 'sha256:none' };
    if (result.stdout) hashes.stdout = 'sha256:' + sha256Hex(result.stdout);
    if (result.stderr) hashes.stderr = 'sha256:' + sha256Hex(result.stderr);
    Object.assign(hashes, this.artifactHashes?.(run) ?? {});
    const meta = result.metadata ?? {};
    const entry = this.ledger.append({
      propertyId: obligation.propertyId,
      specHash: obligation.specHash,
      specVersion: obligation.specVersion,
      sourceCommit: run.revision.commit,
      workspaceRev: run.revision.label,
      tool: obligation.tool,
      toolVersion: result.toolVersion,
      inputHash: result.inputHash || 'sha256:none',
      scope: result.scope ?? obligation.scope,
      steps: typeof meta.steps === 'number' ? meta.steps : undefined,
      assumptions: result.assumptions ?? obligation.assumptions,
      verdict: result.verdict,
      witness: toPlainJson(result.witness),
      unsatOutcome: result.verdict === Verdict.PROVED || result.verdict === Verdict.BOUNDED_PASS ? 'no violation (¬P unsatisfiable within encoding)' : undefined,
      elapsedMs: result.elapsedMs,
      seeds: collectSeeds(obligation, result),
      artifactHashes: hashes,
      obligationId: obligation.id,
      fencingToken: this.fencingToken,
      metadata: toPlainJson({
        kind: run.kind,
        regressionId: run.regressionId,
        command: obligation.command,
        vacuityProbe: result.vacuityProbe,
        trustedBaseGaps: result.trustedBaseGaps,
        attempted: result.attempted,
        reason: meta.reason,
        negativeControl: run.kind === 'negative_control' ? true : undefined,
        expectedVerdict: (obligation.metadata as { expectedVerdict?: string } | undefined)?.expectedVerdict,
      }) as Record<string, unknown>,
    });
    this.appended.push(entry);
  }
}

function collectSeeds(obligation: Obligation, result: VerificationResult): number[] | undefined {
  const seeds = new Set<number>();
  for (const s of [obligation.seed, result.seed]) if (typeof s === 'number') seeds.add(s);
  const holdout = (obligation.metadata as { holdoutSeeds?: unknown } | undefined)?.holdoutSeeds;
  if (Array.isArray(holdout)) for (const s of holdout) if (typeof s === 'number') seeds.add(s);
  return seeds.size > 0 ? [...seeds] : undefined;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface ImplementationWorker {
  /**
   * Run the implementation task (first call) or a repair task in `workspace.dir`, and commit. Returns the label
   * for the new revision; the commit id is read back from the workspace, never trusted from the worker.
   */
  run(task: ImplementationTask | RepairTask, workspace: WorkspaceVcs): Promise<{ label: string }>;
}

export interface ObligationPlanContext {
  revision: RevisionRef;
  /** Snapshot of exactly `revision.commit`. Obligation artifact paths resolve against it. */
  snapshotDir: string;
}

export interface HoldoutConfig {
  /** Seeds drawn per final check. */
  seedsPerCheck?: number;
}

export interface AssuranceRepairOrchestratorOptions {
  runId: string;
  component: string;
  workspace: WorkspaceVcs;
  worker: ImplementationWorker;
  adapters: Partial<Record<FormalTool, SolverAdapter>>;
  /** Spec obligations for a revision (the ObligationPlanner step). */
  planObligations: (ctx: ObligationPlanContext) => Obligation[] | Promise<Obligation[]>;
  regressionStore: RegressionObligationStore;
  /** Repo-relative spec directory; frozen for every worker turn. Default `specs`. */
  specsDir?: string;
  maxRepairAttempts?: number;
  /** Re-check VerifAI/Scenic campaigns on fresh holdout seeds before accepting a revision. Default on. */
  holdout?: HoldoutConfig | false;
  regressionReplayers?: Partial<Record<FormalTool, RegressionReplayer>>;
  evidence?: EvidenceSink;
  timeoutMs?: number;
  onEvent?: (event: RepairLoopEvent) => void;
}

export type RepairLoopEvent =
  | { type: 'revision'; revision: RevisionRef; attempt: number }
  | { type: 'obligation'; run: ObligationRun }
  | { type: 'regression_saved'; witness: RepairWitness }
  | { type: 'repair_task'; task: RepairTask }
  | { type: 'spec_check'; revision: RevisionRef; specsHash: string; unchanged: boolean }
  | { type: 'done'; report: RepairLoopReport };

export type RepairLoopOutcome =
  /** Every obligation, regression and holdout check accepted on the final revision. */
  | 'passed'
  /** Counterexamples remain after k repair attempts. */
  | 'exhausted'
  /** No counterexample, but a non-accepting verdict (NOT_RUN, ERROR, UNKNOWN, ...) that repair cannot fix. */
  | 'blocked'
  /** A worker changed the frozen spec; the attempt is rejected. */
  | 'spec_tampered';

export interface RepairIteration {
  revision: RevisionRef;
  runs: ObligationRun[];
  holdoutRuns: ObligationRun[];
  failures: ObligationRun[];
  repairTask?: RepairTask;
}

export interface RepairLoopReport {
  runId: string;
  component: string;
  outcome: RepairLoopOutcome;
  reason?: string;
  finalRevision: RevisionRef;
  revisions: RevisionRef[];
  repairAttempts: number;
  maxRepairAttempts: number;
  specsHash: string;
  iterations: RepairIteration[];
  /** Every witness seen, in order. */
  witnesses: RepairWitness[];
  regressionObligations: number;
  holdoutSeedsUsed: number[];
}

export class AssuranceRepairOrchestrator {
  private readonly specsDir: string;
  private readonly maxRepairAttempts: number;
  private readonly replanner: AssuranceReplanner;

  constructor(private readonly options: AssuranceRepairOrchestratorOptions) {
    this.specsDir = options.specsDir ?? 'specs';
    this.maxRepairAttempts = options.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS;
    if (!Number.isInteger(this.maxRepairAttempts) || this.maxRepairAttempts < 0) {
      throw new Error('maxRepairAttempts must be a non-negative integer');
    }
    this.replanner = new AssuranceReplanner(options.regressionStore, {
      runId: options.runId,
      component: options.component,
      maxRepairAttempts: this.maxRepairAttempts,
      specsPath: this.specsDir,
    });
  }

  private emit(event: RepairLoopEvent): void {
    this.options.onEvent?.(event);
  }

  private get specsAbs(): string {
    return join(this.options.workspace.dir, this.specsDir);
  }

  /**
   * Run one worker turn with `specs/` frozen. Throws {@link SpecTamperError} if the working tree's spec hash
   * changed or the new commit touches the spec directory.
   */
  private async workerTurn(task: ImplementationTask | RepairTask, expectedSpecsHash: string, fromCommit?: string): Promise<RevisionRef> {
    const before = hashSpecsTree(this.specsAbs);
    if (before !== expectedSpecsHash) {
      throw new SpecTamperError('specs/ changed before the worker turn', { expectedHash: expectedSpecsHash, observedHash: before });
    }
    setTreeWritable(this.specsAbs, false);
    let label: string;
    try {
      ({ label } = await this.options.worker.run(task, this.options.workspace));
    } finally {
      setTreeWritable(this.specsAbs, true);
    }
    const after = hashSpecsTree(this.specsAbs);
    const commit = this.options.workspace.head();
    const prefix = this.specsDir.replace(/\/+$/, '') + '/';
    const changedSpecPaths = fromCommit
      ? this.options.workspace.changedPaths(fromCommit, commit).filter((p) => p === this.specsDir || p.startsWith(prefix))
      : [];
    const revision = { label, commit };
    const unchanged = after === expectedSpecsHash && changedSpecPaths.length === 0;
    this.emit({ type: 'spec_check', revision, specsHash: after, unchanged });
    if (!unchanged) {
      throw new SpecTamperError(`worker ${task.id} modified the frozen spec`, {
        expectedHash: expectedSpecsHash,
        observedHash: after,
        changedSpecPaths,
      });
    }
    return revision;
  }

  private async verifyOne(kind: ObligationRunKind, obligation: Obligation, revision: RevisionRef, snapshotDir: string, regressionId?: string): Promise<ObligationRun> {
    const adapter = this.options.adapters[obligation.tool];
    let result: VerificationResult;
    if (!adapter) {
      result = {
        verdict: Verdict.NOT_RUN,
        tool: obligation.tool,
        toolVersion: 'unavailable',
        assumptions: obligation.assumptions,
        elapsedMs: 0,
        inputHash: '',
        metadata: { reason: `no ${obligation.tool} adapter configured` },
      };
    } else {
      try {
        result = await adapter.verify(obligation, revision.label, { workspaceDir: snapshotDir, timeoutMs: this.options.timeoutMs });
      } catch (error) {
        result = {
          verdict: Verdict.ERROR,
          tool: obligation.tool,
          toolVersion: 'unknown',
          assumptions: obligation.assumptions,
          elapsedMs: 0,
          inputHash: '',
          stderr: String(error),
          metadata: { reason: `adapter threw: ${String(error)}` },
        };
      }
    }
    const run: ObligationRun = { kind, obligation, result, revision, regressionId };
    this.options.evidence?.record(run);
    this.emit({ type: 'obligation', run });
    return run;
  }

  /** Steps 2 + 6: every spec obligation and every stored regression, on a snapshot of exactly this commit. */
  private async runAll(revision: RevisionRef, snapshotDir: string, specHashes: Set<string>): Promise<ObligationRun[]> {
    const runs: ObligationRun[] = [];
    const planned = await this.options.planObligations({ revision, snapshotDir });
    for (const o of planned) specHashes.add(o.specHash);
    // Disclose repair-campaign seeds so they can never be reused as holdout.
    for (const o of planned) {
      if (o.tool === 'verifai' || o.tool === 'scenic') {
        const meta = (o.metadata ?? {}) as { holdoutSeeds?: number[] };
        this.holdoutPool(o).disclose([o.seed ?? 0, ...(meta.holdoutSeeds ?? [])]);
      }
    }
    for (const o of planned) runs.push(await this.verifyOne('spec', o, revision, snapshotDir));

    const properties = new Set(planned.map((o) => o.propertyId));
    const regressions = this.options.regressionStore
      .list()
      .filter((r) => properties.has(r.propertyId) && specHashes.has(r.specHash));
    for (const r of regressions) {
      const replay = this.options.regressionReplayers?.[r.tool] ?? defaultRegressionReplayer;
      let obligation: Obligation;
      try {
        obligation = await replay(r, { revision, snapshotDir });
      } catch (error) {
        // A regression that cannot be replayed is an ERROR on this revision, never a skipped check.
        const failed = { ...defaultRegressionReplayer(r, { revision, snapshotDir }) as Obligation };
        const run: ObligationRun = {
          kind: 'regression',
          obligation: failed,
          revision,
          regressionId: r.id,
          result: {
            verdict: Verdict.ERROR,
            tool: r.tool,
            toolVersion: 'unknown',
            assumptions: failed.assumptions,
            elapsedMs: 0,
            inputHash: '',
            stderr: String(error),
            metadata: { reason: `regression replay failed: ${String(error)}` },
          },
        };
        this.options.evidence?.record(run);
        this.emit({ type: 'obligation', run });
        runs.push(run);
        continue;
      }
      runs.push(await this.verifyOne('regression', obligation, revision, snapshotDir, r.id));
    }
    return runs;
  }

  private holdoutPool(o: Obligation): HoldoutSeedPool {
    return new HoldoutSeedPool(this.options.regressionStore, o.propertyId, o.specHash);
  }

  /** Step 7: fresh, never-disclosed seeds for each campaign obligation on the candidate final revision. */
  private async runHoldout(spec: ObligationRun[], revision: RevisionRef, snapshotDir: string, used: number[]): Promise<ObligationRun[]> {
    if (this.options.holdout === false) return [];
    const perCheck = this.options.holdout?.seedsPerCheck ?? DEFAULT_HOLDOUT_SEEDS_PER_CHECK;
    const runs: ObligationRun[] = [];
    for (const run of spec) {
      const o = run.obligation;
      if (run.kind !== 'spec' || (o.tool !== 'verifai' && o.tool !== 'scenic')) continue;
      const seeds = this.holdoutPool(o).draw(perCheck);
      used.push(...seeds);
      const [first, ...rest] = seeds;
      const holdout: Obligation = {
        ...o,
        id: `${o.id}:holdout`,
        seed: first,
        metadata: { ...(o.metadata ?? {}), holdoutSeeds: rest, holdout: true },
      };
      runs.push(await this.verifyOne('holdout', holdout, revision, snapshotDir));
    }
    return runs;
  }

  async run(task: ImplementationTask): Promise<RepairLoopReport> {
    const specsHash = hashSpecsTree(this.specsAbs);
    const iterations: RepairIteration[] = [];
    const witnesses: RepairWitness[] = [];
    const revisions: RevisionRef[] = [];
    const holdoutSeedsUsed: number[] = [];
    const specHashes = new Set<string>();

    const finish = (outcome: RepairLoopOutcome, finalRevision: RevisionRef, reason?: string): RepairLoopReport => {
      const report: RepairLoopReport = {
        runId: this.options.runId,
        component: this.options.component,
        outcome,
        reason,
        finalRevision,
        revisions,
        repairAttempts: this.replanner.attemptsUsed,
        maxRepairAttempts: this.maxRepairAttempts,
        specsHash,
        iterations,
        witnesses,
        regressionObligations: this.options.regressionStore.list().filter((r) => specHashes.has(r.specHash)).length,
        holdoutSeedsUsed,
      };
      this.emit({ type: 'done', report });
      return report;
    };

    // Step 1.
    let revision: RevisionRef;
    const start = this.options.workspace.head();
    try {
      revision = await this.workerTurn(task, specsHash, start);
    } catch (error) {
      if (error instanceof SpecTamperError) return finish('spec_tampered', { label: 'rejected', commit: this.options.workspace.head() }, error.message);
      throw error;
    }

    for (;;) {
      revisions.push(revision);
      this.emit({ type: 'revision', revision, attempt: this.replanner.attemptsUsed });
      // Step 6: a new revision invalidates every prior piece of evidence.
      this.options.evidence?.beginRevision(revision);
      const snapshotDir = this.options.workspace.snapshot(revision.commit);
      let iteration: RepairIteration;
      try {
        const snapshotSpecs = hashSpecsTree(join(snapshotDir, this.specsDir));
        if (snapshotSpecs !== specsHash) {
          return finish('spec_tampered', revision, `committed specs/ at ${revision.label} differ from the frozen spec`);
        }
        const runs = await this.runAll(revision, snapshotDir, specHashes);
        let failures = runs.filter((r) => isRepairableVerdict(r.result.verdict));
        let holdoutRuns: ObligationRun[] = [];
        const blocking = runs.filter((r) => !ACCEPTED_VERDICTS.includes(r.result.verdict) && !isRepairableVerdict(r.result.verdict));
        if (failures.length === 0 && blocking.length === 0) {
          holdoutRuns = await this.runHoldout(runs, revision, snapshotDir, holdoutSeedsUsed);
          failures = holdoutRuns.filter((r) => isRepairableVerdict(r.result.verdict));
          blocking.push(...holdoutRuns.filter((r) => !ACCEPTED_VERDICTS.includes(r.result.verdict) && !isRepairableVerdict(r.result.verdict)));
        }
        iteration = { revision, runs, holdoutRuns, failures };
        iterations.push(iteration);

        if (failures.length === 0) {
          if (blocking.length > 0) {
            return finish(
              'blocked',
              revision,
              `non-repairable verdicts: ${blocking.map((r) => `${r.obligation.id}=${r.result.verdict}`).join(', ')}`,
            );
          }
          return finish('passed', revision);
        }
      } finally {
        rmSync(snapshotDir, { recursive: true, force: true });
      }

      // Steps 3 + 4: persist regressions before any repair task exists.
      const found = this.replanner.recordFailures(iteration.failures);
      for (const w of found) {
        witnesses.push(w);
        this.emit({ type: 'regression_saved', witness: w });
      }
      // Disclosed holdout witnesses are repair evidence now; their seeds are already marked used.

      // Step 5.
      const repairTask = this.replanner.nextRepairTask(revision, specsHash, found);
      if (!repairTask) {
        return finish(
          'exhausted',
          revision,
          `counterexamples remain after ${this.replanner.attemptsUsed}/${this.maxRepairAttempts} repair attempts`,
        );
      }
      iteration.repairTask = repairTask;
      this.emit({ type: 'repair_task', task: repairTask });

      try {
        revision = await this.workerTurn(repairTask, specsHash, revision.commit);
      } catch (error) {
        if (error instanceof SpecTamperError) return finish('spec_tampered', revision, error.message);
        throw error;
      }
    }
  }
}
