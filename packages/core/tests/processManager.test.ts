import { describe, it, expect } from 'vitest';
import { ProcessManager } from '../src/services/processManager.js';

describe('ProcessManager.stop() — graceful teardown, escalation, verified death', () => {
  it('stops a process that exits cleanly on SIGTERM, without needing to escalate', async () => {
    const manager = new ProcessManager();
    manager.register({ id: 'clean', command: 'node', args: ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);'] });
    await manager.start('clean');
    expect(manager.getStatus('clean')).toBe('running');

    await manager.stop('clean', 3000);
    expect(manager.getStatus('clean')).toBe('stopped');
    expect(manager.get('clean')?.pid).toBeUndefined();
  }, 10_000);

  it('escalates to SIGKILL once graceMs elapses for a process that ignores SIGTERM, and still ends up stopped', async () => {
    const manager = new ProcessManager();
    manager.register({ id: 'stubborn', command: 'node', args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'] });
    await manager.start('stubborn');
    const pid = manager.get('stubborn')?.pid;
    expect(pid).toBeTruthy();

    const start = Date.now();
    await manager.stop('stubborn', 300);
    const elapsed = Date.now() - start;

    expect(manager.getStatus('stubborn')).toBe('stopped');
    // Bounded: 300ms grace + escalation, not "ignores SIGTERM forever".
    expect(elapsed).toBeLessThan(3000);

    // Verify the OS actually reports it gone, not just our own bookkeeping.
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 10_000);

  it('kills the whole process tree, not just the direct child (grandchild does not survive)', async () => {
    const manager = new ProcessManager();
    const parentCode = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      console.log('GRANDCHILD:' + child.pid);
      setInterval(() => {}, 1000);
    `;
    manager.register({
      id: 'parent-with-child',
      command: process.execPath,
      args: ['-e', parentCode],
    });
    await manager.start('parent-with-child');

    const record = manager.get('parent-with-child')!;
    for (let i = 0; i < 20; i++) {
      if (record.stdout.some((l) => l.startsWith('GRANDCHILD:'))) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const grandchildLine = record.stdout.find((l) => l.startsWith('GRANDCHILD:'));
    expect(grandchildLine).toBeTruthy();
    const grandchildPid = Number(grandchildLine!.split(':')[1]);

    await manager.stop('parent-with-child', 1000);

    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(grandchildPid, 0)).toThrow();
  }, 10_000);

  it('is a no-op when the process was never started', async () => {
    const manager = new ProcessManager();
    manager.register({ id: 'never-started', command: 'node', args: ['-e', '1'] });
    await expect(manager.stop('never-started')).resolves.toBeUndefined();
  });
});
