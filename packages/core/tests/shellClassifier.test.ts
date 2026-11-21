import { describe, expect, it } from 'vitest';
import {
  WAZIR_SHELL_COMMANDS,
  classifyShellInput,
  discoverOptionalShellTools,
  type WazirShellCommandName,
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

  it('deterministically classifies all 14 reserved Wazir Shell commands as mode=wazir', () => {
    const expectedCommands: WazirShellCommandName[] = [
      'loop',
      'graph',
      'goal',
      'jobs',
      'agents',
      'models',
      'fleet',
      'status',
      'inspect',
      'pause',
      'resume',
      'stop',
      'history',
      'help',
    ];
    expect(WAZIR_SHELL_COMMANDS.size).toBe(14);
    for (const cmd of expectedCommands) {
      expect(WAZIR_SHELL_COMMANDS.has(cmd)).toBe(true);
      const bare = classifyShellInput(cmd);
      expect(bare.mode, `expected bare '${cmd}' to route to wazir`).toBe('wazir');
      expect(bare.wazirCommand).toBe(cmd);
      expect(bare.wazirArgs).toBe('');
      expect(bare.explicit).toBe(true);

      const withArg = classifyShellInput(`${cmd} target-42`);
      expect(withArg.mode, `expected '${cmd} target-42' to route to wazir`).toBe('wazir');
      expect(withArg.wazirCommand).toBe(cmd);
      expect(withArg.wazirArgs).toBe('target-42');
    }

    expect(classifyShellInput('LOOP "every city"')).toMatchObject({
      mode: 'wazir',
      wazirCommand: 'loop',
      wazirArgs: '"every city"',
    });
  });

  it('keeps quoted shell operators inside Wazir commands as wazir while routing unquoted pipelines to shell', () => {
    expect(classifyShellInput('loop "Improve X && test it"')).toMatchObject({
      mode: 'wazir',
      wazirCommand: 'loop',
      wazirArgs: '"Improve X && test it"',
    });
    expect(classifyShellInput("goal 'Build auth | billing > out'")).toMatchObject({
      mode: 'wazir',
      wazirCommand: 'goal',
    });

    expect(classifyShellInput('jobs | wc -l').mode).toBe('shell');
    expect(classifyShellInput('cat foo.txt | wc -l').mode).toBe('shell');
    expect(classifyShellInput('status > status.log').mode).toBe('shell');
    expect(classifyShellInput('history && echo done').mode).toBe('shell');
    expect(classifyShellInput('loop $(pwd)').mode).toBe('shell');
  });

  it('honors explicit collision escapes (!, \\cmd, os:, sh:) as OS shell and routes NL help/inspect phrases to AI', () => {
    expect(classifyShellInput('! jobs')).toMatchObject({
      mode: 'shell',
      explicit: true,
      command: 'jobs',
    });
    expect(classifyShellInput('\\jobs')).toMatchObject({
      mode: 'shell',
      explicit: true,
      command: 'jobs',
    });
    expect(classifyShellInput('os:status')).toMatchObject({
      mode: 'shell',
      explicit: true,
      command: 'status',
    });
    expect(classifyShellInput('sh:history')).toMatchObject({
      mode: 'shell',
      explicit: true,
      command: 'history',
    });

    expect(classifyShellInput('help me find the bug').mode).toBe('ai');
    expect(classifyShellInput('help us diagnose the crash').mode).toBe('ai');
    expect(classifyShellInput('inspect this repository').mode).toBe('ai');
    expect(classifyShellInput('inspect the auth module').mode).toBe('ai');

    // Explicit session mode overrides bare Wazir commands
    expect(classifyShellInput('jobs', 'shell').mode).toBe('shell');
    expect(classifyShellInput('status', 'ai').mode).toBe('ai');
  });
});
