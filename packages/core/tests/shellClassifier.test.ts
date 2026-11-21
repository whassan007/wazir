import { describe, expect, it } from 'vitest';
import {
  classifyShellInput,
  discoverOptionalShellTools,
} from '../src/services/shellClassifier.js';

describe('classifyShellInput', () => {
  it('honors explicit !, ?, and /mode prefixes', () => {
    expect(classifyShellInput('! find the bug')).toMatchObject({
      mode: 'shell',
      explicit: true,
      command: 'find the bug',
    });
    expect(classifyShellInput('? ls -la')).toMatchObject({
      mode: 'ai',
      explicit: true,
      command: 'ls -la',
    });
    expect(classifyShellInput('/mode shell')).toMatchObject({
      mode: 'control',
      explicit: true,
      modeChange: 'shell',
    });
  });

  it('recognizes ordinary shell commands deterministically', () => {
    expect(classifyShellInput('ls -la').mode).toBe('shell');
    expect(classifyShellInput('git status').mode).toBe('shell');
    expect(classifyShellInput('cd ~/Code/Wazir').mode).toBe('shell');
    expect(classifyShellInput('grep -R TODO .').mode).toBe('shell');
    expect(classifyShellInput('cat foo.txt | wc -l').mode).toBe('shell');
    expect(classifyShellInput('FOO=bar node index.js').mode).toBe('shell');
    expect(classifyShellInput('./scripts/assure-verify.sh').mode).toBe('shell');
  });

  it('routes natural language requests to AI, flags destructive ambiguity, and marks unknown single tokens ambiguous', () => {
    const safe = classifyShellInput('find the startup bottleneck in Wazir');
    expect(safe.mode).toBe('ai');
    expect(safe.requiresConfirmation).toBe(false);

    const risky = classifyShellInput('delete all old log files in my project');
    expect(risky.mode).toBe('ai');
    expect(risky.requiresConfirmation).toBe(true);

    const ambiguous = classifyShellInput('xyzzy_nonexistent_cmd_99');
    expect(ambiguous.mode).toBe('ambiguous');
  });

  it('discovers optional shell tools without side effects', () => {
    const tools = discoverOptionalShellTools('');
    expect(tools).toHaveLength(6);
    expect(tools.every((t) => !t.available)).toBe(true);
  });
});
