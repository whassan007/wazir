import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { MemoryStore } from '@wazir/shared';
import {
  ExecutionEngine,
  WorktreeManager,
  CheckpointService,
} from '../src/index.js';
import {
  PORTABLE_CHECKPOINT_SCHEMA_VERSION,
  PORTABLE_HANDOFF_SCHEMA_VERSION,
  computeWorkspaceContentDigest,
  computePortableCheckpointDigest,
  validatePortableCheckpoint,
  assertValidPortableCheckpoint,
  toPortableHandoff,
  type PortableCheckpointEnvelope,
} from '../src/types/portableCheckpoint.js';

describe('Group C1: Portable Checkpoint Format & Cryptographic Integrity', () => {
  let tempDir: string;
  let targetDir: string;
  let store: MemoryStore;
  let executionEngine: ExecutionEngine;
  let worktreeManager: WorktreeManager;
  let checkpointService: CheckpointService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-portable-chk-'));
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-portable-target-'));
    store = new MemoryStore();
    executionEngine = new ExecutionEngine({ workspace: tempDir });
    worktreeManager = new WorktreeManager({
      worktreeRootDir: path.join(tempDir, '.wazir', 'worktrees'),
    });
    checkpointService = new CheckpointService({
      store,
      executionEngine,
      worktreeManager,
      defaultWorkspaceRoot: tempDir,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
  });

  async function seedExecutionWithWorkspace(overrides?: {
    runtimeId?: string;
    modelId?: string;
    agentId?: string;
    jobId?: string;
    input?: string;
    maxTurns?: number;
    policy?: Record<string, unknown>;
  }) {
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(
      path.join(srcDir, 'index.ts'),
      'export const version = 1;\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(srcDir, 'util.ts'),
      'export function add(a: number, b: number) { return a + b; }\n',
      'utf8',
    );

    const record = await executionEngine.create({
      task: {
        id: 'task-portable-1',
        type: 'coding',
        input: overrides?.input ?? 'Implement portable checkpoint handoff',
        requirements: {},
        maxTurns: overrides?.maxTurns,
        policy: overrides?.policy as any,
        priority: 'normal',
        status: 'running',
        createdAt: new Date(),
      },
      jobId: overrides?.jobId ?? 'job-portable-1',
      computerId: 'local-mac',
      runtimeId: overrides?.runtimeId ?? 'ollama',
      modelId: overrides?.modelId ?? 'qwen2.5-coder:14b',
      agentId: overrides?.agentId ?? 'native-coder',
      workspaceRoot: tempDir,
    });

    await executionEngine.recordFilesChanged(record.execution.id, [
      'src/index.ts',
      'src/util.ts',
    ]);

    return record;
  }

  it('1. exports a portable checkpoint envelope with deterministic digests and survives JSON round-trip', async () => {
    const record = await seedExecutionWithWorkspace();
    await executionEngine.recordCheck(record.execution.id, {
      name: 'test',
      command: 'npx vitest run',
      ok: true,
      output: '2 passed',
      durationMs: 120,
      workspaceRevision: 1,
    });

    const chk = await checkpointService.checkpoint(record.execution.id, {
      description: 'after passing tests',
    });

    const envelope = await checkpointService.exportPortableCheckpoint(chk.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'claude-code-acp',
      pendingActions: ['Run integration suite', 'Commit changes'],
      budgetLimits: {
        maxTokens: 10000,
        maxToolCalls: 20,
        maxModelCalls: 10,
        maxCostUSD: 1.5,
        maxDurationMs: 60000,
      },
    });

    expect(envelope.schemaVersion).toBe(PORTABLE_CHECKPOINT_SCHEMA_VERSION);
    expect(envelope.executionId).toBe(record.execution.id);
    expect(envelope.taskId).toBe('task-portable-1');
    expect(envelope.jobId).toBe('job-portable-1');
    expect(envelope.sourceHarnessId).toBe('native');
    expect(envelope.targetHarnessId).toBe('claude-code-acp');
    expect(envelope.sourceModelId).toBe('qwen2.5-coder:14b');
    expect(envelope.sourceRuntimeId).toBe('ollama');
    expect(envelope.workspaceRevision).toBe('1');
    expect(envelope.checkpointId).toBe(chk.id);
    expect(envelope.filesChanged).toEqual(['src/index.ts', 'src/util.ts']);
    expect(envelope.pendingActions).toEqual(['Run integration suite', 'Commit changes']);
    expect(envelope.verificationEvidenceIds.length).toBeGreaterThan(0);
    expect(envelope.resumable).toBe(true);
    expect(envelope.nonResumableReason).toBeUndefined();

    // Verify deterministic digests
    const expectedWorkspaceDigest = computeWorkspaceContentDigest(
      chk.worktreeState.filesSnapshot,
      chk.workspaceRevision,
    );
    expect(envelope.workspaceContentDigest).toBe(expectedWorkspaceDigest);
    expect(envelope.workspaceContentDigest).toBe(checkpointService.computeDigest(chk));
    expect(envelope.integrityDigest).toBe(computePortableCheckpointDigest(envelope));

    // Verify JSON serialization & deserialization preserves validity and digest
    const serialized = JSON.stringify(envelope);
    const parsed = JSON.parse(serialized);
    const validation = validatePortableCheckpoint(parsed);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(computePortableCheckpointDigest(parsed)).toBe(envelope.integrityDigest);
  });

  it('2. imports, persists to durable KeyValueStore, and restores portable checkpoints across service restarts', async () => {
    const record = await seedExecutionWithWorkspace();
    const chk = await checkpointService.checkpoint(record.execution.id, {
      description: 'durable-portable',
    });
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id, {
      sourceHarnessId: 'native',
      pendingActions: ['Verify build'],
    });

    const remoteStore = new MemoryStore();
    const remoteEngine = new ExecutionEngine({ workspace: targetDir });
    const remoteWorktree = new WorktreeManager({
      worktreeRootDir: path.join(targetDir, '.wazir', 'worktrees'),
    });
    const remoteCheckpointService = new CheckpointService({
      store: remoteStore,
      executionEngine: remoteEngine,
      worktreeManager: remoteWorktree,
      defaultWorkspaceRoot: targetDir,
    });

    const imported = await remoteCheckpointService.importPortableCheckpoint(
      JSON.parse(JSON.stringify(envelope)),
    );
    expect(imported.id).toBe(chk.id);
    expect(imported.executionId).toBe(record.execution.id);
    expect(imported.workspaceRevision).toBe(1);
    expect(imported.worktreeState.filesSnapshot['src/index.ts']).toBe(
      'export const version = 1;\n',
    );

    // Restart a new CheckpointService backed by the same remoteStore
    const restartedService = new CheckpointService({
      store: remoteStore,
      executionEngine: remoteEngine,
      worktreeManager: remoteWorktree,
      defaultWorkspaceRoot: targetDir,
    });
    await restartedService.ready;

    const restored = restartedService.getCheckpoint(chk.id);
    expect(restored).toBeDefined();
    expect(restored?.id).toBe(chk.id);
    expect(restored?.workspaceRevision).toBe(1);
    expect(restored?.worktreeState.filesSnapshot['src/util.ts']).toContain('function add');
  });

  it('3. materializes imported portable checkpoint files onto targetWorkspaceRoot and removes stale files', async () => {
    const record = await seedExecutionWithWorkspace();
    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id);

    // Pre-populate targetDir with a stale file that should be cleaned up on materialization
    const staleFile = path.join(targetDir, 'src', 'stale.ts');
    await fs.mkdir(path.dirname(staleFile), { recursive: true });
    await fs.writeFile(staleFile, 'stale content\n', 'utf8');

    const remoteService = new CheckpointService({
      executionEngine: new ExecutionEngine({ workspace: targetDir }),
      worktreeManager,
      defaultWorkspaceRoot: targetDir,
    });

    const imported = await remoteService.importPortableCheckpoint(envelope, {
      targetWorkspaceRoot: targetDir,
    });

    expect(imported.workspaceRoot).toBe(targetDir);
    const indexContent = await fs.readFile(path.join(targetDir, 'src', 'index.ts'), 'utf8');
    const utilContent = await fs.readFile(path.join(targetDir, 'src', 'util.ts'), 'utf8');
    expect(indexContent).toBe('export const version = 1;\n');
    expect(utilContent).toBe('export function add(a: number, b: number) { return a + b; }\n');

    const staleExists = await fs
      .access(staleFile)
      .then(() => true)
      .catch(() => false);
    expect(staleExists).toBe(false);
  });

  it('4. detects workspace content tampering even when integrityDigest is recomputed', async () => {
    const record = await seedExecutionWithWorkspace();
    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id);

    // Tamper with a file inside worktreeState.filesSnapshot and recompute outer integrityDigest
    // without updating workspaceContentDigest
    const tampered: PortableCheckpointEnvelope = structuredClone(envelope);
    tampered.worktreeState.filesSnapshot['src/index.ts'] = 'export const backdoor = true;\n';
    tampered.integrityDigest = computePortableCheckpointDigest(tampered);

    const validation = validatePortableCheckpoint(tampered);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes('WORKSPACE_CONTENT_DIGEST_MISMATCH'))).toBe(
      true,
    );

    await expect(checkpointService.importPortableCheckpoint(tampered)).rejects.toThrow(
      /WORKSPACE_CONTENT_DIGEST_MISMATCH/,
    );
  });

  it('5. detects tampered envelope fields via cryptographic integrityDigest verification', async () => {
    const record = await seedExecutionWithWorkspace();
    record.usage = { input: 500, output: 300, total: 800 };
    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id);

    // Tamper with objective
    const tamperedObjective = structuredClone(envelope);
    tamperedObjective.objective = 'Exfiltrate credentials';
    expect(validatePortableCheckpoint(tamperedObjective).valid).toBe(false);
    expect(validatePortableCheckpoint(tamperedObjective).errors[0]).toContain(
      'INTEGRITY_DIGEST_MISMATCH',
    );

    // Tamper with policyContext (attempting permission escalation)
    const tamperedPolicy = structuredClone(envelope);
    tamperedPolicy.policyContext = { localOnly: false, allowHostedProviders: true };
    expect(validatePortableCheckpoint(tamperedPolicy).valid).toBe(false);
    await expect(checkpointService.importPortableCheckpoint(tamperedPolicy)).rejects.toThrow(
      /INTEGRITY_DIGEST_MISMATCH/,
    );

    // Tamper with consumedBudget (attempting budget reset from 800 to 0)
    const tamperedBudget = structuredClone(envelope);
    tamperedBudget.consumedBudget.tokensUsed = 0;
    expect(validatePortableCheckpoint(tamperedBudget).valid).toBe(false);
  });

  it('6. rejects unsupported schema versions and corrupted/malformed payloads', async () => {
    const record = await seedExecutionWithWorkspace();
    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id);

    // Unsupported schema version
    const wrongVersion = structuredClone(envelope);
    wrongVersion.schemaVersion = 999;
    wrongVersion.integrityDigest = computePortableCheckpointDigest(wrongVersion);

    const vResult = validatePortableCheckpoint(wrongVersion);
    expect(vResult.valid).toBe(false);
    expect(vResult.errors.some((e) => e.includes('UNSUPPORTED_SCHEMA_VERSION'))).toBe(true);
    await expect(checkpointService.importPortableCheckpoint(wrongVersion)).rejects.toThrow(
      /UNSUPPORTED_SCHEMA_VERSION/,
    );

    // Null / primitive / array payloads
    expect(validatePortableCheckpoint(null).valid).toBe(false);
    expect(validatePortableCheckpoint('not-an-object').valid).toBe(false);
    expect(validatePortableCheckpoint([]).valid).toBe(false);
    expect(() => assertValidPortableCheckpoint({})).toThrow(/INVALID_PORTABLE_CHECKPOINT/);
  });

  it('7. rejects unsafe paths in worktreeState.filesSnapshot (path traversal, .git, absolute paths)', async () => {
    const record = await seedExecutionWithWorkspace();
    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id);

    for (const unsafePath of ['../outside.txt', '/etc/passwd', '.git/config', 'src/../../evil.sh']) {
      const malicious = structuredClone(envelope);
      malicious.worktreeState.filesSnapshot[unsafePath] = 'pwned';
      malicious.workspaceContentDigest = computeWorkspaceContentDigest(
        malicious.worktreeState.filesSnapshot,
        malicious.workspaceRevision,
      );
      malicious.integrityDigest = computePortableCheckpointDigest(malicious);

      const res = validatePortableCheckpoint(malicious);
      expect(res.valid).toBe(false);
      expect(res.errors.some((e) => e.includes('UNSAFE_CHECKPOINT_PATH'))).toBe(true);

      await expect(
        checkpointService.importPortableCheckpoint(malicious, { targetWorkspaceRoot: targetDir }),
      ).rejects.toThrow(/UNSAFE_CHECKPOINT_PATH/);
    }
  });

  it('8. preserves consumedBudget and accurately computes remainingBudget without resetting usage', async () => {
    const record = await seedExecutionWithWorkspace({
      runtimeId: 'openai-api',
      modelId: 'gpt-4o',
      maxTurns: 8,
    });
    record.usage = {
      input: 1200,
      output: 800,
      total: 2000,
    };
    record.totalModelCalls = 3;
    const callId = await executionEngine.recordToolStart(
      record.execution.id,
      'write_file',
      { path: 'src/index.ts' },
      { sideEffectClass: 'IDEMPOTENT_WRITE' },
    );
    await executionEngine.recordToolCall(record.execution.id, {
      id: 'tc-1',
      callId,
      tool: 'write_file',
      input: { path: 'src/index.ts' },
      output: 'wrote file',
      ok: true,
      policyEffect: 'allow',
      policyRule: 'default',
      durationMs: 25,
      at: new Date(),
    });

    const chk = await checkpointService.checkpoint(record.execution.id, {
      metadata: {
        costUSD: 0.045,
        costStatus: 'ACTUAL',
      },
    });

    const envelope = await checkpointService.exportPortableCheckpoint(chk.id, {
      budgetLimits: {
        maxTokens: 5000,
        maxToolCalls: 10,
        maxModelCalls: 8,
        maxCostUSD: 0.25,
        maxDurationMs: 120000,
      },
    });

    expect(envelope.consumedBudget.tokensUsed).toBe(2000);
    expect(envelope.consumedBudget.toolCallsUsed).toBe(1);
    expect(envelope.consumedBudget.modelCallsUsed).toBe(3);
    expect(envelope.consumedBudget.costUSD).toBe(0.045);
    expect(envelope.consumedBudget.costStatus).toBe('ACTUAL');

    expect(envelope.remainingBudget.maxTokens).toBe(3000);
    expect(envelope.remainingBudget.maxToolCalls).toBe(9);
    expect(envelope.remainingBudget.maxModelCalls).toBe(5);
    expect(envelope.remainingBudget.maxCostUSD).toBeCloseTo(0.205, 5);
    expect(envelope.remainingBudget.maxDurationMs).toBeLessThanOrEqual(120000);
  });

  it('9. preserves policyContext across export, import into a remote service, and re-export', async () => {
    const strictPolicy = {
      dataClassification: 'sensitive' as const,
      localOnly: true,
      allowedComputers: ['local-mac'],
      allowedRuntimes: ['ollama'],
      allowedModels: ['qwen2.5-coder:14b'],
      networkAccess: false,
      toolAccess: true,
      allowSubagentDispatch: false,
      maxExecutionTimeSeconds: 300,
      allowHostedProviders: false,
    };

    const record = await seedExecutionWithWorkspace({
      policy: strictPolicy,
    });
    const chk = await checkpointService.checkpoint(record.execution.id);
    const exported = await checkpointService.exportPortableCheckpoint(chk.id);

    expect(exported.policyContext).toEqual(strictPolicy);

    // Import into a separate CheckpointService instance without the original ExecutionRecord
    const isolatedService = new CheckpointService({
      executionEngine: new ExecutionEngine({ workspace: targetDir }),
      worktreeManager,
      defaultWorkspaceRoot: targetDir,
    });
    const importedChk = await isolatedService.importPortableCheckpoint(exported);
    const reExported = await isolatedService.exportPortableCheckpoint(importedChk.id);

    expect(reExported.policyContext).toEqual(strictPolicy);
    expect(reExported.consumedBudget).toEqual(exported.consumedBudget);
    expect(reExported.remainingBudget).toEqual(exported.remainingBudget);
  });

  it('10. classifies checkpoint as non-resumable when unresolved non-read-only side effect exists (OUTCOME_UNKNOWN or STARTED)', async () => {
    const record = await seedExecutionWithWorkspace();
    const callId = await executionEngine.recordToolStart(
      record.execution.id,
      'shell',
      { command: 'npm publish' },
      { sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
    );
    await executionEngine.recordToolCall(record.execution.id, {
      id: 'tc-unknown',
      callId,
      tool: 'shell',
      input: { command: 'npm publish' },
      ok: false,
      failureClass: 'TOOL_OUTCOME_UNKNOWN',
      policyEffect: 'allow',
      policyRule: 'default',
      durationMs: 500,
      at: new Date(),
    });

    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id);

    expect(envelope.unresolvedSideEffects.length).toBe(1);
    expect(envelope.unresolvedSideEffects[0].callId).toBe(callId);
    expect(envelope.unresolvedSideEffects[0].state).toBe('OUTCOME_UNKNOWN');
    expect(envelope.unresolvedSideEffects[0].sideEffectClass).toBe('NON_IDEMPOTENT_WRITE');
    expect(envelope.resumable).toBe(false);
    expect(envelope.nonResumableReason).toMatch(/Unresolved non-read-only side effect/);
    expect(envelope.nonResumableReason).toContain('shell');
    expect(envelope.nonResumableReason).toContain('OUTCOME_UNKNOWN');
  });

  it('11. keeps checkpoint resumable when an interrupted tool call is READ_ONLY', async () => {
    const record = await seedExecutionWithWorkspace();
    const callId = await executionEngine.recordToolStart(
      record.execution.id,
      'read_file',
      { path: 'src/index.ts' },
      { sideEffectClass: 'READ_ONLY' },
    );

    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id);

    expect(envelope.unresolvedSideEffects.length).toBe(1);
    expect(envelope.unresolvedSideEffects[0].callId).toBe(callId);
    expect(envelope.unresolvedSideEffects[0].sideEffectClass).toBe('READ_ONLY');
    expect(envelope.resumable).toBe(true);
    expect(envelope.nonResumableReason).toBeUndefined();
  });

  it('12. classifies checkpoint as non-resumable when any budget dimension is exhausted', async () => {
    const record = await seedExecutionWithWorkspace();
    record.usage = {
      input: 4000,
      output: 1500,
      total: 5500,
    };

    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id, {
      budgetLimits: {
        maxTokens: 5000, // 5500 consumed > 5000 limit -> 0 remaining
        maxToolCalls: 10,
      },
    });

    expect(envelope.remainingBudget.maxTokens).toBe(0);
    expect(envelope.resumable).toBe(false);
    expect(envelope.nonResumableReason).toContain('Budget exhausted: maxTokens');
  });

  it('13. classifies checkpoint as non-resumable when execution status is already completed', async () => {
    const record = await seedExecutionWithWorkspace();
    record.execution.status = 'completed';

    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id);

    expect(envelope.resumable).toBe(false);
    expect(envelope.nonResumableReason).toContain("terminal status 'completed'");
  });

  it('14. rejects forged envelopes claiming resumable: true when blocking side effects or exhausted budgets exist', async () => {
    const record = await seedExecutionWithWorkspace();
    await executionEngine.recordToolStart(
      record.execution.id,
      'write_file',
      { path: 'src/index.ts' },
      { sideEffectClass: 'IDEMPOTENT_WRITE' },
    );

    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id);
    expect(envelope.resumable).toBe(false);

    // Attempt to forge resumable = true and recompute integrityDigest
    const forged = structuredClone(envelope);
    forged.resumable = true;
    delete forged.nonResumableReason;
    forged.integrityDigest = computePortableCheckpointDigest(forged);

    const validation = validatePortableCheckpoint(forged);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((e) => e.includes('INVALID_RESUMABILITY'))).toBe(true);
  });

  it('15. redacts secrets, API keys, and tokens from action summaries, objectives, tool inputs, and metadata', async () => {
    const record = await seedExecutionWithWorkspace({
      input: 'Deploy service using OPENAI_API_KEY=sk-proj-1234567890abcdefghijklmnop and password=supersecret',
    });

    const callId = await executionEngine.recordToolStart(
      record.execution.id,
      'shell',
      {
        command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"',
        apiKey: 'sk-live-secret-value-999999',
      },
      { sideEffectClass: 'NON_IDEMPOTENT_WRITE' },
    );
    await executionEngine.recordToolCall(record.execution.id, {
      id: 'tc-secret',
      callId,
      tool: 'shell',
      input: { command: 'curl' },
      output: 'GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      ok: true,
      policyEffect: 'allow',
      policyRule: 'default',
      durationMs: 40,
      at: new Date(),
    });

    const chk = await checkpointService.checkpoint(record.execution.id, {
      description: 'Checkpoint with token=my_secret_token_value',
      metadata: {
        clientSecret: 'top-secret-client-val',
        note: 'Connected to postgres://admin:hunter2password@db.internal:5432/prod',
      },
    });

    const envelope = await checkpointService.exportPortableCheckpoint(chk.id, {
      pendingActions: ['Rotate api_key=abcdef1234567890'],
    });

    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain('sk-proj-1234567890abcdefghijklmnop');
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
    expect(serialized).not.toContain('my_secret_token_value');
    expect(serialized).not.toContain('top-secret-client-val');
    expect(serialized).not.toContain('hunter2password');
    expect(serialized).not.toContain('abcdef1234567890');
    expect(serialized).toContain('[REDACTED]');
  });

  it('16. extracts a canonical PortableHandoff via toPortableHandoff with independent integrity digest', async () => {
    const record = await seedExecutionWithWorkspace();
    const chk = await checkpointService.checkpoint(record.execution.id);
    const envelope = await checkpointService.exportPortableCheckpoint(chk.id, {
      sourceHarnessId: 'native',
      targetHarnessId: 'codex-cli',
      pendingActions: ['Finalize PR'],
    });

    const handoff = toPortableHandoff(envelope);
    expect(handoff.schemaVersion).toBe(PORTABLE_HANDOFF_SCHEMA_VERSION);
    expect(handoff.executionId).toBe(envelope.executionId);
    expect(handoff.checkpointId).toBe(envelope.checkpointId);
    expect(handoff.workspaceContentDigest).toBe(envelope.workspaceContentDigest);
    expect(handoff.sourceHarnessId).toBe('native');
    expect(handoff.targetHarnessId).toBe('codex-cli');
    expect(handoff.integrityDigest).toBe(computePortableCheckpointDigest(handoff));
    expect((handoff as unknown as Record<string, unknown>).worktreeState).toBeUndefined();
  });
});
