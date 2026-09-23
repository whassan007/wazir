import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as nodePty from 'node-pty';
import { Terminal } from '@xterm/headless';
import { childEnvironment } from './process.js';

/**
 * A persistent, PTY-backed interactive shell session.
 *
 * Unlike the one-shot `shell` tool (spawn, collect stdout/stderr, wait for
 * exit), a TerminalSession stays alive across multiple `send()` calls, so an
 * agent can drive REPLs, watch-mode processes, or a long build and read back
 * incremental output the way a human at a terminal would.
 *
 * Two independent memory stores back this session:
 *  - `scrollback`: an @xterm/headless virtual screen the raw PTY stream is
 *    fed into. Escape sequences (cursor moves, color codes, screen clears)
 *    are fully interpreted here, so reading it back gives rendered text, not
 *    ANSI soup — this is what "zero-scrollback headless PTY" buys: the agent
 *    is isolated from terminal protocol complexity entirely.
 *  - `pending`: a separate, append-only sanitized string of output produced
 *    since the last `send()`/`read()` call, with running byte and newline
 *    counters maintained incrementally as data arrives (not recomputed by
 *    re-scanning the buffer). It is cleared on read, so memory use tracks
 *    unread output, not total session lifetime output — a long session that
 *    is polled regularly never accumulates unbounded pending state, even
 *    though `scrollback` (bounded separately) keeps a longer history.
 */

const CSI_OSC_STRIP = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[a-zA-Z]|\u001b[()][0-9A-Za-z]|\u001b[=>]|\r(?!\n)/g;

function sanitizeChunk(raw: string): string {
  // Strips OSC (terminal title etc.), CSI (cursor/color/clear) sequences and
  // bare carriage returns (overwrite-in-place redraws) so a chunk written
  // straight into the model's context can't smuggle control bytes into it.
  // This is intentionally a cheap streaming pass over the *pending* stream —
  // the authoritative rendered view lives in `scrollback` (the xterm buffer),
  // which processes the same raw bytes through a real terminal emulator.
  return raw.replace(CSI_OSC_STRIP, '');
}

export interface TerminalSessionOptions {
  cwd: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  scrollbackLines?: number;
  shell?: string;
}

export type ReadinessTier = 'STDIN_WAIT' | 'PROMPT_MARKER' | 'IDLE_INFERRED' | 'TIMEOUT';

export interface SendResult {
  output: string;
  readiness: ReadinessTier;
  exitCode?: number;
  byteLength: number;
  newlineCount: number;
}

const IDLE_SETTLE_MS = 200;
const DEFAULT_MAX_WAIT_MS = 30_000;

export class TerminalSession {
  readonly id: string;
  private pty: nodePty.IPty;
  private terminal: Terminal;
  private pending = '';
  private pendingBytes = 0;
  private pendingNewlines = 0;
  private lastDataAt = Date.now();
  private disposed = false;
  private readonly marker: string;
  private markerHit: { exitCode: number } | undefined;

