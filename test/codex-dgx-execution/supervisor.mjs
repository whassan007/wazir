import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const EVIDENCE_DIR = '/home/wael/Code/Wazir/test/codex-dgx-execution';
export const CHECKPOINTS_DIR = path.join(EVIDENCE_DIR, 'checkpoints');
export const TRACES_FILE = path.join(EVIDENCE_DIR, 'execution-traces.jsonl');
export const LIVE_LOG_FILE = path.join(EVIDENCE_DIR, 'execution-live.log');
export const HANDOFF_FILE = path.join(EVIDENCE_DIR, 'HANDOFF.md');
export const HANDOFF_HISTORY_FILE = path.join(EVIDENCE_DIR, 'handoff-history.md');
export const STATE_FILE = path.join(EVIDENCE_DIR, 'run-state.json');

export const GLOBAL_BUDGET_MS = 45 * 60 * 1000; // 45 minutes
export const CLEANUP_RESERVE_MS = 3 * 60 * 1000; // 3 minutes
export const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB per stream

export function ensureDirectories() {
  fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
  const requiredFiles = [
    'HANDOFF.md',
    'handoff-history.md',
    'execution-live.log',
    'model-verification.md',
    'baseline.csv',
    'execution-traces.jsonl',
    'usability-findings.md',
    'observability-findings.md',
    'issues-ranked.md',
    'repairs.md',
    'post-repair.csv',
    'FINAL-REPORT.md',
  ];
  for (const f of requiredFiles) {
    const p = path.join(EVIDENCE_DIR, f);
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, '', 'utf8');
    }
  }
}

export function loadOrInitState() {
  ensureDirectories();
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      // fall through
    }
  }
  const nowWall = Date.now();
  const state = {
    runId: `codex-dgx-${nowWall}`,
    startEpochMs: nowWall,
    checkpointCounter: 0,
    selectedModel: 'UNSET',
    wazirVersion: '0.2.5',
    gitBranch: 'improve/gemini-execution-integrity',
    gitCommit: 'f6a6ce708347f64250527788f69a7bd7b40d2d4e',
    stopCondition: null,
    consecutiveTimeouts: 0,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export function saveState(state) {
  const tmp = `${STATE_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

export function getElapsedMs(state) {
  return Math.max(0, Date.now() - state.startEpochMs);
}

export function getRemainingGlobalMs(state) {
  return Math.max(0, GLOBAL_BUDGET_MS - getElapsedMs(state));
}

export function formatTimeTag() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mmm = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mmm}`;
}

export function logLive(category, lines) {
  ensureDirectories();
  const body = Array.isArray(lines) ? lines.join('\n') : String(lines);
  const entry = `[${formatTimeTag()}] CODEX | ${category}\n${body}\n\n`;
  fs.appendFileSync(LIVE_LOG_FILE, entry, 'utf8');
  process.stdout.write(entry);
}

/**
 * Read /proc/<pid>/stat and extract fields:
 * pid, comm, state, ppid, pgrp, session, ..., starttime (field 22, 1-indexed)
 */
export function readProcStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen === -1) return null;
    const comm = raw.slice(raw.indexOf('(') + 1, closeParen);
    const rest = raw.slice(closeParen + 2).trim().split(/\s+/);
    // rest[0] is state (field 3), rest[1] is ppid (field 4), rest[2] is pgrp (field 5), rest[3] is session (field 6)
    // rest[19] is starttime (field 22)
    return {
      pid: Number(pid),
      comm,
      state: rest[0],
      ppid: Number(rest[1]),
      pgid: Number(rest[2]),
      sid: Number(rest[3]),
      starttime: rest[19],
    };
  } catch {
    return null;
  }
}

/**
 * Discover all current processes in /proc that either:
 * - belong to targetPgid, OR
 * - are descendants (via ppid chain) of rootPid
 */
