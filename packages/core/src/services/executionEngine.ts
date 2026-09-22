import type {
  AcceptanceContract,
  CheckRunRecord,
  ContextDecision,
  EvaluationResult,
  EvidenceType,
  Execution,
  ExecutionEvent,
  ExecutionEventType,
  ExecutionRecord,
  ExecutionStatus,
  FileMutationHistoryEntry,
  PolicyDecision,
  SchedulerDecision,
  Task,
  TokenUsage,
  ToolCallRecord,
  VerificationEvidence,
  WorkspaceState,
} from '../types/index.js';
import { sanitizeUntrustedOutput, appendAuditEvent, computeContentHash } from '@wazir/shared';
import type { ProvenanceManager, CreateArtifactParams } from './provenanceManager.js';

export interface ExecutionEngineOptions {
  /** Persists a record after every mutation. */
  persist?: (record: ExecutionRecord) => void | Promise<void>;
  /** Seeds the engine from durable storage at startup. */
  load?: () => ExecutionRecord[] | Promise<ExecutionRecord[]>;
  idPrefix?: string;
  provenanceManager?: ProvenanceManager;
  /** Project root used as the artifact workspace; defaults to process.cwd(). */
  workspace?: string;
}

let eventCounter = 0;
let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Durable execution tracking. Every execution produces a complete record:
 * task, agent, model, runtime, computer, context, policy decisions,
 * scheduling decision, tool calls, files changed, checks, errors,
 * latency, token usage, final result and evaluation.
 */
export class ExecutionEngine {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly persist?: (record: ExecutionRecord) => void | Promise<void>;
  private readonly idPrefix: string;
  private readonly provenanceManager?: ProvenanceManager;
  private readonly workspace: string;
  readonly ready: Promise<void>;

  constructor(options: ExecutionEngineOptions = {}) {
    this.persist = options.persist;
    this.idPrefix = options.idPrefix ?? 'exec';
    this.provenanceManager = options.provenanceManager;
    this.workspace = options.workspace ?? process.cwd();
    this.ready = Promise.resolve(options.load?.()).then((loaded) => {
      if (!loaded) return;
      for (const record of loaded) {
        this.records.set(record.execution.id, record);
      }
    }).catch(() => {});
  }

  async create(params: {
    task: Task;
    agentId?: string;
    computerId: string;
    runtimeId: string;
    modelId: string;
    workerId?: string;
    scheduling?: SchedulerDecision;
    context?: ContextDecision;
  }): Promise<ExecutionRecord> {
    const now = new Date();
    const execution: Execution = {
      id: nextId(this.idPrefix),
      taskId: params.task.id,
      agentId: params.agentId,
      computerId: params.computerId,
      runtimeId: params.runtimeId,
      modelId: params.modelId,
      workerId: params.workerId,
      status: 'queued',
      createdAt: now,
    };

    const workspaceState: WorkspaceState = {
      workspaceId: execution.id,
      revision: 0,
      updatedAt: now,
    };

    const record: ExecutionRecord = {
      execution,
      task: params.task,
      scheduling: params.scheduling,
      context: params.context,
      policyDecisions: [],
      toolCalls: [],
      filesChanged: [],
      checks: [],
      errors: [],
      workspaceState,
      evidence: [],
      acceptanceContract: params.task.acceptanceContract,
      mutationHistory: [],
      events: [
        {
          id: nextId('evt'),
          executionId: execution.id,
          type: 'execution.created',
          timestamp: now,
          data: {
            agentId: params.agentId,
            computerId: params.computerId,
            runtimeId: params.runtimeId,
            modelId: params.modelId,
          },
        },
      ],
    };

    this.records.set(execution.id, record);
    await this.flush(record);
    return record;
  }

  async setScheduled(executionId: string, scheduling: SchedulerDecision): Promise<void> {
    const record = this.require(executionId);
    record.scheduling = scheduling;
    this.pushEvent(record, 'execution.scheduled', scheduling);
    await this.flush(record);
  }

