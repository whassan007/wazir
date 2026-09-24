import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool, ToolRegistry } from '../src/registry.js';

/**
 * Phase 20: the tool pipeline refuses oracle-weakening writes/edits before dispatch
 * (no checkpoint, no side effect) unless the task explicitly authorizes them.
 */
describe('protected verification in the tool pipeline', () => {
  let root: string;
  const registry = new ToolRegistry();
  const suite = "it('a', () => { expect(f(1)).toBe(2); });\nit('b', () => { expect(f(2)).toBe(4); });\n";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wazir-oracle-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src/f.test.ts'), suite);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('denies an edit that skips a failing test, without checkpointing or writing', async () => {
    let checkpoints = 0;
    const result = await executeTool(registry, 'edit', { path: 'src/f.test.ts', oldString: "it('b'", newString: "it.skip('b'" }, {
      projectRoot: root, verifyWorkspace: true, checkpoint: async () => { checkpoints += 1; },
    });
    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('POLICY_DENIED');
    expect(result.error).toMatch(/^VERIFICATION_PROTECTED: /);
    expect(result.error).toContain('tests_skipped');
    expect(checkpoints).toBe(0);
    expect(await readFile(join(root, 'src/f.test.ts'), 'utf8')).toBe(suite);
  });

  it('denies overwriting a test file with fewer tests', async () => {
    const result = await executeTool(registry, 'write', { path: 'src/f.test.ts', content: "it('a', () => { expect(f(1)).toBe(2); });\n" }, { projectRoot: root });
    expect(result.failureClass).toBe('POLICY_DENIED');
    expect(await readFile(join(root, 'src/f.test.ts'), 'utf8')).toBe(suite);
  });

  it('allows adding a test', async () => {
    const result = await executeTool(registry, 'edit', { path: 'src/f.test.ts', oldString: suite.split('\n')[1], newString: `${suite.split('\n')[1]}\nit('c', () => { expect(f(3)).toBe(6); });` }, { projectRoot: root });
    expect(result.ok).toBe(true);
  });

  it('allows the weakening change when the task explicitly authorizes it', async () => {
    const result = await executeTool(registry, 'edit', { path: 'src/f.test.ts', oldString: "it('b'", newString: "it.skip('b'" }, { projectRoot: root, allowVerificationChanges: true });
    expect(result.ok).toBe(true);
  });

  it('edit inserts replacement text literally, including $ sequences', async () => {
    await writeFile(join(root, 'src/price.ts'), 'const label = PLACEHOLDER;\n');
    const result = await executeTool(registry, 'edit', { path: 'src/price.ts', oldString: 'PLACEHOLDER', newString: "'$&100'" }, { projectRoot: root });
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, 'src/price.ts'), 'utf8')).toBe("const label = '$&100';\n");
  });
});