export function snapshotOwnedProcesses(rootPid, targetPgid, knownMap = new Map()) {
  const allProcs = new Map();
  try {
    const entries = fs.readdirSync('/proc');
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const st = readProcStat(pid);
      if (st) {
        allProcs.set(pid, st);
      }
    }
  } catch {
    // ignore
  }

  const owned = new Map(knownMap);
  const rootStat = allProcs.get(rootPid);
  if (rootStat) {
    owned.set(rootPid, rootStat);
  }

  // Add any process with matching pgid (if targetPgid > 1 and not supervisor's own pgid)
  const supervisorStat = readProcStat(process.pid);
  const supervisorPgid = supervisorStat ? supervisorStat.pgid : process.pid;

  if (targetPgid && targetPgid > 1 && targetPgid !== supervisorPgid) {
    for (const [pid, st] of allProcs.entries()) {
      if (st.pgid === targetPgid && pid !== process.pid) {
        owned.set(pid, st);
      }
    }
  }

  // Traverse PPID chains iteratively
  let added = true;
  while (added) {
    added = false;
    for (const [pid, st] of allProcs.entries()) {
      if (!owned.has(pid) && owned.has(st.ppid) && pid !== process.pid) {
        owned.set(pid, st);
        added = true;
      }
    }
  }

  return owned;
}

export class ProcessSupervisor {
  constructor(state, options = {}) {
    this.state = state;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.activeRegistry = new Map(); // operationId -> info
    this.traceFile = options.traceFile ?? TRACES_FILE;
    this.stop11Triggered = false;
    this.stop12Triggered = false;
    this.interrupted = false;

    if (options.installSignalHandlers !== false) {
      const onSig = async (sig) => {
        if (this.interrupted) return;
        this.interrupted = true;
        logLive('INTERRUPTION', `Received ${sig}. Cancelling owned process trees and writing handoff.`);
        await this.cancelAll(`SIGNAL_${sig}`);
      };
      process.once('SIGINT', () => onSig('SIGINT'));
      process.once('SIGTERM', () => onSig('SIGTERM'));
    }
  }

  emitTrace(event, record) {
    ensureDirectories();
    const payload = {
      event,
      run_id: this.state.runId,
      task_id: record.taskId ?? 'N/A',
      operation_id: record.operationId,
      parent_operation_id: record.parentOperationId ?? null,
      pid: record.pid ?? null,
      pgid: record.pgid ?? null,
      monotonic_elapsed_ms: Math.round(performance.now()),
      run_elapsed_ms: getElapsedMs(this.state),
      timestamp: new Date().toISOString(),
      deadline_ms: record.effectiveDeadlineMs ?? null,
      executable: record.executable ?? null,
      exit_code: record.exitCode ?? null,
      signal: record.signal ?? null,
      error_summary: record.errorSummary ?? null,
      ...record.extra,
    };
    fs.appendFileSync(this.traceFile, JSON.stringify(payload) + '\n', 'utf8');
  }

  getActiveRegistrySummary() {
    if (this.activeRegistry.size === 0) return 'None (0 active owned processes; all prior processes reaped)';
    const items = [];
    for (const [opId, info] of this.activeRegistry.entries()) {
      items.push(`${opId} (PID=${info.pid}, PGID=${info.pgid}, cmd=${info.executable}, deadline=${info.effectiveDeadlineMs}ms)`);
    }
    return items.join('; ');
  }

  async cancelAll(reason = 'GLOBAL_STOP') {
    const promises = [];
    for (const [, info] of this.activeRegistry.entries()) {
      if (info.cancelFn) {
        promises.push(info.cancelFn(reason));
      }
    }
    await Promise.allSettled(promises);
  }

