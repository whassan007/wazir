import fs from 'node:fs';
import path from 'node:path';
import type { ClassifiedInput, ShellMode } from './contracts.js';

const SHELL_BUILTINS = new Set([
  'alias', 'bg', 'bind', 'break', 'builtin', 'cd', 'command', 'compgen', 'complete',
  'continue', 'declare', 'dirs', 'disown', 'echo', 'enable', 'eval', 'exec', 'exit',
  'export', 'false', 'fc', 'fg', 'getopts', 'hash', 'help', 'history', 'jobs', 'kill',
  'let', 'local', 'logout', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readonly',
  'return', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'times', 'trap',
  'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'wait', 'which',
  'sudo', 'apt', 'apt-get', 'dpkg', 'snap', 'flatpak', 'systemctl', 'journalctl',
]);

const executableCache = new Map<string, boolean>();

export function isExecutableOnPathFast(cmd: string): boolean {
  if (!cmd || /\s/.test(cmd)) return false;
  if (cmd.startsWith('./') || cmd.startsWith('../') || cmd.startsWith('/')) {
    try {
      fs.accessSync(cmd, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const cached = executableCache.get(cmd);
  if (cached !== undefined) return cached;

  const pathDirs = (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(path.delimiter);
  let found = false;
  for (const dir of pathDirs) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, cmd);
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        found = true;
        break;
      }
    } catch {
      // continue scanning PATH
    }
  }
  if (executableCache.size > 512) executableCache.clear();
  executableCache.set(cmd, found);
  return found;
}

/**
 * Deterministic Tier-0 command classifier.
 * Never invokes an LLM. Executes in sub-millisecond time.
 */
export function classifyHybridInput(raw: string, mode: ShellMode = 'auto'): ClassifiedInput {
  const start = performance.now();
  const trimmed = raw.trim();
  const finish = (
    partial: Omit<ClassifiedInput, 'raw' | 'classifiedInMs'>,
  ): ClassifiedInput => ({
    raw,
    ...partial,
    classifiedInMs: Number((performance.now() - start).toFixed(3)),
  });

  if (!trimmed) {
    return finish({ normalized: '', kind: 'empty', route: 'control', reason: 'Empty input' });
  }

  // Explicit mode switches
  if (trimmed === '/mode shell') {
    return finish({
      normalized: trimmed,
      kind: 'mode-switch',
      route: 'control',
      modeChange: 'shell',
      reason: 'Switched hybrid shell to explicit shell mode',
    });
  }
  if (trimmed === '/mode ai') {
    return finish({
      normalized: trimmed,
      kind: 'mode-switch',
      route: 'control',
      modeChange: 'ai',
      reason: 'Switched hybrid shell to explicit AI mode',
    });
  }
  if (trimmed === '/mode auto') {
    return finish({
      normalized: trimmed,
      kind: 'mode-switch',
      route: 'control',
      modeChange: 'auto',
      reason: 'Switched hybrid shell to deterministic auto mode',
    });
  }

  // Explicit prefixes always win
  if (trimmed.startsWith('!')) {
    return finish({
      normalized: trimmed.slice(1).trim(),
      kind: 'forced-shell',
      route: 'shell',
      reason: 'Explicit ! prefix forces native shell execution',
    });
  }
  if (trimmed.startsWith('?')) {
    return finish({
      normalized: trimmed.slice(1).trim(),
      kind: 'forced-ai',
      route: 'ai',
      reason: 'Explicit ? prefix forces Wazir AI orchestration',
    });
  }

  if (mode === 'shell') {
    return finish({
      normalized: trimmed,
      kind: 'forced-shell',
      route: 'shell',
      reason: 'Session is in /mode shell',
    });
  }
  if (mode === 'ai') {
    return finish({
      normalized: trimmed,
      kind: 'forced-ai',
      route: 'ai',
      reason: 'Session is in /mode ai',
    });
  }

  // Shell syntax: pipes, redirects, subshells, logical chains, env assignments
  if (
    /[|><;&`]|\$\(|^\w+=[^\s]+\s+/.test(trimmed) &&
    !/^(find|show|explain|install|optimize|diagnose|what|how|why|please)\b/i.test(trimmed)
  ) {
    return finish({
      normalized: trimmed,
      kind: 'shell-syntax',
      route: 'shell',
      reason: 'Contains POSIX shell operators or variable assignment',
    });
  }

  const firstToken = trimmed.split(/\s+/)[0] ?? '';

  if (SHELL_BUILTINS.has(firstToken)) {
    return finish({
      normalized: trimmed,
      kind: 'shell-builtin',
      route: 'shell',
      reason: `Matched shell builtin '${firstToken}'`,
    });
  }

  // Clear natural-language sentence indicators
  const words = trimmed.split(/\s+/);
  const hasPosixFlagsOrPaths = words.slice(1).some((w) => w.startsWith('-') || w.startsWith('./') || w.startsWith('/'));
  if (
    words.length >= 3 &&
    !hasPosixFlagsOrPaths &&
    (/^(find|show|explain|diagnose|install|optimize|create|build|fix|check|why|what|how|where|when|who|please|summarize|list|help|open|switch|enable|disable|configure|audit|analyze|search|clean|resume|cancel)\b/i.test(
      firstToken,
    ) ||
      trimmed.endsWith('?'))
  ) {
    // Note: if firstToken is literally an executable like `find . -name ...`, check flags/paths
    if (firstToken === 'find' && (words[1]?.startsWith('.') || words[1]?.startsWith('/') || words.includes('-name'))) {
      return finish({
        normalized: trimmed,
        kind: 'shell-executable',
        route: 'shell',
        reason: 'POSIX find command with path/flag arguments',
      });
    }
    return finish({
      normalized: trimmed,
      kind: 'natural-language',
      route: 'ai',
      reason: 'Natural-language request routed to Wazir orchestrator',
    });
  }

  if (isExecutableOnPathFast(firstToken)) {
    return finish({
      normalized: trimmed,
      kind: 'shell-executable',
      route: 'shell',
      reason: `Executable '${firstToken}' found on PATH`,
    });
  }

  if (words.length >= 4) {
    return finish({
      normalized: trimmed,
      kind: 'natural-language',
      route: 'ai',
      reason: 'Multi-word non-executable input routed to Wazir orchestrator',
    });
  }

  // Never guess and execute uncertain input as a shell command
  return finish({
    normalized: trimmed,
    kind: 'ambiguous',
    route: 'ambiguous',
    reason: `Uncertain input '${trimmed}' — ask user to prefix with ! (shell) or ? (AI)`,
  });
}
