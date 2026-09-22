import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ExecutionEngine, PolicyEngine, type Task } from '@wazir/core';
import { verifier, evaluateExecution } from '../src/index.js';
import { editTool, writeTool } from '../../tools/src/filesystem.js';

describe('Gate 15: Verification Integrity & Evidence-Bound Harness Tests', () => {
  let tmpDir: string;
  let engine: ExecutionEngine;
  const persisted: any[] = [];

  const createTask = (id: string, overrides: Partial<Task> = {}): Task => ({
    id,
    type: 'coding',
    input: 'Implement clinic calendar',
    requirements: { capabilities: [] },
    priority: 'normal',
    status: 'pending',
    createdAt: new Date(),
    acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] },
    ...overrides,
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-g15-test-'));
    persisted.length = 0;
    engine = new ExecutionEngine({
      persist: (record) => {
        persisted.push(record);
      },
    });
    await engine.ready;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // Test 1: Broken build (R1 exit 1) -> repair (R2) -> no build -> verify R2 -> VERIFICATION_FAILED
  it('Test 1: Broken build (R1 exit 1) -> repair (R2) -> no build -> verify R2 -> VERIFICATION_FAILED (NO_BUILD_EVIDENCE, latestSuccessfulBuildRevision = null)', async () => {
    const task = createTask('task-g15-1');
    const record = await engine.create({
      task,
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const execId = record.execution.id;
    await engine.setStatus(execId, 'running');

    // Step 1: Initial broken write -> R1
    await engine.recordFilesChanged(execId, ['main.cpp']);
    expect(engine.getWorkspaceRevision(execId)).toBe(1);

    // Step 2: Broken build on R1 (exit 1)
    await engine.recordCheck(execId, {
      name: 'build',
      command: 'g++ -c main.cpp',
      ok: false,
      durationMs: 100,
    });

    // Step 3: Repair edit -> R2
    await engine.recordFilesChanged(execId, ['main.cpp']);
    expect(engine.getWorkspaceRevision(execId)).toBe(2);

    // Step 4: No build executed on R2. Verify R2.
    const currentRecord = engine.require(execId);
    const evalResult = evaluateExecution(currentRecord, {
      acceptanceContract: { requiredEvidence: ['BUILD'] },
    });

    expect(evalResult.success).toBe(false);
    expect(evalResult.latestSuccessfulBuildRevision).toBeNull();
    expect(
      evalResult.reasons.some(
        (r) =>
          r.includes('NO_BUILD_EVIDENCE') ||
          r.includes('no successful build exists for current workspace revision 2'),
      ),
    ).toBe(true);

    const verifyDirect = verifier.verify({
      workspaceRevision: 2,
      acceptanceContract: { requiredEvidence: ['BUILD'] },
      evidence: currentRecord.evidence,
    });
    expect(verifyDirect.passed).toBe(false);
    expect(verifyDirect.latestSuccessfulBuildRevision).toBeNull();
    expect(verifyDirect.reasons.some((r) => r.includes('NO_BUILD_EVIDENCE'))).toBe(true);
  });

  // Test 2: Build pass (R1 exit 0) -> test pass (R1 exit 0) -> edit (R2) -> verify R2 -> VERIFICATION_FAILED (BUILD_EVIDENCE_STALE)
  it('Test 2: Build pass (R1 exit 0) -> test pass (R1 exit 0) -> edit (R2) -> verify R2 -> VERIFICATION_FAILED (BUILD_EVIDENCE_STALE, latestSuccessfulBuildRevision = 1). Rebuild R2 -> test R2 -> verify R2 -> PASS', async () => {
    const task = createTask('task-g15-2');
    const record = await engine.create({
      task,
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const execId = record.execution.id;
    await engine.setStatus(execId, 'running');

    // R1: Initial implementation, build passes, test passes
    await engine.recordFilesChanged(execId, ['Calendar.cpp', 'Calendar.h']);
    expect(engine.getWorkspaceRevision(execId)).toBe(1);

    await engine.recordCheck(execId, {
      name: 'build',
      command: 'make',
      ok: true,
      durationMs: 150,
    });
    await engine.recordCheck(execId, {
      name: 'test',
      command: 'make test',
      ok: true,
      durationMs: 90,
    });

    // Edit Calendar.h without rebuilding -> R2
    await engine.recordFilesChanged(execId, ['Calendar.h']);
    expect(engine.getWorkspaceRevision(execId)).toBe(2);

    // Verify R2 before rebuild -> must fail with stale evidence
    const recordAtR2 = engine.require(execId);
    const evalAtR2 = evaluateExecution(recordAtR2, {
      acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] },
    });
    expect(evalAtR2.success).toBe(false);
    expect(evalAtR2.latestSuccessfulBuildRevision).toBe(1);
    expect(evalAtR2.reasons.some((r) => r.includes('BUILD_EVIDENCE_STALE'))).toBe(true);

    const verifyAtR2 = verifier.verify({
      workspaceRevision: 2,
      acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] },
      evidence: recordAtR2.evidence,
    });
    expect(verifyAtR2.passed).toBe(false);
    expect(verifyAtR2.latestSuccessfulBuildRevision).toBe(1);
    expect(verifyAtR2.reasons.some((r) => r.includes('BUILD_EVIDENCE_STALE'))).toBe(true);

    // Rebuild R2 (exit 0) and rerun test R2 (exit 0)
    await engine.recordCheck(execId, {
      name: 'build',
      command: 'make',
      ok: true,
      durationMs: 140,
    });
    await engine.recordCheck(execId, {
      name: 'test',
      command: 'make test',
      ok: true,
      durationMs: 85,
    });

    // Verify R2 again -> PASS
    const recordRebuilt = engine.require(execId);
    const evalRebuilt = evaluateExecution(recordRebuilt, {
      acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] },
    });
    expect(evalRebuilt.success).toBe(true);
    expect(evalRebuilt.latestSuccessfulBuildRevision).toBe(2);

    const verifyRebuilt = verifier.verify({
      workspaceRevision: 2,
      acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] },
      evidence: recordRebuilt.evidence,
    });
    expect(verifyRebuilt.passed).toBe(true);
    expect(verifyRebuilt.latestSuccessfulBuildRevision).toBe(2);
    expect(verifyRebuilt.latestSuccessfulTestRevision).toBe(2);
  });

  // Test 3: Failed edit (oldString missing) -> revision stays R, 0 files-changed emitted, getFilesChangedSince(R) == [], existing evidence remains valid
  it('Test 3: Failed edit (oldString missing) -> revision stays R, 0 files-changed emitted, getFilesChangedSince(R) == [], existing evidence remains valid', async () => {
    const task = createTask('task-g15-3');
    const record = await engine.create({
      task,
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const execId = record.execution.id;
    await engine.setStatus(execId, 'running');

    // Create file on disk and record initial change R1
    const initialContent = 'int getDays() { return 30; }';
    await fs.writeFile(path.join(tmpDir, 'Calendar.cpp'), initialContent, 'utf8');
    await engine.recordFilesChanged(execId, ['Calendar.cpp']);
    expect(engine.getWorkspaceRevision(execId)).toBe(1);

    // Record valid build for R1
    await engine.recordCheck(execId, {
      name: 'build',
      command: 'make',
      ok: true,
      durationMs: 100,
    });

    const eventCountBefore = record.events.length;

    // Execute failed edit (oldString missing)
    const toolResult = await editTool.execute(
      {
        path: 'Calendar.cpp',
        oldString: 'int nonExistentFunction()',
        newString: 'int repaired()',
      },
      {
        projectRoot: tmpDir,
        executionId: execId,
        agentId: 'wazir-coding',
      } as any,
    );

    expect(toolResult.ok).toBe(false);
    expect(toolResult.error).toContain('oldString not found in file');
    expect(toolResult.fileMutations).toBeDefined();
    expect(toolResult.fileMutations![0].changed).toBe(false);

    // Simulating harness logic: only mutations where changed === true advance revision and trigger recordFilesChanged
    const changedMutations = (toolResult.fileMutations || []).filter((m) => m.changed);
    if (changedMutations.length > 0) {
      await engine.recordFilesChanged(
        execId,
        changedMutations.map((m) => m.path),
      );
    }

    // Invariants:
    // 1. Revision unchanged
    expect(engine.getWorkspaceRevision(execId)).toBe(1);
    // 2. 0 files changed since revision 1
    expect(engine.getFilesChangedSince(execId, 1)).toEqual([]);
    // 3. No file.changed events emitted
    const newEvents = record.events.slice(eventCountBefore);
    expect(newEvents.some((e) => e.type === 'file.changed')).toBe(false);
    expect(newEvents.some((e) => e.type === 'workspace.revision_changed')).toBe(false);
    // 4. File content is byte-identical
    const contentAfter = await fs.readFile(path.join(tmpDir, 'Calendar.cpp'), 'utf8');
    expect(contentAfter).toBe(initialContent);
    // 5. Existing evidence remains valid
    const verifyResult = verifier.verify({
      workspaceRevision: 1,
      acceptanceContract: { requiredEvidence: ['BUILD'] },
      evidence: record.evidence,
    });
    expect(verifyResult.passed).toBe(true);
  });

  // Test 4: Successful no-op write (identical bytes) -> revision unchanged, 0 files-changed emitted
  it('Test 4: Successful no-op write (identical bytes) -> revision unchanged, 0 files-changed emitted', async () => {
    const task = createTask('task-g15-4');
    const record = await engine.create({
      task,
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const execId = record.execution.id;
    await engine.setStatus(execId, 'running');

    // Create file and establish revision 1
    const content = '// identical byte content\n';
    await fs.writeFile(path.join(tmpDir, 'test.txt'), content, 'utf8');
    await engine.recordFilesChanged(execId, ['test.txt']);
    expect(engine.getWorkspaceRevision(execId)).toBe(1);

    const eventCountBefore = record.events.length;

    // Overwrite with identical bytes
    const writeResult = await writeTool.execute(
      {
        path: 'test.txt',
        content: content,
      },
      {
        projectRoot: tmpDir,
        executionId: execId,
        agentId: 'wazir-coding',
      } as any,
    );

    expect(writeResult.ok).toBe(true);
    expect(writeResult.fileMutations).toBeDefined();
    expect(writeResult.fileMutations![0].changed).toBe(false);

    // Simulating harness: no changed files -> no recordFilesChanged called
    const changedMutations = (writeResult.fileMutations || []).filter((m) => m.changed);
    if (changedMutations.length > 0) {
      await engine.recordFilesChanged(
        execId,
        changedMutations.map((m) => m.path),
      );
    }

    // Revision unchanged, 0 events emitted
    expect(engine.getWorkspaceRevision(execId)).toBe(1);
    expect(engine.getFilesChangedSince(execId, 1)).toEqual([]);
    const newEvents = record.events.slice(eventCountBefore);
    expect(newEvents.some((e) => e.type === 'file.changed')).toBe(false);
  });

  // Test 5: Verify R10 -> mutate to R11 -> COMPLETE targetRevision=10 -> rejected with STALE_WORKSPACE_REVISION
  it('Test 5: Verify R10 -> mutate to R11 -> COMPLETE targetRevision=10 -> rejected with STALE_WORKSPACE_REVISION', async () => {
    const task = createTask('task-g15-5');
    const record = await engine.create({
      task,
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const execId = record.execution.id;
    await engine.setStatus(execId, 'running');

    // Bump workspace revision to 10
    for (let i = 1; i <= 10; i++) {
      await engine.recordFilesChanged(execId, [`file_${i}.cpp`]);
    }
    expect(engine.getWorkspaceRevision(execId)).toBe(10);

    // Record passing build at R10
    await engine.recordCheck(execId, {
      name: 'build',
      command: 'make',
      ok: true,
      durationMs: 120,
    });

    const verifyR10 = verifier.verify({
      workspaceRevision: 10,
      acceptanceContract: { requiredEvidence: ['BUILD'] },
      evidence: record.evidence,
    });
    expect(verifyR10.passed).toBe(true);

    // Mutate to R11
    await engine.recordFilesChanged(execId, ['unplanned_mutation.cpp']);
    expect(engine.getWorkspaceRevision(execId)).toBe(11);

    // Attempt completion with targetRevision=10 -> must throw STALE_WORKSPACE_REVISION
    await expect(
      engine.setStatus(execId, 'completed', { targetRevision: 10 }),
    ).rejects.toThrow(/STALE_WORKSPACE_REVISION/);

    expect(record.execution.status).not.toBe('completed');
    const rejectedEvent = record.events.find((e) => e.type === 'completion.rejected');
    expect(rejectedEvent).toBeDefined();
    expect((rejectedEvent!.data as any).attemptedRevision).toBe(10);
    expect((rejectedEvent!.data as any).currentRevision).toBe(11);
  });

  // Test 6: Workspace-local make -> BUILD_WORKSPACE allowed, no interactive approval, build evidence recorded
  it('Test 6: Workspace-local make -> BUILD_WORKSPACE allowed, no interactive approval, build evidence recorded', async () => {
    const policy = new PolicyEngine({ projectRoot: tmpDir, networkAllowed: false });
    const task = createTask('task-g15-6');
    const record = await engine.create({
      task,
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const execId = record.execution.id;
    await engine.setStatus(execId, 'running');
    await engine.recordFilesChanged(execId, ['Makefile', 'main.cpp']);
    const rev = engine.getWorkspaceRevision(execId);

    // Evaluate workspace-local make
    const decision = policy.classify({
      tool: 'shell',
      input: {
        command: 'make',
      },
      executionId: execId,
    });

    expect(decision.decision).toBe('allow');
    expect(decision.rule).toBe('shell-build-workspace-allow');

    // Record build evidence
    await engine.recordCheck(execId, {
      name: 'build',
      command: 'make',
      ok: true,
      durationMs: 200,
    });

    const currentRecord = engine.require(execId);
    const buildEv = currentRecord.evidence.find((e) => e.type === 'BUILD');
    expect(buildEv).toBeDefined();
    expect(buildEv!.revision).toBe(rev);
    expect(buildEv!.exitCode).toBe(0);
  });

  // Test 7: Build escaping workspace -> denied or requires approval, never inherits BUILD_WORKSPACE
  it('Test 7: Build escaping workspace (make -C /etc, make install, cp artifact /usr/local/bin, g++ main.cpp -o /usr/local/bin/app) -> denied or requires approval, never inherits BUILD_WORKSPACE', async () => {
    const policy = new PolicyEngine({ projectRoot: tmpDir, networkAllowed: false });
    const execId = 'exec-test-7';

    // 1. make -C /etc
    const makeOutside = policy.classify({
      tool: 'shell',
      input: { command: 'make -C /etc' },
      executionId: execId,
    });
    expect(makeOutside.decision).not.toBe('allow');
    expect(makeOutside.rule).not.toBe('shell-build-workspace-allow');

    // 2. make install
    const makeInstall = policy.classify({
      tool: 'shell',
      input: { command: 'make install' },
      executionId: execId,
    });
    expect(makeInstall.decision).toBe('ask');
    expect(makeInstall.rule).toBe('shell-build-workspace-install-ask');

    // 3. g++ main.cpp -o /usr/local/bin/app
    const gppOutside = policy.classify({
      tool: 'shell',
      input: { command: 'g++ main.cpp -o /usr/local/bin/app' },
      executionId: execId,
    });
    expect(gppOutside.decision).toBe('deny');
    expect(gppOutside.rule).toBe('filesystem-outside-deny');

    // 4. cp artifact /usr/local/bin
    const cpOutside = policy.classify({
      tool: 'shell',
      input: { command: 'cp artifact /usr/local/bin' },
      executionId: execId,
    });
    expect(cpOutside.decision).not.toBe('allow');
    expect(cpOutside.rule).not.toBe('shell-build-workspace-allow');
  });

  // Test 8: Model prose "Everything compiles and all tests pass." without evidence -> VERIFICATION_FAILED
  it('Test 8: Model prose "Everything compiles and all tests pass." without evidence -> VERIFICATION_FAILED', async () => {
    const task = createTask('task-g15-8');
    const record = await engine.create({
      task,
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const execId = record.execution.id;
    await engine.setStatus(execId, 'running');
    await engine.recordFilesChanged(execId, ['main.cpp']);

    // Model claims complete in result summary, but no checks/evidence exist
    record.result = {
      summary:
        'Everything compiles and all tests pass. All 10 tests passed successfully. The implementation is 100% complete and verified.',
    };

    const evalResult = evaluateExecution(record, {
      acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] },
    });

    expect(evalResult.success).toBe(false);
    expect(
      evalResult.reasons.some(
        (r) => r.includes('NO_BUILD_EVIDENCE') || r.includes('TEST_EVIDENCE_MISSING'),
      ),
    ).toBe(true);

    // Also test expectedEvidence
    const evalExpected = evaluateExecution(record, {
      expectedEvidence: ['compilation_succeeds', 'exit_code_zero'],
    });
    expect(evalExpected.success).toBe(false);
  });

  // Test 9: Production bug reproduction: compile R1 fail -> edit R2 -> compile R2 fail -> edit R3 -> model done -> verify R3 -> VERIFICATION_FAILED
  it('Test 9: Production bug reproduction: compile R1 fail -> edit R2 -> compile R2 fail -> edit R3 -> model done -> verify R3 -> VERIFICATION_FAILED', async () => {
    const task = createTask('task-g15-9');
    const record = await engine.create({
      task,
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const execId = record.execution.id;
    await engine.setStatus(execId, 'running');

    // R1: initial write, compile fails (exit 1)
    await engine.recordFilesChanged(execId, ['Calendar.cpp']);
    expect(engine.getWorkspaceRevision(execId)).toBe(1);
    await engine.recordCheck(execId, {
      name: 'build',
      command: 'g++ -c Calendar.cpp',
      ok: false,
      durationMs: 100,
    });

    // R2: repair edit, compile fails (exit 1)
    await engine.recordFilesChanged(execId, ['Calendar.cpp']);
    expect(engine.getWorkspaceRevision(execId)).toBe(2);
    await engine.recordCheck(execId, {
      name: 'build',
      command: 'g++ -c Calendar.cpp',
      ok: false,
      durationMs: 110,
    });

    // R3: second repair edit, but no build executed on R3
    await engine.recordFilesChanged(execId, ['Calendar.cpp']);
    expect(engine.getWorkspaceRevision(execId)).toBe(3);

    // Model outputs completion narration
    record.result = {
      summary: 'Repaired syntax error and clinic reservation is now fully functional.',
    };

    // Verify R3
    const currentRecord = engine.require(execId);
    const evalResult = evaluateExecution(currentRecord, {
      acceptanceContract: { requiredEvidence: ['BUILD'] },
    });

    expect(evalResult.success).toBe(false);
    expect(evalResult.latestSuccessfulBuildRevision).toBeNull();
    expect(
      evalResult.reasons.some(
        (r) =>
          r.includes('NO_BUILD_EVIDENCE') ||
          r.includes('no successful build exists for current workspace revision 3'),
      ),
    ).toBe(true);

    const verifyResult = verifier.verify({
      workspaceRevision: 3,
      acceptanceContract: { requiredEvidence: ['BUILD'] },
      evidence: currentRecord.evidence,
    });
    expect(verifyResult.passed).toBe(false);
    expect(verifyResult.latestSuccessfulBuildRevision).toBeNull();
  });

  // Test 10: Golden path: implement R -> build R exit 0 -> test R exit 0 -> verify R PASS -> complete R with all evidence referencing R
  it('Test 10: Golden path: implement R -> build R exit 0 -> test R exit 0 -> verify R PASS -> complete R with all evidence referencing R', async () => {
    const task = createTask('task-g15-10');
    const record = await engine.create({
      task,
      computerId: 'local',
      runtimeId: 'local',
      modelId: 'test-model',
    });
    const execId = record.execution.id;
    await engine.setStatus(execId, 'running');

    // Implement files -> workspace revision R
    await engine.recordFilesChanged(execId, ['Calendar.cpp', 'Calendar.h', 'tests.cpp']);
    const rev = engine.getWorkspaceRevision(execId);
    expect(rev).toBe(1);

    // Build R (exit 0)
    await engine.recordCheck(execId, {
      name: 'build',
      command: 'make',
      ok: true,
      durationMs: 150,
    });

    // Test R (exit 0)
    await engine.recordCheck(execId, {
      name: 'test',
      command: './tests',
      ok: true,
      durationMs: 80,
    });

    // Verify R PASS
    const currentRecord = engine.require(execId);
    const verifyResult = verifier.verify({
      workspaceRevision: rev,
      acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] },
      evidence: currentRecord.evidence,
    });
    expect(verifyResult.passed).toBe(true);
    expect(verifyResult.latestSuccessfulBuildRevision).toBe(rev);
    expect(verifyResult.latestSuccessfulTestRevision).toBe(rev);

    const evalResult = evaluateExecution(currentRecord, {
      acceptanceContract: { requiredEvidence: ['BUILD', 'TEST'] },
    });
    expect(evalResult.success).toBe(true);
    expect(evalResult.workspaceRevision).toBe(rev);
    expect(evalResult.latestSuccessfulBuildRevision).toBe(rev);

    // Complete R with targetRevision
    await engine.setStatus(execId, 'completed', { targetRevision: rev });
    expect(currentRecord.execution.status).toBe('completed');
    expect(currentRecord.workspaceState.revision).toBe(rev);

    // All evidence references revision R
    expect(currentRecord.evidence.length).toBeGreaterThanOrEqual(2);
    for (const ev of currentRecord.evidence) {
      expect(ev.revision).toBe(rev);
      expect(ev.exitCode).toBe(0);
    }
  });
});