  /**
   * Launch a supervised child process with all 4 mandatory nested deadlines:
   * 1. spawnTimeoutMs (default 10000ms)
   * 2. idleTimeoutMs (default 15000ms)
   * 3. wallTimeoutMs (required operation ceiling)
   * 4. parentDeadlineMs / phaseDeadlineMs / global remaining minus reserve
   * Plus optional firstTokenTimeoutMs & isTokenOutput predicate for inference.
   */
  async runSupervised(spec) {
    const {
      operationId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      parentOperationId = null,
      taskId = 'DIAGNOSTIC',
      executable,
      args = [],
      cwd = '/home/wael/Code/Wazir',
      env = process.env,
      spawnTimeoutMs = 10000,
      idleTimeoutMs = 15000,
      wallTimeoutMs = 20000,
      parentDeadlineMs = Infinity,
      phaseDeadlineMs = Infinity,
      firstTokenTimeoutMs = null,
      isFirstToken = null,
      onStdoutChunk = null,
      onStderrChunk = null,
      cooperativeCancel = null,
      stdinData = null,
      simulateCleanupFailure = false,
      ignoreReserve = false,
    } = spec;

    if (this.stop11Triggered) {
      throw new Error('STOP-11 already active: PROCESS_CLEANUP_BLOCKED');
    }

    // Check fork concurrency budget (Section 13.4 & STOP-12)
    if (this.activeRegistry.size >= this.maxConcurrent) {
      this.stop12Triggered = true;
      this.emitTrace('PROCESS_CLEANUP_FAILED', {
        operationId,
        parentOperationId,
        taskId,
        executable,
        errorSummary: `PROCESS_BUDGET_EXCEEDED: active=${this.activeRegistry.size}, max=${this.maxConcurrent}`,
      });
      throw new Error(`STOP-12: PROCESS_BUDGET_EXCEEDED (active=${this.activeRegistry.size}, max=${this.maxConcurrent})`);
    }

    const remainingGlobal = getRemainingGlobalMs(this.state);
    const availableGlobal = ignoreReserve ? remainingGlobal : Math.max(0, remainingGlobal - CLEANUP_RESERVE_MS);
    const effectiveDeadlineMs = Math.min(
      wallTimeoutMs,
      parentDeadlineMs,
      phaseDeadlineMs,
      availableGlobal
    );

    if (effectiveDeadlineMs <= 0) {
      throw new Error('STOP-01: Insufficient global budget remaining to start operation');
    }

    const opStartMono = performance.now();
    this.emitTrace('PROCESS_SPAWN_REQUESTED', {
      operationId,
      parentOperationId,
      taskId,
      executable,
      effectiveDeadlineMs,
      extra: { args_count: args.length, spawn_timeout_ms: spawnTimeoutMs, idle_timeout_ms: idleTimeoutMs },
    });

    return new Promise((resolve) => {
      let settled = false;
      let cancelling = false;
      let cancelReason = null;
      let timeoutType = null;
      let firstTokenAtMono = null;
      let readyAtMono = null;
      let progressEmitted = false;
      let lastActivityMono = performance.now();
      let stdoutBuf = Buffer.alloc(0);
      let stderrBuf = Buffer.alloc(0);
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let exitCode = null;
      let exitSignal = null;
      let childExited = false;
      let childExitResolver = null;
      const childExitPromise = new Promise((r) => {
        childExitResolver = r;
      });

      const knownOwnedProcs = new Map();
      let child = null;
      let pid = null;
      let pgid = null;

      let spawnTimer = null;
      let idleTimer = null;
      let wallTimer = null;
      let firstTokenTimer = null;
      let heartbeatTimer = null;

      const clearAllTimers = () => {
        if (spawnTimer) clearTimeout(spawnTimer);
        if (idleTimer) clearTimeout(idleTimer);
        if (wallTimer) clearTimeout(wallTimer);
        if (firstTokenTimer) clearTimeout(firstTokenTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        spawnTimer = idleTimer = wallTimer = firstTokenTimer = heartbeatTimer = null;
      };

      const settleOnce = (result) => {
        if (settled) return;
        settled = true;
        clearAllTimers();
        this.activeRegistry.delete(operationId);
        resolve(result);
      };

      const terminateAndVerify = async (reason, tType = null) => {
        if (cancelling) return;
        cancelling = true;
        cancelReason = reason;
        if (tType) timeoutType = tType;

        clearAllTimers();

        if (tType) {
          this.emitTrace('PROCESS_TIMEOUT', {
            operationId,
            parentOperationId,
            taskId,
            pid,
            pgid,
            executable,
            effectiveDeadlineMs,
            errorSummary: `${tType}: ${reason}`,
          });
        }

        this.emitTrace('PROCESS_CANCEL_REQUESTED', {
          operationId,
          parentOperationId,
          taskId,
          pid,
          pgid,
          executable,
          effectiveDeadlineMs,
          errorSummary: reason,
        });

        // 1. Cooperative cancellation if supported
        if (typeof cooperativeCancel === 'function' && child && !childExited) {
          try {
            await Promise.race([
              Promise.resolve(cooperativeCancel(child)),
              new Promise((r) => setTimeout(r, 500)),
            ]);
          } catch {
            // ignore cooperative cancel error
          }
        }

        // Snapshot owned process tree BEFORE sending signals
        if (pid) {
          const snap = snapshotOwnedProcesses(pid, pgid, knownOwnedProcs);
          for (const [k, v] of snap.entries()) knownOwnedProcs.set(k, v);
        }

        const supervisorStat = readProcStat(process.pid);
        const supervisorPgid = supervisorStat ? supervisorStat.pgid : process.pid;

        // 2. Send SIGTERM to verified owned process group and tracked descendants
        if (pid) {
          this.emitTrace('PROCESS_SIGTERM', {
            operationId,
            parentOperationId,
            taskId,
            pid,
            pgid,
            executable,
            effectiveDeadlineMs,
            errorSummary: `Sending SIGTERM (${knownOwnedProcs.size} tracked procs)`,
          });

          if (pgid && pgid > 1 && pgid !== supervisorPgid) {
            try {
              process.kill(-pgid, 'SIGTERM');
            } catch {
              // ESRCH ok
            }
          }
          for (const [targetPid, info] of knownOwnedProcs.entries()) {
            const cur = readProcStat(targetPid);
            if (cur && cur.starttime === info.starttime && targetPid !== process.pid) {
              try {
                process.kill(targetPid, 'SIGTERM');
              } catch {
                // ESRCH ok
              }
            }
          }
        }

        // 3. Wait up to 3 seconds for graceful termination
        const graceDeadline = performance.now() + 3000;
        while (performance.now() < graceDeadline) {
          if ( pid ) {
            const snap = snapshotOwnedProcesses(pid, pgid, knownOwnedProcs);
            for (const [k, v] of snap.entries()) knownOwnedProcs.set(k, v);
          }
          const alive = [];
          for (const [targetPid, info] of knownOwnedProcs.entries()) {
            const cur = readProcStat(targetPid);
            if (cur && cur.starttime === info.starttime && cur.state !== 'Z') {
              alive.push(targetPid);
            }
          }
          if (alive.length === 0 && childExited) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        // 4. Escalate to SIGKILL if any verified owned processes remain
        const remainingBeforeKill = [];
        if (pid) {
          const snap = snapshotOwnedProcesses(pid, pgid, knownOwnedProcs);
          for (const [k, v] of snap.entries()) knownOwnedProcs.set(k, v);
          for (const [targetPid, info] of knownOwnedProcs.entries()) {
            const cur = readProcStat(targetPid);
            if (cur && cur.starttime === info.starttime && cur.state !== 'Z') {
              remainingBeforeKill.push(targetPid);
            }
          }
        }

        if (remainingBeforeKill.length > 0 || !childExited) {
          this.emitTrace('PROCESS_SIGKILL', {
            operationId,
            parentOperationId,
            taskId,
            pid,
            pgid,
            executable,
            effectiveDeadlineMs,
            errorSummary: `Escalating to SIGKILL for PIDs: [${remainingBeforeKill.join(', ')}]`,
          });

          if (pgid && pgid > 1 && pgid !== supervisorPgid) {
            try {
              process.kill(-pgid, 'SIGKILL');
            } catch {
              // ignore
            }
          }
          for (const targetPid of remainingBeforeKill) {
            const info = knownOwnedProcs.get(targetPid);
            const cur = readProcStat(targetPid);
            if (cur && info && cur.starttime === info.starttime && targetPid !== process.pid) {
              try {
                process.kill(targetPid, 'SIGKILL');
              } catch {
                // ignore
              }
            }
          }

          // Wait up to 2 additional seconds for SIGKILL termination/reaping
          await Promise.race([
            childExitPromise,
            new Promise((r) => setTimeout(r, 2000)),
          ]);
        }

        // 5. Spend up to 5 seconds verifying cleanup of all owned processes and zombies
        const verifyDeadline = performance.now() + 5000;
        let residualPids = [];
        while (performance.now() < verifyDeadline) {
          residualPids = [];
          for (const [targetPid, info] of knownOwnedProcs.entries()) {
            const cur = readProcStat(targetPid);
            if (cur && cur.starttime === info.starttime) {
              residualPids.push(targetPid);
            }
          }
          if (simulateCleanupFailure) {
            residualPids = [pid || 999999];
          }
          if (residualPids.length === 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }

        try {
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          child?.stdin?.destroy();
        } catch {
          // ignore
        }

        const durationMs = Math.round(performance.now() - opStartMono);

        if (residualPids.length > 0) {
          this.stop11Triggered = true;
          this.emitTrace('PROCESS_CLEANUP_FAILED', {
            operationId,
            parentOperationId,
            taskId,
            pid,
            pgid,
            executable,
            effectiveDeadlineMs,
            exitCode,
            signal: exitSignal,
            errorSummary: `PROCESS_CLEANUP_BLOCKED: residual PIDs [${residualPids.join(', ')}]`,
          });
          settleOnce({
            ok: false,
            operationId,
            taskId,
            pid,
            pgid,
            exitCode,
            signal: exitSignal,
            stdout: stdoutBuf.toString('utf8'),
            stderr: stderrBuf.toString('utf8'),
            stdoutTruncated,
            stderrTruncated,
            durationMs,
            firstTokenMs: firstTokenAtMono ? Math.round(firstTokenAtMono - opStartMono) : null,
            readyMs: readyAtMono ? Math.round(readyAtMono - opStartMono) : null,
            timedOut: Boolean(timeoutType),
            timeoutType: timeoutType || 'PROCESS_CLEANUP_BLOCKED',
            cancelled: true,
            cancelReason: reason,
            cleanupVerified: false,
            residualPids,
          });
          return;
        }

        this.emitTrace('PROCESS_REAPED', {
          operationId,
          parentOperationId,
          taskId,
          pid,
          pgid,
          executable,
          effectiveDeadlineMs,
          exitCode,
          signal: exitSignal,
          extra: { duration_ms: durationMs, reason },
        });

        settleOnce({
          ok: false,
          operationId,
          taskId,
          pid,
          pgid,
          exitCode,
          signal: exitSignal,
          stdout: stdoutBuf.toString('utf8'),
          stderr: stderrBuf.toString('utf8'),
          stdoutTruncated,
          stderrTruncated,
          durationMs,
          firstTokenMs: firstTokenAtMono ? Math.round(firstTokenAtMono - opStartMono) : null,
          readyMs: readyAtMono ? Math.round(readyAtMono - opStartMono) : null,
          timedOut: Boolean(timeoutType),
          timeoutType,
          cancelled: true,
          cancelReason: reason,
          cleanupVerified: true,
          residualPids: [],
        });
      };

      // Spawn timeout timer
      spawnTimer = setTimeout(() => {
        if (!readyAtMono && !settled) {
          terminateAndVerify(`Spawn/readiness exceeded ${spawnTimeoutMs}ms`, 'SPAWN_TIMEOUT');
        }
      }, Math.min(spawnTimeoutMs, effectiveDeadlineMs));

      // Wall-clock / inherited deadline timer
      wallTimer = setTimeout(() => {
        if (!settled) {
          const isInherited = effectiveDeadlineMs < wallTimeoutMs;
          terminateAndVerify(
            `Wall-clock deadline exceeded (${effectiveDeadlineMs}ms)`,
            isInherited ? 'INHERITED_DEADLINE_TIMEOUT' : 'EXECUTION_TIMEOUT'
          );
        }
      }, effectiveDeadlineMs);

      // First-token timer (if configured)
      if (firstTokenTimeoutMs && firstTokenTimeoutMs > 0) {
        firstTokenTimer = setTimeout(() => {
          if (!firstTokenAtMono && !settled) {
            terminateAndVerify(`First-token deadline exceeded (${firstTokenTimeoutMs}ms)`, 'FIRST_TOKEN_TIMEOUT');
          }
        }, Math.min(firstTokenTimeoutMs, effectiveDeadlineMs));
      }

      // Idle timer check loop (every 100ms so we never reset on supervisor heartbeats)
      if (idleTimeoutMs && idleTimeoutMs > 0) {
        idleTimer = setInterval(() => {
          if (settled || cancelling) return;
          const idleDuration = performance.now() - lastActivityMono;
          if (idleDuration >= idleTimeoutMs) {
            terminateAndVerify(`Idle/no-progress deadline exceeded (${idleTimeoutMs}ms)`, 'IDLE_TIMEOUT');
          }
        }, Math.min(100, Math.max(20, Math.floor(idleTimeoutMs / 5))));
      }

      // 5-second supervisor heartbeat (Section 12 & 13.2: does NOT reset lastActivityMono!)
      heartbeatTimer = setInterval(() => {
        if (settled) return;
        const elapsedS = ((performance.now() - opStartMono) / 1000).toFixed(1);
        const remOpS = Math.max(0, (effectiveDeadlineMs - (performance.now() - opStartMono)) / 1000).toFixed(1);
        const remGlobS = (getRemainingGlobalMs(this.state) / 1000).toFixed(1);
        const idleS = ((performance.now() - lastActivityMono) / 1000).toFixed(1);
        logLive('HEARTBEAT', [
          `Current operation: ${operationId} (task=${taskId}, cmd=${executable})`,
          `Elapsed time: ${elapsedS}s | Remaining op timeout: ${remOpS}s | Remaining global budget: ${remGlobS}s`,
          `Last observed progress: ${idleS}s ago | Process status: PID=${pid} PGID=${pgid} running`,
        ]);
      }, 5000);

      try {
        child = spawn(executable, args, {
          cwd,
          env,
          detached: true,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (err) {
        this.emitTrace('PROCESS_CLEANUP_FAILED', {
          operationId,
          parentOperationId,
          taskId,
          executable,
          effectiveDeadlineMs,
          errorSummary: `Spawn error: ${err.message}`,
        });
        settleOnce({
          ok: false,
          operationId,
          taskId,
          pid: null,
          pgid: null,
          exitCode: null,
          signal: null,
          stdout: '',
          stderr: err.message,
          durationMs: Math.round(performance.now() - opStartMono),
          timedOut: false,
          timeoutType: null,
          cancelled: false,
          cleanupVerified: true,
          residualPids: [],
        });
        return;
      }

      child.on('spawn', () => {
        pid = child.pid;
        const st = readProcStat(pid);
        pgid = st ? st.pgid : pid;
        if (st) knownOwnedProcs.set(pid, st);

        readyAtMono = performance.now();
        lastActivityMono = readyAtMono;
        if (spawnTimer) {
          clearTimeout(spawnTimer);
          spawnTimer = null;
        }

        this.activeRegistry.set(operationId, {
          operationId,
          taskId,
          pid,
          pgid,
          executable,
          effectiveDeadlineMs,
          cancelFn: (r) => terminateAndVerify(r, null),
        });

        this.emitTrace('PROCESS_STARTED', {
          operationId,
          parentOperationId,
          taskId,
          pid,
          pgid,
          executable,
          effectiveDeadlineMs,
        });

        this.emitTrace('PROCESS_READY', {
          operationId,
          parentOperationId,
          taskId,
          pid,
          pgid,
          executable,
          effectiveDeadlineMs,
          extra: { ready_ms: Math.round(readyAtMono - opStartMono) },
        });

        if (stdinData !== null && child.stdin) {
          try {
            child.stdin.write(stdinData);
            child.stdin.end();
          } catch {
            // ignore
          }
        }
      });

      const handleChunk = (chunk, isStderr) => {
        lastActivityMono = performance.now();
        if (pid) {
          const snap = snapshotOwnedProcesses(pid, pgid, knownOwnedProcs);
          for (const [k, v] of snap.entries()) knownOwnedProcs.set(k, v);
        }

        const text = chunk.toString('utf8');
        if (!firstTokenAtMono) {
          const tokenCheck = typeof isFirstToken === 'function' ? isFirstToken(text, isStderr) : (!isStderr && text.trim().length > 0);
          if (tokenCheck) {
            firstTokenAtMono = performance.now();
            if (firstTokenTimer) {
              clearTimeout(firstTokenTimer);
              firstTokenTimer = null;
            }
          }
        }

        if (!progressEmitted) {
          progressEmitted = true;
          this.emitTrace('PROCESS_PROGRESS', {
            operationId,
            parentOperationId,
            taskId,
            pid,
            pgid,
            executable,
            effectiveDeadlineMs,
            extra: { stream: isStderr ? 'stderr' : 'stdout', bytes: chunk.length },
          });
        }

        if (isStderr) {
          if (stderrBuf.length < MAX_OUTPUT_BYTES) {
            const rem = MAX_OUTPUT_BYTES - stderrBuf.length;
            stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, rem)]);
            if (chunk.length > rem) stderrTruncated = true;
          } else {
            stderrTruncated = true;
          }
          if (onStderrChunk) onStderrChunk(text);
        } else {
          if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
            const rem = MAX_OUTPUT_BYTES - stdoutBuf.length;
            stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, rem)]);
            if (chunk.length > rem) stdoutTruncated = true;
          } else {
            stdoutTruncated = true;
          }
          if (onStdoutChunk) onStdoutChunk(text);
        }
      };

      child.stdout.on('data', (chunk) => handleChunk(chunk, false));
      child.stderr.on('data', (chunk) => handleChunk(chunk, true));

      child.on('error', (err) => {
        if (!cancelling && !settled) {
          terminateAndVerify(`Process error: ${err.message}`, null);
        }
      });

      child.on('close', async (code, sig) => {
        exitCode = code;
        exitSignal = sig;
        childExited = true;
        if (childExitResolver) childExitResolver();

        if (cancelling || settled) return;
        clearAllTimers();

        this.emitTrace('PROCESS_EXITED', {
          operationId,
          parentOperationId,
          taskId,
          pid,
          pgid,
          executable,
          effectiveDeadlineMs,
          exitCode: code,
          signal: sig,
        });

        // Even when the parent process exits normally, verify no owned descendants remain!
        if (pid) {
          const snap = snapshotOwnedProcesses(pid, pgid, knownOwnedProcs);
          for (const [k, v] of snap.entries()) knownOwnedProcs.set(k, v);
        }

        const supervisorStat = readProcStat(process.pid);
        const supervisorPgid = supervisorStat ? supervisorStat.pgid : process.pid;

        // Check for any surviving descendants
        const surviving = [];
        for (const [targetPid, info] of knownOwnedProcs.entries()) {
          if (targetPid === pid) continue;
          const cur = readProcStat(targetPid);
          if (cur && cur.starttime === info.starttime && cur.state !== 'Z') {
            surviving.push(targetPid);
          }
        }

        if (surviving.length > 0) {
          // Clean up stray descendants left behind after parent exit
          if (pgid && pgid > 1 && pgid !== supervisorPgid) {
            try {
              process.kill(-pgid, 'SIGTERM');
            } catch {}
          }
          for (const sPid of surviving) {
            try {
              process.kill(sPid, 'SIGTERM');
            } catch {}
          }
          await new Promise((r) => setTimeout(r, 300));
          for (const sPid of surviving) {
            const cur = readProcStat(sPid);
            const info = knownOwnedProcs.get(sPid);
            if (cur && info && cur.starttime === info.starttime) {
              try {
                process.kill(sPid, 'SIGKILL');
              } catch {}
            }
          }
          await new Promise((r) => setTimeout(r, 200));
        }

        const residualPids = [];
        for (const [targetPid, info] of knownOwnedProcs.entries()) {
          const cur = readProcStat(targetPid);
          if (cur && cur.starttime === info.starttime) {
            residualPids.push(targetPid);
          }
        }

        const durationMs = Math.round(performance.now() - opStartMono);
        if (residualPids.length > 0) {
          this.stop11Triggered = true;
          this.emitTrace('PROCESS_CLEANUP_FAILED', {
            operationId,
            parentOperationId,
            taskId,
            pid,
            pgid,
            executable,
            effectiveDeadlineMs,
            exitCode: code,
            signal: sig,
            errorSummary: `Residual descendants after exit: [${residualPids.join(', ')}]`,
          });
          settleOnce({
            ok: false,
            operationId,
            taskId,
            pid,
            pgid,
            exitCode: code,
            signal: sig,
            stdout: stdoutBuf.toString('utf8'),
            stderr: stderrBuf.toString('utf8'),
            stdoutTruncated,
            stderrTruncated,
            durationMs,
            firstTokenMs: firstTokenAtMono ? Math.round(firstTokenAtMono - opStartMono) : null,
            readyMs: readyAtMono ? Math.round(readyAtMono - opStartMono) : null,
            timedOut: false,
            timeoutType: 'PROCESS_CLEANUP_BLOCKED',
            cancelled: false,
            cleanupVerified: false,
            residualPids,
          });
          return;
        }

        this.emitTrace('PROCESS_REAPED', {
          operationId,
          parentOperationId,
          taskId,
          pid,
          pgid,
          executable,
          effectiveDeadlineMs,
          exitCode: code,
          signal: sig,
          extra: { duration_ms: durationMs },
        });

        settleOnce({
          ok: code === 0,
          operationId,
          taskId,
          pid,
          pgid,
          exitCode: code,
          signal: sig,
          stdout: stdoutBuf.toString('utf8'),
          stderr: stderrBuf.toString('utf8'),
          stdoutTruncated,
          stderrTruncated,
          durationMs,
          firstTokenMs: firstTokenAtMono ? Math.round(firstTokenAtMono - opStartMono) : null,
          readyMs: readyAtMono ? Math.round(readyAtMono - opStartMono) : null,
          timedOut: false,
          timeoutType: null,
          cancelled: false,
          cleanupVerified: true,
          residualPids: [],
        });
      });
    });
  }
}

