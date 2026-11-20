export type ShellInputMode = 'shell' | 'ai';

export interface ShellClassification {
  mode: ShellInputMode;
  explicit: boolean;
  command: string;
  reason: string;
  requiresConfirmation: boolean;
}

const SHELL_BUILTINS = new Set([
  'cd', 'pwd', 'export', 'unset', 'alias', 'unalias', 'echo', 'printf',
  'exit', 'logout', 'history', 'jobs', 'fg', 'bg', 'wait', 'source', '.',
  'true', 'false', 'test', '[', 'set', 'shopt', 'ulimit', 'umask', 'type',
  'command', 'builtin', 'exec', 'eval', 'read', 'return',
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
  'journalctl', 'brew', 'apt', 'apt-get', 'dpkg', 'rpm', 'dnf',
]);

const DESTRUCTIVE_AI_KEYWORDS = /\b(delete|remove|wipe|format|destroy|drop|truncate|purge|reset\s+--hard|rm\s+-rf)\b/i;

/**
 * Deterministically classifies universal shell input into native OS shell execution
 * vs governed AI task execution.
 */
export function classifyShellInput(rawInput: string): ShellClassification {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { mode: 'shell', explicit: false, command: '', reason: 'empty input', requiresConfirmation: false };
  }

  if (trimmed.startsWith('!')) {
    const cmd = trimmed.slice(1).trim();
    return { mode: 'shell', explicit: true, command: cmd, reason: 'explicit ! shell prefix', requiresConfirmation: false };
  }

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

  // Shell operators: pipes, redirections, logical chaining, subshells
  if (/[|><;]|&&|\|\|/.test(trimmed)) {
    return { mode: 'shell', explicit: false, command: trimmed, reason: 'contains shell pipeline/redirection/chaining operator', requiresConfirmation: false };
  }

  // Path invocation or home-relative path
  if (/^(\.\/|\.\.\/|\/|~\/)/.test(trimmed)) {
    return { mode: 'shell', explicit: false, command: trimmed, reason: 'path-prefixed executable', requiresConfirmation: false };
  }

  // Leading ENV=val assignment
  if (/^[A-Za-z_][A-Za-z0-9_]*=\S*/.test(trimmed)) {
    return { mode: 'shell', explicit: false, command: trimmed, reason: 'environment assignment syntax', requiresConfirmation: false };
  }

  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0] ?? '';
  const secondToken = (tokens[1] ?? '').toLowerCase();
  const ENGLISH_VERB_COMMANDS = new Set(['find', 'make', 'open', 'kill', 'test', 'read', 'diff', 'which']);
  const NATURAL_LANGUAGE_FOLLOWERS = new Set(['the', 'a', 'an', 'me', 'my', 'all', 'why', 'how', 'out', 'if', 'whether', 'where', 'what', 'which']);

  if (ENGLISH_VERB_COMMANDS.has(firstToken) && NATURAL_LANGUAGE_FOLLOWERS.has(secondToken)) {
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

  return {
    mode: 'ai',
    explicit: false,
    command: trimmed,
    reason: 'natural-language instruction',
    requiresConfirmation: DESTRUCTIVE_AI_KEYWORDS.test(trimmed),
  };
}
