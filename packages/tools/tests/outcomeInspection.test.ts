import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectToolOutcome } from '../src/outcomeInspection.js';

describe('inspectToolOutcome', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wazir-outcome-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const write = (content: string) => ({ toolName: 'write', sideEffectClass: 'IDEMPOTENT_WRITE' as const, input: { path: 'a.cpp', content } });
  const edit = (oldString: string, newString: string) => ({ toolName: 'edit', sideEffectClass: 'IDEMPOTENT_WRITE' as const, input: { path: 'a.cpp', oldString, newString } });

  it('write: exact intended content proves APPLIED; missing or different proves NOT_APPLIED', async () => {
    expect((await inspectToolOutcome(root, write('int main(){}'))).outcome).toBe('NOT_APPLIED');
    await writeFile(join(root, 'a.cpp'), 'int ma'); // truncated by an interrupted write
    expect((await inspectToolOutcome(root, write('int main(){}'))).outcome).toBe('NOT_APPLIED');
    await writeFile(join(root, 'a.cpp'), 'int main(){}');
    expect((await inspectToolOutcome(root, write('int main(){}'))).outcome).toBe('APPLIED');
  });

  it('edit: old-only is NOT_APPLIED, new-only is APPLIED, both/neither/overlap is UNDETERMINED', async () => {
    await writeFile(join(root, 'a.cpp'), 'swap(a, b);');
    expect((await inspectToolOutcome(root, edit('swap(a, b)', 'std::swap(x, y)'))).outcome).toBe('NOT_APPLIED');
    await writeFile(join(root, 'a.cpp'), 'std::swap(x, y);');
    expect((await inspectToolOutcome(root, edit('swap(a, b)', 'std::swap(x, y)'))).outcome).toBe('APPLIED');
    await writeFile(join(root, 'a.cpp'), 'garbage');
    expect((await inspectToolOutcome(root, edit('swap(a, b)', 'std::swap(x, y)'))).outcome).toBe('UNDETERMINED');
    expect((await inspectToolOutcome(root, edit('swap', 'std::swap'))).outcome).toBe('UNDETERMINED');
  });

  it('never claims to know the outcome of external side effects', async () => {
    const commit = await inspectToolOutcome(root, { toolName: 'git', sideEffectClass: 'NON_IDEMPOTENT_WRITE', input: { command: 'commit -m x' } });
    expect(commit.outcome).toBe('UNDETERMINED');
    const read = await inspectToolOutcome(root, { toolName: 'read', sideEffectClass: 'READ_ONLY', input: { path: 'a.cpp' } });
    expect(read.outcome).toBe('NOT_APPLIED');
  });
});
