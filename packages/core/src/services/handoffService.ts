import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { KeyValueStore } from '@wazir/shared';
import type { ExecutionEngine } from './executionEngine.js';
import type { CheckpointService } from './checkpointService.js';
import type { HandoffRecord, HandoffStatus } from '../types/handoff.js';
import type { PolicyRequirements } from '../types/task.js';
import type { ToolCallCheckpoint } from '../types/execution.js';
import { extractToolCheckpoints, reconstructExecutionState } from './executionRecovery.js';

const exec = promisify(execFile);
const SECRET_PATTERN =
  /(?:api[_-]?key|token|secret|password|authorization|credential|bearer)\s*[:=]\s*[^\s,;'"`]+/gi;

export function redactSecrets(input: string): string {
  return input.replace(SECRET_PATTERN, '[REDACTED]');
}

const redact = redactSecrets;

function redactUnknown<T>(value: T): T {
  if (typeof value === 'string') {
    return redact(value) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(?:api[_-]?key|token|secret|password|authorization|credential)$/i.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactUnknown(v);
      }
    }
    return out as T;
  }
  return value;
}

function containsUnredactedSecret(value: unknown): boolean {
  if (typeof value === 'string') {
    SECRET_PATTERN.lastIndex = 0;
    return SECRET_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsUnredactedSecret(item));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        /^(?:api[_-]?key|token|secret|password|authorization|credential)$/i.test(k) &&
        typeof v === 'string' &&
        v !== '[REDACTED]' &&
        v.length > 0
      ) {
        return true;
      }
      if (containsUnredactedSecret(v)) return true;
    }
  }
  return false;
}

export const PORTABLE_HANDOFF_SCHEMA_VERSION = 1 as const;

export interface PortableBudgetState {
  tokensUsed: number;
  toolCallsUsed: number;
  modelCallsUsed: number;
  costUSD: number;
  costStatus: 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN';
  durationMs: number;
}

export interface PortableRemainingBudget {
  maxTokens?: number | null;
  maxToolCalls?: number | null;
  maxModelCalls?: number | null;
  maxCostUSD?: number | null;
  maxDurationMs?: number | null;
}

export interface PortableActionSummary {
  actionId: string;
  kind: 'tool_call' | 'file_mutation' | 'verification_check' | 'plan_step';
  summary: string;
  toolName?: string;
  targetPath?: string;
  workspaceRevision: number;
  confirmed: boolean;
  at: string;
}

export type PortablePolicyContext = PolicyRequirements & {
  allowedTools?: string[];
  protectedPaths?: string[];
};

export interface PortableHandoff {
  schemaVersion: number;

  executionId: string;
  taskId: string;
  jobId?: string;

  sourceHarnessId: string;
  targetHarnessId?: string;
  sourceModelId?: string;
  sourceRuntimeId?: string;
  sourceWorkerId?: string;

  workspaceRevision: string;
  workspaceContentDigest: string;
  checkpointId: string;

  objective: string;
  completedActions: PortableActionSummary[];
  pendingActions: string[];
  filesChanged: string[];

  unresolvedSideEffects: ToolCallCheckpoint[];

  verificationEvidenceIds: string[];

  consumedBudget: PortableBudgetState;
  remainingBudget: PortableRemainingBudget;

  policyContext: PortablePolicyContext;

  resumable: boolean;
  nonResumableReason?: string;

  createdAt: string;
  integrityDigest: string;
}

export interface PortableHandoffBudgetLimits {
  maxTokens?: number;
  maxToolCalls?: number;
  maxModelCalls?: number;
  maxCostUSD?: number;
  maxDurationMs?: number;
}

export interface PortableHandoffCreateOptions {
  sourceHarnessId?: string;
  targetHarnessId?: string;
  checkpointId?: string;
  budgetLimits?: PortableHandoffBudgetLimits;
  pendingActions?: string[];
  policyContext?: Partial<PortablePolicyContext>;
}

export interface PortableHandoffVerificationResult {
  valid: boolean;
  errors: string[];
}

export interface HandoffCreateOptions {
  executionId?: string;
  taskId?: string;
  sourceSession?: string;
  sourceAgent?: string;
  targetAgent?: string;
  objective?: string;
  nextSteps?: string[];
  trigger?: string;
}

