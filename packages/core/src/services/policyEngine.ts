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
import { appendAuditEvent } from '@wazir/shared';

// `env`/`printenv` are deliberately absent: they dump the operator's whole
// environment (API keys, database URLs) into an execution record that is
// persisted and can be shipped to a control plane (security review F-13).
const SAFE_SHELL_COMMANDS = new Set([
  'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'which', 'whoami', 'uname', 'date', 'echo', 'printf',
  'ps', 'tree', 'rg', 'grep', 'find', 'sort', 'uniq', 'cut', 'column',
  // Compilers: unlike interpreters/package managers (ASK_SHELL_COMMANDS), a plain
  // compile invocation doesn't execute arbitrary model-supplied code — it only turns
  // source into an artifact. That artifact's own execution (`./a.out`, `java Foo`) is a
  // separate, still-ask-gated command. Without these, every single compile step in a
  // coding task requires a human to click Approve, which made basic "write and compile
  // a program" workflows unusable unattended. Their output path is still containment-
  // checked below (OUTPUT_FLAGS) exactly like sort/tree's `-o`, so this doesn't allow
  // writing outside the project.
  'gcc', 'g++', 'cc', 'c++', 'clang', 'clang++', 'rustc', 'javac',
]);

// Safe commands that open the files named by their arguments. Their path
// arguments get the same project containment as the `read` tool, otherwise
// `cat /etc/passwd` is a zero-approval host read (F-5).
const PATH_READING_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df',
  'tree', 'rg', 'grep', 'find', 'sort', 'uniq', 'cut', 'column',
]);

// Flags that make an otherwise read-only binary execute another program.
// Matched exactly or as `flag=value` (F-6).
const EXEC_FLAGS: Record<string, string[]> = {
  rg: ['--pre', '--hostname-bin'],
  sort: ['--compress-program'],
  find: ['-exec', '-execdir', '-ok', '-okdir'],
};

// Flags that write to the file named by their value; the value must stay
// inside the project like a `>` redirect would (F-8).
const OUTPUT_FLAGS: Record<string, string[]> = {
  sort: ['-o', '--output', '-T', '--temporary-directory'],
  find: ['-fprint', '-fprint0', '-fprintf', '-fls'],
  tree: ['-o'],
  gcc: ['-o'],
  'g++': ['-o'],
  cc: ['-o'],
  'c++': ['-o'],
  clang: ['-o'],
  'clang++': ['-o'],
  rustc: ['-o', '--out-dir'],
  javac: ['-d'],
};

// Native compilers whose output is a directly-executable file (unlike javac, whose
// output is run via `java <ClassName>`, not `./<path>` — so it's excluded here even
// though it's in SAFE_SHELL_COMMANDS/OUTPUT_FLAGS for the compile step itself). Used to
// track "this task just compiled this exact binary" so a later attempt to run it can be
// auto-approved too — see trackCompiledOutput/isTrackedCompiledOutput.
const NATIVE_COMPILER_COMMANDS = new Set(['gcc', 'g++', 'cc', 'c++', 'clang', 'clang++', 'rustc']);

// Per-execution memory of binaries an already-approved compile step just produced, so
// running one to verify it works isn't a second, unrelated "arbitrary command" decision
// — it's the natural next step of a compile we already scrutinized. Capped so a very
// long-running session can't grow this unboundedly.
const MAX_TRACKED_EXECUTIONS = 200;

