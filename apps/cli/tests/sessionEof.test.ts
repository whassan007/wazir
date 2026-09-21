// Regression suite: `wa chat` session exit paths.
//
// Covers the bug where a piped stdin (`printf '/doctor\r' | wa chat`) or a dead
// terminal left the TUI sitting in waitForExit() forever — the process only died
// when something killed it. Root causes fixed in FleetTui:
//   1. no stdin 'end' listener: piped/EOF input never triggered an exit
//   2. screen.leave() wrote restore codes to an already-dead terminal, and the
//      resulting async 'error' (EIO) crashed the process mid-exit (exit 1)
//
// Two harnesses are used because they exercise different stream realities:
//   - plain pipes  (child_process.spawn) — stdin/stdout are anonymous pipes,
//     no TTY, no keypress events; command text is delivered as raw data
//   - a real PTY   (ptyDriver.py, stdlib only) — TTY semantics, keypress
//     decoding, raw mode, terminal resize, and terminal death (master close)
//
// The PTY driver reports JSON on stdout: exitCode, signalName, killed, steps,
// outputTail. `killed=true` means the driver had to SIGKILL a still-live child —
// the exact "hang" symptom this suite guards against.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dirname = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(dirname, '../dist/index.js');
const ptyDriver = path.join(dirname, 'ptyDriver.py');

const STARTUP_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 15_000;

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wazir-session-eof-'));
}

/**
 * Environment that pins every runtime to an unreachable local port so the test
 * outcome never depends on whatever happens to be running on the executing
 * machine, and isolates the config/state dir.
 */
async function isolatedEnv(dir: string): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    WAZIR_HOME: dir,
    WAZIR_COMPUTER_ID: `session-eof-${Date.now()}`,
    WAZIR_OLLAMA_URL: 'http://127.0.0.1:1',
    WAZIR_LMSTUDIO_URL: 'http://127.0.0.1:1',
  };
}

interface PipeRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run `wa chat` with stdin/stdout as plain pipes. Writes `payload` to stdin and
 * closes it (EOF) — the pipe-EOF scenario. Fails the test loudly on timeout
 * instead of hanging the whole suite.
 */
async function runPipedChat(payload: string, env: NodeJS.ProcessEnv): Promise<PipeRun> {
  await fs.access(cliEntry).catch(() => {
    throw new Error(`${cliEntry} is missing — run \`npm run build\` before this test`);
  });

  return await new Promise<PipeRun>((resolve) => {
    const child = spawn(process.execPath, [cliEntry, 'chat'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ exitCode: null, stdout, stderr, timedOut: true });
    }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + String(err), timedOut: false });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut: false });
    });

    // Give the TUI a moment to bind its input stream before delivering the
    // payload — the TUI attaches listeners asynchronously after engine startup.
    setTimeout(() => {
      child.stdin.write(payload);
      child.stdin.end(); // EOF
    }, 1_500);
  });
}

interface PtyResult {
  exitCode: number | null;
  signalName: string | null;
  killed: boolean;
  steps: Array<{ op: string; ok: boolean; detail?: string }>;
  outputTail: string;
  error?: string;
}

/**
 * Run `wa chat` under a real pseudo-terminal via ptyDriver.py.
 */