  async setStatus(executionId: string, status: ExecutionStatus, options?: { targetRevision?: number }): Promise<void> {
    const record = this.require(executionId);

    if (status === 'completed' && options?.targetRevision !== undefined) {
      const currentRev = record.workspaceState?.revision ?? 0;
      if (options.targetRevision !== currentRev) {
        this.pushEvent(record, 'completion.rejected', {
          targetRevision: options.targetRevision,
          attemptedRevision: options.targetRevision,
          currentRevision: currentRev,
          reason: 'STALE_WORKSPACE_REVISION',
        });
        const err = new Error(`STALE_WORKSPACE_REVISION: target revision ${options.targetRevision} does not match current workspace revision ${currentRev}`);
        (err as any).code = 'STALE_WORKSPACE_REVISION';
        throw err;
      }
    }

    record.execution.status = status;
    const now = new Date();
    if (status === 'running' && !record.execution.startedAt) {
      record.execution.startedAt = now;
    }
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      record.execution.completedAt = now;
    }

    const eventType: ExecutionEventType =
      status === 'running'
        ? 'execution.assigned'
        : status === 'completed'
          ? 'execution.completed'
          : status === 'failed'
            ? 'execution.failed'
            : status === 'cancelled'
              ? 'execution.cancelled'
              : 'execution.scheduled';

