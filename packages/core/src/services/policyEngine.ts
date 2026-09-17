import path from 'node:path';
import { parse as parseShell } from 'shell-quote';
import type { ParseEntry } from 'shell-quote';
import type {
  PolicyActionRequest,
  PolicyDecision,
  PolicyEffect,
  PolicyEngineOptions,
  PolicyRule,
} from '../types/policy.js';
import type { Task } from '../types/task.js';

const SAFE_SHELL_COMMANDS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'which', 'whoami', 'uname', 'date', 'echo', 'printf', 'env', 'printenv',
  'ps', 'tree', 'rg', 'grep', 'find', 'sort', 'uniq', 'cut', 'column',
]);

const DENY_SHELL_COMMANDS = new Set([
  'sudo', 'su', 'mkfs', 'dd', 'fdisk', 'partprobe', 'shutdown', 'reboot',
  'halt', 'poweroff', 'iptables', 'ip6tables', 'mount', 'umount', 'kill',
  'killall', 'pkill', 'systemctl', 'launchctl', 'eval', 'exec',
]);

// Interpreters and package managers can run arbitrary code (node -e, npm scripts),
// so they are never auto-allowed.
const ASK_SHELL_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'chmod', 'chown', 'ln', 'touch', 'mkdir', 'rmdir',
  'git', 'docker', 'kubectl', 'brew', 'apt', 'apt-get', 'yum',
  'dnf', 'pacman', 'pip', 'pip3', 'gem', 'cargo', 'make', 'cmake',
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun',
]);

const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'sftp', 'ping',
  'traceroute', 'nslookup', 'dig', 'telnet',
]);

// Commands that execute their trailing arguments as another command.
const WRAPPER_COMMANDS = new Set(['env', 'nice', 'nohup', 'time', 'timeout', 'xargs', 'command', 'builtin', 'stdbuf', 'ionice']);

const COMMAND_BOUNDARY_OPS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')', '<(']);
const REDIRECT_OPS = new Set(['>', '>>', '>&', '<', '<&', '<<<']);

const EFFECT_RANK: Record<PolicyEffect, number> = { allow: 0, ask: 1, deny: 2 };

interface ShellSegment {
  words: string[];
  redirects: Array<{ op: string; target: string }>;
}

function basename(word: string): string {
  return word.split('/').pop() ?? word;
}

function isAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function stripAssignments(words: string[]): string[] {
  let i = 0;
  while (i < words.length && isAssignment(words[i])) i += 1;
  return words.slice(i);
}

/** Splits a parsed command line into independent simple commands. */
function splitSegments(entries: ParseEntry[]): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let current: ShellSegment = { words: [], redirects: [] };
  const flush = () => {
    if (current.words.length > 0 || current.redirects.length > 0) segments.push(current);
    current = { words: [], redirects: [] };
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry === 'string') {
      // `$` immediately before `(` is command substitution, not an argument
      if (entry !== '$') current.words.push(entry);
      continue;
    }
    if ('comment' in entry) continue;
    if (entry.op === 'glob') {
      current.words.push(entry.pattern);
      continue;
    }
    if (REDIRECT_OPS.has(entry.op)) {
      const next = entries[i + 1];
      const target = typeof next === 'string' ? next : '';
      if (typeof next === 'string') i += 1;
      current.redirects.push({ op: entry.op, target });
      continue;
    }
    if (COMMAND_BOUNDARY_OPS.has(entry.op)) {
      flush();
      continue;
    }
    flush();
  }
  flush();
  return segments;
}

/** Unwraps env/nice/xargs/... to find the command that will actually run. */
function resolveCommand(words: string[]): { name: string; args: string[] } {
  let rest = stripAssignments(words);
  for (let depth = 0; depth < 5 && rest.length > 0; depth++) {
    const name = basename(rest[0]);
    if (!WRAPPER_COMMANDS.has(name)) return { name, args: rest.slice(1) };
    let j = 1;
    while (j < rest.length && rest[j].startsWith('-')) j += 1;
    if (name === 'timeout') j += 1;
    const inner = stripAssignments(rest.slice(j));
    if (inner.length === 0) return { name, args: rest.slice(1) };
    rest = inner;
  }
  return rest.length > 0 ? { name: basename(rest[0]), args: rest.slice(1) } : { name: '', args: [] };
}

function mostRestrictive(decisions: PolicyDecision[]): PolicyDecision {
  let winner = decisions[0];
  for (const d of decisions) {
    if (EFFECT_RANK[d.decision] > EFFECT_RANK[winner.decision]) winner = d;
  }
  const reasons = Array.from(new Set(decisions.flatMap((d) => d.reasons)));
  return { decision: winner.decision, rule: winner.rule, reasons };
}