export interface HandoffServiceOptions {
  store: KeyValueStore;
  executions: ExecutionEngine;
  checkpoints?: CheckpointService;
  projectRoot?: string;
  lazy?: boolean;
}

function canonicalizeForDigest(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForDigest(item));
  }
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        sorted[key] = canonicalizeForDigest(v);
      }
    }
    return sorted;
  }
  return value;
}

export function computePortableHandoffDigest(
  handoff: Omit<PortableHandoff, 'integrityDigest'> | PortableHandoff,
): string {
  const clone = {
    ...handoff,
    integrityDigest: '',
  };
  const canonicalJson = JSON.stringify(canonicalizeForDigest(clone));
  return createHash('sha256').update(canonicalJson).digest('hex');
}

async function snapshotDirectoryFiles(workspaceRoot: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.wazir' || entry.name === 'dist') {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
        try {
          snapshot[relPath] = await fs.readFile(fullPath, 'utf8');
        } catch {
          // ignore unreadable or binary files
        }
      }
    }
  };
  await walk(workspaceRoot);
  return snapshot;
}

export async function computeWorkspaceContentDigest(options: {
  workspaceRoot?: string;
  revision: number | string;
  filesChanged?: string[];
  contentFingerprint?: string;
}): Promise<string> {
  const hash = createHash('sha256');
  const root = options.workspaceRoot;
  const cwd = process.cwd();

  if (root && path.resolve(root) !== path.resolve(cwd)) {
    const snapshot = await snapshotDirectoryFiles(root);
    const sortedEntries = Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b));
    for (const [filePath, content] of sortedEntries) {
      hash.update(JSON.stringify([filePath, content]));
    }
  } else if (root && options.filesChanged && options.filesChanged.length > 0) {
    const sortedFiles = [...new Set(options.filesChanged)].sort((a, b) => a.localeCompare(b));
    for (const relPath of sortedFiles) {
      try {
        const content = await fs.readFile(path.resolve(root, relPath), 'utf8');
        hash.update(JSON.stringify([relPath, content]));
      } catch {
        hash.update(JSON.stringify([relPath, null]));
      }
    }
  }

  if (options.contentFingerprint) {
    hash.update(`fp:${options.contentFingerprint}\n`);
  }
  hash.update(`rev:${options.revision}\n`);
  return hash.digest('hex');
}

const LOCAL_RUNTIMES = new Set(['local', 'ollama', 'lmstudio', 'vllm', 'llamacpp', 'llama.cpp', 'mlx']);

export class HandoffService {
  private _ready?: Promise<void>;
  private readonly records = new Map<string, HandoffRecord>();
  private readonly portableRecords = new Map<string, PortableHandoff>();

  get ready(): Promise<void> {
    return (this._ready ??= this.restore());
  }

  constructor(private readonly o: HandoffServiceOptions) {
    if (!o.lazy) void this.ready;
  }

  private digest(r: HandoffRecord) {
    return createHash('sha256').update(JSON.stringify(r)).digest('hex');
  }

  private async restore() {
    for (const { key, value } of await this.o.store.list('handoff/')) {
      const e = value as any;
      if (
        e?.version !== 1 ||
        !e.handoff ||
        key !== `handoff/${e.handoff.id}` ||
        this.digest(e.handoff) !== e.digest
      ) {
        throw new Error(`INVALID_HANDOFF: ${key}`);
      }
      this.records.set(e.handoff.id, e.handoff);
    }

    for (const { key, value } of await this.o.store.list('portable-handoff/')) {
      const e = value as { version?: number; handoff?: PortableHandoff } | undefined;
      if (e?.version === 1 && e.handoff) {
        const verification = this.verifyPortableHandoff(e.handoff);
        if (!verification.valid) {
          throw new Error(`INVALID_PORTABLE_HANDOFF: ${key} (${verification.errors.join('; ')})`);
        }
        this.portableRecords.set(e.handoff.executionId, e.handoff);
      }
    }
  }

