// Live end-to-end scenario: launch the real `wa chat` TUI against a real,
// locally running model and ask it to write a C++ program that sorts an
// array and produces the sum — the same class of task that originally
// exposed real bugs in this agent (tool-argument loss, brace-in-prose
// parsing, etc.) earlier in this project's history.
//
// This is intentionally NOT part of the fast, deterministic suite: it drives
// a full multi-turn agentic loop against whatever model LM Studio has
// loaded, which can take several minutes and is not reproducible run to run.
// It is excluded from the default `vitest run` sweep (see vitest.config.ts)
// and is meant to be run deliberately:
//
//   npm run test:buildcpp
//   npx vitest run apps/cli/tests/buildcpp.e2e.test.ts
//
// Verification follows Section 17's rule for live-model tests: don't assert
// exact natural-language output. Instead assert on ground truth the test
// itself checks independently — a C++ source file actually landed on disk,
// and it actually compiles and runs — rather than trusting the agent's own
// self-reported VERIFY status.

import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(dirname, '../dist/index.js');
const ptyDriver = path.join(dirname, 'ptyDriver.py');

const PROMPT = 'write a c++ program to sort an array of numbers and to produce the sum';

const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234';

const TUI_WAIT_TIMEOUT_S = 480; // up to 8 minutes for a full plan/implement/verify loop
const JOB_TIMEOUT_S = 470; // wa chat's own --timeout, kept just under the wait above
const OVERALL_TEST_TIMEOUT_MS = 600_000; // 10 minutes

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface PtyResult {
  exitCode: number | null;
  signalName: string | null;
  killed: boolean;
  steps: Array<{ op: string; ok: boolean; detail?: string }>;
  outputTail: string;
  error?: string;
}

async function runPtyChat(
  script: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  extraArgs: string[] = [],
): Promise<PtyResult> {
  await fs.access(cliEntry).catch(() => {
    throw new Error(`${cliEntry} is missing — run \`npm run build\` before this test`);
  });
  await fs.access(ptyDriver).catch(() => {
    throw new Error(`${ptyDriver} is missing — this test drives the TUI through a PTY`);
  });

  const full = {
    ...script,
    env,
    cols: 200,
    rows: 50,
    stepTimeout: script.stepTimeout ?? 20,
  };

  const { stdout } = await execFileAsync(
    'python3',
    [ptyDriver, '--json', JSON.stringify(full), '--', process.execPath, cliEntry, 'chat', ...extraArgs],
    { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: OVERALL_TEST_TIMEOUT_MS },
  ).catch((err: { stdout?: string; stderr?: string }) => {
    // The driver always emits one JSON line on stdout, even when a step fails.
    const out = (err?.stdout ?? '').trim();
    if (out) return { stdout: out, stderr: err?.stderr ?? '' };
    throw new Error(`ptyDriver failed: ${err?.stderr ?? String(err)}`);
  });

  const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
  const parsed = JSON.parse(jsonLine);
  if (parsed.error) throw new Error(`ptyDriver: ${parsed.error}`);
  return parsed as PtyResult;
}

async function findFilesRecursive(root: string, pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.wazir') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (pattern.test(entry.name)) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found;
}

async function findCompiler(): Promise<string> {
  for (const candidate of ['g++', 'clang++']) {
    try {
      await execFileAsync(candidate, ['--version']);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error('no C++ compiler (g++ or clang++) found on PATH — required to verify buildcpp output');
}

describe('buildcpp: live `wa chat` TUI writes a working C++ sort+sum program', () => {
  let isLMStudioLive = false;

  beforeAll(async () => {
    try {
      const res = await fetch(`${LMSTUDIO_BASE_URL}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        isLMStudioLive = Boolean(data.data && data.data.length > 0);
      }
    } catch {
      isLMStudioLive = false;
    }
  });

  it(
    'asks wazir via the TUI to sort an array and sum it, then verifies the result compiles and runs',
    async () => {
      if (!isLMStudioLive) {
        // Graceful skip when no live LM Studio daemon is reachable — this
        // scenario needs a real model, not a fake adapter.
        expect(true).toBe(true);
        return;
      }

      const homeDir = await tempDir('wazir-buildcpp-home-');
      const projectDir = await tempDir('wazir-buildcpp-project-');

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        WAZIR_HOME: homeDir,
        WAZIR_COMPUTER_ID: `buildcpp-${Date.now()}`,
      };

      try {
        const result = await runPtyChat(
          {
            cwd: projectDir,
            stepTimeout: 20,
            steps: [
              { op: 'wait', text: 'wa>', timeout: 20 },
              { op: 'send', data: `${PROMPT}\r` },
              { op: 'wait', text: 'Tokens: In', timeout: TUI_WAIT_TIMEOUT_S },
              { op: 'send', data: '/exit\r' },
              { op: 'exit', timeout: 20, expectCode: 0 },
            ],
          },
          env,
          ['--no-worktrees', '--timeout', String(JOB_TIMEOUT_S)],
        );

        expect(result.killed, `driver had to SIGKILL the process — tail:\n${result.outputTail}`).toBe(false);
        expect(result.exitCode, `unexpected exit code — tail:\n${result.outputTail}`).toBe(0);

        const completed = /completed!\s*Tokens: In/.test(result.outputTail);
        expect(completed, `job did not report a completed status — tail:\n${result.outputTail}`).toBe(true);

        // Ground truth: find what the agent actually wrote on disk, independent
        // of anything the TUI claims about its own verification.
        const cppFiles = await findFilesRecursive(projectDir, /\.(cpp|cc|cxx)$/i);
        expect(cppFiles.length, `no C++ source file found under ${projectDir}`).toBeGreaterThan(0);

        // Independently compile and run the first C++ file the agent produced —
        // don't trust the agent's self-reported VERIFY phase.
        const compiler = await findCompiler();
        const source = cppFiles[0];
        const binary = path.join(path.dirname(source), 'buildcpp_verify_bin');
        await execFileAsync(compiler, ['-std=c++17', '-O2', '-o', binary, source]);

        const { stdout } = await execFileAsync(binary, [], { timeout: 10_000 });
        expect(stdout.length).toBeGreaterThan(0);
      } finally {
        await fs.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    OVERALL_TEST_TIMEOUT_MS,
  );
});
