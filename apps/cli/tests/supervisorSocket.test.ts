import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { supervisorSocket } from '../src/improvementSupervisor.js';

describe('supervisor socket addresses', () => {
  afterEach(() => vi.restoreAllMocks());
  const directory = '/isolated/config';
  const digest = createHash('sha256').update(directory).digest('hex').slice(0, 32);

  it('uses the Windows named pipe namespace', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(supervisorSocket(directory)).toBe(`\\\\.\\pipe\\wazir-improve-${digest}`);
  });

  it('keeps Linux abstract socket ownership tied to the process', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(supervisorSocket(directory)).toBe(`\0wazir-improve-${digest}`);
  });

  it('uses a filesystem socket on macOS', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(supervisorSocket(directory)).toBe(path.join(os.tmpdir(), `wazir-improve-${digest}.sock`));
  });
});
