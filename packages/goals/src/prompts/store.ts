import type { KeyValueStore } from '@wazir/shared';
import {
  GOAL_STORE_KEYS,
  GoalStudioFailure,
  type GoalStudioDeps,
  type GoalStudioEvent,
  type PromptDefinition,
  type PromptId,
  type PromptVersion,
} from '../contracts.js';
import { canonicalJson, cloneJson, sha256Hex } from './canonical.js';
import { diffPromptVersions } from './diff.js';
import { evaluatePrompt, type EvaluatePromptOptions } from './evaluation.js';
import { deriveInputSchema, lintPrompt } from './render.js';
import { checkSchema } from './schema.js';
import { DEFAULT_PROMPT_SEEDS } from './seeds.js';
import type {
  PromptComparison,
  PromptDraft,
  PromptEvalCase,
  PromptEvaluationResult,
  PromptHead,
  PromptRunner,
  PromptSeed,
  PromptStudio,
  PromptSummary,
  PromptVersionRecord,
  PublishResult,
} from './types.js';

export const PROMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const MAX_TEMPLATE_BYTES = 64 * 1024;
export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_CAPABILITIES = 64;

const VERSION_PREFIX = (promptId: PromptId) => `goals/prompts/${promptId}/v/`;
const HEAD_PREFIX = 'goals/prompts-head/';
/** Evaluation results live under this workstream's `goals/prompts/` prefix. */
export const PROMPT_EVAL_KEY = (promptId: PromptId, evaluationId: string) => `goals/prompts/${promptId}/eval/${evaluationId}`;
const EVAL_PREFIX = (promptId: PromptId) => `goals/prompts/${promptId}/eval/`;

export interface PromptStoreOptions {
  /** Injected model call used by evaluate/compareVersions. Absent → `canEvaluate` is false. */
  runner?: PromptRunner;
  runnerId?: string;
  evaluationTimeoutMs?: number;
  /** Called after every new version is written (wire to GoalGovernance.audit / an event log). */
  onEvent?: (event: Omit<GoalStudioEvent, 'seq'>) => void | Promise<void>;
}

/** The content fields covered by the digest. Provenance (version, author, time, note) is not content. */
export function promptContent(def: Pick<PromptDefinition, 'executorKey' | 'role' | 'template' | 'inputSchema' | 'outputSchema' | 'requiredCapabilities'>) {
  return {
    executorKey: def.executorKey,
    role: def.role,
    template: def.template,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    requiredCapabilities: def.requiredCapabilities,
  };
}

/** sha256 hex of the canonical JSON of a prompt's content. */
export function promptDigest(def: Parameters<typeof promptContent>[0]): string {
  return sha256Hex(canonicalJson(promptContent(def)));
}

/** True when a stored record's digest still matches its content (tamper / corruption check). */
export function verifyPromptIntegrity(def: PromptDefinition): boolean {
  return promptDigest(def) === def.digest;
}

function fail(message: string, details?: Record<string, unknown>): never {
  throw new GoalStudioFailure('VALIDATION', message, { details });
}

function normalizeCapabilities(caps: unknown): string[] {
  if (caps === undefined) return [];
  if (!Array.isArray(caps) || caps.some((cap) => typeof cap !== 'string' || !cap.trim())) fail('requiredCapabilities must be an array of non-empty strings');
  const unique = [...new Set((caps as string[]).map((cap) => cap.trim()))].sort();
  if (unique.length > MAX_CAPABILITIES) fail(`at most ${MAX_CAPABILITIES} requiredCapabilities`);
  return unique;
}

function normalizeSchema(name: string, schema: unknown): Record<string, unknown> | undefined {
  if (schema === undefined || schema === null) return undefined;
  if (Buffer.byteLength(JSON.stringify(schema)) > MAX_SCHEMA_BYTES) fail(`${name} exceeds ${MAX_SCHEMA_BYTES} bytes`);
  const problem = checkSchema(schema);
  if (problem) fail(`${name} is not a valid JSON Schema: ${problem}`);
  return cloneJson(schema as Record<string, unknown>);
}