  constructor(options: TerminalSessionOptions) {
    this.id = `term-${randomBytes(6).toString('hex')}`;
    this.marker = `\u0001WAZIR:${randomBytes(8).toString('hex')}`;
    this.terminal = new Terminal({
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      scrollback: options.scrollbackLines ?? 2000,
      allowProposedApi: true,
    });

    const project = path.resolve(options.cwd);
    const wazirTmp = path.join(project, '.wazir', 'tmp');
    const wazirHome = path.join(project, '.wazir', 'home');
    try {
      if (!existsSync(wazirTmp)) mkdirSync(wazirTmp, { recursive: true });
      if (!existsSync(wazirHome)) mkdirSync(wazirHome, { recursive: true });
    } catch {
      // best effort; falls back to host TMPDIR/HOME below if creation failed
    }
    const normalizedEnv: Record<string, string> = {};
    if (existsSync(wazirTmp)) normalizedEnv.TMPDIR = wazirTmp;
    if (existsSync(wazirHome)) normalizedEnv.HOME = wazirHome;

    const shell = options.shell ?? (process.platform === 'win32' ? 'powershell.exe' : 'bash');
    const args = process.platform === 'win32' ? [] : ['--noprofile'];
    // PROMPT_COMMAND fires after every command completes (before the next
    // prompt is drawn), so a marker printed there is an exact readiness
    // signal, not a heuristic — the shell only runs it once it's back at the
    // top of its read loop. `\u0001` is a control byte a shell prompt would
    // never legitimately emit into its own output, so a false-positive match
    // against the program's own stdout is not realistic.
    const promptCommand = `printf '${this.marker}:%d\\n' "$?"`;

    this.pty = nodePty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
      cwd: options.cwd,
      env: childEnvironment({
        ...normalizedEnv,
        ...(options.env ?? {}),
        PS1: '',
        PROMPT_COMMAND: promptCommand,
      }) as Record<string, string>,
    });

    this.pty.onData((data: string) => this.onData(data));
    TerminalSessionRegistry.register(this);
  }

  private onData(data: string): void {
    this.lastDataAt = Date.now();
    this.terminal.write(data);

    const markerIdx = data.indexOf(this.marker);
    if (markerIdx !== -1) {
      const after = data.slice(markerIdx + this.marker.length);
      const match = /^:(\d+)/.exec(after);
      if (match) this.markerHit = { exitCode: Number(match[1]) };
      data = data.slice(0, markerIdx);
    }

    const clean = sanitizeChunk(data);
    if (clean.length === 0) return;
    this.pending += clean;
    this.pendingBytes += Buffer.byteLength(clean, 'utf8');
    for (const ch of clean) if (ch === '\n') this.pendingNewlines++;
  }

  /** Linux-only tier-1 readiness check: is the foreground shell blocked reading stdin? */
  private stdinWaitEvidence(): boolean {
    if (process.platform !== 'linux') return false;
    try {
      const stat = readFileSync(`/proc/${this.pty.pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ')[0];
      if (state !== 'S') return false; // not sleeping = actively running something
      const wchan = readFileSync(`/proc/${this.pty.pid}/wchan`, 'utf8');
      return /read|wait|poll|select|pipe/i.test(wchan);
    } catch {
      return false;
    }
  }

  /**
   * Writes `input` to the session and waits for the shell to settle before
   * returning, using the readiness tiers in order of confidence:
   *   1. STDIN_WAIT   — /proc evidence the shell is blocked on stdin (Linux only, advisory)
   *   2. PROMPT_MARKER — the injected PROMPT_COMMAND marker was observed (exact, cross-platform)
   *   3. IDLE_INFERRED — no output for IDLE_SETTLE_MS even without a marker
   *      (a full-screen program can swallow PROMPT_COMMAND's own output)
   *   4. TIMEOUT      — maxWaitMs elapsed with none of the above; the command
   *      may still be running (e.g. a long build) — this is not a failure.
   */
  async send(input: string, options: { maxWaitMs?: number; newline?: boolean } = {}): Promise<SendResult> {
    if (this.disposed) throw new Error('TERMINAL_SESSION_DISPOSED');
    this.markerHit = undefined;
    const startPending = this.pending.length;
    void startPending;
    this.pty.write(options.newline === false ? input : `${input}\r`);

    const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      if (this.markerHit) {
        return this.flush('PROMPT_MARKER', this.markerHit.exitCode);
      }
      if (this.stdinWaitEvidence() && Date.now() - this.lastDataAt > 20) {
        return this.flush('STDIN_WAIT');
      }
      if (Date.now() - this.lastDataAt >= IDLE_SETTLE_MS) {
        return this.flush('IDLE_INFERRED');
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.flush('TIMEOUT');
  }

  /** Reads and clears pending output without sending anything. */
  read(): SendResult {
    return this.flush(Date.now() - this.lastDataAt >= IDLE_SETTLE_MS ? 'IDLE_INFERRED' : 'TIMEOUT');
  }

  private flush(readiness: ReadinessTier, exitCode?: number): SendResult {
    const result: SendResult = {
      output: this.pending,
      readiness,
      exitCode,
      byteLength: this.pendingBytes,
      newlineCount: this.pendingNewlines,
    };
    this.pending = '';
    this.pendingBytes = 0;
    this.pendingNewlines = 0;
    return result;
  }

  /** The full rendered session history, oldest first — independent of `pending`. */
  scrollbackText(): string {
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trailing blank lines are the unused rows of the virtual screen, not session content.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n');
  }

  /**
   * Attempts a graceful shutdown (SIGTERM to the process group) and escalates
   * to SIGKILL if the session hasn't exited within `disposeGraceMs`. Safe to
   * call more than once.
   */
  async dispose(disposeGraceMs = 2000): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    TerminalSessionRegistry.unregister(this);

    const pid = this.pty.pid;
    let exited = false;
    this.pty.onExit(() => { exited = true; });

    try {
      // Negative pid targets the whole process group node-pty put the shell
      // in, so a foreground job the shell spawned dies too, not just bash.
      process.kill(-pid, 'SIGTERM');
    } catch {
      try { this.pty.kill('SIGTERM'); } catch { /* already gone */ }
    }

    const deadline = Date.now() + disposeGraceMs;
    while (!exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!exited) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
      try { this.pty.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }
}

/**
 * Tracks every live session so a process crash or signal doesn't leave PTY
 * children running forever. Wazir has no hot-swappable plugin kernel to hang
 * this off of, so this is a plain module-level registry with exit/signal
 * hooks instead — the same end state (no orphaned PTYs survive process
 * death), reached without inventing infrastructure the rest of the codebase
 * doesn't have.
 */
class TerminalSessionRegistryImpl {
  private sessions = new Set<TerminalSession>();
  private hooked = false;

  register(session: TerminalSession): void {
    this.sessions.add(session);
    this.hookOnce();
  }

  unregister(session: TerminalSession): void {
    this.sessions.delete(session);
  }

  private hookOnce(): void {
    if (this.hooked) return;
    this.hooked = true;
    const killAllSync = () => {
      for (const session of this.sessions) {
        try { (session as unknown as { pty: nodePty.IPty }).pty.kill('SIGKILL'); } catch { /* ignore */ }
      }
    };
    process.once('exit', killAllSync);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(sig, () => {
        killAllSync();
        process.exit(1);
      });
    }
  }
}

export const TerminalSessionRegistry = new TerminalSessionRegistryImpl();
