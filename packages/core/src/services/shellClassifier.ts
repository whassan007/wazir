import fs from 'node:fs';
import path from 'node:path';
import { isExecutableOnPath, resolveExecutable } from '@wazir/shared';

export type ShellInputMode = 'shell' | 'ai' | 'ambiguous' | 'control' | 'wazir';
export type ShellRoutingMode = 'auto' | 'shell' | 'ai';

export type WazirShellCommandName =
  | 'loop'
  | 'graph'
  | 'goal'
  | 'jobs'
  | 'agents'
  | 'models'
  | 'fleet'
  | 'status'
  | 'inspect'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'history'
  | 'help';

export const WAZIR_SHELL_COMMANDS: ReadonlySet<WazirShellCommandName> = new Set([
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
]);

export interface ShellClassification {
  mode: ShellInputMode;
  explicit: boolean;
  command: string;
  reason: string;
  requiresConfirmation: boolean;
  modeChange?: ShellRoutingMode;
  wazirCommand?: WazirShellCommandName;
  wazirArgs?: string;
}

export interface OptionalShellToolStatus {
  name: 'fzf' | 'zoxide' | 'rg' | 'bat' | 'atuin' | 'lazygit';
  label: string;
  available: boolean;
  executablePath: string | null;
}

const OPTIONAL_SHELL_TOOLS: ReadonlyArray<{ name: OptionalShellToolStatus['name']; label: string }> = [
  { name: 'fzf', label: 'fzf (fuzzy finder)' },
  { name: 'zoxide', label: 'zoxide (smart directory jumper)' },
  { name: 'rg', label: 'ripgrep (fast recursive search)' },
  { name: 'bat', label: 'bat (syntax-highlighted cat)' },
  { name: 'atuin', label: 'Atuin (magical shell history)' },
  { name: 'lazygit', label: 'lazygit (terminal UI for git)' },
];

/**
 * Discovers optional developer shell enhancement tools on PATH without automatically installing anything.
 */
export function discoverOptionalShellTools(customPath?: string): OptionalShellToolStatus[] {
  if (customPath !== undefined) {
    const dirs = customPath.split(path.delimiter).filter(Boolean);
    return OPTIONAL_SHELL_TOOLS.map((tool) => {
      let foundPath: string | null = null;
      for (const dir of dirs) {
        const candidate = path.join(dir, process.platform === 'win32' ? `${tool.name}.cmd` : tool.name);
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            fs.accessSync(candidate, fs.constants.X_OK);
            foundPath = candidate;
            break;
          }
        } catch {
          // continue checking next dir
        }
      }
      return {
        name: tool.name,
        label: tool.label,
        available: foundPath !== null,
        executablePath: foundPath,
      };
    });
  }
  return OPTIONAL_SHELL_TOOLS.map((tool) => {
    const resolved = resolveExecutable(tool.name);
    return {
      name: tool.name,
      label: tool.label,
      available: resolved !== null,
      executablePath: resolved,
    };
  });
}

const SHELL_BUILTINS = new Set([
  'cd', 'pwd', 'export', 'unset', 'alias', 'unalias', 'echo', 'printf',
  'exit', 'quit', 'logout', 'history', 'jobs', 'fg', 'bg', 'wait', 'source', '.',
  'true', 'false', 'test', '[', 'set', 'shopt', 'ulimit', 'umask', 'type',
  'command', 'builtin', 'exec', 'eval', 'read', 'return', 'pushd', 'popd', 'dirs',
]);

const KNOWN_SHELL_BINARIES = new Set([
  'ls', 'll', 'la', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep',
  'fgrep', 'rg', 'ag', 'find', 'fd', 'sed', 'awk', 'sort', 'uniq', 'wc',
  'cut', 'tr', 'xargs', 'tee', 'diff', 'patch', 'mkdir', 'rmdir', 'rm',
  'cp', 'mv', 'ln', 'touch', 'chmod', 'chown', 'stat', 'file', 'du', 'df',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'curl', 'wget', 'ssh', 'scp',
  'rsync', 'ping', 'dig', 'nslookup', 'nc', 'lsof', 'ps', 'top', 'htop',
  'kill', 'pkill', 'uname', 'whoami', 'id', 'hostname', 'date', 'uptime',
  'which', 'whereis', 'env', 'printenv', 'git', 'gh', 'docker', 'podman',
  'kubectl', 'helm', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'tsx',
  'python', 'python3', 'pip', 'pip3', 'uv', 'cargo', 'rustc', 'rustup',
  'go', 'make', 'cmake', 'ninja', 'gcc', 'g++', 'clang', 'clang++', 'java',
  'javac', 'gradle', 'adb', 'ollama', 'wa', 'wazir', 'tmux', 'screen',
  'vim', 'nvim', 'nano', 'vi', 'code', 'open', 'xdg-open', 'systemctl',
  'journalctl', 'brew', 'apt', 'apt-get', 'dpkg', 'rpm', 'dnf', 'sudo',
  'fzf', 'zoxide', 'z', 'bat', 'atuin', 'lazygit',
]);

