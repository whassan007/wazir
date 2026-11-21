import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as spawnPty } from 'node-pty';
import {
  classifyWithFastOrchestrator,
  computeLatencyPercentiles,
  type ExecutionTier,
} from '@wazir/core';
import {
  createInitialShellState,
  executeShellLine,
  runFastDebugCli,
  runFastLatencyCli,
  runFastRouteCli,
  type ShellAiHandler,
} from '../src/commands/shellCommand.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI_DIST = path.join(REPO_ROOT, 'apps/cli/dist/index.js');

interface BenchmarkClassificationCase {
  id: number;
  category: string;
  input: string;
  expectedTier: ExecutionTier;
  expectedAmbiguous?: boolean;
}

const BENCHMARK_CASES: BenchmarkClassificationCase[] = [
  // Category 1: Tier 0 Time, Date & Calendar (8)
  { id: 1, category: '01-clock-date', input: 'what time is it', expectedTier: 0 },
  { id: 2, category: '01-clock-date', input: 'what time is it today', expectedTier: 0 },
  { id: 3, category: '01-clock-date', input: "what's the time", expectedTier: 0 },
  { id: 4, category: '01-clock-date', input: 'current time', expectedTier: 0 },
  { id: 5, category: '01-clock-date', input: 'what day is today', expectedTier: 0 },
  { id: 6, category: '01-clock-date', input: "what is today's date", expectedTier: 0 },
  { id: 7, category: '01-clock-date', input: 'current date', expectedTier: 0 },
  { id: 8, category: '01-clock-date', input: 'what is the date today', expectedTier: 0 },

  // Category 2: Tier 0 Version & Release Metadata (5)
  { id: 9, category: '02-version', input: 'version', expectedTier: 0 },
  { id: 10, category: '02-version', input: 'wa version', expectedTier: 0 },
  { id: 11, category: '02-version', input: 'wazir version', expectedTier: 0 },
  { id: 12, category: '02-version', input: 'wa --version', expectedTier: 0 },
  { id: 13, category: '02-version', input: 'wazir -V', expectedTier: 0 },

  // Category 3: Tier 0 Identity, Host & Working Directory (6)
  { id: 14, category: '03-identity-cwd', input: 'whoami', expectedTier: 0 },
  { id: 15, category: '03-identity-cwd', input: 'hostname', expectedTier: 0 },
  { id: 16, category: '03-identity-cwd', input: 'pwd', expectedTier: 0 },
  { id: 17, category: '03-identity-cwd', input: 'where am i', expectedTier: 0 },
  { id: 18, category: '03-identity-cwd', input: 'current directory', expectedTier: 0 },
  { id: 19, category: '03-identity-cwd', input: 'who am i', expectedTier: 0 },

  // Category 4: Tier 0 Safe Deterministic Arithmetic (8)
  { id: 20, category: '04-arithmetic', input: '2 + 2', expectedTier: 0 },
  { id: 21, category: '04-arithmetic', input: '2+2', expectedTier: 0 },
  { id: 22, category: '04-arithmetic', input: '15 * 4 - 8', expectedTier: 0 },
  { id: 23, category: '04-arithmetic', input: '(10 + 5) * 3', expectedTier: 0 },
  { id: 24, category: '04-arithmetic', input: '100 / 8', expectedTier: 0 },
  { id: 25, category: '04-arithmetic', input: '(256 / 16) + 84', expectedTier: 0 },
  { id: 26, category: '04-arithmetic', input: '999 - 333 * 2', expectedTier: 0 },
  { id: 27, category: '04-arithmetic', input: '17 % 5', expectedTier: 0 },

  // Category 5: Tier 0 Session Builtins & Controls (10)
  { id: 28, category: '05-builtins-controls', input: 'cd /tmp', expectedTier: 0 },
  { id: 29, category: '05-builtins-controls', input: 'export FOO=bar', expectedTier: 0 },
  { id: 30, category: '05-builtins-controls', input: 'unset FOO', expectedTier: 0 },
  { id: 31, category: '05-builtins-controls', input: 'alias ll="ls -la"', expectedTier: 0 },
  { id: 32, category: '05-builtins-controls', input: 'unalias ll', expectedTier: 0 },
  { id: 33, category: '05-builtins-controls', input: 'exit', expectedTier: 0 },
  { id: 34, category: '05-builtins-controls', input: 'quit', expectedTier: 0 },
  { id: 35, category: '05-builtins-controls', input: '/mode auto', expectedTier: 0 },
  { id: 36, category: '05-builtins-controls', input: '/model auto', expectedTier: 0 },
  { id: 37, category: '05-builtins-controls', input: '/permissions read-only', expectedTier: 0 },

  // Category 6: Tier 0 Introspection, Telemetry & Diagnostics (10)
  { id: 38, category: '06-introspection', input: 'help', expectedTier: 0 },
  { id: 39, category: '06-introspection', input: 'models', expectedTier: 0 },
  { id: 40, category: '06-introspection', input: 'jobs', expectedTier: 0 },
  { id: 41, category: '06-introspection', input: 'status', expectedTier: 0 },
  { id: 42, category: '06-introspection', input: 'agents', expectedTier: 0 },
  { id: 43, category: '06-introspection', input: 'fleet', expectedTier: 0 },
  { id: 44, category: '06-introspection', input: 'history', expectedTier: 0 },
  { id: 45, category: '06-introspection', input: 'wa debug on', expectedTier: 0 },
  { id: 46, category: '06-introspection', input: 'wa route "explain chmod 755"', expectedTier: 0 },
  { id: 47, category: '06-introspection', input: 'wa latency', expectedTier: 0 },

  // Category 7: Negative Traps — MUST NOT be hijacked by Tier 0 (7)
  { id: 48, category: '07-negative-traps', input: 'what time is it in Tokyo', expectedTier: 2 },
  { id: 49, category: '07-negative-traps', input: 'what version of node should I use', expectedTier: 2 },
  { id: 50, category: '07-negative-traps', input: 'what is the date of the last commit', expectedTier: 3 },
  { id: 51, category: '07-negative-traps', input: 'explain how pwd works in POSIX shells', expectedTier: 2 },
  { id: 52, category: '07-negative-traps', input: 'how does hostname resolution work', expectedTier: 2 },
  { id: 53, category: '07-negative-traps', input: 'explain why version pinning matters', expectedTier: 2 },
  { id: 54, category: '07-negative-traps', input: 'write a script that checks whoami and logs it', expectedTier: 3 },

  // Category 8: Tier 1 Native Shell Commands (8)
  { id: 55, category: '08-native-shell', input: 'ls -la', expectedTier: 1 },
  { id: 56, category: '08-native-shell', input: 'git status', expectedTier: 1 },
  { id: 57, category: '08-native-shell', input: 'git log -3', expectedTier: 1 },
  { id: 58, category: '08-native-shell', input: 'cat README.md', expectedTier: 1 },
  { id: 59, category: '08-native-shell', input: 'uname -a', expectedTier: 1 },
  { id: 60, category: '08-native-shell', input: 'df -h', expectedTier: 1 },
  { id: 61, category: '08-native-shell', input: 'ps aux', expectedTier: 1 },
  { id: 62, category: '08-native-shell', input: 'date +%s', expectedTier: 1 },

  // Category 9: Tier 1 Pipelines, Redirection & Compound Shell Expressions (7)
  { id: 63, category: '09-pipelines', input: 'ls -la | grep package', expectedTier: 1 },
  { id: 64, category: '09-pipelines', input: 'echo "hello world" > /tmp/out.txt', expectedTier: 1 },
  { id: 65, category: '09-pipelines', input: 'git log --oneline -5 | wc -l', expectedTier: 1 },
  { id: 66, category: '09-pipelines', input: 'echo A && echo B', expectedTier: 1 },
  { id: 67, category: '09-pipelines', input: 'mkdir -p /tmp/foo && rmdir /tmp/foo', expectedTier: 1 },
  { id: 68, category: '09-pipelines', input: 'env | sort | head -5', expectedTier: 1 },
  { id: 69, category: '09-pipelines', input: './scripts/check.sh --dry-run', expectedTier: 1 },

  // Category 10: Explicit Escapes & Overrides (6)
  { id: 70, category: '10-escapes', input: '! jobs', expectedTier: 1 },
  { id: 71, category: '10-escapes', input: '\\status', expectedTier: 1 },
  { id: 72, category: '10-escapes', input: 'os:status', expectedTier: 1 },
  { id: 73, category: '10-escapes', input: 'sh:history', expectedTier: 1 },
  { id: 74, category: '10-escapes', input: '! what is TCP', expectedTier: 1 },
  { id: 75, category: '10-escapes', input: '? explain chmod 755', expectedTier: 2 },

  // Category 11: Ambiguous Non-Shell Single Tokens (3)
  { id: 76, category: '11-ambiguous', input: 'xyzzy_nonexistent_cmd_1', expectedTier: 1, expectedAmbiguous: true },
  { id: 77, category: '11-ambiguous', input: 'foobarbaz', expectedTier: 1, expectedAmbiguous: true },
  { id: 78, category: '11-ambiguous', input: 'blorp123', expectedTier: 1, expectedAmbiguous: true },

  // Category 12: Tier 2 Fast Conversational / Explanatory Queries (10)
  { id: 79, category: '12-tier2-fast-llm', input: 'explain chmod 755', expectedTier: 2 },
  { id: 80, category: '12-tier2-fast-llm', input: 'what is a Python decorator', expectedTier: 2 },
  { id: 81, category: '12-tier2-fast-llm', input: 'what is TCP', expectedTier: 2 },
  { id: 82, category: '12-tier2-fast-llm', input: 'summarize this short error: ECONNREFUSED 127.0.0.1:11434', expectedTier: 2 },
  { id: 83, category: '12-tier2-fast-llm', input: 'what does this git message mean: detached HEAD', expectedTier: 2 },
  { id: 84, category: '12-tier2-fast-llm', input: 'difference between SIGTERM and SIGKILL', expectedTier: 2 },
  { id: 85, category: '12-tier2-fast-llm', input: 'explain Unix file permissions concisely', expectedTier: 2 },
  { id: 86, category: '12-tier2-fast-llm', input: 'what does HTTP 429 mean', expectedTier: 2 },
  { id: 87, category: '12-tier2-fast-llm', input: 'why use exponential backoff in retries', expectedTier: 2 },
  { id: 88, category: '12-tier2-fast-llm', input: 'explain git rebase vs git merge briefly', expectedTier: 2 },

  // Category 13: Tier 3 Coding & Multi-Agent Orchestration (10)
  { id: 89, category: '13-tier3-agent', input: 'build a REST API', expectedTier: 3 },
  { id: 90, category: '13-tier3-agent', input: 'fix the failing tests', expectedTier: 3 },
  { id: 91, category: '13-tier3-agent', input: 'review this repository', expectedTier: 3 },
  { id: 92, category: '13-tier3-agent', input: 'deploy the application to staging', expectedTier: 3 },
  { id: 93, category: '13-tier3-agent', input: 'run 12 agents to improve the code', expectedTier: 3 },
  { id: 94, category: '13-tier3-agent', input: 'create an autonomous improvement graph', expectedTier: 3 },
  { id: 95, category: '13-tier3-agent', input: 'refactor the authentication module across files', expectedTier: 3 },
  { id: 96, category: '13-tier3-agent', input: 'implement a new caching layer and add unit tests', expectedTier: 3 },
  { id: 97, category: '13-tier3-agent', input: 'audit this codebase for race conditions and patch them', expectedTier: 3 },
  { id: 98, category: '13-tier3-agent', input: 'debug and resolve the broken CI build in packages/core', expectedTier: 3 },

  // Category 14: Tier 3 Reserved Wazir Workflows (7)
  { id: 99, category: '14-tier3-workflows', input: 'loop "fix all failing tests"', expectedTier: 3 },
  { id: 100, category: '14-tier3-workflows', input: 'graph "build auth and billing"', expectedTier: 3 },
  { id: 101, category: '14-tier3-workflows', input: 'goal "harden security and run verification"', expectedTier: 3 },
  { id: 102, category: '14-tier3-workflows', input: 'inspect run-123', expectedTier: 3 },
  { id: 103, category: '14-tier3-workflows', input: 'pause run-123', expectedTier: 3 },
  { id: 104, category: '14-tier3-workflows', input: 'resume run-123', expectedTier: 3 },
  { id: 105, category: '14-tier3-workflows', input: 'stop run-123', expectedTier: 3 },
];

