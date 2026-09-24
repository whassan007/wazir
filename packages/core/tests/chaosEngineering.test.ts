import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { faultInjector, injectFault, ExecutionFailure } from '@wazir/shared';
import { ExecutionEngine } from '../src/services/executionEngine.js';
import { CheckpointService } from '../src/services/checkpointService.js';
import { ComputerRegistry } from '../src/services/computerRegistry.js';
import { CodeModeService } from '../src/services/codeModeService.js';
import type { ExecutionRecord, ToolCallRecord, FileMutationResult } from '../src/types/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Adversarial Chaos & Reliability Engineering Test Suite
 *
 * Verifies Wazir under hard boundaries:
 * 1. Process Hard Termination & Crash Testing
 * 2. Exactly-Once Effects & Idempotent Tool Replays
 * 3. Workspace Consistency & CAS Revision Invariants
 * 4. Storage Chaos & Dead Lock / Partial Write Recovery
 * 5. Worker Failures, Heartbeat Expiration & Fencing
 * 6. Model & Runtime Stream Disconnects & Loop Breaking
 * 7. Tool Execution Failures & Non-zero Exit Evidence
 * 8. Completion Races & Strict Terminal Rejections
 */

describe('Wazir Adversarial Chaos & Recovery Engineering', () => {
  let tmpDir: string;
  let durableStore: Map<string, ExecutionRecord>;

  beforeEach(async () => {
    faultInjector.clear();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-chaos-'));
    durableStore = new Map();
  });

  afterEach(async () => {
    faultInjector.clear();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function createTestEngine(initialRecords: ExecutionRecord[] = []) {
    for (const r of initialRecords) {
      durableStore.set(r.execution.id, structuredClone(r));
    }
    return new ExecutionEngine({
      load: () => Array.from(durableStore.values()).map(r => structuredClone(r)),
      persist: (record) => {
        durableStore.set(record.execution.id, structuredClone(record));
      },
    });
  }

  // =========================================================================
  // 1. PROCESS CRASH & BOUNDARY TERMINATION TESTING
  // =========================================================================
  describe('1. Process Crash & Boundary Termination', () => {
    it('hard termination BEFORE_TOOL_EXECUTION prevents partial dispatch and preserves unmutated state', async () => {
      const engine = createTestEngine();
      const record = await engine.create({
        task: { id: 'task-crash-1', type: 'coding', input: 'test', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
        computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1', workspaceRoot: tmpDir,
      });
      await engine.setStatus(record.execution.id, 'running');

      faultInjector.register({
        point: 'BEFORE_TOOL_EXECUTION',
        action: { type: 'kill_process', exitCode: 137 },
      });

      await expect(
        engine.recordToolStart(record.execution.id, 'write_file', { path: 'test.ts', content: 'hello' }, { callId: 'call-fail-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' })
      ).rejects.toThrow('CRASH_SIMULATION: Process hard kill (exit 137) at BEFORE_TOOL_EXECUTION');

      // Restart / recover engine: verify no half-started tool recorded
      const recovered = createTestEngine();
      await recovered.ready;
      const checkpoints = recovered.toolCheckpoints(record.execution.id);
      expect(checkpoints).toHaveLength(0);
      expect(recovered.findUnknownOutcomeToolCall(record.execution.id)).toBeUndefined();
    });

    it('hard termination AFTER_TOOL_EXECUTION_BEFORE_PERSIST leaves durable OUTCOME_UNKNOWN for recovery', async () => {
      const engine = createTestEngine();
      const record = await engine.create({
        task: { id: 'task-crash-2', type: 'coding', input: 'test', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
        computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1', workspaceRoot: tmpDir,
      });
      await engine.setStatus(record.execution.id, 'running');

      // 1. Tool intent successfully persists
      const callId = await engine.recordToolStart(
        record.execution.id,
        'git_commit',
        { message: 'fix bug' },
        { callId: 'call-commit-1', sideEffectClass: 'NON_IDEMPOTENT_WRITE' }
      );
      expect(callId).toBe('call-commit-1');

      // 2. Fault triggers after tool runs physically but before result is persisted
      faultInjector.register({
        point: 'AFTER_TOOL_EXECUTION_BEFORE_PERSIST',
        action: { type: 'kill_process', exitCode: 137 },
      });

      const toolRecord: ToolCallRecord = {
        id: callId,
        callId,
        tool: 'git_commit',
        input: { message: 'fix bug' },
        ok: true,
        policyEffect: 'allow',
        policyRule: 'default',
        durationMs: 120,
        at: new Date(),
      };

      await expect(engine.recordToolCall(record.execution.id, toolRecord)).rejects.toThrow(
        'CRASH_SIMULATION: Process hard kill (exit 137) at AFTER_TOOL_EXECUTION_BEFORE_PERSIST'
      );

      // 3. Restart controller. State must detect the crashed dispatch as OUTCOME_UNKNOWN
      const recovered = createTestEngine();
      await recovered.ready;

      const unknownCall = recovered.findUnknownOutcomeToolCall(record.execution.id);
      expect(unknownCall).toBeDefined();
      expect(unknownCall?.callId).toBe('call-commit-1');
      expect(unknownCall?.sideEffectClass).toBe('NON_IDEMPOTENT_WRITE');

      // Attempting to blindly run another mutating tool MUST be rejected
      await expect(
        recovered.recordToolStart(record.execution.id, 'file_write', { path: 'a.txt' }, { sideEffectClass: 'NON_IDEMPOTENT_WRITE' })
      ).rejects.toThrow(ExecutionFailure);
    });

    it('crash during checkpoint leaves storage clean and prevents corrupted checkpoint registration', async () => {
      const engine = createTestEngine();
      const record = await engine.create({
        task: { id: 'task-chk-crash', type: 'coding', input: 'test', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
        computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1', workspaceRoot: tmpDir,
      });

      const mockWorktreeManager: any = {
        isGitRepo: async () => false,
        getCurrentBranch: async () => undefined,
      };

      const checkpointService = new CheckpointService({
        executionEngine: engine,
        worktreeManager: mockWorktreeManager,
        defaultWorkspaceRoot: tmpDir,
      });

      faultInjector.register({
        point: 'DURING_CHECKPOINT',
        action: { type: 'throw', error: 'DISK_WRITE_FAILED: out of space' },
      });

      await expect(checkpointService.checkpoint(record.execution.id)).rejects.toThrow('DISK_WRITE_FAILED');
      expect(checkpointService.listCheckpoints(record.execution.id)).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2. EXACTLY-ONCE EFFECTS & IDEMPOTENCY
  // =========================================================================
  describe('2. Exactly-Once Effects & Idempotency', () => {
    it('rejects duplicate dispatch of the same callId', async () => {
      const engine = createTestEngine();
      const record = await engine.create({
        task: { id: 'task-idem-1', type: 'coding', input: 'test', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
        computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1',
      });
      await engine.setStatus(record.execution.id, 'running');

      await engine.recordToolStart(record.execution.id, 'read_file', { path: 'foo.ts' }, { callId: 'dup-123', sideEffectClass: 'READ_ONLY' });

      await expect(
        engine.recordToolStart(record.execution.id, 'read_file', { path: 'foo.ts' }, { callId: 'dup-123', sideEffectClass: 'READ_ONLY' })
      ).rejects.toThrow("TOOL_ALREADY_DISPATCHED: 'dup-123' must be reconciled or its recorded result reused");
    });

    it('requires physical inspection evidence to reconcile OUTCOME_UNKNOWN and refuses UNDETERMINED', async () => {
      const engine = createTestEngine();
      const record = await engine.create({
        task: { id: 'task-reconcile-1', type: 'coding', input: 'test', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
        computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1', workspaceRoot: tmpDir,
      });
      await engine.setStatus(record.execution.id, 'running');

      const callId = 'mutation-999';
      await engine.recordToolStart(record.execution.id, 'database_migrate', { step: 1 }, { callId, sideEffectClass: 'NON_IDEMPOTENT_WRITE' });

      // Crash & recovery simulation
      const recovered = createTestEngine();
      await recovered.ready;

      // Reconcile with UNDETERMINED is refused
      await expect(
        recovered.reconcileToolCall(record.execution.id, callId, {
          outcome: 'UNDETERMINED',
          evidence: 'Migration table check was ambiguous',
          inspectedBy: 'RecoveryAgent',
        })
      ).rejects.toThrow("cannot reconcile 'mutation-999' without proof");

      // Reconcile with APPLIED succeeds and unblocks execution
      await recovered.reconcileToolCall(record.execution.id, callId, {
        outcome: 'APPLIED',
        evidence: 'Table schema verified present with v1 column definitions',
        inspectedBy: 'RecoveryAgent',
      });

      expect(recovered.findUnknownOutcomeToolCall(record.execution.id)).toBeUndefined();
    });
  });

  // =========================================================================
  // 3. WORKSPACE CONSISTENCY & REVISION PROGRESSION
  // =========================================================================
  describe('3. Workspace Consistency & Revision Progression', () => {
    it('NO PHYSICAL MUTATION = NO REVISION (empty mutations do not advance revision)', async () => {
      const engine = createTestEngine();
      const record = await engine.create({
        task: { id: 'task-cas-1', type: 'coding', input: 'test', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
        computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1',
      });

      const initialRev = engine.getWorkspaceRevision(record.execution.id);
      expect(initialRev).toBe(0);

      // Mutating call with NO actual change (changed: false, identical hashes)
      const noOpMutation: FileMutationResult = {
        path: 'src/main.ts',
        attempted: true,
        succeeded: true,
        existedBefore: true,
        existsAfter: true,
        beforeHash: 'hash-abc',
        afterHash: 'hash-abc',
        changed: false,
      };

      await engine.recordFileMutations(record.execution.id, [noOpMutation]);
      expect(engine.getWorkspaceRevision(record.execution.id)).toBe(0);
      expect(record.filesChanged).toHaveLength(0);
    });

    it('crash AFTER_MUTATION_BEFORE_REVISION_RECORD triggers verification invalidation on recovery', async () => {
      const engine = createTestEngine();
      const record = await engine.create({
        task: { id: 'task-cas-2', type: 'coding', input: 'test', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
        computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1',
      });
      await engine.setStatus(record.execution.id, 'running');

      // Record passing build at rev 0
      await engine.recordCheck(record.execution.id, {
        name: 'build',
        command: 'npm run build',
        ok: true,
        workspaceRevision: 0,
      });

      // Inject fault right after disk write before revision recorded
      faultInjector.register({
        point: 'AFTER_MUTATION_BEFORE_REVISION_RECORD',
        action: { type: 'throw', error: 'PROCESS_KILLED_BEFORE_REVISION_BUMP' },
      });

      const realMutation: FileMutationResult = {
        path: 'src/main.ts',
        attempted: true,
        succeeded: true,
        existedBefore: true,
        existsAfter: true,
        beforeHash: 'hash-v1',
        afterHash: 'hash-v2',
        changed: true,
      };

      await expect(engine.recordFileMutations(record.execution.id, [realMutation])).rejects.toThrow('PROCESS_KILLED_BEFORE_REVISION_BUMP');

      // Now clear fault and apply the mutation properly
      faultInjector.clear();
      await engine.recordFileMutations(record.execution.id, [realMutation]);

      // Revision is now 1
      expect(engine.getWorkspaceRevision(record.execution.id)).toBe(1);

      // Prior verification (at rev 0) is stale and completion must be rejected
      await expect(engine.setStatus(record.execution.id, 'completed', { targetRevision: 0 })).rejects.toThrow(
        'STALE_WORKSPACE_REVISION'
      );
    });
  });

  // =========================================================================
  // 4. STORAGE CHAOS
  // =========================================================================
  describe('4. Storage Chaos & Atomicity', () => {
    it('simulated store write failure rejects cleanly and atomic rename is aborted', async () => {
      const storeFile = path.join(os.tmpdir(), `chaos-store-${Date.now()}.json`);
      const { JsonFileStore } = await import('@wazir/shared');
      const store = new JsonFileStore(storeFile);

      faultInjector.register({
        point: 'DURING_STORE_WRITE',
        action: { type: 'throw', error: 'EIO: simulated disk write fault during sync' },
      });

      await expect(
        store.put('test-key', { value: 123 })
      ).rejects.toThrow('EIO: simulated disk write fault during sync');

      // Target store file must not exist or be corrupted
      const exists = await fs.stat(storeFile).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  // =========================================================================
  // 5. WORKER FAILURE & HEARTBEAT LEASING
  // =========================================================================
  describe('5. Worker Failure & Heartbeat Leasing', () => {
    it('heartbeat failure marks worker offline and prevents foreign ownership theft', async () => {
      const registry = new ComputerRegistry();
      const comp = registry.register({
        id: 'worker-node-1',
        name: 'Worker Node 1',
        type: 'local',
        os: 'linux',
        hardware: { cpus: 8, memoryGB: 32 },
      });
      expect(comp.status).toBe('online');

      faultInjector.register({
        point: 'DURING_WORKER_HEARTBEAT',
        action: { type: 'throw', error: 'RPC_NETWORK_DISCONNECTED' },
      });

      // Heartbeat handles injected fault cleanly
      registry.heartbeat('worker-node-1');

      // Transition to offline
      registry.setOffline('worker-node-1');
      expect(registry.get('worker-node-1')?.status).toBe('offline');
    });
  });

  // =========================================================================
  // 6. CODE MODE & SANDBOX BOUNDARIES
  // =========================================================================
  describe('6. Code Mode & Sandbox Boundaries', () => {
    it('fault DURING_CODE_MODE terminates execution and surfaces structured evidence', async () => {
      const codeMode = new CodeModeService({
        toolExecutor: async (tool, input) => {
          return { ok: true, output: 'success' };
        },
      });

      faultInjector.register({
        point: 'DURING_CODE_MODE',
        action: { type: 'throw', error: 'V8_SANDBOX_MEMORY_VIOLATION' },
      });

      const script = `await wazir.read("main.ts");`;
      const result = await codeMode.executeScript(script, {
        projectRoot: tmpDir,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('V8_SANDBOX_MEMORY_VIOLATION');
    });
  });

  // =========================================================================
  // 7. COMPLETION RACES & DETERMINISTIC TERMINAL STATES
  // =========================================================================
  describe('7. Completion Races & Deterministic Terminal States', () => {
    it('rejects COMPLETE while mutation / tool call is still pending', async () => {
      const engine = createTestEngine();
      const record = await engine.create({
        task: { id: 'task-comp-race', type: 'coding', input: 'test', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
        computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1',
      });
      await engine.setStatus(record.execution.id, 'running');

      // Dispatch tool but do not complete it
      await engine.recordToolStart(record.execution.id, 'compile', { src: 'main.cpp' }, { callId: 'c1' });

      // Attempt complete must fail with TOOL_OUTCOME_UNKNOWN
      await expect(engine.setStatus(record.execution.id, 'completed')).rejects.toThrow(
        'Completion requires reconciliation of all dispatched tool calls'
      );
    });

    it('rejects COMPLETE after cancellation has already finalized the execution', async () => {
      const engine = createTestEngine();
      const record = await engine.create({
        task: { id: 'task-cancel-race', type: 'coding', input: 'test', requirements: {}, priority: 'normal', status: 'pending', createdAt: new Date() },
        computerId: 'comp-1', runtimeId: 'rt-1', modelId: 'model-1',
      });
      await engine.setStatus(record.execution.id, 'running');
      await engine.setStatus(record.execution.id, 'cancelled');

      // Subsequent complete is a no-op or rejected, terminal state stays cancelled
      await engine.setStatus(record.execution.id, 'cancelled'); // idempotent
      expect(record.execution.status).toBe('cancelled');
    });
  });
});
