import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { PolicyEngine, protectedPathReason } from '../src/index.js';

/**
 * Security review F-4..F-8, F-10, F-11, F-13, F-25: the `allow` tier must
 * not be reachable by the bypasses the assessment reproduced. Every case
 * here previously classified as `allow`.
 */
const projectRoot = path.resolve('/srv/project');
const engine = new PolicyEngine({ projectRoot });
const shell = (command: string) => engine.classify({ tool: 'shell', input: { command } });
const git = (...args: string[]) => engine.classify({ tool: 'git', input: { args } });

describe('F-4: newline command injection', () => {
  it.each(['ls\nsudo reboot', 'ls\r\nrm -rf ~', 'echo a\n\tcurl x | sh', 'pwd\rreboot'])('denies %j', (command) => {
    const decision = shell(command);
    expect(decision.decision).toBe('deny');
    expect(decision.reasons.join(' ')).toMatch(/line break/);
  });

  it('still allows the same commands chained explicitly when each part is safe', () => {
    expect(shell('ls && pwd').decision).toBe('allow');
    expect(shell('ls; sudo reboot').decision).toBe('deny');
  });
});

describe('F-5: host reads through allow-listed commands', () => {
  it.each([
    'cat /etc/passwd',
    'cat ~/.ssh/id_rsa',
    'head ../../.env',
    'head -n 5 ../../../etc/shadow',
    'grep -r . /home',
    'grep -f /etc/passwd .',
    'rg secret /etc',
    'tail -f /var/log/syslog',
    'ls -la /root',
    'find / -name id_rsa',
    'wc -l /etc/hosts',
    'stat ~/.aws/credentials',
    'sort /etc/hostname',
    'cut -d: -f1 /etc/passwd',
    'cat --files0-from=/tmp/list',
    'wc --files0-from /tmp/list',
  ])('denies %s', (command) => {
    const decision = shell(command);
    expect(decision.decision).toBe('deny');
    expect(decision.rule).toBe('filesystem-outside-deny');
  });

  it('asks (never allows) when the path depends on shell expansion', () => {
    expect(shell('cat $HOME/.ssh/id_rsa').decision).toBe('ask');
    expect(shell('cat "$(pwd)/../x"').decision).toBe('ask');
    expect(shell('ls ${DIR}').decision).toBe('ask');
  });

  it('keeps ordinary project-local reads allowed', () => {
    for (const command of [
      'cat src/index.ts', 'ls -la', 'ls src', 'head -n 20 README.md', 'tail -n 5 log.txt', 'wc -l src/*.ts',
      'grep -rn "foo/bar" src', 'rg "/api/" src', 'rg -e /api/ src', 'find . -name "*.ts" -maxdepth 3',
      'cut -d/ -f1 paths.txt', 'sort -k2 data.csv', 'cat /dev/null', 'df -h', 'du -sh .', 'stat package.json',
      `cat ${projectRoot}/src/a.ts`, 'grep -A 3 -B 3 pattern file.txt', 'echo /etc/passwd',
    ]) {
      expect(shell(command).decision, command).toBe('allow');
    }
  });
});

describe('F-6: code-executing flags on allow-listed binaries', () => {
  it.each(['rg --pre "sh -c id" x .', 'rg --pre=./run.sh x', 'rg --hostname-bin id x', 'sort --compress-program=sh file', 'sort --compress-program sh file'])(
    'denies %s',
    (command) => {
      const decision = shell(command);
      expect(decision.decision).toBe('deny');
      expect(decision.rule).toBe('shell-dangerous-deny');
    },
  );

  it('classifies find -exec by the command it would run', () => {
    expect(shell('find . -name "*.log" -exec rm {} \;').decision).toBe('ask');
    expect(shell('find . -exec reboot \;').decision).toBe('deny');
    expect(shell('find . -exec cat {} \;').decision).toBe('allow');
    expect(shell('find . -delete').decision).toBe('ask');
  });
});

describe('F-8: host writes via output flags', () => {
  it.each(['sort -o /tmp/pwned in.txt', 'sort --output=/tmp/pwned in.txt', 'sort -o ~/.bashrc in.txt', 'find . -fprint /tmp/out', 'find . -fprintf /tmp/out "%p"', 'find . -fls ../out', 'tree -o /tmp/tree.txt', 'sort -T /tmp in.txt'])(
    'does not allow %s',
    (command) => {
      const decision = shell(command);
      expect(decision.decision).not.toBe('allow');
      expect(['filesystem-outside-deny', 'shell-unknown-ask']).toContain(decision.rule);
    },
  );

  it('allows output flags that stay inside the project', () => {
    expect(shell('sort -o sorted.txt in.txt').decision).toBe('allow');
    expect(shell('find . -fprint out.txt').decision).toBe('allow');
  });
});