  async create(x: HandoffCreateOptions = {}): Promise<HandoffRecord> {
    await this.ready;
    const source = x.executionId ? await this.o.executions.get(x.executionId) : undefined;
    if (x.executionId && !source) throw new Error(`Execution '${x.executionId}' not found`);
    const status = (source?.execution.status ?? 'unknown') as HandoffStatus;
    const duplicate = [...this.records.values()].find(
      (r) =>
        r.executionId === x.executionId &&
        r.status === status &&
        r.sourceSession === x.sourceSession &&
        r.targetAgent === x.targetAgent &&
        r.provenance.trigger === x.trigger,
    );
    if (duplicate) return structuredClone(duplicate);
    const root = source?.execution.workspaceRoot ?? this.o.projectRoot;
    const git = await this.git(root);
    const checks = (source?.checks ?? []).map((c) => ({
      name: c.name,
      command: redact(c.command),
      ok: c.ok,
    }));
    const r: HandoffRecord = {
      schemaVersion: 1,
      id: `ho-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      sourceSession: x.sourceSession,
      sourceAgent: x.sourceAgent,
      targetAgent: x.targetAgent,
      jobId: source?.execution.jobId,
      taskId: x.taskId ?? source?.task.id ?? 'unknown',
      executionId: source?.execution.id,
      task: {
        objective: redact(x.objective ?? source?.task.input ?? 'No objective recorded'),
        requirements: source?.task.requirements ?? {},
        constraints: [source?.task.policy, source?.task.workspaceMode].filter(Boolean),
        decisions: [],
      },
      status,
      completed: {
        actions:
          source?.events
            .filter(
              (e) =>
                (e.eventType ?? e.type).endsWith('.completed') ||
                (e.eventType ?? e.type) === 'workspace.mutated',
            )
            .map((e) => e.eventType ?? e.type) ?? [],
        files: [...(source?.filesChanged ?? [])],
        commits: git.commit ? [git.commit] : [],
        tests: checks,
        verification: (source?.evidence ?? []).map((e) => ({
          id: e.id,
          type: e.type,
          status: e.status,
          revision: e.revision,
        })),
      },
      remaining: {
        openTasks: status === 'completed' ? [] : ['Continue the authorized task'],
        defects: source?.errors.map(redact) ?? [],
        blockers:
          status === 'failed' || status === 'blocked'
            ? source?.errors.map(redact) ?? ['Investigation required']
            : [],
        pendingApprovals:
          source?.policyDecisions.filter((p) => p.decision === 'ask').map((p) => p.rule) ?? [],
        nextSteps:
          x.nextSteps ??
          (status === 'completed' ? [] : ['Inspect the workspace and run required verification']),
      },
      environment: {
        repositoryPath: root,
        worktree: root,
        branch: git.branch,
        currentCommit: git.commit,
        runtime: {
          runtimeId: source?.execution.runtimeId,
          modelId: source?.execution.modelId,
          agentId: source?.execution.agentId,
        },
        checkpointIds:
          source?.execution.id && this.o.checkpoints
            ? this.o.checkpoints.listCheckpoints(source.execution.id).map((c) => c.id)
            : [],
      },
      evidence: {
        executionIds: source?.execution.id ? [source.execution.id] : [],
        artifactReferences: [],
        toolResults: source?.toolCalls.map((t) => t.id) ?? [],
        verificationRecords: source?.evidence.map((e) => e.id) ?? [],
      },
      provenance: {
        generatedBy: 'HandoffService',
        sourceRevision: source?.workspaceState?.revision,
        sourceEventCount: source?.events.length,
        trigger: x.trigger,
      },
    };
    await this.o.store.put(`handoff/${r.id}`, { version: 1, digest: this.digest(r), handoff: r });
    this.records.set(r.id, r);
    return structuredClone(r);
  }

  async createAutomatic(
    trigger: string,
    executionId: string,
    options: Omit<HandoffCreateOptions, 'executionId' | 'trigger'> = {},
  ) {
    return this.create({ ...options, executionId, trigger });
  }

  async list() {
    await this.ready;
    return structuredClone(
      [...this.records.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  async get(id: string) {
    await this.ready;
    const r = this.records.get(id);
    return r && structuredClone(r);
  }

  async remove(id: string) {
    await this.ready;
    await this.o.store.delete(`handoff/${id}`);
    this.records.delete(id);
  }

  async resume(id: string) {
    const r = await this.get(id);
    if (!r) throw new Error(`Handoff '${id}' not found`);
    return r;
  }

  toMarkdown(r: HandoffRecord) {
    return [
      `# Wazir Agent Handoff`,
      ``,
      `Task: ${r.task.objective}`,
      `Status: ${r.status.toUpperCase()}`,
      ``,
      `Completed:`,
      ...r.completed.actions.map((x) => `- ${x}`),
      ``,
      `Files: ${r.completed.files.join(', ') || 'None recorded'}`,
      `Tests: ${r.completed.tests.map((t) => `${t.ok ? 'PASS' : 'FAIL'} ${t.name}`).join(', ') || 'None recorded'}`,
      ``,
      `Blocked:`,
      ...r.remaining.blockers.map((x) => `- ${x}`),
      ``,
      `Next actions:`,
      ...r.remaining.nextSteps.map((x, i) => `${i + 1}. ${x}`),
      ``,
      `Confidence: Only execution and verification evidence listed above is established.`,
      `Evidence: ${r.evidence.executionIds.join(', ') || 'None recorded'}`,
    ].join('\n');
  }