// Flags whose following argument is a value that is *not* a path (a pattern,
// a count, a delimiter) and must not be containment-checked.
const NON_PATH_VALUE_FLAGS: Record<string, string[]> = {
  grep: ['-e', '--regexp', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '--include', '--exclude', '--exclude-dir', '--label', '-d', '-D'],
  rg: ['-e', '--regexp', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '--type-add', '-m', '--max-count', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-M', '--max-columns', '-j', '--threads', '--max-depth', '--max-filesize', '--color', '--colors', '--sort', '--sortr', '-r', '--replace', '--context-separator', '--field-context-separator', '--field-match-separator', '--path-separator', '--dfa-size-limit', '--regex-size-limit', '--engine'],
  find: ['-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-wholename', '-iwholename', '-lname', '-ilname', '-maxdepth', '-mindepth', '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-size', '-type', '-user', '-group', '-perm', '-printf', '-newermt', '-newerat', '-newerct', '-links', '-inum', '-uid', '-gid', '-regextype', '-fstype', '-used', '-xtype', '-context'],
  cut: ['-d', '--delimiter', '-f', '--fields', '-c', '--characters', '-b', '--bytes', '--output-delimiter'],
  head: ['-n', '-c', '--lines', '--bytes'],
  tail: ['-n', '-c', '--lines', '--bytes', '-s', '--sleep-interval', '--pid'],
  sort: ['-k', '--key', '-t', '--field-separator', '-S', '--buffer-size', '--parallel'],
  uniq: ['-f', '--skip-fields', '-s', '--skip-chars', '-w', '--check-chars'],
  column: ['-s', '-c', '-o', '-N', '-R', '-T', '-H', '-W', '-E', '-l', '-O'],
  ls: ['-w', '--width', '-I', '--ignore', '--hide', '--time-style', '--format', '--color', '--sort', '--time', '--indicator-style', '--quoting-style', '-T', '--tabsize', '--block-size'],
  tree: ['-L', '-P', '-I', '-H', '-T', '--charset', '--filelimit', '--timefmt', '--sort'],
  du: ['-d', '--max-depth', '-B', '--block-size', '-t', '--threshold', '--exclude', '--time-style'],
  df: ['-B', '--block-size', '-t', '--type', '-x', '--exclude-type', '--output'],
  stat: ['-c', '--format', '--printf'],
  wc: [],
  file: ['-e', '--exclude', '-m', '--magic-file', '-F', '--separator', '-P', '--parameter'],
};

// Commands whose first positional argument is a pattern rather than a file.
const PATTERN_FIRST_COMMANDS = new Set(['grep', 'rg']);

// Paths a write to which can change what runs on the operator's machine
// (git hooks, Wazir's own state, npm scripts and lifecycle hooks, package
// resolution). Still project-local, but a model may not touch them without
// a human seeing it (F-10, F-11).
const PROTECTED_DIRS = new Set(['.git', '.wazir', '.rook', '.husky', '.githooks', 'node_modules', '.github']);
const PROTECTED_FILES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'pnpm-workspace.yaml', '.envrc',
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

const WRAPPER_VALUE_FLAGS = new Set(['-n', '--adjustment', '-c', '--class', '-p', '-s', '--signal', '-k', '--kill-after', '-o', '-e', '-i', '-P', '--max-procs', '-L', '-I', '-d', '--delimiter', '-a', '--arg-file']);

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
    while (j < rest.length && rest[j].startsWith('-')) {
      // `nice -n 5`, `ionice -c 2 -n 7`, `timeout -s KILL`: the value is a separate word.
      if (WRAPPER_VALUE_FLAGS.has(rest[j])) j += 1;
      j += 1;
    }
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

// Verbs that only read repository state. `branch`, `remote` and `config`
// are read-only for some argument shapes and writes for others, so they are
// classified by `classifyGitConditionalVerb` instead of appearing here (F-7).
const GIT_ALLOW = new Set([
  'status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'blame',
  'cat-file', 'rev-list', 'for-each-ref', 'show-ref', 'diff-tree', 'diff-files', 'diff-index', 'name-rev',
  'count-objects', 'check-ignore', 'check-attr', 'merge-base', 'ls-remote', 'reflog', 'var', 'version', 'help',
]);
const GIT_CONDITIONAL = new Set(['branch', 'remote', 'config']);
const GIT_ASK = new Set(['add', 'commit', 'checkout', 'switch', 'restore', 'merge', 'rebase', 'stash', 'reset', 'cherry-pick', 'tag', 'am']);
const GIT_DENY = new Set(['push', 'clean', 'gc', 'filter-branch', 'update-ref']);

// Global options (before the verb) that redirect git at another repository,
// inject configuration (`-c core.fsmonitor=...` runs a command on `status`)
// or change which binaries git executes.
const GIT_GLOBAL_DENY_FLAGS = ['-c', '-C', '--git-dir', '--work-tree', '--exec-path', '--namespace', '--config-env', '--super-prefix', '--bare'];
// Options on read verbs that write a file or run an external program.
// `--no-index` turns `git diff` into a host-wide file reader; `help -w`
// launches a browser via xdg-open (second-pass S-3/S-5).
const GIT_READ_VERB_DENY_FLAGS = ['--output', '--ext-diff', '--textconv', '--exec', '--no-index', '--web', '-w', '--open-files-in-pager', '-O'];
// Read-only verbs that contact a remote: allowed only when network access is on (S-4).
const GIT_NETWORK_READ_VERBS = new Set(['ls-remote']);
// Options that turn `branch`/`remote`/`config` into writes.
const GIT_BRANCH_READ_FLAGS = new Set(['-a', '-r', '-v', '-vv', '-l', '--list', '--all', '--remotes', '--verbose', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--color', '--no-color', '--column', '--no-column', '-i', '--ignore-case', '--abbrev', '--no-abbrev']);
const GIT_REMOTE_READ_SUBCOMMANDS = new Set(['show', 'get-url']);
const GIT_CONFIG_GET_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope', '--type', '--bool', '--int', '--path', '--null', '-z', '--name-only', '--global', '--system', '--local', '--worktree', '--includes', '--no-includes', '--default']);
const GIT_CONFIG_WRITE_FLAGS = ['--edit', '-e', '--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '--file', '-f', '--blob'];

const FILE_TOOLS_READ = new Set(['read', 'search', 'glob']);
const FILE_TOOLS_WRITE = new Set(['write', 'edit']);

function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

/**
 * Why a project-local path is protected (git internals, Wazir state, npm
 * manifests/lockfiles...), or null when it is an ordinary project file.
 * Callers pass an absolute path already known to be inside `projectRoot`.
 */
export function protectedPathReason(projectRoot: string, absolute: string): string | null {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(absolute));
  if (!relative || relative.startsWith('..')) return null;
  const segments = relative.split(path.sep);
  if (PROTECTED_DIRS.has(segments[0])) {
    return `'${segments[0]}/' holds hooks, tooling or Wazir state that can change what runs on this machine`;
  }
  const base = segments[segments.length - 1];
  if (PROTECTED_FILES.has(base)) {
    return `'${base}' controls package scripts, lifecycle hooks or dependency resolution`;
  }
  return null;
}

function flagMatches(arg: string, flag: string): boolean {
  return arg === flag || arg.startsWith(`${flag}=`);
}

/** The value carried by `--flag=value` / `-fvalue`, if any. */
function attachedValue(arg: string, flag: string): string | undefined {
  if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  if (!flag.startsWith('--') && flag.length === 2 && arg.length > 2 && arg.startsWith(flag)) return arg.slice(2);
  return undefined;
}

export class PolicyEngine {
  readonly options: PolicyEngineOptions;
  readonly rules: PolicyRule[];
  private readonly compiledOutputsByExecution = new Map<string, Set<string>>();

  constructor(options: PolicyEngineOptions) {
    this.options = options;
    this.rules = this.buildRules();
  }

  private trackCompiledOutput(executionId: string | undefined, absolutePath: string): void {
    if (!executionId) return;
    let set = this.compiledOutputsByExecution.get(executionId);
    if (!set) {
      if (this.compiledOutputsByExecution.size >= MAX_TRACKED_EXECUTIONS) {
        const oldest = this.compiledOutputsByExecution.keys().next().value;
        if (oldest !== undefined) this.compiledOutputsByExecution.delete(oldest);
      }
      set = new Set();
      this.compiledOutputsByExecution.set(executionId, set);
    }
    set.add(absolutePath);
  }

  private isTrackedCompiledOutput(executionId: string | undefined, absolutePath: string): boolean {
    if (!executionId) return false;
    return this.compiledOutputsByExecution.get(executionId)?.has(absolutePath) ?? false;
  }

  private buildRules(): PolicyRule[] {
    const rules: PolicyRule[] = [
      { id: 'unknown-tool', description: 'Tools that are not registered are denied', effect: 'deny' },
      { id: 'mcp-explicit-approval', description: 'MCP servers require explicit approval in policy', effect: 'deny' },
      { id: 'filesystem-project-allow', description: 'Filesystem access inside the project root is allowed', effect: 'allow' },
      { id: 'filesystem-outside-deny', description: 'Filesystem access outside the project root is denied', effect: 'deny' },
      { id: 'filesystem-protected-ask', description: `Writes to protected project paths require approval (${[...PROTECTED_DIRS].map((d) => `${d}/`).join(', ')}, ${[...PROTECTED_FILES].join(', ')})`, effect: 'ask' },
      { id: 'network-default-deny', description: 'Network commands are denied unless networkAccess is enabled', effect: 'deny' },
      { id: 'shell-safe-allow', description: `Read-only commands are allowed; every sub-command, pipe and substitution must qualify (${[...SAFE_SHELL_COMMANDS].join(', ')})`, effect: 'allow' },
      { id: 'shell-dangerous-deny', description: `System-level destructive commands are denied (${[...DENY_SHELL_COMMANDS].join(', ')})`, effect: 'deny' },
      { id: 'shell-unknown-ask', description: 'Interpreters, package managers and other shell commands require approval (deny when non-interactive)', effect: 'ask' },
      { id: 'git-read-allow', description: `Read-only git commands are allowed (${[...GIT_ALLOW].join(', ')})`, effect: 'allow' },
      { id: 'git-write-ask', description: `Local git write commands require approval (${[...GIT_ASK].join(', ')})`, effect: 'ask' },
      { id: 'shell-compiled-binary-allow', description: 'Binaries compiled by this task via approved steps are allowed', effect: 'allow' },
      { id: 'shell-workspace-artifact-allow', description: 'Executable artifacts inside the isolated project workspace are allowed', effect: 'allow' },
      { id: 'shell-workspace-artifact-ask', description: 'Executable artifacts in protected project paths require approval', effect: 'ask' },
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

    // The queue is only useful when something is subscribed to answer it (the
    // fleet TUI). A plain `wa run` in a terminal has no subscriber, so route
    // the question to the interactive approver instead of parking it forever.
    const queue = this.options.approvalQueue;
    const useQueue = queue && (queue.hasSubscribers === undefined || queue.hasSubscribers || !this.options.approveCallback);
    if (queue && useQueue) {
      try {
        const approved = await queue.enqueue(request, decision);
        if (approved) {
          return {
            ...decision,
            decision: 'allow',
            rule: `${decision.rule}+user-approved`,
            reasons: [...decision.reasons, 'approved by user via approval queue'],
          };
        }
        return {
          ...decision,
          decision: 'deny',
          rule: decision.rule,
          reasons: [...decision.reasons, 'denied by user via approval queue'],
        };
      } catch {
        return {
          ...decision,
          decision: 'deny',
          rule: decision.rule,
          reasons: [...decision.reasons, 'approval queue resolution failed; denying'],
        };
      }
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
      void appendAuditEvent({
        type: 'approval_resolution',
        tool: request.tool,
        decision: approved ? 'allow' : 'deny',
        rule: decision.rule,
        reasons: decision.reasons,
        executionId: request.executionId,
        resolvedBy: 'interactive_approver',
        details: { input: request.input },
      }).catch(() => {});
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

  /**
   * Explains how a shell command would be classified by policy without executing it.
   * Useful for operators inspecting policy rules and command security.
   */
  explainCommand(command: string, projectRoot?: string): PolicyDecision {
    const root = projectRoot ?? this.options.projectRoot;
    const request: PolicyActionRequest = {
      tool: 'shell',
      input: { command },
      projectRoot: root,
    };
    const decision = this.classify(request);
    decision.command = command;
    return decision;
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
      // `mcp:<server>` or `mcp:<server>:<tool>`. An allow-list entry is either a
      // bare server name (every tool on it) or `server:tool` (that tool only), so
      // an operator can expose one tool of a server without the rest (F-25).
      const [server, ...toolParts] = tool.slice(4).split(':');
      const toolName = toolParts.join(':');
      const allowed = this.options.allowedMcpServers ?? [];
      if (allowed.includes(server) || allowed.includes(`${server}:*`)) {
        return { decision: 'allow', rule: 'mcp-explicit-approval', reasons: [`MCP server '${server}' is explicitly approved for all tools`] };
      }
      if (toolName && allowed.includes(`${server}:${toolName}`)) {
        return { decision: 'allow', rule: 'mcp-explicit-approval', reasons: [`MCP tool '${server}:${toolName}' is explicitly approved`] };
      }
      return {
        decision: 'deny',
        rule: 'mcp-explicit-approval',
        reasons: [`MCP ${toolName ? `tool '${server}:${toolName}'` : `server '${server}'`} is not in the allowed MCP list (explicit approval required)`],
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
        // glob/search document `path` as optional, defaulting to the project
        // root — but this check used to deny both of them outright whenever
        // the model (correctly, per their own schema) omitted it, with a
        // message ("requires a path argument") that flatly contradicts what
        // the tool told the model. `read` has no such default (there's no
        // sensible "read the project root" as a single file), so it still
        // requires an explicit path.
        if (lower === 'glob' || lower === 'search') {
          return { decision: 'allow', rule: 'filesystem-project-root-allow', reasons: [`'${tool}' with no path defaults to the project root`] };
        }
        return { decision: 'deny', rule: 'filesystem-outside-deny', reasons: [`tool '${tool}' requires a path argument`] };
      }
      // A relative rawPath must resolve against the project root, not the
      // process's cwd (path.resolve(rawPath) alone would use cwd) — those
      // only coincide when the CLI happens to be invoked from projectRoot.
      const absolute = path.resolve(projectRoot, rawPath);
      if (isInside(projectRoot, absolute)) {
        if (FILE_TOOLS_WRITE.has(lower)) {
          const protectedReason = protectedPathReason(projectRoot, absolute);
          if (protectedReason) {
            return { decision: 'ask', rule: 'filesystem-protected-ask', reasons: [`write to protected path '${rawPath}': ${protectedReason}`] };
          }
        }
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
    if (args.some((a) => /[\r\n]/.test(a))) {
      return { decision: 'deny', rule: 'git-push-deny', reasons: ['git arguments may not contain line breaks'] };
    }
    const verbIndex = args.findIndex((a) => !a.startsWith('-'));
    const verb = verbIndex === -1 ? '' : args[verbIndex];
    const globalOptions = verbIndex === -1 ? args : args.slice(0, verbIndex);
    const verbArgs = verbIndex === -1 ? [] : args.slice(verbIndex + 1);

    // Global options come before the verb and can point git at another
    // repository or inject config that executes commands (`-c core.fsmonitor`,
    // `-c alias.status=!sh`), so a "read-only" verb is no longer read-only.
    for (const option of globalOptions) {
      if (GIT_GLOBAL_DENY_FLAGS.some((flag) => flagMatches(option, flag))) {
        return { decision: 'deny', rule: 'git-push-deny', reasons: [`git global option '${option}' can redirect git or inject executable configuration; denied`] };
      }
    }

    if (verb === 'reset' && args.includes('--hard')) {
      return { decision: 'deny', rule: 'git-push-deny', reasons: ['git reset --hard is destructive and denied'] };
    }

    if (GIT_ALLOW.has(verb) || GIT_CONDITIONAL.has(verb)) {
      for (const arg of verbArgs) {
        if (GIT_READ_VERB_DENY_FLAGS.some((flag) => flagMatches(arg, flag))) {
          return { decision: 'deny', rule: 'git-push-deny', reasons: [`git ${verb} ${arg} writes a file or runs an external program; denied`] };
        }
      }
    }

    if (GIT_NETWORK_READ_VERBS.has(verb) && !this.options.networkAllowed) {
      return { decision: 'deny', rule: 'network-default-deny', reasons: [`git ${verb} contacts a remote and network access is disabled by default policy`] };
    }
    if (GIT_ALLOW.has(verb)) {
      return { decision: 'allow', rule: 'git-read-allow', reasons: [`git ${verb} is a read-only command`] };
    }
    if (GIT_CONDITIONAL.has(verb)) {
      return this.classifyGitConditionalVerb(verb, verbArgs);
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

  /** `branch` / `remote` / `config` are reads only for specific argument shapes. */
  private classifyGitConditionalVerb(verb: string, verbArgs: string[]): PolicyDecision {
    const ask = (why: string): PolicyDecision => ({ decision: 'ask', rule: 'git-write-ask', reasons: [`git ${verb} ${why}`] });
    const flags = verbArgs.filter((a) => a.startsWith('-'));
    const positionals = verbArgs.filter((a) => !a.startsWith('-'));

    if (verb === 'branch') {
      const unknownFlag = flags.find((f) => !GIT_BRANCH_READ_FLAGS.has(f.split('=')[0]));
      if (unknownFlag) return ask(`with '${unknownFlag}' modifies branches and requires approval`);
      const listing = flags.some((f) => ['--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--show-current', '-a', '-r', '--all', '--remotes'].includes(f.split('=')[0]));
      if (positionals.length > 0 && !listing) return ask(`'${positionals[0]}' creates a branch and requires approval`);
      return { decision: 'allow', rule: 'git-read-allow', reasons: ['git branch (listing form) is read-only'] };
    }

    if (verb === 'remote') {
      if (verbArgs.length === 0 || (positionals.length === 0 && flags.every((f) => f === '-v' || f === '--verbose'))) {
        return { decision: 'allow', rule: 'git-read-allow', reasons: ['git remote (listing form) is read-only'] };
      }
      if (GIT_REMOTE_READ_SUBCOMMANDS.has(positionals[0] ?? '') && !flags.some((f) => f === '--push' && positionals[0] !== 'get-url')) {
        return { decision: 'allow', rule: 'git-read-allow', reasons: [`git remote ${positionals[0]} is read-only`] };
      }
      return ask(`${positionals[0] ?? flags[0] ?? ''} modifies remotes and requires approval`);
    }

    // config
    if (flags.some((f) => GIT_CONFIG_WRITE_FLAGS.some((w) => flagMatches(f, w)))) {
      return ask('with a write/edit/file option modifies configuration and requires approval');
    }
    const reading = flags.some((f) => GIT_CONFIG_GET_FLAGS.has(f.split('=')[0]) && /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/.test(f.split('=')[0]));
    const unknownFlag = flags.find((f) => !GIT_CONFIG_GET_FLAGS.has(f.split('=')[0]));
    if (!reading || unknownFlag || positionals.length > 1) {
      return ask('sets a configuration value (hooks, aliases and fsmonitor can execute commands) and requires approval');
    }
    return { decision: 'allow', rule: 'git-read-allow', reasons: ['git config (get/list form) is read-only'] };
  }

  private classifyShell(request: PolicyActionRequest): PolicyDecision {
    const command = typeof request.input.command === 'string' ? request.input.command.trim() : '';
    if (!command) {
      return { decision: 'deny', rule: 'shell-unknown-ask', reasons: ['empty shell command'] };
    }

    // `sh -c` runs each line as its own command, but shell-quote treats a line
    // break as plain whitespace, so `ls\nrm -rf ~` would be classified as one
    // `ls` invocation (F-4). Multi-line command text is never auto-classified.
    if (/[\r\n]/.test(command)) {
      return { decision: 'deny', rule: 'shell-dangerous-deny', reasons: ['shell command contains a line break; chain commands with && or ; instead'] };
    }

    // shell-quote does not understand backtick substitution; rewrite it to $(...) so it is inspected too.
    let normalized = command.replace(/\\`([^`\\]+)\\`/g, '$($1)');
    normalized = normalized.replace(/`([^`]*)`/g, '$($1)');

    let entries: ParseEntry[];
    try {
      // Keep `$VAR` as a visible marker instead of expanding it to '' so a
      // path such as `$HOME/.ssh` is recognised as unverifiable rather than
      // silently becoming the project-relative `/.ssh`.
      entries = parseShell(normalized, (key: string) => `$${key}`);
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
      decisions.push(...this.classifyShellSegment(segment, projectRoot, request.executionId));
    }

    const merged = mostRestrictive(decisions);
    if (segments.length > 1) {
      merged.reasons.unshift(`command line contains ${segments.length} sub-commands; each was classified and the most restrictive decision applies`);
    }
    return merged;
  }

  private classifyShellSegment(segment: ShellSegment, projectRoot: string, executionId?: string): PolicyDecision[] {
    const decisions: PolicyDecision[] = [];
    const text = segment.words.join(' ');

    for (const redirect of segment.redirects) {
      const decision = this.classifyRedirect(redirect, projectRoot);
      if (decision) decisions.push(decision);
    }

    if (segment.words.length === 0) {
      return decisions;
    }

    // Inspect any command substitutions embedded inside quoted words (e.g. "outer $(reboot)")
    for (const word of segment.words) {
      const match = word.match(/\$\((.+)\)/);
      if (match) {
        decisions.push(this.classifyShell({ tool: 'shell', input: { command: match[1] }, projectRoot, executionId }));
      }
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

    // Running a binary this exact task already compiled via an already-approved compile
    // step isn't really "an arbitrary unknown command" — the source that produced it was
    // already scrutinized when the compile itself was allowed. Narrower than trusting any
    // executable: only ones this task's own compile output is tracked under (see
    // trackCompiledOutput), and only a bare `./path`/absolute-path invocation, not e.g.
    // `bash -c "$(cat ./hello)"` trying to launder it through another command.
    // resolveCommand() basenames its result (so `wrapper` unwrapping works uniformly),
    // which strips the very `./`/`/` prefix this check needs — read it off the raw word.
    const rawFirstWord = stripAssignments(segment.words)[0] ?? '';
    if ((rawFirstWord.startsWith('./') || rawFirstWord.startsWith('/')) && !rawFirstWord.includes('..')) {
      const absolute = path.resolve(projectRoot, rawFirstWord);
      if (this.isTrackedCompiledOutput(executionId, absolute)) {
        decisions.push({
          decision: 'allow',
          rule: 'shell-compiled-binary-allow',
          reasons: [`'${rawFirstWord}' is a binary this task already compiled via an approved compile step`],
        });
        return decisions;
      }
      if (this.options.allowWorkspaceArtifactExecution === true && isInside(projectRoot, absolute)) {
        const protectedReason = protectedPathReason(projectRoot, absolute);
        if (protectedReason) {
          decisions.push({
            decision: 'ask',
            rule: 'shell-workspace-artifact-ask',
            reasons: [`execution of workspace artifact in protected path '${rawFirstWord}': ${protectedReason}`],
          });
          return decisions;
        }
        decisions.push({
          decision: 'allow',
          rule: 'shell-workspace-artifact-allow',
          reasons: [`'${rawFirstWord}' is an executable artifact inside the isolated workspace`],
        });
        return decisions;
      }
    }

    decisions.push(this.classifyCommandName(name));
    if (SAFE_SHELL_COMMANDS.has(name)) {
      decisions.push(...this.classifySafeCommandArgs(name, args, projectRoot, executionId));
      // `echo /etc/passwd | xargs cat`: the paths xargs hands to `cat` come
      // from stdin, so nothing above could inspect them (second-pass S-2).
      const viaXargs = stripAssignments(segment.words).some((w, i) => i < segment.words.length - 1 && basename(w) === 'xargs');
      if (viaXargs && PATH_READING_COMMANDS.has(name)) {
        decisions.push({ decision: 'ask', rule: 'shell-unknown-ask', reasons: [`'${name}' via xargs receives its file arguments from stdin, which cannot be checked against the project root`] });
      }
    }

    return decisions;
  }

  /**
   * A binary on the safe list is only safe for its read-only argument shapes.
   * This checks the flags that make it execute a program or write a file, and
   * applies project containment to every path it would read.
   */
  private classifySafeCommandArgs(name: string, args: string[], projectRoot: string, executionId?: string): PolicyDecision[] {
    const decisions: PolicyDecision[] = [];
    const execFlags = EXEC_FLAGS[name] ?? [];
    const outputFlags = OUTPUT_FLAGS[name] ?? [];
    const valueFlags = NON_PATH_VALUE_FLAGS[name] ?? [];
    const pathValueFlags = ['--files0-from', '-f', '--file', ...(name === 'find' ? ['-newer', '-anewer', '-cnewer', '-samefile', '-newerBB', '-newermm', '-newerBm', '-newermB'] : [])];
    let positionalIndex = 0;
    const patternGiven = PATTERN_FIRST_COMMANDS.has(name) && args.some((a) => ['-e', '--regexp', '-f', '--file'].some((f) => flagMatches(a, f)));

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '--') {
        for (const rest of args.slice(i + 1)) decisions.push(...this.classifyReadPath(name, rest, projectRoot));
        break;
      }

      if (name === 'find' && arg === '-delete') {
        decisions.push({ decision: 'ask', rule: 'shell-unknown-ask', reasons: ['find -delete removes files and requires approval'] });
        continue;
      }

      const execFlag = execFlags.find((f) => flagMatches(arg, f));
      if (execFlag) {
        if (name === 'find' && args[i + 1]) {
          // `find -exec <cmd>` is as safe as <cmd> itself; the rest of the -exec
          // clause is that command's own arguments.
          decisions.push(this.classifyCommandName(basename(args[i + 1])));
          const end = args.indexOf(';', i + 1);
          i = end === -1 ? args.length : end;
          continue;
        }
        decisions.push({ decision: 'deny', rule: 'shell-dangerous-deny', reasons: [`'${name} ${execFlag}' executes an arbitrary program under a read-only command; denied`] });
        continue;
      }

      const outputFlag = outputFlags.find((f) => flagMatches(arg, f) || attachedValue(arg, f) !== undefined);
      if (outputFlag) {
        const target = attachedValue(arg, outputFlag) ?? args[++i] ?? '';
        const writeDecision = this.classifyWriteTarget(`${name} ${outputFlag}`, target, projectRoot);
        decisions.push(writeDecision);
        if (writeDecision.decision === 'allow' && NATIVE_COMPILER_COMMANDS.has(name) && target) {
          this.trackCompiledOutput(executionId, path.resolve(projectRoot, target));
        }
        continue;
      }

      if (arg.startsWith('-') && arg.length > 1) {
        // Flags whose value is a file the command reads (`grep -f FILE`,
        // `wc --files0-from=FILE`); `sort -f` is "fold case", not a file.
        const takesPath = pathValueFlags.includes(arg) && !(name === 'sort' && arg === '-f') && !(name === 'cut' && arg === '-f') && !(name === 'uniq' && arg === '-f');
        if (takesPath) {
          const target = args[++i];
          if (target !== undefined) decisions.push(...this.classifyReadPath(name, target, projectRoot));
          continue;
        }
        if (valueFlags.includes(arg)) {
          i += 1; // the next argument is this flag's non-path value
          continue;
        }
        const eq = arg.indexOf('=');
        if (eq > 0) {
          if (!valueFlags.includes(arg.slice(0, eq))) {
            decisions.push(...this.classifyReadPath(name, arg.slice(eq + 1), projectRoot));
          }
        } else if (!arg.startsWith('--') && !valueFlags.includes(arg.slice(0, 2))) {
          // `-f/etc/passwd`-style attached values: anything from the first
          // path character on is treated as a path.
          const pathStart = arg.search(/[/~]/);
          if (pathStart > 0) decisions.push(...this.classifyReadPath(name, arg.slice(pathStart), projectRoot));
        }
        continue;
      }

      if (PATTERN_FIRST_COMMANDS.has(name) && positionalIndex === 0 && !patternGiven) {
        positionalIndex += 1; // the pattern, not a file
        continue;
      }
      positionalIndex += 1;
      decisions.push(...this.classifyReadPath(name, arg, projectRoot));
    }
    return decisions;
  }

  /**
   * Containment check for a path a safe command would read. Only arguments
   * that can actually leave the project (absolute, `~`, or containing `..`)
   * are resolved; everything else is project-relative by construction.
   */
  private classifyReadPath(name: string, candidate: string, projectRoot: string): PolicyDecision[] {
    if (!PATH_READING_COMMANDS.has(name)) return [];
    if (!candidate || candidate === '-' || candidate === '/dev/null' || candidate.startsWith('/dev/std')) return [];
    if (candidate.includes('$')) {
      return [{ decision: 'ask', rule: 'shell-unknown-ask', reasons: [`'${name}' argument '${candidate}' depends on shell expansion and cannot be verified to stay inside the project`] }];
    }
    const mayEscape = candidate.startsWith('~') || candidate.startsWith('/') || candidate.split('/').includes('..');
    if (!mayEscape) return [];
    if (!candidate.startsWith('~') && isInside(projectRoot, path.resolve(projectRoot, candidate))) return [];
    return [{
      decision: 'deny',
      rule: 'filesystem-outside-deny',
      reasons: [`'${name}' would read '${candidate}', which is outside project root '${projectRoot}'`],
    }];
  }

  /** A file written by an output flag is held to the same rules as a `>` redirect. */
  private classifyWriteTarget(what: string, target: string, projectRoot: string): PolicyDecision {
    if (!target) {
      return { decision: 'ask', rule: 'shell-unknown-ask', reasons: [`'${what}' with an undetermined output target requires approval`] };
    }
    if (target === '/dev/null') return { decision: 'allow', rule: 'shell-safe-allow', reasons: [`'${what}' discards output`] };
    if (target.includes('$') || target.startsWith('~')) {
      return { decision: 'ask', rule: 'shell-unknown-ask', reasons: [`'${what} ${target}' output path cannot be verified to stay inside the project`] };
    }
    const absolute = path.resolve(projectRoot, target);
    if (!isInside(projectRoot, absolute)) {
      return { decision: 'deny', rule: 'filesystem-outside-deny', reasons: [`'${what} ${target}' writes outside project root '${projectRoot}'`] };
    }
    const protectedReason = protectedPathReason(projectRoot, absolute);
    if (protectedReason) {
      return { decision: 'ask', rule: 'filesystem-protected-ask', reasons: [`'${what} ${target}' writes a protected path: ${protectedReason}`] };
    }
    return { decision: 'allow', rule: 'shell-safe-allow', reasons: [`'${what} ${target}' writes inside the project`] };
  }

  private classifyRedirect(redirect: { op: string; target: string }, projectRoot: string): PolicyDecision | null {
    if (redirect.op === '<&' || redirect.op === '<<<') return null;
    if (redirect.op === '<') {
      // `cat < /etc/passwd` reads the file exactly like `cat /etc/passwd`
      // (second-pass review S-1): same containment as a path argument.
      if (!redirect.target) return { decision: 'ask', rule: 'shell-unknown-ask', reasons: ['input redirection with an undetermined source requires approval'] };
      return this.classifyReadPath('cat', redirect.target, projectRoot)[0] ?? null;
    }
    if (redirect.op === '>&' && /^\d+$/.test(redirect.target)) return null;
    if (!redirect.target) {
      return { decision: 'ask', rule: 'shell-unknown-ask', reasons: ['output redirection with an undetermined target requires approval'] };
    }
    if (redirect.target === '/dev/null') return null;
    if (redirect.target.includes('$') || redirect.target.startsWith('~')) {
      return { decision: 'ask', rule: 'shell-unknown-ask', reasons: [`output redirection to '${redirect.target}' depends on shell expansion and cannot be verified to stay inside the project`] };
    }
    const absolute = path.resolve(projectRoot, redirect.target);
    if (isInside(projectRoot, absolute)) {
      const protectedReason = protectedPathReason(projectRoot, absolute);
      if (protectedReason) {
        return { decision: 'ask', rule: 'filesystem-protected-ask', reasons: [`output redirection to protected path '${redirect.target}': ${protectedReason}`] };
      }
      return null;
    }
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