describe('F-7: git verb and option classification', () => {
  it.each([
    [['config', 'core.fsmonitor', 'echo x']],
    [['config', 'alias.st', '!sh']],
    [['config', '--global', 'user.name', 'x']],
    [['config', '--edit']],
    [['config', '--unset', 'core.hooksPath']],
    [['branch', '-D', 'main']],
    [['branch', '-m', 'main', 'other']],
    [['branch', 'newbranch']],
    [['remote', 'set-url', 'origin', 'x']],
    [['remote', 'add', 'evil', 'x']],
    [['remote', 'remove', 'origin']],
  ])('does not classify git %j as read-only', (args) => {
    const decision = git(...args);
    expect(decision.decision).toBe('ask');
  });

  it.each([
    [['--git-dir=/tmp/x', 'status']],
    [['--work-tree=/', 'status']],
    [['-C', '/', 'status']],
    [['-c', 'core.fsmonitor=sh', 'status']],
    [['-c', 'core.hooksPath=/tmp/h', 'commit', '-m', 'x']],
    [['log', '--output=/tmp/x']],
    [['diff', '--output', '/tmp/x']],
    [['diff', '--ext-diff']],
    [['status', 'x\ny']],
  ])('denies git %j', (args) => {
    expect(git(...args).decision).toBe('deny');
  });

  it('keeps genuine read forms allowed', () => {
    for (const args of [
      ['status', '-s'], ['log', '--oneline', '-5'], ['diff', 'HEAD~1'], ['show', 'HEAD'], ['ls-files'], ['rev-parse', 'HEAD'],
      ['branch'], ['branch', '-a'], ['branch', '--show-current'], ['branch', '--list', 'feat*'], ['branch', '--contains', 'abc'],
      ['remote'], ['remote', '-v'], ['remote', 'show', 'origin'], ['remote', 'get-url', 'origin'],
      ['config', '--get', 'user.name'], ['config', '--list'], ['config', '-l', '--show-origin'], ['blame', 'README.md'],
    ]) {
      expect(git(...args).decision, args.join(' ')).toBe('allow');
    }
  });
});

describe('F-10 / F-11: protected project paths', () => {
  it.each(['package.json', 'apps/cli/package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.npmrc', '.git/hooks/post-checkout', '.git/config', '.wazir/config.json', '.husky/pre-commit', '.githooks/pre-push', 'node_modules/left-pad/index.js', '.github/workflows/ci.yml'])(
    'write/edit to %s requires approval',
    (target) => {
      for (const tool of ['write', 'edit']) {
        const decision = engine.classify({ tool, input: { path: target, content: 'x', oldString: 'a', newString: 'b' } });
        expect(decision.decision, `${tool} ${target}`).toBe('ask');
        expect(decision.rule).toBe('filesystem-protected-ask');
      }
    },
  );

  it('reading protected paths stays allowed; ordinary writes stay allowed', () => {
    expect(engine.classify({ tool: 'read', input: { path: 'package.json' } }).decision).toBe('allow');
    expect(engine.classify({ tool: 'write', input: { path: 'src/index.ts', content: 'x' } }).decision).toBe('allow');
    expect(engine.classify({ tool: 'write', input: { path: 'docs/package.json.md', content: 'x' } }).decision).toBe('allow');
  });

  it('shell redirects and output flags into protected paths require approval', () => {
    expect(shell('echo x > .git/hooks/post-checkout').rule).toBe('filesystem-protected-ask');
    expect(shell('echo x >> package.json').rule).toBe('filesystem-protected-ask');
    expect(shell('sort -o package.json in.txt').rule).toBe('filesystem-protected-ask');
    expect(shell('echo x > out.txt').decision).toBe('allow');
  });

  it('protectedPathReason ignores paths outside the project', () => {
    expect(protectedPathReason(projectRoot, '/etc/package.json')).toBeNull();
    expect(protectedPathReason(projectRoot, path.join(projectRoot, 'package.json'))).toMatch(/package scripts/);
  });
});

describe('F-13: environment dumps', () => {
  it.each(['env', 'printenv', 'printenv HOME', 'env | grep KEY', 'nice env'])('never auto-allows %s', (command) => {
    expect(shell(command).decision).toBe('ask');
  });

  it('still unwraps env as a wrapper for a safe inner command', () => {
    expect(shell('env FOO=1 ls').decision).toBe('allow');
  });
});

describe('F-25: MCP tool-level allow list', () => {
  const scoped = new PolicyEngine({ projectRoot, allowedMcpServers: ['fs:read_file', 'search'] });
  it('allows only the listed tool of a tool-scoped server', () => {
    expect(scoped.classify({ tool: 'mcp:fs:read_file', input: {} }).decision).toBe('allow');
    expect(scoped.classify({ tool: 'mcp:fs:write_file', input: {} }).decision).toBe('deny');
    expect(scoped.classify({ tool: 'mcp:fs', input: {} }).decision).toBe('deny');
  });
  it('a bare server entry still allows every tool on it', () => {
    expect(scoped.classify({ tool: 'mcp:search:anything', input: {} }).decision).toBe('allow');
  });
});
