import { describe, it, expect } from 'vitest';
import { ToolReceiptManager } from '../src/proactive/toolReceipt.js';

describe('ToolReceiptManager (Adapted from Qwen-Live-Harness)', () => {
  it('creates authoritative atomic receipts for tool operations', () => {
    const manager = new ToolReceiptManager();

    const receipt = manager.createReceipt({
      toolName: 'patchTool',
      op: 'apply_patch',
      input: { file: 'src/index.ts', patch: '@@ -1,1 +1,2 @@' },
      output: 'Patch applied cleanly',
      success: true,
    });

    expect(receipt.atomic).toBe(true);
    expect(receipt.committed).toBe(true);
    expect(receipt.results[0].toolName).toBe('patchTool');
    expect(receipt.results[0].success).toBe(true);
  });

  it('guarantees idempotency by returning cached receipt for identical tool calls', () => {
    const manager = new ToolReceiptManager();

    const input = { command: 'npm test', cwd: '/tmp/repo' };
    const r1 = manager.createReceipt({
      toolName: 'shell',
      op: 'execute_tool',
      input,
      output: 'All tests passed',
      success: true,
    });

    const r2 = manager.createReceipt({
      toolName: 'shell',
      op: 'execute_tool',
      input,
      output: 'Duplicate execution',
      success: true,
    });

    // Identical fingerprint returns the exact same receipt without re-executing
    expect(r1.receiptId).toBe(r2.receiptId);
    expect(r1.fingerprint).toBe(r2.fingerprint);
    expect(r2.results[0].output).toBe('All tests passed');
  });
});
