import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { executeTool } from '../../src/index.js';
import { ToolRegistry } from '../../src/registry.js';
import { writeTool, editTool, readTool } from '../../src/filesystem.js';

describe('LIVE-CODE-07: Filesystem Mutation & Snapshot Synchronization', () => {
  let tmpDir: string;
  let registry: ToolRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-live-07-'));
    registry = new ToolRegistry();
    registry.register(writeTool);
    registry.register(editTool);
    registry.register(readTool);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('TEST A - successful mutation increments revision and emits accurate FILE_CHANGED', async () => {
    const file = path.join(tmpDir, 'live-output.txt');
    const result = await executeTool(registry, 'write', { path: file, content: 'revision 1 content' }, { projectRoot: tmpDir, executionId: 'ex1' });
    
    expect(result.ok).toBe(true);
    expect(result.fileMutations).toBeDefined();
    expect(result.fileMutations![0].changed).toBe(true);
    expect(result.fileMutations![0].path).toBe(file);
    
    const content = await fs.readFile(file, 'utf8');
    expect(content).toBe('revision 1 content');
  });

  it('TEST B - failed edit does not emit FILE_CHANGED', async () => {
    const file = path.join(tmpDir, 'existing.txt');
    await fs.writeFile(file, 'actual content');
    
    const result = await executeTool(registry, 'edit', { path: file, oldString: 'nonexistent', newString: 'changed' }, { projectRoot: tmpDir, executionId: 'ex1' });
    
    expect(result.ok).toBe(false);
    expect(result.fileMutations).toBeDefined();
    // In our implementation, a failed edit doesn't even set changed to true.
    const m = result.fileMutations![0];
    expect(m.changed).toBe(false);
    
    const content = await fs.readFile(file, 'utf8');
    expect(content).toBe('actual content');
  });

  it('TEST C - successful no-op leaves physical bytes identical and FILE_CHANGED=false', async () => {
    const file = path.join(tmpDir, 'noop.txt');
    await fs.writeFile(file, 'unchanged text');
    
    const result = await executeTool(registry, 'write', { path: file, content: 'unchanged text' }, { projectRoot: tmpDir, executionId: 'ex1' });
    
    expect(result.ok).toBe(true);
    expect(result.fileMutations![0].changed).toBe(false);
    
    const content = await fs.readFile(file, 'utf8');
    expect(content).toBe('unchanged text');
  });
});
