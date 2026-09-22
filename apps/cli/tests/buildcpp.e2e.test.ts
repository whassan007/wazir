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
//
// Every run — pass, fail, or skip — writes a full report to
// buildcpp-test-report.json at the repo root: the raw PTY transcript tail,
// every step's outcome, the files found, compiler output, run output, and
// (on failure) the exact error and stack. This is a live, non-reproducible
// run, so the report is the only durable record of what actually happened —
// scrollback is not enough to diagnose a failure after the fact.

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
const reportPath = path.resolve(dirname, '../../../buildcpp-test-report.json');

const PROMPT = 'write a c++ program to sort an array of numbers and to produce the sum';

const LMSTUDIO_BASE_URL = process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234';

const TUI_WAIT_TIMEOUT_S = 180; // 3 minutes for a full plan/implement/verify loop
const JOB_TIMEOUT_S = 170; // wa chat's own --timeout, kept just under the wait above
const OVERALL_TEST_TIMEOUT_MS = 240_000; // 4 minutes
const APPROVAL_POLL_CHUNK_S = 15; // how often to clear a pending policy approval while waiting

/**
 * Splits the completion wait into short chunks, sending Ctrl+A (the TUI's
 * approve-all binding, TUI-032) between each one. A shell command like
 * `mkdir -p build` requires interactive policy approval — without this, the
 * job stalls forever waiting for a human who never answers, and the driver
 * eventually has to SIGKILL the process (confirmed live: see the first
 * buildcpp run, which stalled exactly on an unapproved `mkdir -p build`).
 * Ctrl+A is a no-op when nothing is pending, so this is safe to send blindly.
 *
 * The `needle` MUST be text that only appears once the job has actually
 * reached a terminal state — NOT a status widget that's on screen from the
 * moment generation starts (e.g. a live token counter). `ptyDriver.py`'s
 * `wait` step checks the *entire* accumulated output buffer, not just output
 * newly arrived since the step began, so a needle that's present from turn
 * one makes every chunk resolve instantly and the whole `totalTimeoutS`
 * budget collapses to a few hundred milliseconds of real wait time — the
 * exact bug that made this test intermittently SIGKILL a job that was still
 * legitimately working (confirmed live: two consecutive runs both failed at
 * ~26s, nowhere near the intended 180s budget, both killed while the model
 * was still mid-task).
 */
function pollingWaitSteps(totalTimeoutS: number, needle: string): Array<Record<string, unknown>> {
  const steps: Array<Record<string, unknown>> = [];
  let remaining = totalTimeoutS;
  while (remaining > 0) {
    const chunk = Math.min(APPROVAL_POLL_CHUNK_S, remaining);
    steps.push({ op: 'wait', text: needle, timeout: chunk });
    steps.push({ op: 'send', data: '\x01' }); // Ctrl+A: approve all pending
    remaining -= chunk;
  }
  return steps;
}

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface PtyResult {
  exitCode: number | null;
  signalName: string | null;
  killed: boolean;
  steps: Array<{ op: string; ok: boolean; detail?: string }>;
  outputTail: string;
  outputBytes?: number;
  error?: string;
}

/** Everything captured about one run, written to disk unconditionally. */
interface BuildCppReport {
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  prompt: string;
  lmStudioLive: boolean;
  skipped: boolean;
  skipReason?: string;
  homeDir?: string;
  projectDir?: string;
  pty?: PtyResult;
  jobCompletedStatusSeen?: boolean;
  cppFilesFound?: string[];
  compiler?: string;
  compile?: { ok: boolean; error?: string; stdout?: string; stderr?: string };
  run?: { ok: boolean; error?: string; stdout?: string; stderr?: string };
  outcome: 'pass' | 'fail' | 'skip' | 'error';
  error?: { message: string; stack?: string };
}

async function writeReport(report: BuildCppReport): Promise<void> {
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8').catch((err) => {
    // Surface a write failure loudly — losing the only record of a live,
    // non-reproducible run is exactly the failure mode this exists to avoid.
    // eslint-disable-next-line no-console
    console.error(`buildcpp: failed to write report to ${reportPath}: ${String(err)}`);
  });
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
      // Do NOT skip .wazir: a "write ... from scratch" prompt puts the agent
      // in an isolated clean workspace under .wazir/worktrees/, regardless of
      // --no-worktrees — confirmed live (first buildcpp run wrote its
      // src/main.cpp there, not at the project root). Only .git and
      // node_modules are genuinely irrelevant to search.
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
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

