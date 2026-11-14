import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolicyEngine } from '@wazir/core';
import { executeTool, ToolRegistry } from '../src/registry.js';

describe('Qwen Code 1.0 ergonomics tools & PolicyEngine alignment', () => {
  let root: string;
  let registry: ToolRegistry;
  let policy: PolicyEngine;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wazir-qwen-tools-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'specs'), { recursive: true });
    registry = new ToolRegistry();
    policy = new PolicyEngine({ projectRoot: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('multi_edit applies ordered edits atomically and rolls back completely if a later edit fails', async () => {
    await writeFile(join(root, 'src/math.ts'), 'export const a = 1;\nexport const b = 2;\n');

    // Partial failure leaves disk untouched
    const failed = await executeTool(
      registry,
      'multi_edit',
      {
        path: 'src/math.ts',
        edits: [
          { oldString: 'export const a = 1;', newString: 'export const a = 10;' },
          { oldString: 'export const missing = 3;', newString: 'export const missing = 30;' },
        ],
      },
      { projectRoot: root, verifyWorkspace: true },
    );
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('edits[1]');
    expect(await readFile(join(root, 'src/math.ts'), 'utf8')).toBe('export const a = 1;\nexport const b = 2;\n');

    // Atomic success
    const ok = await executeTool(
      registry,
      'multi_edit',
      {
        path: 'src/math.ts',
        edits: [
          { oldString: 'export const a = 1;', newString: 'export const a = 10;' },
          { oldString: 'export const b = 2;', newString: 'export const b = 20;' },
        ],
      },
      { projectRoot: root, verifyWorkspace: true },
    );
    expect(ok.ok).toBe(true);
    expect(ok.fileMutations).toMatchObject([{ path: 'src/math.ts', changed: true }]);
    expect(await readFile(join(root, 'src/math.ts'), 'utf8')).toBe('export const a = 10;\nexport const b = 20;\n');
  });

  it('multi_edit enforces VERIFICATION_PROTECTED oracle check and PolicyEngine spec write fence', async () => {
    const suite = "it('works', () => { expect(1 + 1).toBe(2); });\n";
    await writeFile(join(root, 'src/math.test.ts'), suite);
    await writeFile(join(root, 'specs/inv.als'), 'module inv\n');

    const weakened = await executeTool(
      registry,
      'multi_edit',
      {
        path: 'src/math.test.ts',
        edits: [{ oldString: "it('works'", newString: "it.skip('works'" }],
      },
      { projectRoot: root },
    );
    expect(weakened.ok).toBe(false);
    expect(weakened.failureClass).toBe('POLICY_DENIED');
    expect(weakened.error).toContain('VERIFICATION_PROTECTED');

    // PolicyEngine denies multi_edit targeting specs/ for non-spec-author tasks
    const fenceDecision = policy.classify({
      tool: 'multi_edit',
      input: { path: 'specs/inv.als', edits: [{ oldString: 'module inv', newString: 'module inv2' }] },
      projectRoot: root,
      executionId: 'exec-impl',
    });
    expect(fenceDecision.decision).toBe('deny');
    expect(fenceDecision.rule).toBe('spec-write-fence-deny');
  });

  it('read_many_files reads multiple project files and PolicyEngine blocks path traversal', async () => {
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, 'src/b.ts'), 'export const b = 2;\n');

    const allowed = policy.classify({
      tool: 'read_many_files',
      input: { paths: ['src/a.ts', 'src/b.ts'] },
      projectRoot: root,
    });
    expect(allowed.decision).toBe('allow');

    const traversal = policy.classify({
      tool: 'read_many_files',
      input: { paths: ['src/a.ts', '../../etc/passwd'] },
      projectRoot: root,
    });
    expect(traversal.decision).toBe('deny');
    expect(traversal.rule).toBe('filesystem-outside-deny');

    // Capability probe with empty input returns non-unknown-tool rule
    const probe = policy.classify({ tool: 'read_many_files', input: {}, projectRoot: root });
    expect(probe.rule).not.toBe('unknown-tool');

    const res = await executeTool(
      registry,
      'read_many_files',
      { paths: ['src/a.ts', 'src/b.ts'] },
      { projectRoot: root },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('=== src/a.ts');
    expect(res.output).toContain('1: export const a = 1;');
    expect(res.output).toContain('=== src/b.ts');
    expect(res.output).toContain('1: export const b = 2;');
  });

  it('todo_write updates checklist in memory and is allowed by PolicyEngine without triggering spec fence', async () => {
    const decision = policy.classify({
      tool: 'todo_write',
      input: {
        todos: [{ id: '1', content: 'Review specs/inv.als before implementing', status: 'in_progress' }],
      },
      projectRoot: root,
      executionId: 'exec-impl',
    });
    expect(decision.decision).toBe('allow');
    expect(decision.rule).toBe('scratchpad-allow');

    const res = await executeTool(
      registry,
      'todo_write',
      {
        todos: [
          { id: '1', content: 'Inspect module', status: 'completed' },
          { id: '2', content: 'Patch bug', status: 'in_progress' },
        ],
      },
      { projectRoot: root },
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('Checklist updated (1/2 completed)');
    expect(res.output).toContain('[x] (1) Inspect module');
    expect(res.output).toContain('[>] (2) Patch bug');
  });
});