async function runPtyChat(script: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<PtyResult> {
  await fs.access(ptyDriver).catch(() => {
    throw new Error(`${ptyDriver} is missing — this test drives the TUI through a PTY`);
  });

  const full = {
    ...script,
    env,
    cols: 200,
    rows: 50,
    stepTimeout: 15,
  };

  const { stdout, stderr } = await execFileAsync(
    'python3',
    [ptyDriver, '--json', JSON.stringify(full), '--', process.execPath, cliEntry, 'chat'],
    { env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 },
  ).catch((err: { stdout?: string; stderr?: string }) => {
    // The driver always emits one JSON line on stdout, even when a step fails.
    const out = (err?.stdout ?? '').trim();
    if (out) {
      try {
        return { stdout: out, stderr: err?.stderr ?? '' };
      } catch {
        /* fall through */
      }
    }
    throw new Error(`ptyDriver failed: ${err?.stderr ?? err?.message ?? 'unknown error'}`);
  });

  // The driver emits exactly one JSON line (possibly with a trailing newline).
  const jsonLine = stdout.trim().split('\n').pop() ?? '{}';
  const parsed = JSON.parse(jsonLine);
  if (parsed.error) throw new Error(`ptyDriver: ${parsed.error}`);
  return parsed as PtyResult;
}

describe('Section 14: `wa chat` session exit — stdin EOF & dead terminal (regression)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('piped stdin (no TTY)', () => {
    it('exits 0 when stdin is an empty pipe — previously hung forever', async () => {
      const env = await isolatedEnv(dir);
      const result = await runPipedChat('', env);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS + 5_000);

    it('runs the piped /doctor command, then exits 0 — previously hung forever', async () => {
      const env = await isolatedEnv(dir);
      const result = await runPipedChat('/doctor\r', env);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('System diagnostics');
    }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS + 5_000);

    it('exits 0 when a bare `q` arrives over the pipe', async () => {
      const env = await isolatedEnv(dir);
      const result = await runPipedChat('q\r', env);
      expect(result.timedOut).toBe(false);
      expect(result.exitCode).toBe(0);
    }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS + 5_000);
  });

  describe('real TTY (PTY)', () => {
    it('/exit exits 0', async () => {
      const env = await isolatedEnv(dir);
      const result = await runPtyChat(
        {
          steps: [
            { op: 'wait', text: 'wa>', timeout: 15 },
            { op: 'send', data: '/exit\r' },
            { op: 'exit', timeout: 15, expectCode: 0 },
          ],
        },
        env,
      );
      expect(result.killed).toBe(false);
      expect(result.exitCode).toBe(0);
    }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS + 5_000);

    it('bare `q` exits 0', async () => {
      const env = await isolatedEnv(dir);
      const result = await runPtyChat(
        {
          steps: [
            { op: 'wait', text: 'wa>', timeout: 15 },
            { op: 'send', data: 'q\r' },
            { op: 'exit', timeout: 15, expectCode: 0 },
          ],
        },
        env,
      );
      expect(result.killed).toBe(false);
      expect(result.exitCode).toBe(0);
    }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS + 5_000);

    it('Ctrl+P opens the quick-actions palette, Esc dismisses, session continues', async () => {
      const env = await isolatedEnv(dir);
      const result = await runPtyChat(
        {
          steps: [
            { op: 'wait', text: 'wa>', timeout: 15 },
            { op: 'send', data: '\x10' }, // Ctrl+P
            { op: 'wait', text: 'QUICK ACTIONS (Ctrl+P)', timeout: 10 },
            { op: 'send', data: '\x1b' }, // Esc dismisses
            // Esc decodes with a 500ms escape-sequence timeout — wait past it
            // before the next key or the keystrokes get combined (meta).
            { op: 'sleep', ms: 700 },
            { op: 'send', data: '/exit\r' },
            { op: 'exit', timeout: 15, expectCode: 0 },
          ],
        },
        env,
      );
      expect(result.killed).toBe(false);
      expect(result.exitCode).toBe(0);
      // outputTail only keeps the *last* 32KB — after Esc dismissed the palette
      // the final frames no longer show it. The driver's step log does.
      const paletteWait = result.steps.find((s) => s.op === 'wait' && (s.detail ?? '').includes('QUICK ACTIONS'));
      expect(paletteWait?.ok).toBe(true);
    }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS + 10_000);

    it('a dead terminal (PTY master closed) exits gracefully — previously hung or crashed exit 1', async () => {
      const env = await isolatedEnv(dir);
      const result = await runPtyChat(
        {
          steps: [
            { op: 'wait', text: 'wa>', timeout: 15 },
            { op: 'closemaster' },
            { op: 'exit', timeout: 15, expectCode: 0 },
          ],
        },
        env,
      );
      // killed=true would mean the app ignored the dead terminal and had to be
      // SIGKILLed by the driver — the exact hang this suite guards against.
      expect(result.killed).toBe(false);
      expect(result.exitCode).toBe(0);
    }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS + 5_000);

    it('survives a window resize and still exits 0 on /exit', async () => {
      const env = await isolatedEnv(dir);
      const result = await runPtyChat(
        {
          steps: [
            { op: 'wait', text: 'wa>', timeout: 15 },
            { op: 'resize', cols: 80, rows: 24 },
            { op: 'sleep', ms: 500 },
            { op: 'send', data: '/exit\r' },
            { op: 'exit', timeout: 15, expectCode: 0 },
          ],
        },
        env,
      );
      expect(result.killed).toBe(false);
      expect(result.exitCode).toBe(0);
    }, STARTUP_TIMEOUT_MS + EXIT_TIMEOUT_MS + 5_000);
  });
});
