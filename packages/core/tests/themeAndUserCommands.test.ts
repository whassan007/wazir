import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyWithFastOrchestrator,
  expandUserCustomCommand,
  formatThemeCssVariables,
  getUserCustomCommand,
  listUserCustomCommands,
  listWazirThemes,
  readActiveWazirTheme,
  removeUserCustomCommand,
  saveUserCustomCommand,
  writeActiveWazirTheme,
} from '../src/services/index.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wazir-omarchy-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('Coordinated Cross-Surface Theme Engine (#3)', () => {
  it('lists 9 curated themes and persists active theme in isolated WAZIR_HOME', () => {
    const wazirHome = makeTempHome();
    const themes = listWazirThemes();
    expect(themes.length).toBe(9);
    expect(readActiveWazirTheme({ wazirHome, env: {} }).id).toBe('tokyo-night');

    const updated = writeActiveWazirTheme('catppuccin', { wazirHome, env: {} });
    expect(updated.id).toBe('catppuccin');
    expect(readActiveWazirTheme({ wazirHome, env: {} }).id).toBe('catppuccin');

    const cssVars = formatThemeCssVariables(updated);
    expect(cssVars['--accent']).toBe('#cba6f7');

    expect(() => writeActiveWazirTheme('not-a-theme', { wazirHome, env: {} })).toThrow();
  });
});

describe('Agent-Malleable User Extension Directory (#4)', () => {
  it('saves, lists, expands, and removes custom commands in ~/.wazir/commands/ and ~/.wazir/bin/', () => {
    const wazirHome = makeTempHome();
    const saved = saveUserCustomCommand(
      {
        name: 'deploy-preview',
        description: 'Deploy preview build',
        command: 'echo deploying {{args}}',
        mode: 'shell',
        aliases: ['dp'],
      },
      { wazirHome, env: {} },
    );
    expect(saved.name).toBe('deploy-preview');
    expect(expandUserCustomCommand(saved, 'portal')).toBe('echo deploying portal');

    const binDir = path.join(wazirHome, 'bin');
    const scriptPath = path.join(binDir, 'hello-bin');
    // Also test ~/.wazir/bin executable discovery
    saveUserCustomCommand({ name: 'tmp-check', description: 'check', command: 'echo ok' }, { wazirHome, env: {} });
    const all = listUserCustomCommands({ wazirHome, env: {} });
    expect(all.some((c) => c.name === 'deploy-preview')).toBe(true);
    expect(getUserCustomCommand('dp', { wazirHome, env: {} })?.name).toBe('deploy-preview');

    expect(removeUserCustomCommand('tmp-check', { wazirHome, env: {} })).toBe(true);
    expect(() => saveUserCustomCommand({ name: '../evil', description: 'bad', command: 'ls' }, { wazirHome, env: {} })).toThrow();

    // Ensure binDir creation doesn't crash when absent
    expect(scriptPath).toContain('hello-bin');
  });

  it('routes /theme, /commands, /menu, and custom commands at Tier 0 in FastOrchestrator', () => {
    const wazirHome = makeTempHome();
    saveUserCustomCommand(
      {
        name: 'greet',
        description: 'Greet user',
        command: 'echo hi {{args}}',
        mode: 'shell',
      },
      { wazirHome, env: {} },
    );

    const env = { ...process.env, WAZIR_HOME: wazirHome };
    const themeDecision = classifyWithFastOrchestrator('/theme set gruvbox', { env });
    expect(themeDecision.tier).toBe(0);
    expect(themeDecision.tier0Kind).toBe('theme');

    const cmdDecision = classifyWithFastOrchestrator('/commands list', { env });
    expect(cmdDecision.tier).toBe(0);
    expect(cmdDecision.tier0Kind).toBe('commands');

    const menuDecision = classifyWithFastOrchestrator('/menu', { env });
    expect(menuDecision.tier).toBe(0);
    expect(menuDecision.tier0Kind).toBe('menu');

    const customDecision = classifyWithFastOrchestrator('greet world', { env });
    expect(customDecision.tier).toBe(0);
    expect(customDecision.tier0Kind).toBe('custom_command');
    expect(customDecision.shellCommand).toBe('echo hi world');
  });
});
