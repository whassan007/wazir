import fs from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonFileStore } from '@wazir/shared';
import {
  SelfImprovementSupervisor,
  parseImprovementModes,
  redactImprovementText,
  type ImprovementMode,
  type SupervisorState,
} from '@wazir/evaluation';
import { configDir } from './config.js';

export function supervisorDirectory(projectRoot = process.cwd()): string {
  return path.join(
    configDir(),
    'self-improvement',
    createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 20),
  );
}

export function supervisorSocket(directory: string): string {
  const digest = createHash('sha256').update(directory).digest('hex').slice(0, 32);
  if (process.platform === 'linux') {
    // Linux abstract sockets are released by the kernel even after SIGKILL.
    return '\0wazir-improve-' + digest;
  }
  return path.join(os.tmpdir(), `wazir-improve-${digest}.sock`);
}

export async function supervisorLease(directory: string): Promise<net.Server> {
  const sockPath = supervisorSocket(directory);
  if (process.platform !== 'linux' && existsSync(sockPath)) {
    const alive = await running(directory);
    if (alive) {
      throw new Error('A supervisor already owns this repository');
    }
    try {
      unlinkSync(sockPath);
    } catch {
      // ignore stale socket removal error
    }
  }
  const server = net.createServer((socket) => {
    socket.on('error', () => undefined);
    socket.end(JSON.stringify({ pid: process.pid }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}

export async function running(directory: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(supervisorSocket(directory));
    socket.setTimeout(500);
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

export function buildSystemdUserUnit(projectRoot = process.cwd(), modes = 'harden,optimize'): string {
  const nodeBin = process.execPath;
  const cliEntry = path.resolve(process.argv[1]);
  const nodeDir = path.dirname(nodeBin);
  return [
    '[Unit]',
    'Description=Wazir Continuous Self-Improvement Supervisor',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${path.resolve(projectRoot)}`,
    `Environment="PATH=${nodeDir}:/usr/local/bin:/usr/bin:/bin"`,
    `ExecStart=${nodeBin} ${cliEntry} improve start --foreground --continuous --mode ${modes}`,
    'Restart=on-failure',
    'RestartSec=15',
    'KillMode=process',
    '',
    '[Install]',
    'WantedBy=default.target',
  ].join('\n');
}

export interface SupervisorCommandOptions {
  mode?: string;
  continuous?: boolean;
  foreground?: boolean;
  json?: boolean;
  live?: boolean;
  follow?: boolean;
  interval?: string;
  maxCycles?: string;
  scope?: string;
  printSystemdUnit?: boolean;
}

export async function improvementSupervisorCommand(
  command: string,
  options: SupervisorCommandOptions = {},
): Promise<void> {
  const projectRoot = process.cwd();
  const directory = supervisorDirectory(projectRoot);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const store = new JsonFileStore(path.join(directory, 'state.json'));
  const logFile = path.join(directory, 'events.jsonl');

  if (options.printSystemdUnit) {
    console.log(buildSystemdUserUnit(projectRoot, options.mode ?? 'harden,optimize'));
    return;
  }

  if (['pause', 'resume', 'stop'].includes(command)) {
    if (command === 'resume' && !(await running(directory))) {
      const saved = await store.get<SupervisorState>('supervisor/state');
      return improvementSupervisorCommand('start', {
        ...options,
        continuous: true,
        mode: saved?.modes.join(',') ?? 'harden',
      });
    }
    await store.put(
      'supervisor/control',
      command === 'pause' ? 'pause' : command === 'stop' ? 'stop' : 'run',
    );
    const isRunning = await running(directory);
    if (command === 'stop' && isRunning) {
      for (let i = 0; i < 20; i++) {
        if (!(await running(directory))) break;
        await delay(100);
      }
    }
    const state = await store.get<SupervisorState>('supervisor/state');
    if (command === 'pause' && state && state.phase !== 'PAUSED' && !(await running(directory))) {
      state.phase = 'PAUSED';
      state.reason = 'Operator requested pause';
      state.updatedAt = new Date().toISOString();
      await store.put('supervisor/state', state);
    }
    if (command === 'stop' && state && state.phase !== 'STOPPED' && !(await running(directory))) {
      state.phase = 'STOPPED';
      state.reason = 'Operator requested stop';
      state.updatedAt = new Date().toISOString();
      await store.put('supervisor/state', state);
    }
    console.log(
      JSON.stringify({
        requested: command,
        running: await running(directory),
        phase: (await store.get<SupervisorState>('supervisor/state'))?.phase ?? 'IDLE',
        directory,
      }),
    );
    return;
  }

  if (command === 'status') {
    const maxPolls = Number(process.env.WAZIR_IMPROVE_LIVE_POLLS ?? (process.stdout.isTTY ? 0 : 1));
    let polls = 0;
    do {
      const savedState = await store.get<SupervisorState>('supervisor/state');
      const incidents = await store.list('supervisor/incidents/');
      const recommendations = await store.list('supervisor/recommendations/');
      const attempts = await store.list('supervisor/attempts/');
      console.log(
        JSON.stringify(
          {
            ...(savedState ?? {
              schema: 1,
              phase: 'IDLE',
              modes: parseImprovementModes(options.mode ?? 'harden'),
              cycles: 0,
              failures: 0,
              consecutiveFailures: 0,
            }),
            incidentsCount: incidents.length,
            recommendationsCount: recommendations.length,
            attemptsCount: attempts.length,
            running: await running(directory),
            directory,
          },
          null,
          2,
        ),
      );
      polls++;
      if (!options.live || (maxPolls > 0 && polls >= maxPolls)) break;
      await delay(2000);
    } while (options.live);
    return;
  }

  if (['failures', 'history', 'recommendations'].includes(command)) {
    const prefix =
      command === 'history'
        ? 'supervisor/attempts/'
        : command === 'recommendations'
          ? 'supervisor/recommendations/'
          : 'supervisor/incidents/';
    const entries = await store.list(prefix);
    const values = entries
      .map((entry) => entry.value)
      .sort((a: any, b: any) =>
        String(b?.lastSeen ?? b?.updatedAt ?? b?.completedAt ?? '').localeCompare(
          String(a?.lastSeen ?? a?.updatedAt ?? a?.completedAt ?? ''),
        ),
      );
    console.log(JSON.stringify(values, null, 2));
    return;
  }

  if (command === 'logs') {
    const maxFollowPolls = Number(process.env.WAZIR_IMPROVE_FOLLOW_POLLS ?? (process.stdout.isTTY ? 0 : 1));
    let polls = 0;
    let previous = '';
    do {
      const content = await fs.readFile(logFile, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return '';
      });
      if (content !== previous) {
        process.stdout.write(content.startsWith(previous) ? content.slice(previous.length) : content);
      }
      previous = content;
      polls++;
      if (!options.follow || (maxFollowPolls > 0 && polls >= maxFollowPolls)) break;
      await delay(1000);
    } while (options.follow);
    return;
  }

  if (command === 'doctor') {
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ quiet: true, readOnlyLifecycle: true });
    const models = engine.models.list().map((model) => model.id);
    const disqualifiedModels = models.filter((m) =>
      ['nvidia/nemotron-3-nano-omni', 'qwen2.5-7b-instruct'].includes(m),
    );
    const defaultScopePath = path.join(directory, 'scope.json');
    const scopes = await fs
      .access(options.scope ? path.resolve(options.scope) : defaultScopePath)
      .then(() => true)
      .catch(() => false);
    const report = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      directory,
      models,
      disqualifiedCodingModels: disqualifiedModels,
      agents: engine.agents.list().map((agent) => agent.descriptor.name),
      scopeConfigured: scopes,
      supervisorRunning: await running(directory),
      serviceInstalledByThisCommand: false,
      systemdUserUnitAvailable: process.platform === 'linux',
    };
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const modes = parseImprovementModes(options.mode ?? 'harden');
  const intervalMs = Number(options.interval ?? 60) * 1000;
  const maxCycles = Number(options.maxCycles ?? 1000);
  if (!Number.isFinite(intervalMs) || intervalMs < 1000 || intervalMs > 86_400_000) {
    throw new Error('Interval must be 1..86400 seconds');
  }
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 100_000) {
    throw new Error('Cycle budget must be 1..100000');
  }

  const defaultScopeFile = path.join(directory, 'scope.json');
  const hasDefaultScope = existsSync(defaultScopeFile);
  const scope = options.scope
    ? path.resolve(options.scope)
    : hasDefaultScope
      ? defaultScopeFile
      : undefined;

  if (command === 'start' && modes.includes('evolve') && !scope) {
    throw new Error('EVOLVE requires --scope with explicit feature authorization and independent checks');
  }

  if (command === 'start' && !options.foreground) {
    if (await running(directory)) throw new Error('A supervisor already owns this repository');
    const logHandle = await fs.open(logFile, 'a', 0o600);
    const args = [
      path.resolve(process.argv[1]),
      'improve',
      'start',
      '--foreground',
      '--mode',
      modes.join(','),
      '--interval',
      String(intervalMs / 1000),
      '--max-cycles',
      String(maxCycles),
    ];
    if (options.continuous) args.push('--continuous');
    if (scope) args.push('--scope', scope);
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      env: process.env,
    });
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.unref();
    await logHandle.close();
    for (let n = 0; n < 150; n++) {
      if (spawnError) throw spawnError;
      const state = await store.get<SupervisorState>('supervisor/state');
      if (state?.pid === child.pid && (await running(directory))) {
        console.log(JSON.stringify({ started: true, pid: child.pid, modes, directory }));
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(`Supervisor exited ${child.exitCode}; inspect ${logFile}`);
      }
      await delay(200);
    }
    if (child.pid) child.kill('SIGTERM');
    throw new Error(`Supervisor did not become ready; inspect ${logFile}`);
  }

  const lease = await supervisorLease(directory);
  const abort = new AbortController();
  const shutdown = () => abort.abort();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await store.put('supervisor/control', 'run');
    const { createEngine } = await import('./engine.js');
    const engine = await createEngine({ quiet: true, readOnlyLifecycle: true });
    const log = async (event: Record<string, unknown>) => {
      const size = await fs
        .stat(logFile)
        .then((stat) => stat.size)
        .catch(() => 0);
      if (size > 2_000_000) await fs.rename(logFile, `${logFile}.1`);
      await fs.appendFile(logFile, JSON.stringify(event) + '\n', { mode: 0o600 });
    };
    const { executeRepairScope } = await import('./improvementRepair.js');
    const supervisor = new SelfImprovementSupervisor({
      store,
      intervalMs,
      maxCycles,
      log,
      busy: async () => {
        const executions = await engine.executions.list();
        const now = Date.now();
        const activeForeground = executions.some((record) => {
          if (!['running', 'pending', 'waiting_approval'].includes(record.execution.status)) {
            return false;
          }
          const rawTs =
            (record.execution as unknown as Record<string, unknown>).updatedAt ??
            record.execution.startedAt ??
            record.execution.createdAt;
          const parsed = typeof rawTs === 'string' ? Date.parse(rawTs) : NaN;
          return Number.isFinite(parsed) && now - parsed < 10 * 60_000;
        });
        if (activeForeground) return true;
        if (process.env.WAZIR_IMPROVE_IGNORE_LOAD === '1') return false;
        let availableBytes = os.freemem();
        if (process.platform === 'linux') {
          try {
            const meminfo = await fs.readFile('/proc/meminfo', 'utf8');
            const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
            if (match) availableBytes = Number(match[1]) * 1024;
          } catch {
            // fall back to os.freemem()
          }
        }
        return (
          availableBytes < 1 * 1024 ** 3 ||
          os.loadavg()[0] > Math.max(4, os.availableParallelism() * 0.9)
        );
      },
      observe: async () => {
        const executions = await engine.executions.list();
        const observations: Array<{ source: string; kind: string; summary: string }> = [];
        for (const record of executions.slice(-400)) {
          const execId = record.execution.id;
          const errText = record.errors.join('\n');
          if (
            errText.includes('INVALID_JSON_ACTION') ||
            errText.includes('UNREGISTERED_TOOL') ||
            errText.includes('REPEATED_ACTION') ||
            errText.includes('NO_PROGRESS')
          ) {
            observations.push({
              source: execId,
              kind: 'tool_protocol_failure',
              summary: `[${record.execution.modelId ?? 'unknown-model'}] ${errText || 'Tool protocol or loop guard failure'}`,
            });
          } else if (record.execution.status === 'failed' || record.errors.length > 0) {
            observations.push({
              source: execId,
              kind: 'execution_failure',
              summary: errText || 'Execution failed without diagnostics',
            });
          }
          const failedChecks = (record.checks ?? []).filter((c) => !c.ok);
          if (failedChecks.length > 0) {
            observations.push({
              source: `${execId}:checks`,
              kind: 'build_failure',
              summary: `Failed checks (${failedChecks.map((c) => c.name).join(', ')}): ${failedChecks
                .map((c) => c.output ?? c.command)
                .join('; ')
                .slice(0, 400)}`,
            });
          }
          const failedTools = (record.toolCalls ?? []).filter((t) => !t.ok);
          if (failedTools.length >= 2) {
            observations.push({
              source: `${execId}:tools`,
              kind: 'tool_call_failure',
              summary: `${failedTools.length} failed tool calls in ${execId}: ${failedTools
                .map((t) => t.tool)
                .slice(0, 5)
                .join(', ')}`,
            });
          }
        }
        const crashDirectory = path.join(configDir(), 'logs');
        const names = await fs.readdir(crashDirectory).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return [];
        });
        for (const name of names
          .filter((n) => /^crash-.*\.log$/.test(n))
          .sort()
          .slice(-100)) {
          const file = path.join(crashDirectory, name);
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.size > 256_000) continue;
          observations.push({
            source: name,
            kind: 'crash',
            summary: redactImprovementText(await fs.readFile(file, 'utf8')),
          });
        }
        return observations;
      },
      diagnose: async (activeModes: ImprovementMode[]) => {
        const recs: Array<{
          signature: string;
          mode: ImprovementMode;
          category: string;
          targetComponent: string;
          summary: string;
          proposedAction: string;
          evidence: Record<string, unknown>;
        }> = [];
        const executions = await engine.executions.list();
        if (engine.optimizer) {
          const opportunities = engine.optimizer.observe({ executions });
          for (const opp of opportunities) {
            const mode: ImprovementMode = [
              'HIGH_CONTEXT_GROWTH',
              'EXCESSIVE_MODEL_CALLS',
              'HIGH_RUNTIME_LATENCY',
              'UNNECESSARY_TOOL_EXPOSURE',
              'MODEL_SPECIALIZATION_OPPORTUNITY',
            ].includes(opp.category)
              ? 'optimize'
              : 'harden';
            recs.push({
              signature: createHash('sha256')
                .update(`${opp.category}:${opp.component}:${opp.metric}`)
                .digest('hex')
                .slice(0, 20),
              mode,
              category: opp.category,
              targetComponent: opp.component,
              summary: `${opp.category} on ${opp.component} (${opp.metric}=${opp.baseline})`,
              proposedAction: `Run bounded ${mode.toUpperCase()} experiment targeting ${opp.component} (${opp.domain})`,
              evidence: {
                opportunityId: opp.id,
                metric: opp.metric,
                baseline: opp.baseline,
                detail: opp.evidence,
              },
            });
          }
        }
        if (activeModes.includes('optimize') && recs.every((r) => r.mode !== 'optimize')) {
          recs.push({
            signature: 'opt-context-compaction-policy',
            mode: 'optimize',
            category: 'CONTEXT_EFFICIENCY',
            targetComponent: 'ContextCompiler',
            summary: 'Monitor peak context token utilization and compaction reserve ratios across coding executions',
            proposedAction: 'Evaluate contextWeights and compaction threshold mutations against registered benchmark tasks',
            evidence: { observedExecutions: executions.length },
          });
        }
        if (activeModes.includes('evolve')) {
          recs.push({
            signature: 'evolve-authorized-scope-gate',
            mode: 'evolve',
            category: 'CAPABILITY_EVOLUTION',
            targetComponent: 'SelfImprovementSupervisor',
            summary: 'Controlled feature evolution requires an explicit authorizedFeature scope and independent check suite',
            proposedAction: 'Provide --scope <path> with mode="evolve", authorizedFeature, files, and independent checks',
            evidence: { scopeConfigured: Boolean(scope) },
          });
        }
        return recs;
      },
      experiment: scope
        ? (id, activeModes) =>
            executeRepairScope({
              scope,
              id,
              modes: activeModes,
              engine,
              store,
              signal: abort.signal,
              directory,
            })
        : undefined,
    });

    await supervisor.initialize(modes);
    do {
      if (abort.signal.aborted) await store.put('supervisor/control', 'stop');
      const state = await supervisor.tick();
      if (!options.continuous || state.phase === 'STOPPED' || state.reason === 'CYCLE_BUDGET_EXHAUSTED') {
        console.log(JSON.stringify(state, null, 2));
        break;
      }
      await delay(Math.min(1000, intervalMs), undefined, { signal: abort.signal }).catch(() => undefined);
    } while (true);
  } finally {
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    await new Promise<void>((resolve) => lease.close(() => resolve()));
    if (process.platform !== 'linux') {
      try {
        unlinkSync(supervisorSocket(directory));
      } catch {
        // ignore cleanup error
      }
    }
  }
}