const DESTRUCTIVE_AI_KEYWORDS = /\b(delete|remove|wipe|format|destroy|drop|truncate|purge|reset\s+--hard|rm\s+-rf)\b/i;

const NATURAL_LANGUAGE_VERBS = new Set([
  'explain', 'summarize', 'diagnose', 'optimize', 'fix', 'create', 'build',
  'check', 'why', 'what', 'how', 'where', 'when', 'who', 'please', 'help',
  'configure', 'audit', 'analyze', 'search', 'clean', 'refactor', 'write',
  'organize', 'inspect', 'review', 'generate', 'tell', 'show', 'list',
]);

/** Returns true when input contains a shell pipeline, redirection, command separator, or subshell outside single/double quotes. */
function hasUnquotedShellOperator(input: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '|' || ch === '>' || ch === '<' || ch === ';' || ch === '&' || ch === '`') {
      return true;
    }
    if (ch === '$' && input[i + 1] === '(') {
      return true;
    }
  }
  return false;
}

/**
 * Deterministically classifies universal shell input into native OS shell execution,
 * reserved Wazir Shell commands, governed AI task execution, control mode switches,
 * or ambiguous prompts requiring explicit routing.
 */
export function classifyShellInput(
  rawInput: string,
  sessionMode: ShellRoutingMode = 'auto',
): ShellClassification {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { mode: 'shell', explicit: false, command: '', reason: 'empty input', requiresConfirmation: false };
  }

  // Control mode switches (/mode shell | /mode ai | /mode auto)
  if (/^\/mode\s+(shell|ai|auto)$/i.test(trimmed)) {
    const nextMode = trimmed.split(/\s+/)[1]!.toLowerCase() as ShellRoutingMode;
    return {
      mode: 'control',
      explicit: true,
      command: trimmed,
      reason: `session mode switch to '${nextMode}'`,
      requiresConfirmation: false,
      modeChange: nextMode,
    };
  }

  // 1. Explicit ! prefix forces native shell execution
  if (trimmed.startsWith('!')) {
    const cmd = trimmed.slice(1).trim();
    return { mode: 'shell', explicit: true, command: cmd, reason: 'explicit ! shell prefix', requiresConfirmation: false };
  }

  // 1b. Explicit OS collision escapes: \cmd, os:<cmd>, sh:<cmd>, command <cmd>, builtin <cmd>
  if (/^\\[A-Za-z0-9._-]/.test(trimmed)) {
    return {
      mode: 'shell',
      explicit: true,
      command: trimmed.slice(1),
      reason: 'explicit backslash OS shell escape',
      requiresConfirmation: false,
    };
  }
  if (/^(?:os|sh):/i.test(trimmed)) {
    const cmd = trimmed.replace(/^(?:os|sh):\s*/i, '');
    return {
      mode: 'shell',
      explicit: true,
      command: cmd,
      reason: 'explicit os:/sh: namespace escape',
      requiresConfirmation: false,
    };
  }

  // 2. Explicit ? prefix forces governed AI execution
  if (trimmed.startsWith('?')) {
    const req = trimmed.slice(1).trim();
    return {
      mode: 'ai',
      explicit: true,
      command: req,
      reason: 'explicit ? AI prefix',
      requiresConfirmation: DESTRUCTIVE_AI_KEYWORDS.test(req),
    };
  }

  // 3. Explicit session mode overrides
  if (sessionMode === 'shell') {
    return { mode: 'shell', explicit: true, command: trimmed, reason: 'session is in explicit shell mode', requiresConfirmation: false };
  }
  if (sessionMode === 'ai') {
    return {
      mode: 'ai',
      explicit: true,
      command: trimmed,
      reason: 'session is in explicit AI mode',
      requiresConfirmation: DESTRUCTIVE_AI_KEYWORDS.test(trimmed),
    };
  }

  // 3b. Explicit Wazir Shell commands (precedence 1 over colliding bare command names unless piped/redirected/escaped)
  const firstWsIdx = trimmed.search(/\s/);
  const headToken = firstWsIdx === -1 ? trimmed : trimmed.slice(0, firstWsIdx);
  const headLower = headToken.toLowerCase();
  const tailArgs = firstWsIdx === -1 ? '' : trimmed.slice(firstWsIdx + 1).trim();
  const unquotedOp = hasUnquotedShellOperator(trimmed);

  if (!unquotedOp && WAZIR_SHELL_COMMANDS.has(headLower as WazirShellCommandName)) {
    const secondArgLower = (tailArgs.split(/\s+/)[0] ?? '').toLowerCase();
    // Preserve natural language like "help me fix the tests" or "inspect the auth module"
    const isHelpNaturalLanguage = headLower === 'help' && (secondArgLower === 'me' || secondArgLower === 'us');
    const isInspectNaturalLanguage =
      headLower === 'inspect' &&
      ['the', 'a', 'an', 'this', 'that', 'my', 'our', 'all', 'every', 'why', 'how'].includes(secondArgLower);
    if (!isHelpNaturalLanguage && !isInspectNaturalLanguage) {
      return {
        mode: 'wazir',
        explicit: true,
        command: trimmed,
        reason: `reserved Wazir Shell command '${headLower}'`,
        requiresConfirmation: headLower !== 'help' && headLower !== 'status' && headLower !== 'jobs' && headLower !== 'history' && headLower !== 'inspect' && headLower !== 'agents' && headLower !== 'models' && headLower !== 'fleet' && DESTRUCTIVE_AI_KEYWORDS.test(tailArgs),
        wazirCommand: headLower as WazirShellCommandName,
        wazirArgs: tailArgs,
      };
    }
  }

  // 4. Shell operators: pipes, redirections, logical chaining, subshells, backgrounding (unquoted)
  if (unquotedOp) {
    return { mode: 'shell', explicit: false, command: trimmed, reason: 'contains shell pipeline/redirection/chaining operator', requiresConfirmation: false };
  }

  // 5. Path invocation or home-relative path
  if (/^(\.\/|\.\.\/|\/|~\/)/.test(trimmed)) {
    return { mode: 'shell', explicit: false, command: trimmed, reason: 'path-prefixed executable', requiresConfirmation: false };
  }

  // 6. Leading ENV=val assignment
  if (/^[A-Za-z_][A-Za-z0-9_]*=\S*/.test(trimmed)) {
    return { mode: 'shell', explicit: false, command: trimmed, reason: 'environment assignment syntax', requiresConfirmation: false };
  }

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0] ?? '';
  const firstLower = firstToken.toLowerCase();
  const secondToken = (tokens[1] ?? '').toLowerCase();

  const ENGLISH_VERB_COMMANDS = new Set(['find', 'make', 'open', 'kill', 'test', 'read', 'diff', 'which', 'clean', 'sort', 'file']);
  const NATURAL_LANGUAGE_FOLLOWERS = new Set([
    'the', 'a', 'an', 'me', 'my', 'all', 'why', 'how', 'out', 'if', 'whether', 'where', 'what', 'which', 'this', 'that', 'these', 'those', 'failing',
  ]);

  if (ENGLISH_VERB_COMMANDS.has(firstLower) && NATURAL_LANGUAGE_FOLLOWERS.has(secondToken)) {
    return {
      mode: 'ai',
      explicit: false,
      command: trimmed,
      reason: `natural-language phrase starting with '${firstToken} ${secondToken}'`,
      requiresConfirmation: DESTRUCTIVE_AI_KEYWORDS.test(trimmed),
    };
  }

  if (SHELL_BUILTINS.has(firstToken) || KNOWN_SHELL_BINARIES.has(firstToken)) {
    return { mode: 'shell', explicit: false, command: trimmed, reason: `known shell command '${firstToken}'`, requiresConfirmation: false };
  }

  // Clear natural-language requests (question mark suffix, conversational lead verb, or >= 3 words)
  if (trimmed.endsWith('?') || NATURAL_LANGUAGE_VERBS.has(firstLower) || tokens.length >= 3) {
    return {
      mode: 'ai',
      explicit: false,
      command: trimmed,
      reason: 'natural-language instruction',
      requiresConfirmation: DESTRUCTIVE_AI_KEYWORDS.test(trimmed),
    };
  }

  // Check if firstToken is an executable actually installed on PATH
  if (isExecutableOnPath(firstToken)) {
    return { mode: 'shell', explicit: false, command: trimmed, reason: `executable '${firstToken}' found on PATH`, requiresConfirmation: false };
  }

  // Short unknown 1- or 2-token input that is neither a known command/executable nor a clear NL sentence is marked ambiguous
  return {
    mode: 'ambiguous',
    explicit: false,
    command: trimmed,
    reason: `ambiguous input '${trimmed}' — prefix with '! ' for shell or '? ' for AI`,
    requiresConfirmation: DESTRUCTIVE_AI_KEYWORDS.test(trimmed),
  };
}