export function writeCheckpoint(state, supervisor, data) {
  ensureDirectories();
  state.checkpointCounter += 1;
  const cpId = String(state.checkpointCounter).padStart(4, '0');
  const nowIso = new Date().toISOString();
  const elapsedMs = getElapsedMs(state);
  const remMs = getRemainingGlobalMs(state);
  const elapsedStr = `${(elapsedMs / 1000).toFixed(1)}s (${(elapsedMs / 60000).toFixed(2)} min)`;
  const remStr = `${(remMs / 1000).toFixed(1)}s (${(remMs / 60000).toFixed(2)} min)`;

  const activeRegistryStr = supervisor ? supervisor.getActiveRegistrySummary() : 'None (0 active owned processes; all prior processes reaped)';

  const content = `# Codex Execution Checkpoint

Checkpoint ID: ${cpId}
Timestamp: ${nowIso}
Elapsed runtime: ${elapsedStr}
Remaining global budget: ${remStr}
Current phase: ${data.phase || 'UNKNOWN'}
Git branch: ${state.gitBranch}
Git commit: ${state.gitCommit}
Wazir version: ${state.wazirVersion}
Selected model: ${state.selectedModel}
Active owned processes: ${activeRegistryStr}

## Action
${data.action || 'N/A'}

## Expected Outcome
${data.expected || 'N/A'}

## Actual Outcome
${data.actual || 'N/A'}

## Analysis
${data.analysis || 'N/A'}

## Decision
${data.decision || 'N/A'}

## Files Modified
${data.filesModified || 'None'}

## Verification
${data.verification || 'N/A'}

## Stop Condition Evaluation
${data.stopCheck || 'STOP-01..STOP-12 evaluated: None triggered.'}

## Next Action
${data.nextAction || 'N/A'}

## Resume Instructions
${data.resumeInstructions || 'Inspect test/codex-dgx-execution/HANDOFF.md and continue from Next Action.'}
`;

  // Save checkpoint file
  const cpFile = path.join(CHECKPOINTS_DIR, `checkpoint-${cpId}.md`);
  fs.writeFileSync(cpFile, content, 'utf8');

  // Append to handoff-history.md
  fs.appendFileSync(HANDOFF_HISTORY_FILE, content + '\n---\n\n', 'utf8');

  // Atomically update HANDOFF.md
  const tmpHandoff = `${HANDOFF_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmpHandoff, content, 'utf8');
  fs.renameSync(tmpHandoff, HANDOFF_FILE);

  saveState(state);
  logLive('HANDOFF', `Checkpoint ${cpId} persisted (${data.phase}). Next: ${data.nextAction}`);
  return cpId;
}
