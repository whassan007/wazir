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

  it('installs a narrow, idempotent SQLite ExperimentalWarning filter only when db is accessed', () => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'wazir-ledger-warn-'));
    const file = path.join(directory, 'resources.db');
    const previousEmitWarning = process.emitWarning;
    const forwarded: unknown[][] = [];
    const spyEmitWarning = ((...args: unknown[]) => {
      forwarded.push(args);
    }) as typeof process.emitWarning;
    process.emitWarning = spyEmitWarning;

    try {
      const ledger = new ResourceLedger(file);
      expect(process.emitWarning).toBe(spyEmitWarning);

      ledger.setMeta('k', 'v');
      const wrappedOnce = process.emitWarning;
      expect(wrappedOnce).not.toBe(spyEmitWarning);

      const secondLedger = new ResourceLedger(':memory:');
      secondLedger.setMeta('k2', 'v2');
      expect(process.emitWarning).toBe(wrappedOnce);

      process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
      process.emitWarning(new Error('sqlite is an experimental feature'));
      expect(forwarded).toHaveLength(0);

      const otherError = new Error('Other experimental warning');
      process.emitWarning('Unrelated experimental warning', 'ExperimentalWarning');
      process.emitWarning(otherError, 'DeprecationWarning');
      expect(forwarded).toEqual([
        ['Unrelated experimental warning', 'ExperimentalWarning'],
        [otherError, 'DeprecationWarning'],
      ]);

      ledger.close();
      secondLedger.close();
    } finally {
      process.emitWarning = previousEmitWarning;
    }
  });
});