    this.pushEvent(record, eventType, { status });
    await this.flush(record);
  }

  async recordPolicy(executionId: string, decision: PolicyDecision): Promise<void> {
    const record = this.require(executionId);
    record.policyDecisions.push(decision);
    this.pushEvent(record, 'policy.decision', decision);
    void appendAuditEvent({
      type: 'policy_decision',
      tool: decision.tool,
      decision: decision.decision,
      rule: decision.rule,
      reasons: decision.reasons,
      command: decision.command,
      executionId,
      taskId: record.task.id,
      agentId: record.execution.agentId,
    }).catch(() => {});
    await this.flush(record);
  }

  async recordToolCall(executionId: string, call: ToolCallRecord): Promise<void> {
    const record = this.require(executionId);
    // Tool output is persisted for the life of the record and may be shipped
    // to a control plane; scrub terminal escapes and credential-shaped
    // material before it lands anywhere durable (F-13, F-23).
    record.toolCalls.push({
      ...call,
      output: call.output === undefined ? undefined : sanitizeUntrustedOutput(call.output),
      error: call.error === undefined ? undefined : sanitizeUntrustedOutput(call.error),
    });
    this.pushEvent(record, 'tool.completed', {
      tool: call.tool,
      ok: call.ok,
      policyEffect: call.policyEffect,
      durationMs: call.durationMs,
    });
    await this.flush(record);
  }

  async recordToolStart(executionId: string, tool: string, input: unknown): Promise<void> {
    const record = this.require(executionId);
    this.pushEvent(record, 'tool.started', { tool, input });
    await this.flush(record);
  }

  async recordCheck(executionId: string, check: CheckRunRecord): Promise<void> {
    const record = this.require(executionId);
    const sanitized = {
      ...check,
      output: check.output !== undefined ? sanitizeUntrustedOutput(check.output) : undefined,
    };
    record.checks.push(sanitized);
    this.pushEvent(record, 'check.completed', sanitized);

    const currentRev = record.workspaceState?.revision ?? 0;
    const evidenceType: EvidenceType | undefined =
      check.name === 'build' ? 'BUILD' :
      check.name === 'test' ? 'TEST' :
      check.name === 'lint' || check.name === 'typecheck' ? 'STATIC_CHECK' : undefined;

    if (evidenceType) {
      if (!record.evidence) record.evidence = [];
      const ev: VerificationEvidence = {
        id: nextId('evd'),
        type: evidenceType,
        executionId,
        workspaceId: record.workspaceState?.workspaceId ?? executionId,
        revision: currentRev,
        command: check.command,
        exitCode: check.ok ? 0 : 1,
        durationMs: check.durationMs,
        output: sanitized.output,
        completedAt: new Date(),
      };
      record.evidence.push(ev);

      if (evidenceType === 'BUILD') {
        this.pushEvent(record, 'build.completed', {
          workspaceRevision: currentRev,
          exitCode: ev.exitCode,
          command: check.command,
          ok: check.ok,
        });
      } else if (evidenceType === 'TEST') {
        this.pushEvent(record, 'test.completed', {
          workspaceRevision: currentRev,
          exitCode: ev.exitCode,
          command: check.command,
          ok: check.ok,
        });
      }
    }

    await this.flush(record);
  }

  async recordEvidence(
    executionId: string,
    evidence: Omit<VerificationEvidence, 'id'> & { id?: string },
  ): Promise<VerificationEvidence> {
    const record = this.require(executionId);
    if (!record.evidence) {
      record.evidence = [];
    }
    const currentRev = record.workspaceState?.revision ?? 0;
    const fullEvidence: VerificationEvidence = {
      id: evidence.id ?? nextId('evd'),
      type: evidence.type,
      executionId,
      workspaceId: evidence.workspaceId ?? record.workspaceState?.workspaceId ?? executionId,
      revision: evidence.revision !== undefined ? evidence.revision : currentRev,
      command: evidence.command,
      exitCode: evidence.exitCode,
      durationMs: evidence.durationMs,
      startedAt: evidence.startedAt,
      completedAt: evidence.completedAt ?? new Date(),
      output: evidence.output ? sanitizeUntrustedOutput(evidence.output) : undefined,
      artifactFingerprint: evidence.artifactFingerprint,
      metadata: evidence.metadata,
    };
    record.evidence.push(fullEvidence);

    if (fullEvidence.type === 'BUILD') {
      this.pushEvent(record, 'build.completed', {
        workspaceRevision: fullEvidence.revision,
        exitCode: fullEvidence.exitCode,
        command: fullEvidence.command,
        ok: fullEvidence.exitCode === 0,
      });
    } else if (fullEvidence.type === 'TEST') {
      this.pushEvent(record, 'test.completed', {
        workspaceRevision: fullEvidence.revision,
        exitCode: fullEvidence.exitCode,
        command: fullEvidence.command,
        ok: fullEvidence.exitCode === 0,
      });
    }

    await this.flush(record);
    return fullEvidence;
  }

  async recordEvent(executionId: string, type: ExecutionEventType, data?: unknown): Promise<void> {
    const record = this.require(executionId);
    this.pushEvent(record, type, data);
    await this.flush(record);
  }

  async recordError(executionId: string, error: string): Promise<void> {
    const record = this.require(executionId);
    record.errors.push(error);
    await this.flush(record);
  }

  async recordUsage(executionId: string, usage: TokenUsage): Promise<void> {
    const record = this.require(executionId);
    record.usage = {
      input: (record.usage?.input ?? 0) + usage.input,
      output: (record.usage?.output ?? 0) + usage.output,
      total: (record.usage?.total ?? 0) + (usage.total ?? usage.input + usage.output),
    };
    await this.flush(record);
  }

  async recordFilesChanged(executionId: string, files: string[]): Promise<void> {
    if (!files || files.length === 0) return;
    const record = this.require(executionId);
    if (!record.workspaceState) {
      record.workspaceState = {
        workspaceId: executionId,
        revision: 0,
        updatedAt: new Date(),
      };
    }
    if (!record.mutationHistory) {
      record.mutationHistory = [];
    }

    record.workspaceState.revision += 1;
    record.workspaceState.updatedAt = new Date();
    const currentRev = record.workspaceState.revision;

    for (const file of files) {
      if (!record.filesChanged.includes(file)) {
        record.filesChanged.push(file);
      }
      record.mutationHistory.push({
        path: file,
        revision: currentRev,
        at: new Date(),
      });
      this.pushEvent(record, 'file.changed', { file, workspaceRevision: currentRev });
    }

    this.pushEvent(record, 'workspace.revision_changed', {
      workspaceRevision: currentRev,
      files,
    });

    if (record.evidence && record.evidence.some((e) => e.revision < currentRev)) {
      this.pushEvent(record, 'evidence.stale', {
        workspaceRevision: currentRev,
        staleEvidenceCount: record.evidence.filter((e) => e.revision < currentRev).length,
      });
    }

    for (const file of files) {
      // Register artifact provenance if provenance manager is available
      if (this.provenanceManager && !file.startsWith('node_modules') && !file.startsWith('.git')) {
        try {
          const content = await this.readFile(file);
          const hash = await computeContentHash(content);
          const size = Buffer.byteLength(content, 'utf8');
          
          const artifactParams: CreateArtifactParams = {
            type: file.endsWith('.ts') || file.endsWith('.js') ? 'generated_code' : 'source',
            name: file.split('/').pop() ?? file,
            location: file,
            contentHash: hash,
            sizeBytes: size,
            workspace: this.workspace,
            executionId: executionId,
            agentId: record.execution.agentId || '',
            modelId: record.execution.modelId,
            runtimeId: record.execution.runtimeId,
            computerId: record.execution.computerId,
            workerId: record.execution.workerId,
            toolsUsed: record.toolCalls.map(t => t.tool),
            mcpServersUsed: [],
            connectorsUsed: [],
            policyDecisions: record.policyDecisions.map(d => d.rule),
            inputArtifactIds: [],
            parentArtifactIds: [],
            evaluations: record.checks.map(c => c.name),
            reviewers: [],
            gitMetadata: {
              repository: this.getGitRepo(file),
              branch: await this.getGitBranch(file),
              commit: await this.getGitCommit(file),
              dirty: false,
              changedFiles: [file],
              diffHash: ''
            }
          };
          
          await this.provenanceManager.registerArtifact(artifactParams);
        } catch {
          // Ignore provenance registration errors
        }
      }
    }
    await this.flush(record);
  }

  getFilesChangedSince(executionId: string, revision: number): string[] {
    const record = this.require(executionId);
    if (!record.mutationHistory) return [];
    const changed = new Set<string>();
    for (const entry of record.mutationHistory) {
      if (entry.revision > revision) {
        changed.add(entry.path);
      }
    }
    return Array.from(changed);
  }

  getWorkspaceRevision(executionId: string): number {
    return this.require(executionId).workspaceState?.revision ?? 0;
  }

  async setResult(executionId: string, result: string): Promise<void> {
    const record = this.require(executionId);
    record.result = sanitizeUntrustedOutput(result);
    
    // Register execution summary as an artifact
    if (this.provenanceManager) {
      try {
        const content = JSON.stringify({
          result,
          task: record.task,
          executionId,
          status: record.execution.status
        });
        const hash = await computeContentHash(Buffer.from(content, 'utf8'));
        
        const artifactParams: CreateArtifactParams = {
          type: 'report',
          name: `execution-summary-${record.execution.id}`,
          location: `.wazir/artifacts/${record.execution.id}.json`,
          contentHash: hash,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          workspace: this.workspace,
          executionId: executionId,
          agentId: record.execution.agentId || '',
          modelId: record.execution.modelId,
          runtimeId: record.execution.runtimeId,
          computerId: record.execution.computerId,
          workerId: record.execution.workerId,
          toolsUsed: record.toolCalls.map(t => t.tool),
          mcpServersUsed: [],
          connectorsUsed: [],
          policyDecisions: record.policyDecisions.map(d => d.rule),
          inputArtifactIds: [],
          parentArtifactIds: [],
          evaluations: record.checks.map(c => c.name),
          reviewers: []
        };
        
        await this.provenanceManager.registerArtifact(artifactParams);
      } catch {
        // Ignore provenance registration errors
      }
    }
    
    await this.flush(record);
  }

  async setEvaluation(executionId: string, evaluation: EvaluationResult): Promise<void> {
    const record = this.require(executionId);
    record.evaluation = evaluation;
    this.pushEvent(record, 'evaluation.completed', evaluation);
    
    // Register test results as artifacts
    if (this.provenanceManager) {
      try {
        for (const check of record.checks) {
          {
            const content = JSON.stringify({
              ...check,
              executionId,
              taskId: record.task.id
            });
            const hash = await computeContentHash(Buffer.from(content, 'utf8'));
            
            const artifactParams: CreateArtifactParams = {
              type: 'test_result',
              name: `test-${check.name.replace(/\s+/g, '-')}`,
              location: check.command,
              contentHash: hash,
              sizeBytes: Buffer.byteLength(content, 'utf8'),
              workspace: this.workspace,
              executionId: executionId,
              agentId: record.execution.agentId || '',
              modelId: record.execution.modelId,
              runtimeId: record.execution.runtimeId,
              computerId: record.execution.computerId,
              workerId: record.execution.workerId,
              toolsUsed: [check.name],
              mcpServersUsed: [],
              connectorsUsed: [],
              policyDecisions: [],
              inputArtifactIds: [],
              parentArtifactIds: [],
              evaluations: [],
              reviewers: []
            };
            
            await this.provenanceManager.registerArtifact(artifactParams);
          }
        }
      } catch {
        // Ignore provenance registration errors
      }
    }
    
    await this.flush(record);
  }

  private async readFile(filepath: string): Promise<Buffer> {
    try {
      const { promises: fs } = await import('node:fs');
      return await fs.readFile(filepath);
    } catch {
      return Buffer.from('');
    }
  }

  private getGitRepo(filepath: string): string | undefined {
    // Simplified - in production, this would parse .git/config
    return process.env.GIT_REPO;
  }

  private async getGitBranch(filepath: string): Promise<string | undefined> {
    try {
      const { exec } = await import('node:child_process');
      return 'main'; // simplified
    } catch {
      return undefined;
    }
  }

  private async getGitCommit(filepath: string):Promise<string | undefined> {
    try {
      const { exec } = await import('node:child_process');
      return 'HEAD'; // simplified
    } catch {
      return undefined;
    }
  }

  async get(executionId: string): Promise<ExecutionRecord | undefined> {
    return this.records.get(executionId);
  }

  require(executionId: string): ExecutionRecord {
    const record = this.records.get(executionId);
    if (!record) {
      throw new Error(`Execution '${executionId}' not found`);
    }
    return record;
  }

  async list(): Promise<ExecutionRecord[]> {
    return Array.from(this.records.values()).sort((a, b) =>
      b.execution.createdAt.getTime() - a.execution.createdAt.getTime(),
    );
  }

  async listByTask(taskId: string): Promise<ExecutionRecord[]> {
    const records = await this.list();
    return records.filter((r) => r.execution.taskId === taskId);
  }

  async events(executionId: string): Promise<ExecutionEvent[]> {
    const record = await this.get(executionId);
    if (!record) {
      throw new Error(`Execution '${executionId}' not found`);
    }
    return [...record.events].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }

  /** Replays the recorded event stream in order. */
  async *replay(executionId: string): AsyncIterable<ExecutionEvent> {
    const events = await this.events(executionId);
    for (const event of events) {
      yield event;
    }
  }

  private pushEvent(record: ExecutionRecord, type: ExecutionEventType, data?: unknown): void {
    eventCounter += 1;
    record.events.push({
      id: nextId('evt'),
      executionId: record.execution.id,
      type,
      timestamp: new Date(),
      data,
    });
  }

  private async flush(record: ExecutionRecord): Promise<void> {
    if (this.persist) {
      await this.persist(record);
    }
  }
}

export function createExecutionEngine(options: ExecutionEngineOptions = {}): ExecutionEngine {
  return new ExecutionEngine(options);
}
