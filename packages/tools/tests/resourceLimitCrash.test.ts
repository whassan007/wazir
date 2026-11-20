import { describe, it, expect } from 'vitest';
import { classifyResourceLimitCrash } from '../src/resourceLimits.js';

describe('classifyResourceLimitCrash', () => {
  it('detects CPU limit kill via SIGXCPU or exit code 152', () => {
    const res = classifyResourceLimitCrash(152, 'SIGXCPU', 'CPU time limit exceeded', { maxCpuSeconds: 600 }, false);
    expect(res).toBeDefined();
    expect(res?.kind).toBe('cpu');
    expect(res?.limit).toBe(600);
  });

  it('detects file size limit kill via SIGXFSZ or stderr message', () => {
    const res = classifyResourceLimitCrash(153, null, 'File size limit exceeded', { maxFileSizeMB: 4096 }, false);
    expect(res).toBeDefined();
    expect(res?.kind).toBe('file_size');
    expect(res?.limit).toBe(4096);
  });

  it('detects memory limit kill when maxMemoryMB is configured and not timedOut', () => {
    const res = classifyResourceLimitCrash(137, 'SIGKILL', 'Out of memory', { maxMemoryMB: 512 }, false);
    expect(res).toBeDefined();
    expect(res?.kind).toBe('memory');
  });

  it('does not misclassify a normal timeout SIGKILL as memory OOM without maxMemoryMB', () => {
    const res = classifyResourceLimitCrash(137, 'SIGKILL', '', {}, true);
    expect(res).toBeUndefined();
  });
});
