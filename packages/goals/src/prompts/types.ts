import type { PromptDefinition, PromptId, PromptStore, PromptVersion } from '../contracts.js';

/** Author-supplied content for a new prompt version. Ids, versions and digests are assigned by the store. */
export interface PromptDraft {
  /** Defaults to `executorKey`. Must match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`. */
  id?: PromptId;
  executorKey: string;
  role: string;
  template: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredCapabilities?: string[];
  /** Free-text change note recorded with the version. Not part of the digest. */
  note?: string;
  /** Optimistic concurrency: publish fails with LEDGER_CONFLICT unless the head is at this version (0 = new prompt). */
  expectedVersion?: PromptVersion;
}

/** Seed shape extracted from a goal graph's `prompts:` section (Agent 02 `extractPromptSeeds`). */
export interface PromptSeed {
  executorKey: string;
  role: string;
  template: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredCapabilities?: string[];
}

/** A stored version: the contract definition plus provenance that is not part of the content digest. */
export interface PromptVersionRecord extends PromptDefinition {
  parentVersion?: PromptVersion;
  /** Set when this version was produced by rolling back to an earlier version's content. */
  rollbackOf?: PromptVersion;
  source?: 'publish' | 'rollback' | 'seed';
  note?: string;
}

export interface PromptHead {
  promptId: PromptId;
  executorKey: string;
  version: PromptVersion;
  digest: string;
  updatedAt: string;
  updatedBy: string;
}

export interface PromptSummary {
  promptId: PromptId;
  executorKey: string;
  role: string;
  latestVersion: PromptVersion;
  digest: string;
  requiredCapabilities: string[];
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface PublishResult {
  prompt: PromptVersionRecord;
  /** False when the content was identical to the head and no version was written. */
  created: boolean;
  warnings: string[];
}

export type LineOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  op: LineOp;
  text: string;
  /** 1-based line number in version A (absent for additions). */
  aLine?: number;
  /** 1-based line number in version B (absent for removals). */
  bLine?: number;
}

export interface SchemaChange {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  from?: unknown;
  to?: unknown;
}

export interface PromptDiff {
  promptId: PromptId;
  a: PromptVersion;
  b: PromptVersion;
  digest: { a: string; b: string };
  identical: boolean;
  template: { lines: DiffLine[]; added: number; removed: number };
  role?: { from: string; to: string };
  requiredCapabilities: { added: string[]; removed: string[] };
  inputSchema: SchemaChange[];
  outputSchema: SchemaChange[];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface PromptEvalExpectation {
  /** Every string must occur in the raw output text. */
  contains?: string[];
  /** No string may occur in the raw output text. */
  notContains?: string[];
  /** JavaScript regular expression source the output text must match. */
  matches?: string;
  /** Parsed JSON output must deep-equal this value. */
  equals?: unknown;
  /** Parsed JSON output must contain these fields with deep-equal values (recursive subset). */
  subset?: Record<string, unknown>;
  /** Set false to skip `outputSchema` validation for this case. Default true when the prompt has one. */
  validateOutputSchema?: boolean;
  /** The case passes only if rendering the template fails (negative test of input validation). */
  renderFails?: boolean;
}

export interface PromptEvalCase {
  id: string;
  inputs: Record<string, unknown>;
  expect?: PromptEvalExpectation;
}

export interface PromptRunnerRequest {
  prompt: PromptDefinition;
  rendered: string;
  inputs: Record<string, unknown>;
  caseId: string;
  signal: AbortSignal;
}

export interface PromptRunnerResponse {
  /** Raw model output. Objects are treated as already-parsed JSON. */
  output: string | Record<string, unknown> | unknown[];
  modelId?: string;
  costUsd?: number;
}

/** Injected model call. Tests use a deterministic fake; nothing in this module performs hosted calls. */
export type PromptRunner = (request: PromptRunnerRequest) => Promise<PromptRunnerResponse>;

export interface PromptEvalCheck {
  name: string;
  passed: boolean;
  message?: string;
}

export interface PromptEvalCaseResult {
  caseId: string;
  passed: boolean;
  checks: PromptEvalCheck[];
  rendered?: string;
  output?: unknown;
  modelId?: string;
  costUsd?: number;
  error?: string;
  durationMs: number;
}

export interface PromptEvaluationResult {
  id: string;
  promptId: PromptId;
  version: PromptVersion;
  digest: string;
  runnerId: string;
  actor: string;
  startedAt: string;
  finishedAt: string;
  cases: PromptEvalCaseResult[];
  summary: { total: number; passed: number; failed: number; passRate: number; costUsd: number };
}

export interface PromptComparison {
  promptId: PromptId;
  a: PromptEvaluationResult;
  b: PromptEvaluationResult;
  perCase: Array<{ caseId: string; a: boolean; b: boolean; change: 'fixed' | 'regressed' | 'same-pass' | 'same-fail' }>;
  diff: PromptDiff;
}

export interface PromptAdmin {
  /** Creates a new prompt at version 1. DUPLICATE if the id or executor key is already bound. */
  create(draft: PromptDraft, actor: string): Promise<PublishResult>;
  /** Appends an immutable version (or creates the prompt). Identical content to the head is a no-op. */
  publish(draft: PromptDraft, actor: string): Promise<PublishResult>;
  list(): Promise<PromptSummary[]>;
  head(promptId: PromptId): Promise<PromptVersionRecord | undefined>;
  history(promptId: PromptId): Promise<PromptVersionRecord[]>;
  diff(promptId: PromptId, a: PromptVersion, b: PromptVersion): Promise<PromptDiff>;
  /** Writes a NEW version carrying `toVersion`'s content. History is never rewritten. */
  rollback(promptId: PromptId, toVersion: PromptVersion, actor: string, note?: string): Promise<PublishResult>;
  /** Idempotent: unchanged seeds create no versions. */
  seedFromGraph(seeds: PromptSeed[], actor: string): Promise<PublishResult[]>;
  /** Resolves a historical binding; never follows the head. */
  resolve(ref: { promptId: PromptId; version: PromptVersion }): Promise<PromptVersionRecord>;
  /** True when a runner is configured, i.e. `evaluate`/`compareVersions` can run. */
  readonly canEvaluate: boolean;
  evaluate(promptId: PromptId, version: PromptVersion | undefined, cases: PromptEvalCase[], actor: string): Promise<PromptEvaluationResult>;
  compareVersions(promptId: PromptId, a: PromptVersion, b: PromptVersion, cases: PromptEvalCase[], actor: string): Promise<PromptComparison>;
  evaluations(promptId: PromptId, version?: PromptVersion): Promise<PromptEvaluationResult[]>;
}

export type PromptStudio = PromptStore & PromptAdmin;
