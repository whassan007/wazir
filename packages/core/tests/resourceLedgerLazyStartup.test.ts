import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ResourceLedger } from '../src/resources/ledger.js';

describe('ResourceLedger lazy startup', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('does not open or create the ledger database until an accounting operation uses it', () => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'wazir-ledger-lazy-'));
    const file = path.join(directory, 'nested', 'resources.db');
    const ledger = new ResourceLedger(file);

    expect(existsSync(file)).toBe(false);
    ledger.close();
    expect(existsSync(file)).toBe(false);

    const usedLedger = new ResourceLedger(file);
    usedLedger.setMeta('startup', 'used');
    expect(usedLedger.getMeta('startup')).toBe('used');
    expect(existsSync(file)).toBe(true);
    usedLedger.close();
  });
});