/** Validates and normalizes a draft into digest-ready content. */
export function normalizeDraft(draft: PromptDraft): { id: PromptId } & Parameters<typeof promptContent>[0] {
  if (!draft || typeof draft !== 'object') fail('prompt body must be an object');
  const executorKey = typeof draft.executorKey === 'string' ? draft.executorKey.trim() : '';
  if (!PROMPT_ID_PATTERN.test(executorKey)) fail(`executorKey must match ${PROMPT_ID_PATTERN}`);
  const id = draft.id === undefined ? executorKey : String(draft.id).trim();
  if (!PROMPT_ID_PATTERN.test(id)) fail(`id must match ${PROMPT_ID_PATTERN}`);
  const role = typeof draft.role === 'string' ? draft.role.trim() : '';
  if (!role || role.length > 200) fail('role must be a non-empty string of at most 200 characters');
  if (typeof draft.template !== 'string' || !draft.template.trim()) fail('template must be a non-empty string');
  if (Buffer.byteLength(draft.template) > MAX_TEMPLATE_BYTES) fail(`template exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  if (draft.note !== undefined && (typeof draft.note !== 'string' || draft.note.length > 2000)) fail('note must be a string of at most 2000 characters');
  return {
    id,
    executorKey,
    role,
    template: draft.template,
    inputSchema: normalizeSchema('inputSchema', draft.inputSchema),
    outputSchema: normalizeSchema('outputSchema', draft.outputSchema),
    requiredCapabilities: normalizeCapabilities(draft.requiredCapabilities),
  };
}

/** Serializes async work per key within this process (fallback when the store has no atomic `update`). */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/**
 * Prompt Studio store: immutable, monotonic prompt versions in the shared
 * KeyValueStore.
 *
 * Keys: `GOAL_STORE_KEYS.prompt(id, v)` holds each version (written once, never
 * overwritten); `GOAL_STORE_KEYS.promptHead(executorKey)` points at the latest
 * version (head always equals the highest version: rollback appends a copy).
 * Version slots are claimed with `KeyValueStore.update` when available, so two
 * writers can never both own version N; without `update`, writers are
 * serialized per prompt within this process.
 */
export function createPromptStore(deps: GoalStudioDeps & PromptStoreOptions): PromptStudio {
  const store: KeyValueStore = deps.store;
  const clock = deps.clock ?? (() => new Date());
  const mutex = new KeyedMutex();
  const runner = deps.runner;

  async function readVersion(promptId: PromptId, version: PromptVersion): Promise<PromptVersionRecord | undefined> {
    if (!PROMPT_ID_PATTERN.test(promptId) || !Number.isInteger(version) || version < 1) return undefined;
    const record = await store.get<PromptVersionRecord>(GOAL_STORE_KEYS.prompt(promptId, version));
    return record ? cloneJson(record) : undefined;
  }

  async function versionsOf(promptId: PromptId): Promise<PromptVersionRecord[]> {
    if (!PROMPT_ID_PATTERN.test(promptId)) return [];
    const entries = await store.list(VERSION_PREFIX(promptId));
    return entries
      .map((entry) => cloneJson(entry.value as PromptVersionRecord))
      .filter((record) => record && record.id === promptId)
      .sort((a, b) => a.version - b.version);
  }

  async function latestOf(promptId: PromptId): Promise<PromptVersionRecord | undefined> {
    const all = await versionsOf(promptId);
    return all[all.length - 1];
  }

  async function requireVersion(promptId: PromptId, version: PromptVersion): Promise<PromptVersionRecord> {
    const record = await readVersion(promptId, version);
    if (!record) throw new GoalStudioFailure('NOT_FOUND', `prompt '${promptId}' version ${version} not found`, { details: { promptId, version } });
    return record;
  }

  /** Writes `record` at its version iff the slot is empty. Returns false if another writer owns it. */
  async function claimSlot(record: PromptVersionRecord): Promise<boolean> {
    const key = GOAL_STORE_KEYS.prompt(record.id, record.version);
    if (store.update) {
      const stored = await store.update<PromptVersionRecord>(key, (current) => current ?? record);
      return stored.createdAt === record.createdAt && stored.digest === record.digest && stored.createdBy === record.createdBy && canonicalJson(stored) === canonicalJson(record);
    }
    if (await store.get(key)) return false;
    await store.put(key, record);
    return true;
  }

  async function moveHead(record: PromptVersionRecord): Promise<void> {
    const key = GOAL_STORE_KEYS.promptHead(record.executorKey);
    const head: PromptHead = { promptId: record.id, executorKey: record.executorKey, version: record.version, digest: record.digest, updatedAt: record.createdAt, updatedBy: record.createdBy };
    if (store.update) {
      await store.update<PromptHead>(key, (current) => (!current || current.promptId !== record.id || current.version < record.version ? head : current));
      return;
    }
    const current = await store.get<PromptHead>(key);
    if (!current || current.promptId !== record.id || current.version < record.version) await store.put(key, head);
  }

  async function emit(record: PromptVersionRecord): Promise<void> {
    if (!deps.onEvent) return;
    try {
      await deps.onEvent({
        type: 'prompt.version',
        timestamp: record.createdAt,
        data: { promptId: record.id, version: record.version, digest: record.digest, executorKey: record.executorKey, source: record.source, rollbackOf: record.rollbackOf, actor: record.createdBy },
      });
    } catch {
      // Event delivery is advisory; the version is already durable.
    }
  }

  async function write(
    draft: PromptDraft,
    actor: string,
    mode: { requireNew?: boolean; source: PromptVersionRecord['source']; rollbackOf?: PromptVersion },
  ): Promise<PublishResult> {
    if (typeof actor !== 'string' || !actor.trim()) fail('actor is required');
    const content = normalizeDraft(draft);
    if (!content.inputSchema && mode.source === 'seed') content.inputSchema = deriveInputSchema(content.template);
    const digest = promptDigest(content);
    const warnings = lintPrompt(content);

    return mutex.run(content.executorKey, async () => {
      // One executor key binds to one prompt id.
      const boundHead = await store.get<PromptHead>(GOAL_STORE_KEYS.promptHead(content.executorKey));
      if (boundHead && boundHead.promptId !== content.id) {
        throw new GoalStudioFailure('DUPLICATE', `executorKey '${content.executorKey}' is already bound to prompt '${boundHead.promptId}'`, { details: { executorKey: content.executorKey, promptId: boundHead.promptId } });
      }
      for (let attempt = 0; attempt < 16; attempt++) {
        const latest = await latestOf(content.id);
        if (mode.requireNew && latest) throw new GoalStudioFailure('DUPLICATE', `prompt '${content.id}' already exists (latest version ${latest.version})`, { details: { promptId: content.id, version: latest.version } });
        if (latest && latest.executorKey !== content.executorKey) {
          fail(`prompt '${content.id}' is bound to executorKey '${latest.executorKey}'; executorKey cannot change between versions`, { promptId: content.id });
        }
        const currentVersion = latest?.version ?? 0;
        if (draft.expectedVersion !== undefined && draft.expectedVersion !== currentVersion) {
          throw new GoalStudioFailure('LEDGER_CONFLICT', `prompt '${content.id}' is at version ${currentVersion}, expected ${draft.expectedVersion}`, { details: { promptId: content.id, currentVersion, expectedVersion: draft.expectedVersion } });
        }
        if (latest && latest.digest === digest) {
          await moveHead(latest); // repair a head left behind by a crash between slot write and head move
          return { prompt: latest, created: false, warnings };
        }
        if (mode.source === 'seed' && latest) {
          // A seed whose content already exists anywhere in history is not re-applied, so
          // re-seeding an unchanged graph never reverts an operator's later edits.
          const seen = (await versionsOf(content.id)).find((record) => record.digest === digest);
          if (seen) return { prompt: seen, created: false, warnings };
        }
        const record: PromptVersionRecord = {
          id: content.id,
          version: currentVersion + 1,
          executorKey: content.executorKey,
          role: content.role,
          template: content.template,
          ...(content.inputSchema ? { inputSchema: content.inputSchema } : {}),
          ...(content.outputSchema ? { outputSchema: content.outputSchema } : {}),
          requiredCapabilities: content.requiredCapabilities,
          digest,
          createdAt: clock().toISOString(),
          createdBy: actor,
          ...(latest ? { parentVersion: latest.version } : {}),
          ...(mode.rollbackOf !== undefined ? { rollbackOf: mode.rollbackOf } : {}),
          source: mode.source,
          ...(draft.note ? { note: draft.note } : {}),
        };
        if (await claimSlot(record)) {
          await moveHead(record);
          await emit(record);
          return { prompt: cloneJson(record), created: true, warnings };
        }
        // Another writer (other process) took this version slot; re-read and retry.
      }
      throw new GoalStudioFailure('LEDGER_CONFLICT', `could not claim a version slot for prompt '${content.id}'`, { retryable: true });
    });
  }

  async function storeEvaluation(result: PromptEvaluationResult): Promise<void> {
    await store.put(PROMPT_EVAL_KEY(result.promptId, result.id), result);
  }

  function requireRunner(): PromptRunner {
    if (!runner) throw new GoalStudioFailure('INTERNAL', 'prompt evaluation runner not configured');
    return runner;
  }

  const evalOptions = (actor: string): EvaluatePromptOptions => ({ clock, runnerId: deps.runnerId ?? 'injected', actor, timeoutMs: deps.evaluationTimeoutMs });

  const studio: PromptStudio = {
    canEvaluate: Boolean(runner),

    async latest(executorKey: string): Promise<PromptDefinition | undefined> {
      if (!PROMPT_ID_PATTERN.test(executorKey)) return undefined;
      const head = await store.get<PromptHead>(GOAL_STORE_KEYS.promptHead(executorKey));
      if (!head) return undefined;
      // Head may lag a crashed writer by one version; the version list is authoritative.
      return (await latestOf(head.promptId)) ?? readVersion(head.promptId, head.version);
    },

    get: readVersion,

    async resolve(ref) {
      if (!ref || typeof ref.promptId !== 'string' || !Number.isInteger(ref.version)) fail('promptRef must be { promptId, version }');
      return requireVersion(ref.promptId, ref.version);
    },

    create: (draft, actor) => write(draft, actor, { requireNew: true, source: 'publish' }),
    publish: (draft, actor) => write(draft, actor, { source: 'publish' }),

    async list(): Promise<PromptSummary[]> {
      const heads = (await store.list(HEAD_PREFIX)).map((entry) => entry.value as PromptHead).filter(Boolean);
      const summaries: PromptSummary[] = [];
      for (const head of heads) {
        const latest = (await latestOf(head.promptId)) ?? (await readVersion(head.promptId, head.version));
        if (!latest) continue;
        summaries.push({
          promptId: latest.id,
          executorKey: latest.executorKey,
          role: latest.role,
          latestVersion: latest.version,
          digest: latest.digest,
          requiredCapabilities: latest.requiredCapabilities,
          hasInputSchema: Boolean(latest.inputSchema),
          hasOutputSchema: Boolean(latest.outputSchema),
          updatedAt: latest.createdAt,
          updatedBy: latest.createdBy,
        });
      }
      return summaries.sort((a, b) => a.promptId.localeCompare(b.promptId));
    },

    head: latestOf,
    history: versionsOf,

    async diff(promptId, a, b) {
      const [left, right] = await Promise.all([requireVersion(promptId, a), requireVersion(promptId, b)]);
      return diffPromptVersions(left, right);
    },

    async rollback(promptId, toVersion, actor, note) {
      const target = await requireVersion(promptId, toVersion);
      return write(
        { ...promptContent(target), id: target.id, inputSchema: target.inputSchema, note: note ?? `rollback to v${toVersion}` },
        actor,
        { source: 'rollback', rollbackOf: toVersion },
      );
    },

    async seedFromGraph(seeds: readonly PromptSeed[] = DEFAULT_PROMPT_SEEDS, actor = 'system:seed') {
      if (!Array.isArray(seeds)) fail('seeds must be an array');
      const results: PublishResult[] = [];
      for (const seed of seeds) {
        results.push(await write({ ...seed, id: seed.executorKey, note: 'seeded from goal graph' }, actor, { source: 'seed' }));
      }
      return results;
    },

    async seedDefaults(actor = 'system:seed') {
      return studio.seedFromGraph(DEFAULT_PROMPT_SEEDS, actor);
    },

    async evaluate(promptId, version, cases: PromptEvalCase[], actor) {
      const run = requireRunner();
      const def = version === undefined ? await latestOf(promptId) : await requireVersion(promptId, version);
      if (!def) throw new GoalStudioFailure('NOT_FOUND', `prompt '${promptId}' not found`);
      const result = await evaluatePrompt(def, cases, run, evalOptions(actor));
      await storeEvaluation(result);
      return result;
    },

    async compareVersions(promptId, a, b, cases, actor): Promise<PromptComparison> {
      const run = requireRunner();
      const [left, right] = await Promise.all([requireVersion(promptId, a), requireVersion(promptId, b)]);
      const resultA = await evaluatePrompt(left, cases, run, evalOptions(actor));
      const resultB = await evaluatePrompt(right, cases, run, evalOptions(actor));
      await storeEvaluation(resultA);
      await storeEvaluation(resultB);
      const byIdB = new Map(resultB.cases.map((item) => [item.caseId, item.passed]));
      return {
        promptId,
        a: resultA,
        b: resultB,
        perCase: resultA.cases.map((item) => {
          const passB = byIdB.get(item.caseId) ?? false;
          const change = item.passed && passB ? 'same-pass' : !item.passed && !passB ? 'same-fail' : passB ? 'fixed' : 'regressed';
          return { caseId: item.caseId, a: item.passed, b: passB, change };
        }),
        diff: diffPromptVersions(left, right),
      };
    },

    async evaluations(promptId, version) {
      if (!PROMPT_ID_PATTERN.test(promptId)) return [];
      return (await store.list(EVAL_PREFIX(promptId)))
        .map((entry) => cloneJson(entry.value as PromptEvaluationResult))
        .filter((result) => result && (version === undefined || result.version === version))
        .sort((x, y) => x.startedAt.localeCompare(y.startedAt) || x.id.localeCompare(y.id));
    },
  };
  return studio;
}

/** Duck-type check routes use to decide whether admin endpoints are available. */
export function isPromptAdmin(value: unknown): value is PromptStudio {
  const candidate = value as Partial<PromptStudio> | undefined;
  return Boolean(candidate && typeof candidate.publish === 'function' && typeof candidate.history === 'function' && typeof candidate.rollback === 'function' && typeof candidate.list === 'function');
}