const GIT_ALLOW = new Set(['status', 'diff', 'log', 'show', 'branch', 'remote', 'ls-files', 'rev-parse', 'describe', 'config', 'shortlog', 'blame']);
const GIT_ASK = new Set(['add', 'commit', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'stash', 'reset', 'cherry-pick', 'tag', 'am']);
const GIT_DENY = new Set(['push', 'clean', 'gc', 'filter-branch', 'update-ref']);

const FILE_TOOLS_READ = new Set(['read', 'search', 'glob']);
const FILE_TOOLS_WRITE = new Set(['write', 'edit']);

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

export class PolicyEngine {
  readonly options: PolicyEngineOptions;
  readonly rules: PolicyRule[];

  constructor(options: PolicyEngineOptions) {
    this.options = options;
    this.rules = this.buildRules();
  }

  private buildRules(): PolicyRule[] {
    const rules: PolicyRule[] = [
      { id: 'unknown-tool', description: 'Tools that are not registered are denied', effect: 'deny' },
      { id: 'mcp-explicit-approval', description: 'MCP servers require explicit approval in policy', effect: 'deny' },
      { id: 'filesystem-project-allow', description: 'Filesystem access inside the project root is allowed', effect: 'allow' },
      { id: 'filesystem-outside-deny', description: 'Filesystem access outside the project root is denied', effect: 'deny' },
      { id: 'network-default-deny', description: 'Network commands are denied unless networkAccess is enabled', effect: 'deny' },
      { id: 'shell-safe-allow', description: `Read-only commands are allowed; every sub-command, pipe and substitution must qualify (${[...SAFE_SHELL_COMMANDS].join(', ')})`, effect: 'allow' },
      { id: 'shell-dangerous-deny', description: `System-level destructive commands are denied (${[...DENY_SHELL_COMMANDS].join(', ')})`, effect: 'deny' },
      { id: 'shell-unknown-ask', description: 'Interpreters, package managers and other shell commands require approval (deny when non-interactive)', effect: 'ask' },
      { id: 'git-read-allow', description: `Read-only git commands are allowed (${[...GIT_ALLOW].join(', ')})`, effect: 'allow' },
      { id: 'git-write-ask', description: `Local git write commands require approval (${[...GIT_ASK].join(', ')})`, effect: 'ask' },
      { id: 'git-push-deny', description: `Publishing git commands are denied by default (${[...GIT_DENY].join(', ')})`, effect: 'deny' },
      { id: 'project-checks-allow', description: 'test / lint / typecheck / build run inside the project', effect: 'allow' },
    ];
    return rules;
  }

  /** Task-level evaluation (before scheduling). */
  evaluateTask(task: Task): { allowed: boolean; reasons: string[] } {
    const reasons: string[] = [];
    let allowed = true;

    const policy = task.policy;

    if (policy?.toolAccess === false && task.requirements.toolCalling) {
      allowed = false;
      reasons.push('policy disables tool access but the task requires tool calling');
    }

    if (policy?.maxExecutionTimeSeconds !== undefined && policy.maxExecutionTimeSeconds <= 0) {
      allowed = false;
      reasons.push('policy maxExecutionTimeSeconds must be positive');
    }

    if (policy?.localOnly) {
      reasons.push('local-only policy: scheduler will restrict to local computers');
    }

    if (policy?.networkAccess === false) {
      reasons.push('network access disabled by policy');
    }

    return { allowed, reasons };
  }

  /**
   * Action-level authorization. Agents and models can never bypass this:
   * every tool call is checked here before it executes.
   */
  async authorize(request: PolicyActionRequest): Promise<PolicyDecision> {
    const decision = this.classify(request);
    return this.resolveAsk(request, decision);
  }

  private async resolveAsk(request: PolicyActionRequest, decision: PolicyDecision): Promise<PolicyDecision> {
    if (decision.decision !== 'ask') {
      return decision;
    }

    const approver = this.options.approveCallback;
    if (!approver) {
      return {
        ...decision,
        decision: 'deny',
        rule: `${decision.rule}+escalated-from-ask`,
        reasons: [...decision.reasons, 'approval required but no interactive approver is available; denying (never silently allowed)'],
      };
    }

    try {
      const approved = await approver(request, decision);
      if (approved) {
        return {
          ...decision,
          decision: 'allow',
          rule: `${decision.rule}+user-approved`,
          reasons: [...decision.reasons, 'approved by user'],
        };
      }
      return {
        ...decision,
        decision: 'deny',
        rule: decision.rule,
        reasons: [...decision.reasons, 'denied by user'],
      };
    } catch {
      return {
        ...decision,
        decision: 'deny',
        rule: decision.rule,
        reasons: [...decision.reasons, 'approval callback failed; denying'],
      };
    }
  }