describe('FastOrchestrator 100+ Regression & 1000-Request Latency Benchmark Suite', () => {
  let tmpDir: string;
  let capturedOut: string[];
  let capturedErr: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-bench-'));
    capturedOut = [];
    capturedErr = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...args: unknown[]) => {
      capturedOut.push(args.map((a) => String(a)).join(' '));
    };
    console.error = (...args: unknown[]) => {
      capturedErr.push(args.map((a) => String(a)).join(' '));
    };
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('classifies all 105 benchmark cases across 14 routing categories accurately without LLM calls', () => {
    expect(BENCHMARK_CASES.length).toBeGreaterThanOrEqual(100);
    const failures: string[] = [];

    for (const tc of BENCHMARK_CASES) {
      const decision = classifyWithFastOrchestrator(tc.input, {
        sessionMode: 'auto',
        cwd: tmpDir,
        packageVersion: '0.4.1',
      });
      if (decision.tier !== tc.expectedTier) {
        failures.push(
          `#${tc.id} (${tc.category}) "${tc.input}": expected tier=${tc.expectedTier}, got tier=${decision.tier} (handler=${decision.handler}, reason=${decision.reason})`,
        );
      }
      if (tc.expectedAmbiguous !== undefined && Boolean(decision.ambiguous) !== tc.expectedAmbiguous) {
        failures.push(`#${tc.id} "${tc.input}": expected ambiguous=${tc.expectedAmbiguous}, got ${decision.ambiguous}`);
      }
    }

    expect(failures).toEqual([]);
  });

  // Category 15a: Live Tier 0 regression queries with 0 LLM calls, dynamic clock/TZ, quiet defaults
  it('executes Tier 0 regression commands deterministically with 0 LLM calls, local TZ/DST, and quiet default output', async () => {
    let llmCalls = 0;
    const neverCalledAi: ShellAiHandler = async () => {
      llmCalls += 1;
      return 0;
    };

    const state = createInitialShellState({
      initialCwd: tmpDir,
      env: { ...process.env, WAZIR_HOME: tmpDir, WAZIR_SKIP_RUNTIME_DISCOVERY: '1', TZ: 'UTC' },
    });

    const regressionInputs = [
      'what time is it today',
      'what time is it',
      'what day is today',
      'version',
      'wa version',
      'pwd',
      '2 + 2',
    ];

    for (const cmd of regressionInputs) {
      const code = await executeShellLine(cmd, state, neverCalledAi);
      expect(code).toBe(0);
    }

    expect(llmCalls).toBe(0);
    const joined = capturedOut.join('\n');
    expect(joined).toContain('UTC');
    expect(joined).toMatch(/Wazir v\d+\.\d+\.\d+/);
    expect(joined).toContain(tmpDir);
    expect(joined).toContain('4');
    // Must not emit noisy internal routing chatter when debug is off
    expect(joined).not.toContain('[AI] Routing request');
    expect(joined).not.toContain('[wazir-debug]');
    expect(capturedErr.join('\n')).not.toContain('ExperimentalWarning');

    // Timezone switch must reflect dynamically without clock caching
    capturedOut = [];
    state.env.TZ = 'America/Los_Angeles';
    expect(await executeShellLine('what time is it today', state, neverCalledAi)).toBe(0);
    expect(capturedOut.join('\n')).toMatch(/PST|PDT/);

    // Debug toggle + CLI introspection helpers
    capturedOut = [];
    expect(await executeShellLine('wa debug on', state, neverCalledAi)).toBe(0);
    expect(state.debug).toBe(true);
    expect(await executeShellLine('pwd', state, neverCalledAi)).toBe(0);
    expect(capturedOut.join('\n')).toContain('[wazir-debug] tier=0');

    capturedOut = [];
    expect(await runFastRouteCli(['explain', 'chmod', '755'])).toBe(0);
    expect(capturedOut.join('\n')).toMatch(/Tier:\s*2/);
    expect(llmCalls).toBe(0);

    capturedOut = [];
    expect(await executeShellLine('wa latency --json', state, neverCalledAi)).toBe(0);
    const latencyReport = JSON.parse(capturedOut[capturedOut.length - 1] ?? '{}');
    expect(latencyReport.totalSamples).toBeGreaterThanOrEqual(regressionInputs.length);

    capturedOut = [];
    const prevHome = process.env.WAZIR_HOME;
    process.env.WAZIR_HOME = tmpDir;
    try {
      expect(await runFastDebugCli('off')).toBe(0);
      expect(await runFastDebugCli('status')).toBe(0);
      expect(await runFastLatencyCli({ reset: true })).toBe(0);
    } finally {
      if (prevHome === undefined) delete process.env.WAZIR_HOME;
      else process.env.WAZIR_HOME = prevHome;
    }
  });

  // Category 15b: 1,000 sequential Tier 0 stress test
  it('handles 1,000 sequential Tier 0 requests with 0 silent failures and p95 < 50ms', async () => {
    const state = createInitialShellState({
      initialCwd: tmpDir,
      env: { ...process.env, WAZIR_HOME: tmpDir, WAZIR_SKIP_RUNTIME_DISCOVERY: '1' },
      debug: false,
    });
    const queries = [
      'what time is it today',
      'version',
      'pwd',
      '2 + 2',
      'whoami',
      'hostname',
      'what day is today',
      'status',
    ];
    let llmCalls = 0;
    const spyAi: ShellAiHandler = async () => {
      llmCalls += 1;
      return 0;
    };

    const samples: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      capturedOut = [];
      const q = queries[i % queries.length]!;
      const t0 = performance.now();
      const code = await executeShellLine(q, state, spyAi);
      const dt = performance.now() - t0;
      samples.push(dt);
      expect(code).toBe(0);
      expect(capturedOut.length).toBeGreaterThan(0);
      expect(capturedOut.join('').trim().length).toBeGreaterThan(0);
    }

    const stats = computeLatencyPercentiles(samples);
    expect(llmCalls).toBe(0);
    expect(stats.count).toBe(1000);
    expect(stats.p95Ms).toBeLessThan(50);
    expect(stats.p99Ms).toBeLessThan(100);
    expect(state.latencyTracker?.getSummary().byTier[0]?.count).toBe(1000);
  });

  // Category 16: Mixed-tier execution & node-pty interactive prompt-ordering verification
  it('delivers all outputs before rendering the next prompt in a real PTY session without SQLite warnings', async () => {
    expect(fs.existsSync(CLI_DIST)).toBe(true);
    let clean = '';
    const exitCode = await new Promise<number>((resolve, reject) => {
      const pty = spawnPty(process.execPath, [CLI_DIST, 'shell', '--no-ai'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: tmpDir,
        env: {
          ...process.env,
          HOME: tmpDir,
          WAZIR_HOME: path.join(tmpDir, '.wazir'),
          WAZIR_SKIP_RUNTIME_DISCOVERY: '1',
        },
      });

      const timer = setTimeout(() => {
        try {
          pty.kill();
        } catch {
          // ignore cleanup kill errors
        }
        reject(new Error(`PTY session timed out. Output so far:\n${clean}`));
      }, 15_000);

      let stage = 0;
      pty.onData((chunk) => {
        clean += chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
        if (stage === 0 && /wa:.*\$ /.test(clean)) {
          stage = 1;
          pty.write('version\n');
        } else if (stage === 1 && /Wazir v\d+\.\d+\.\d+[\s\S]*wa:.*\$ /.test(clean)) {
          stage = 2;
          pty.write('2 + 2\n');
        } else if (stage === 2 && /\b4\b[\s\S]*wa:.*\$ [\s\S]*wa:.*\$ /.test(clean)) {
          stage = 3;
          pty.write('what time is it today\n');
        } else if (stage === 3 && clean.split('wa:').length >= 5) {
          stage = 4;
          pty.write('! echo PTY_NATIVE_OK\n');
        } else if (stage === 4 && /PTY_NATIVE_OK[\s\S]*wa:.*\$ /.test(clean)) {
          stage = 5;
          pty.write('exit 0\n');
        }
      });

      pty.onExit(({ exitCode: code }) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(0);
    expect(clean).not.toMatch(/ExperimentalWarning:\s*SQLite/i);
    expect(clean).not.toContain('[AI] Routing request');
    expect(clean).toMatch(/Wazir v\d+\.\d+\.\d+/);
    expect(clean).toContain('PTY_NATIVE_OK');
  }, 20_000);
});