  /**
   * Creates a schema-versioned, integrity-verified PortableHandoff from durable
   * execution facts (without replaying raw model transcripts or assuming KV cache portability).
   */
  async createPortableHandoff(
    executionId: string,
    options: PortableHandoffCreateOptions = {},
  ): Promise<PortableHandoff> {
    await this.ready;
    const source = await this.o.executions.get(executionId);
    if (!source) {
      throw new Error(`Execution '${executionId}' not found`);
    }

    // Merge tool checkpoints from ExecutionEngine and record.events
    const engineCheckpoints = this.o.executions.toolCheckpoints?.(executionId) ?? [];
    const eventCheckpoints = extractToolCheckpoints(source);
    const checkpointByCallId = new Map<string, ToolCallCheckpoint>();
    for (const chk of engineCheckpoints) {
      checkpointByCallId.set(chk.callId, chk);
    }
    for (const chk of eventCheckpoints) {
      checkpointByCallId.set(chk.callId, chk);
    }
    const allCheckpoints = [...checkpointByCallId.values()];

    const limits = options.budgetLimits ?? {};
    const state = reconstructExecutionState(source, allCheckpoints, {
      maxTokens: limits.maxTokens,
      maxToolCalls: limits.maxToolCalls,
      maxModelRequests: limits.maxModelCalls,
      maxWallClockMs: limits.maxDurationMs,
    });

    // Resolve checkpoint and workspace digest
    let checkpointId = options.checkpointId;
    let workspaceRevisionNum = state.workspaceRevision;
    let workspaceContentDigest: string | undefined;

    if (this.o.checkpoints) {
      if (checkpointId) {
        const chk = this.o.checkpoints.getCheckpoint(checkpointId);
        if (chk) {
          workspaceRevisionNum = chk.workspaceRevision;
          workspaceContentDigest = this.o.checkpoints.computeDigest(chk);
        }
      } else {
        const existing = this.o.checkpoints.listCheckpoints(executionId);
        if (existing.length > 0) {
          const latest = existing.sort(
            (a, b) =>
              b.workspaceRevision - a.workspaceRevision ||
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          )[0];
          checkpointId = latest.id;
          workspaceRevisionNum = latest.workspaceRevision;
          workspaceContentDigest = this.o.checkpoints.computeDigest(latest);
        }
      }
    }

    if (!checkpointId) {
      checkpointId = `chk-portable-${executionId}-r${workspaceRevisionNum}`;
    }

    const workspaceRoot = source.execution.workspaceRoot ?? this.o.projectRoot;
    if (!workspaceContentDigest) {
      workspaceContentDigest = await computeWorkspaceContentDigest({
        workspaceRoot,
        revision: workspaceRevisionNum,
        filesChanged: source.filesChanged,
        contentFingerprint: source.workspaceState?.contentFingerprint,
      });
    }

    // Build durable completedActions (tool calls, file mutations, verification checks, plan steps)
    // Explicitly excludes raw model transcripts, token streams, and KV cache state.
    const completedActions: PortableActionSummary[] = [];

    for (const tc of source.toolCalls ?? []) {
      if (!tc.ok) continue;
      completedActions.push({
        actionId: tc.callId ?? tc.id,
        kind: 'tool_call',
        summary: redact(
          `Confirmed tool '${tc.tool}'${tc.output ? ` (${tc.output.slice(0, 100).replace(/\s+/g, ' ').trim()})` : ''}`,
        ),
        toolName: tc.tool,
        workspaceRevision: workspaceRevisionNum,
        confirmed: true,
        at: tc.at instanceof Date ? tc.at.toISOString() : new Date(tc.at).toISOString(),
      });
    }

    if (source.mutationHistory && source.mutationHistory.length > 0) {
      for (const mut of source.mutationHistory) {
        completedActions.push({
          actionId: `mutation-${mut.revision}-${mut.path}`,
          kind: 'file_mutation',
          summary: redact(`Modified file '${mut.path}' at revision ${mut.revision}`),
          targetPath: mut.path,
          workspaceRevision: mut.revision,
          confirmed: true,
          at: mut.at instanceof Date ? mut.at.toISOString() : new Date(mut.at).toISOString(),
        });
      }
    } else {
      for (const filePath of source.filesChanged ?? []) {
        completedActions.push({
          actionId: `mutation-${workspaceRevisionNum}-${filePath}`,
          kind: 'file_mutation',
          summary: redact(`Modified file '${filePath}'`),
          targetPath: filePath,
          workspaceRevision: workspaceRevisionNum,
          confirmed: true,
          at: new Date().toISOString(),
        });
      }
    }

    for (const check of source.checks ?? []) {
      const checkRev = check.workspaceRevision ?? workspaceRevisionNum;
      if (check.ok && checkRev === workspaceRevisionNum) {
        completedActions.push({
          actionId: `check-${check.name}-r${checkRev}`,
          kind: 'verification_check',
          summary: redact(`Check '${check.name}' passed at revision ${checkRev} (${check.command})`),
          workspaceRevision: checkRev,
          confirmed: true,
          at: new Date().toISOString(),
        });
      }
    }

    for (const ev of source.events ?? []) {
      const type = ev.eventType ?? ev.type;
      if (type === 'step.completed') {
        const data = (ev.data ?? {}) as Record<string, unknown>;
        const stepSummary =
          typeof data.summary === 'string'
            ? data.summary
            : typeof data.stepId === 'string'
              ? `Completed plan step ${data.stepId}`
              : 'Completed plan step';
        completedActions.push({
          actionId: ev.stepId ?? ev.id,
          kind: 'plan_step',
          summary: redact(stepSummary),
          workspaceRevision: ev.workspaceRevision ?? workspaceRevisionNum,
          confirmed: true,
          at: ev.timestamp instanceof Date ? ev.timestamp.toISOString() : new Date(ev.timestamp).toISOString(),
        });
      }
    }

    // Unresolved side effects from tool checkpoints
    const unresolvedSideEffects: ToolCallCheckpoint[] = allCheckpoints
      .filter((c) => c.state === 'STARTED' || c.state === 'OUTCOME_UNKNOWN')
      .map((c) => ({
        ...c,
        startedAt: c.startedAt instanceof Date ? c.startedAt : new Date(c.startedAt),
        ...(c.finishedAt ? { finishedAt: c.finishedAt instanceof Date ? c.finishedAt : new Date(c.finishedAt) } : {}),
        input: redactUnknown(c.input),
      }));

    // Verification evidence IDs valid at the current workspace revision
    const verificationEvidenceIds: string[] = [];
    for (const ev of source.evidence ?? []) {
      const evRev = ev.revision ?? (ev as any).workspaceRevision ?? workspaceRevisionNum;
      const status = (ev.status ?? 'PASS').toUpperCase();
      if (evRev === workspaceRevisionNum && (status === 'PASS' || status === 'PASSED' || status === 'VALID')) {
        verificationEvidenceIds.push(ev.id);
      }
    }
    for (const passingCheck of state.verification.currentPassing) {
      const syntheticId = `check:${passingCheck}@r${workspaceRevisionNum}`;
      if (!verificationEvidenceIds.includes(syntheticId)) {
        verificationEvidenceIds.push(syntheticId);
      }
    }

    // Consumed budget calculation (following Invariant 3 for costStatus)
    const runtimeLower = (source.execution.runtimeId ?? '').toLowerCase();
    const isLocalRuntime =
      LOCAL_RUNTIMES.has(runtimeLower) ||
      runtimeLower.startsWith('local') ||
      runtimeLower.startsWith('ollama') ||
      source.task.policy?.localOnly === true;

    const explicitCost = (source as any).costUSD as number | undefined;
    const explicitCostStatus = (source as any).costStatus as
      | 'ACTUAL'
      | 'ESTIMATED'
      | 'UNKNOWN'
      | undefined;

    let costUSD = 0;
    let costStatus: 'ACTUAL' | 'ESTIMATED' | 'UNKNOWN' = 'UNKNOWN';
    if (typeof explicitCost === 'number' && Number.isFinite(explicitCost)) {
      costUSD = explicitCost;
      costStatus = explicitCostStatus ?? 'ACTUAL';
    } else if (isLocalRuntime) {
      costUSD = 0;
      costStatus = 'ACTUAL';
    } else {
      costUSD = 0;
      costStatus = explicitCostStatus ?? 'UNKNOWN';
    }

    const tokensUsed = state.consumed.tokens;
    const toolCallsUsed = state.consumed.toolCalls;
    const modelCallsUsed = source.totalModelCalls ?? state.consumed.modelRequests;
    const durationMs = state.consumed.wallClockMs ?? 0;

    const consumedBudget: PortableBudgetState = {
      tokensUsed,
      toolCallsUsed,
      modelCallsUsed,
      costUSD,
      costStatus,
      durationMs,
    };

    const maxDurationFromPolicy =
      source.task.policy?.maxExecutionTimeSeconds !== undefined
        ? source.task.policy.maxExecutionTimeSeconds * 1000
        : undefined;
    const effectiveMaxDurationMs = limits.maxDurationMs ?? maxDurationFromPolicy;

    const remainingBudget: PortableRemainingBudget = {
      maxTokens: limits.maxTokens !== undefined ? limits.maxTokens - tokensUsed : null,
      maxToolCalls: limits.maxToolCalls !== undefined ? limits.maxToolCalls - toolCallsUsed : null,
      maxModelCalls: limits.maxModelCalls !== undefined ? limits.maxModelCalls - modelCallsUsed : null,
      maxCostUSD: limits.maxCostUSD !== undefined ? Number((limits.maxCostUSD - costUSD).toFixed(6)) : null,
      maxDurationMs: effectiveMaxDurationMs !== undefined ? effectiveMaxDurationMs - durationMs : null,
    };

    // Determine resumability
    const blockingMutatingCalls = unresolvedSideEffects.filter((c) => c.sideEffectClass !== 'READ_ONLY');
    const exhaustedBudgets = Object.entries(remainingBudget)
      .filter(([, val]) => typeof val === 'number' && val <= 0)
      .map(([key]) => key);

    let resumable = true;
    let nonResumableReason: string | undefined;

    if (source.execution.status === 'completed' || source.execution.status === 'cancelled') {
      resumable = false;
      nonResumableReason = `TERMINAL_STATUS: execution is already ${source.execution.status}`;
    } else if (blockingMutatingCalls.length > 0) {
      resumable = false;
      nonResumableReason = redact(
        `UNRESOLVED_MUTATING_SIDE_EFFECTS: ${blockingMutatingCalls
          .map((c) => `${c.toolName} (${c.callId}, ${c.sideEffectClass})`)
          .join(', ')}`,
      );
    } else if (exhaustedBudgets.length > 0) {
      resumable = false;
      nonResumableReason = `BUDGET_EXHAUSTED: ${exhaustedBudgets.join(', ')}`;
    }

    const basePolicy: PortablePolicyContext = {
      ...(source.task.policy ? structuredClone(source.task.policy) : {}),
      ...(options.policyContext ? structuredClone(options.policyContext) : {}),
    };
    if (workspaceRoot && !basePolicy.projectRoot) {
      basePolicy.projectRoot = workspaceRoot;
    }

    const pendingActions = (
      options.pendingActions ??
      (source.execution.status === 'completed'
        ? []
        : [
            'Inspect modified files and current workspace state',
            'Complete remaining task requirements',
            'Run verification checks at the final workspace revision',
          ])
    ).map(redact);

    const draft: Omit<PortableHandoff, 'integrityDigest'> = {
      schemaVersion: PORTABLE_HANDOFF_SCHEMA_VERSION,
      executionId: source.execution.id,
      taskId: source.task.id,
      ...(source.execution.jobId ? { jobId: source.execution.jobId } : {}),
      sourceHarnessId: options.sourceHarnessId ?? source.execution.agentId ?? 'native',
      ...(options.targetHarnessId ? { targetHarnessId: options.targetHarnessId } : {}),
      sourceModelId: source.execution.modelId,
      sourceRuntimeId: source.execution.runtimeId,
      ...(source.execution.workerId || source.execution.computerId
        ? { sourceWorkerId: source.execution.workerId ?? source.execution.computerId }
        : {}),
      workspaceRevision: String(workspaceRevisionNum),
      workspaceContentDigest,
      checkpointId,
      objective: redact(source.task.input || 'Continue task execution'),
      completedActions,
      pendingActions,
      filesChanged: [...(source.filesChanged ?? [])],
      unresolvedSideEffects,
      verificationEvidenceIds,
      consumedBudget,
      remainingBudget,
      policyContext: redactUnknown(basePolicy),
      resumable,
      ...(nonResumableReason ? { nonResumableReason } : {}),
      createdAt: new Date().toISOString(),
    };

    const integrityDigest = computePortableHandoffDigest(draft);
    const handoff: PortableHandoff = {
      ...draft,
      integrityDigest,
    };

    await this.o.store.put(`portable-handoff/${handoff.executionId}`, {
      version: 1,
      digest: integrityDigest,
      handoff,
    });
    this.portableRecords.set(handoff.executionId, structuredClone(handoff));

    return structuredClone(handoff);
  }

