import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LedgerEntry as ContractLedgerEntry } from './contracts';

export const GENESIS_HASH = '0'.repeat(64);
export interface LedgerEntry extends ContractLedgerEntry {
  specVersion: string;
  fencingToken: number;
  leaseToken?: number;
  seed?: number;
}
export type LedgerInput = Omit<LedgerEntry, 'index' | 'timestamp' | 'prevHash' | 'entryHash'> & { timestamp?: string };
/** Runs inside the store's write lock; consult authoritative lease/revision state here. */
export type LeaseFenceValidator = (entry: Readonly<LedgerInput>) => boolean;
export class StaleLeaseFenceError extends Error {
  constructor(message = 'Stale lease fencing token or superseded workspace revision') {
    super(message);
    this.name = 'StaleLeaseFenceError';
  }
}
export class LedgerIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'LedgerIntegrityError'; }
}

/** Sorted object keys, JSON primitives only; rejects lossy/non-JSON evidence. */
export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalSerialize).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => JSON.stringify(key) + ':' + canonicalSerialize(value[key])).join(',') + '}';
  }
  throw new TypeError('Evidence must contain only finite JSON values');
}
export function hashLedgerEntry(entry: Omit<LedgerEntry, 'entryHash'> | LedgerEntry): string {
  const { entryHash: ignored, ...fields } = entry as LedgerEntry;
  return createHash('sha256').update(canonicalSerialize(fields)).digest('hex');
}
export interface LedgerCheckpoint { length: number; headHash: string }
/** Supply a trusted checkpoint to also detect removal of an otherwise valid suffix. */
export function verifyLedger(entries: readonly LedgerEntry[], checkpoint?: LedgerCheckpoint): true {
  let previous = GENESIS_HASH;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.index !== index || entry.prevHash !== previous || entry.entryHash !== hashLedgerEntry(entry)) {
      throw new LedgerIntegrityError(`Invalid evidence chain at index ${index}`);
    }
    previous = entry.entryHash;
  }
  if (checkpoint && (checkpoint.length !== entries.length || checkpoint.headHash !== previous)) {
    throw new LedgerIntegrityError('Ledger does not match trusted checkpoint');
  }
  return true;
}
interface StoreState {
  entries: LedgerEntry[];
  activeCommit?: string;
  workspaceRev?: string;
  fencingToken: number;
}
export interface EvidenceLedgerOptions {
  filePath?: string;
  leaseFenceValidator?: LeaseFenceValidator;
}

/** Synchronous single-host store. All file writers must use this lock protocol. */
export class EvidenceLedger {
  private state: StoreState = { entries: [], fencingToken: -1 };
  private readonly options: EvidenceLedgerOptions;
  constructor(options: EvidenceLedgerOptions = {}) {
    this.options = options;
    this.reload();
  }
  private reload(): void {
    if (this.options.filePath && existsSync(this.options.filePath)) {
      const state = JSON.parse(readFileSync(this.options.filePath, 'utf8')) as StoreState;
      verifyLedger(state.entries);
      this.state = state;
    }
  }
  private mutate<T>(operation: () => T): T {
    const path = this.options.filePath;
    let lock: number | undefined;
    let temporary: string | undefined;
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      lock = openSync(path + '.lock', 'wx');
    }
    const before = structuredClone(this.state);
    try {
      this.reload();
      const result = operation();
      if (path) {
        temporary = path + '.' + randomUUID() + '.tmp';
        writeFileSync(temporary, canonicalSerialize(this.state), { flag: 'wx' });
        renameSync(temporary, path);
        temporary = undefined;
      }
      return result;
    } catch (error) {
      this.state = before;
      throw error;
    } finally {
      if (temporary && existsSync(temporary)) unlinkSync(temporary);
      if (lock !== undefined) { closeSync(lock); unlinkSync(path + '.lock'); }
    }
  }
  append(input: LedgerInput): LedgerEntry {
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 0) throw new StaleLeaseFenceError();
    // Detach caller-owned data before invoking the validator or storing evidence.
    const candidate = JSON.parse(canonicalSerialize(input)) as LedgerInput;
    return this.mutate(() => {
      const state = this.state;
      const token = candidate.fencingToken;
      if (!Number.isSafeInteger(token) || token < 0 || token < state.fencingToken ||
          (candidate.leaseToken !== undefined && candidate.leaseToken !== token) ||
          (state.activeCommit !== undefined && candidate.sourceCommit !== state.activeCommit) ||
          (token === state.fencingToken && state.workspaceRev !== undefined && candidate.workspaceRev !== state.workspaceRev) ||
          (this.options.leaseFenceValidator && this.options.leaseFenceValidator(structuredClone(candidate)) !== true)) {
        throw new StaleLeaseFenceError();
      }
      const entry: LedgerEntry = {
        ...candidate, index: state.entries.length,
        timestamp: candidate.timestamp ?? new Date().toISOString(),
        prevHash: state.entries.at(-1)?.entryHash ?? GENESIS_HASH, entryHash: '',
      };
      entry.entryHash = hashLedgerEntry(entry);
      state.entries.push(entry);
      state.fencingToken = token;
      state.workspaceRev = candidate.workspaceRev;
      return structuredClone(entry);
    });
  }
  /** Set the authoritative revision before accepting evidence from a replacement worker. */
  setLeaseFence(fencingToken: number, workspaceRev: string): void {
    this.mutate(() => {
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 0 || fencingToken < this.state.fencingToken ||
          (fencingToken === this.state.fencingToken && this.state.workspaceRev !== undefined && workspaceRev !== this.state.workspaceRev)) {
        throw new StaleLeaseFenceError();
      }
      this.state.fencingToken = fencingToken;
      this.state.workspaceRev = workspaceRev;
    });
  }
  /** Preserve history, but make only the new commit eligible for evidence queries/writes. */
  invalidatePriorEvidence(newCommit: string): void {
    this.mutate(() => { this.state.activeCommit = newCommit; });
  }
  getEvidenceForCommit(sourceCommit: string): LedgerEntry[] {
    this.reload();
    if (this.state.activeCommit !== undefined && sourceCommit !== this.state.activeCommit) return [];
    return structuredClone(this.state.entries.filter(entry => entry.sourceCommit === sourceCommit));
  }
  get entries(): LedgerEntry[] { this.reload(); return structuredClone(this.state.entries); }
  get checkpoint(): LedgerCheckpoint {
    const entries = this.entries;
    return { length: entries.length, headHash: entries.at(-1)?.entryHash ?? GENESIS_HASH };
  }
  verifyLedger(checkpoint?: LedgerCheckpoint): true { return verifyLedger(this.entries, checkpoint); }
}