  classify(request: PolicyActionRequest): PolicyDecision {
    const decision = this.doClassify(request);
    decision.tool = request.tool;
    return decision;
  }

  private doClassify(request: PolicyActionRequest): PolicyDecision {
    const tool = request.tool;
    const projectRoot = request.projectRoot ?? this.options.projectRoot;
    const lower = tool.toLowerCase();

    // 1. MCP — explicit approval only
    if (lower.startsWith('mcp:')) {
      const server = tool.slice(4).split(':')[0];
      const allowed = this.options.allowedMcpServers ?? [];
      if (allowed.includes(server)) {
        return { decision: 'allow', rule: 'mcp-explicit-approval', reasons: [`MCP server '${server}' is explicitly approved`] };
      }
      return {
        decision: 'deny',
        rule: 'mcp-explicit-approval',
        reasons: [`MCP server '${server}' is not in the allowed MCP list (explicit approval required)`],
      };
    }

    // 2. Project-scoped checks
    if (['test', 'lint', 'typecheck', 'build'].includes(lower)) {
      return {
        decision: 'allow',
        rule: 'project-checks-allow',
        reasons: [`'${tool}' runs inside the project root`],
      };
    }

    // 3. Filesystem tools — path containment
    if (FILE_TOOLS_READ.has(lower) || FILE_TOOLS_WRITE.has(lower)) {
      const rawPath = typeof request.input.path === 'string'
        ? request.input.path
        : typeof request.input.file === 'string'
          ? request.input.file
          : undefined;
      if (!rawPath) {
        return { decision: 'deny', rule: 'filesystem-outside-deny', reasons: [`tool '${tool}' requires a path argument`] };
      }
      // A relative rawPath must resolve against the project root, not the
      // process's cwd (path.resolve(rawPath) alone would use cwd) — those
      // only coincide when the CLI happens to be invoked from projectRoot.
      if (isInside(projectRoot, path.resolve(projectRoot, rawPath))) {
        return {
          decision: 'allow',
          rule: 'filesystem-project-allow',
          reasons: [`${FILE_TOOLS_WRITE.has(lower) ? 'write' : 'read'} path is inside project root`],
        };
      }
      return {
        decision: 'deny',
        rule: 'filesystem-outside-deny',
        reasons: [`path '${rawPath}' is outside project root '${projectRoot}'`],
      };
    }

    // 4. git — verb classification
    if (lower === 'git') {
      return this.classifyGit(request);
    }

    // 5. shell — command classification
    if (lower === 'shell') {
      return this.classifyShell(request);
    }

    // 6. Unknown tools
    return {
      decision: 'deny',
      rule: 'unknown-tool',
      reasons: [`tool '${tool}' is not registered; unknown tools are denied by default`],
    };
  }

  private classifyGit(request: PolicyActionRequest): PolicyDecision {
    const args = Array.isArray(request.input.args)
      ? (request.input.args as unknown[]).map((a) => String(a))
      : [];
    const verb = args.find((a) => !a.startsWith('-')) ?? '';

    if (verb === 'reset' && args.includes('--hard')) {
      return { decision: 'deny', rule: 'git-push-deny', reasons: ['git reset --hard is destructive and denied'] };
    }

    if (GIT_ALLOW.has(verb)) {
      return { decision: 'allow', rule: 'git-read-allow', reasons: [`git ${verb} is a read-only command`] };
    }
    if (GIT_DENY.has(verb)) {
      return {
        decision: 'deny',
        rule: 'git-push-deny',
        reasons: [`git ${verb} is denied by default policy (publishing/destructive)`],
      };
    }
    if (GIT_ASK.has(verb)) {
      return {
        decision: 'ask',
        rule: 'git-write-ask',
        reasons: [`git ${verb} modifies local state and requires approval`],
      };
    }

    return { decision: 'ask', rule: 'git-write-ask', reasons: [`git ${verb || '(unknown)'} requires approval`] };
  }