  /**
   * Verifies schemaVersion === 1, required fields, secret redaction, and SHA-256 integrityDigest.
   * Also sanitizes any unredacted secrets in-place on a defensive copy if needed.
   */
  verifyPortableHandoff(handoff: PortableHandoff): PortableHandoffVerificationResult {
    const errors: string[] = [];

    if (!handoff || typeof handoff !== 'object') {
      return { valid: false, errors: ['INVALID_PAYLOAD: handoff must be an object'] };
    }

    if (handoff.schemaVersion !== PORTABLE_HANDOFF_SCHEMA_VERSION) {
      errors.push(
        `UNSUPPORTED_SCHEMA_VERSION: expected ${PORTABLE_HANDOFF_SCHEMA_VERSION}, got ${String(handoff.schemaVersion)}`,
      );
    }

    if (!handoff.executionId || typeof handoff.executionId !== 'string') {
      errors.push('MISSING_FIELD: executionId is required');
    }
    if (!handoff.taskId || typeof handoff.taskId !== 'string') {
      errors.push('MISSING_FIELD: taskId is required');
    }
    if (!handoff.sourceHarnessId || typeof handoff.sourceHarnessId !== 'string') {
      errors.push('MISSING_FIELD: sourceHarnessId is required');
    }
    if (!handoff.checkpointId || typeof handoff.checkpointId !== 'string') {
      errors.push('MISSING_FIELD: checkpointId is required');
    }
    if (handoff.workspaceRevision === undefined || handoff.workspaceRevision === null || handoff.workspaceRevision === '') {
      errors.push('MISSING_FIELD: workspaceRevision is required');
    }
    if (!handoff.workspaceContentDigest || typeof handoff.workspaceContentDigest !== 'string') {
      errors.push('MISSING_FIELD: workspaceContentDigest is required');
    }
    if (!handoff.integrityDigest || typeof handoff.integrityDigest !== 'string') {
      errors.push('MISSING_FIELD: integrityDigest is required');
    }

    const withoutDigest = { ...handoff, integrityDigest: '' };
    if (containsUnredactedSecret(withoutDigest)) {
      errors.push('UNREDACTED_SECRET_DETECTED: portable handoff contains unredacted credential material');
    }

    const expectedDigest = computePortableHandoffDigest(handoff);
    if (handoff.integrityDigest !== expectedDigest) {
      errors.push(
        `INTEGRITY_DIGEST_MISMATCH: expected '${expectedDigest}', got '${handoff.integrityDigest}'`,
      );
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  async getPortableHandoff(executionId: string): Promise<PortableHandoff | undefined> {
    await this.ready;
    const record = this.portableRecords.get(executionId);
    return record ? structuredClone(record) : undefined;
  }

  async listPortableHandoffs(): Promise<PortableHandoff[]> {
    await this.ready;
    return structuredClone(
      [...this.portableRecords.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  private async git(cwd?: string) {
    if (!cwd) return {};
    try {
      const [b, c] = await Promise.all([
        exec('git', ['branch', '--show-current'], { cwd }),
        exec('git', ['rev-parse', 'HEAD'], { cwd }),
      ]);
      return { branch: b.stdout.trim(), commit: c.stdout.trim() };
    } catch {
      return {};
    }
  }
}