// This test drives a full live multi-turn agentic loop against whatever
// model LM Studio has loaded, which can take several minutes and is not
// reproducible run to run. It is intentionally opt-in only — checking
// RUN_BUILDCPP here (rather than relying on vitest's `exclude` config) means
// the default `vitest run`/`npm test` sweep skips it instantly regardless of
// how the file is invoked, while still allowing it to run when explicitly
// targeted (`npx vitest run apps/cli/tests/buildcpp.e2e.test.ts` would
// otherwise re-include it despite an `exclude` entry, since vitest's exclude
// patterns don't bypass an explicit path argument). Enabled via:
//
//   npm run test:buildcpp
const RUN_BUILDCPP = process.env.RUN_BUILDCPP === '1';

describe('buildcpp: live `wa chat` TUI writes a working C++ sort+sum program', () => {
  let isLMStudioLive = false;

  beforeAll(async () => {
    if (!RUN_BUILDCPP) return;
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
      if (!RUN_BUILDCPP) {
        // Not opted in — the default sweep must not attempt this live,
        // multi-minute scenario. No report is written for a bare no-op skip.
        expect(true).toBe(true);
        return;
      }

      const report: BuildCppReport = {
        startedAt: new Date().toISOString(),
        prompt: PROMPT,
        lmStudioLive: isLMStudioLive,
        skipped: false,
        outcome: 'error', // overwritten below on every path; stays 'error' only if we throw before reassigning
      };

      if (!isLMStudioLive) {
        report.skipped = true;
        report.skipReason = `no LM Studio daemon with a loaded model reachable at ${LMSTUDIO_BASE_URL}`;
        report.outcome = 'skip';
        await writeReport(report);
        // Graceful skip when no live LM Studio daemon is reachable — this
        // scenario needs a real model, not a fake adapter.
        expect(true).toBe(true);
        return;
      }

      const homeDir = await tempDir('wazir-buildcpp-home-');
      const projectDir = await tempDir('wazir-buildcpp-project-');
      report.homeDir = homeDir;
      report.projectDir = projectDir;

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
              // 'completed! Tokens' matches FleetTui's job-terminal status line
              // (`Job <id> completed! Tokens: In .../Out ..., Dur: ...s` — see
              // apps/cli/src/tui/fleetTui.ts), which is only rendered once
              // runJob() has actually resolved. It is NOT the per-execution
              // tail pane's live token counter ('Tokens: In ...' with no
              // preceding 'completed!'), which is on screen from turn one and
              // was the actual bug (see pollingWaitSteps()'s docstring).
              ...pollingWaitSteps(TUI_WAIT_TIMEOUT_S, 'completed! Tokens'),
              { op: 'send', data: '/exit\r' },
              { op: 'exit', timeout: 20, expectCode: 0 },
            ],
          },
          env,
          ['--no-worktrees', '--timeout', String(JOB_TIMEOUT_S)],
        );
        report.pty = result;

        const completed = /completed!\s*Tokens: In/.test(result.outputTail);
        report.jobCompletedStatusSeen = completed;

        expect(result.killed, `driver had to SIGKILL the process — tail:\n${result.outputTail}`).toBe(false);
        expect(result.exitCode, `unexpected exit code — tail:\n${result.outputTail}`).toBe(0);
        expect(completed, `job did not report a completed status — tail:\n${result.outputTail}`).toBe(true);

        // Ground truth: find what the agent actually wrote on disk, independent
        // of anything the TUI claims about its own verification.
        const cppFiles = await findFilesRecursive(projectDir, /\.(cpp|cc|cxx)$/i);
        report.cppFilesFound = cppFiles;
        expect(cppFiles.length, `no C++ source file found under ${projectDir}`).toBeGreaterThan(0);

        // Independently compile and run the first C++ file the agent produced —
        // don't trust the agent's self-reported VERIFY phase.
        const compiler = await findCompiler();
        report.compiler = compiler;
        const source = cppFiles[0];
        const binary = path.join(path.dirname(source), 'buildcpp_verify_bin');

        try {
          await execFileAsync(compiler, ['-std=c++17', '-O2', '-o', binary, source]);
          report.compile = { ok: true };
        } catch (err) {
          const e = err as { message?: string; stdout?: string; stderr?: string };
          report.compile = { ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr };
          throw err;
        }

        try {
          const { stdout, stderr } = await execFileAsync(binary, [], { timeout: 10_000 });
          report.run = { ok: true, stdout, stderr };
          expect(stdout.length).toBeGreaterThan(0);
        } catch (err) {
          const e = err as { message?: string; stdout?: string; stderr?: string };
          report.run = { ok: false, error: e.message, stdout: e.stdout, stderr: e.stderr };
          throw err;
        }

        report.outcome = 'pass';
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        report.error = { message: e.message, stack: e.stack };
        report.outcome = 'fail';
        throw err;
      } finally {
        await writeReport(report);
        await fs.rm(homeDir, { recursive: true, force: true }).catch(() => undefined);
        await fs.rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    OVERALL_TEST_TIMEOUT_MS,
  );
});