  private classifyShell(request: PolicyActionRequest): PolicyDecision {
    const command = typeof request.input.command === 'string' ? request.input.command.trim() : '';
    if (!command) {
      return { decision: 'deny', rule: 'shell-unknown-ask', reasons: ['empty shell command'] };
    }

    // shell-quote does not understand backtick substitution; rewrite it to $(...) so it is inspected too.
    const normalized = command.replace(/`([^`]*)`/g, '$($1)');

    let entries: ParseEntry[];
    try {
      entries = parseShell(normalized);
    } catch (error) {
      return {
        decision: 'deny',
        rule: 'shell-unknown-ask',
        reasons: [`shell command could not be parsed: ${error instanceof Error ? error.message : String(error)}`],
      };
    }

    const segments = splitSegments(entries);
    if (segments.length === 0) {
      return { decision: 'deny', rule: 'shell-unknown-ask', reasons: ['shell command contains no executable command'] };
    }

    const projectRoot = request.projectRoot ?? this.options.projectRoot;
    const decisions: PolicyDecision[] = [];
    for (const segment of segments) {
      decisions.push(...this.classifyShellSegment(segment, projectRoot));
    }

    const merged = mostRestrictive(decisions);
    if (segments.length > 1) {
      merged.reasons.unshift(`command line contains ${segments.length} sub-commands; each was classified and the most restrictive decision applies`);
    }
    return merged;
  }

  private classifyShellSegment(segment: ShellSegment, projectRoot: string): PolicyDecision[] {
    const decisions: PolicyDecision[] = [];
    const text = segment.words.join(' ');

    for (const redirect of segment.redirects) {
      const decision = this.classifyRedirect(redirect, projectRoot);
      if (decision) decisions.push(decision);
    }

    if (segment.words.length === 0) {
      return decisions;
    }

    if (this.options.denyCommands?.some((d) => text.startsWith(d))) {
      decisions.push({ decision: 'deny', rule: 'shell-dangerous-deny', reasons: [`command matches operator deny list: ${text}`] });
      return decisions;
    }
    if (this.options.allowCommands?.some((a) => text.startsWith(a))) {
      decisions.push({ decision: 'allow', rule: 'shell-safe-allow', reasons: [`command matches operator allow list: ${text}`] });
      return decisions;
    }

    const { name, args } = resolveCommand(segment.words);
    decisions.push(this.classifyCommandName(name));

    if (name === 'find') {
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-delete') {
          decisions.push({ decision: 'ask', rule: 'shell-unknown-ask', reasons: ['find -delete removes files and requires approval'] });
        }
        if (/^-(exec|execdir|ok|okdir)$/.test(args[i]) && args[i + 1]) {
          decisions.push(this.classifyCommandName(basename(args[i + 1])));
        }
      }
    }

    return decisions;
  }

  private classifyRedirect(redirect: { op: string; target: string }, projectRoot: string): PolicyDecision | null {
    if (redirect.op === '<' || redirect.op === '<&' || redirect.op === '<<<') return null;
    if (redirect.op === '>&' && /^\d+$/.test(redirect.target)) return null;
    if (!redirect.target) {
      return { decision: 'ask', rule: 'shell-unknown-ask', reasons: ['output redirection with an undetermined target requires approval'] };
    }
    if (redirect.target === '/dev/null') return null;
    if (isInside(projectRoot, path.resolve(projectRoot, redirect.target))) return null;
    return {
      decision: 'deny',
      rule: 'filesystem-outside-deny',
      reasons: [`output redirection to '${redirect.target}' is outside project root '${projectRoot}'`],
    };
  }

  private classifyCommandName(cmd: string): PolicyDecision {
    if (!cmd) {
      return { decision: 'ask', rule: 'shell-unknown-ask', reasons: ['could not determine the command to execute; approval required'] };
    }

    if (NETWORK_COMMANDS.has(cmd)) {
      if (this.options.networkAllowed) {
        return { decision: 'allow', rule: 'network-default-deny', reasons: [`network command '${cmd}' allowed because networkAccess is enabled`] };
      }
      return {
        decision: 'deny',
        rule: 'network-default-deny',
        reasons: [`network command '${cmd}' is denied: network access is disabled by default policy`],
      };
    }

    if (DENY_SHELL_COMMANDS.has(cmd)) {
      return { decision: 'deny', rule: 'shell-dangerous-deny', reasons: [`'${cmd}' is a dangerous command and denied by policy`] };
    }

    if (SAFE_SHELL_COMMANDS.has(cmd)) {
      return { decision: 'allow', rule: 'shell-safe-allow', reasons: [`'${cmd}' is on the safe command list`] };
    }

    if (ASK_SHELL_COMMANDS.has(cmd)) {
      return { decision: 'ask', rule: 'shell-unknown-ask', reasons: [`'${cmd}' is a state-modifying command and requires approval`] };
    }

    return { decision: 'ask', rule: 'shell-unknown-ask', reasons: [`'${cmd}' is not on the safe command list and requires approval`] };
  }
}

export function createPolicyEngine(options: PolicyEngineOptions): PolicyEngine {
  return new PolicyEngine(options);
}
