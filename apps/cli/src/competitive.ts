import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  CompetitiveExecution, raceGit, raceHash, protectedRacePath, validateRacePolicy, pricingFor, costUsd, VerificationEngine,
  type AgentRuntime, type RacePolicy, type RaceRecord, type RaceCheck, type RaceConfiguration, type AttemptMeasurement, type RoutingPreference,
} from '@wazir/core';
import { resolveInsideProject, readTool, writeTool, editTool, globTool, sandboxStatus, wrapInSandbox } from '@wazir/tools';
import { terminateProcessTree } from '@wazir/shared';
import type { RookEngine } from './engine.js';
import { planTask, type ExecuteTaskOptions } from './run.js';
import { createCodingAgent } from '@wazir/agents';

const fileTools = [readTool, writeTool, editTool, globTool];
/** No shell, arbitrary code, MCP, delegation, network tools, Git, or external agent processes.
 * All source I/O passes existing canonical path checks plus race ownership checks. */
export function raceToolAllowed(name: string, relative: string, policy: RacePolicy): boolean {
  if (!['read', 'write', 'edit', 'glob'].includes(name)) return false;
  if (relative.split('/').some(p => p.startsWith('.') || p === 'node_modules')) return false;
  if (name === 'read' || name === 'glob') return true;
  return !protectedRacePath(relative, policy) && policy.writablePaths.some(p => relative === p || relative.startsWith(p.replace(/\/$/, '') + '/'));
}
export async function verifyCompetitiveCandidate(cwd: string, policy: RacePolicy, signal: AbortSignal): Promise<RaceCheck[]> {
  if (sandboxStatus().mode === 'none') throw new Error('race verification requires an available OS sandbox; host fallback is forbidden');
  const tracked = (await raceGit(cwd, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const immutablePaths = tracked.map(file => path.join(cwd, file));
  for (const file of immutablePaths) if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('verification refuses baseline symlinks; provision a self-contained trusted tree');
  const outputPaths = ['.wazir', ...(policy.verificationWritablePaths ?? ['dist', 'build', 'coverage'])];
  const readWritePaths: string[] = [];
  for (const output of outputPaths) {
    if (!output || path.isAbsolute(output) || output.split(/[\\/]/).some(p => p === '..' || p === '.git')) throw new Error('unsafe verification output path');
    if (tracked.some(file => file === output || file.startsWith(output.replace(/\/$/, '') + '/'))) throw new Error('verification output overlaps tracked input');
    const resolved = await resolveInsideProject(cwd, output);
    await fs.mkdir(resolved.real, { recursive: true }); readWritePaths.push(resolved.real);
  }
  const verifier = new VerificationEngine({ projectRoot: cwd });
  const results: RaceCheck[] = [];
  for (const check of policy.checks) {
    signal.throwIfAborted();
    const started = Date.now();
    const wrapped = wrapInSandbox(check.file, check.args, { projectRoot: cwd, cwd, networkAllowed: false, competitiveIsolation: true, immutablePaths, readWritePaths });
    const child = spawn(wrapped.file, wrapped.args, {
      cwd, detached: process.platform !== 'win32', stdio: wrapped.seccomp ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: path.join(cwd, '.wazir', 'home'), TMPDIR: path.join(cwd, '.wazir', 'tmp'), TEMP: path.join(cwd, '.wazir', 'tmp'), CI: '1', NO_COLOR: '1' },
    });
    if (wrapped.seccomp) (child.stdio[3] as import('node:stream').Writable).end(wrapped.seccomp);
    const kill = () => { if (child.pid) terminateProcessTree(child.pid, { graceMs: 500 }).catch(() => undefined); };
    signal.addEventListener('abort', kill, { once: true });
    if (signal.aborted) kill();
    let output = ''; let exitCode = 1;
    try {
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        // The subprocess has already started: attach once, retaining bounded stdout/stderr via callback below.
        let stdout = ''; let stderr = ''; let overflow = false;
        child.stdout?.on('data', data => { if (overflow) return; stdout += String(data); if (stdout.length + stderr.length > 2 * 1024 * 1024) { overflow = true; kill(); } });
        child.stderr?.on('data', data => { if (overflow) return; stderr += String(data); if (stdout.length + stderr.length > 2 * 1024 * 1024) { overflow = true; kill(); } });
        child.on('error', reject);
        child.on('close', (code, childSignal) => code === 0 && !overflow && !signal.aborted ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(`verification command failed: exit=${code}, signal=${childSignal}`), { stdout, stderr, code })));
      });
      output = result.stdout + result.stderr; exitCode = 0;
    } catch (e) {
      const error = e as Error & { stdout?: string; stderr?: string; code?: number };
      output = (error.stdout ?? '') + (error.stderr ?? '') + error.message;
      exitCode = typeof error.code === 'number' && error.code !== 0 ? error.code : 1;
    } finally {
      signal.removeEventListener('abort', kill);
      // A check can exit while descendants retain its process group. Reap that
      // group without a direct-PID fallback after the leader has been reaped.
      if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* no remaining group */ } }
    }
    const evidence = verifier.recordEvidence({ oracle: check.oracle, command: [check.file, ...check.args].join(' '), exitCode, output, startedAt: new Date(started), completedAt: new Date() });
    results.push({ name: check.name, passed: evidence.status === 'PASS', exitCode, durationMs: Date.now() - started, outputHash: raceHash(output), output: output.slice(0, 64 * 1024) });
  }
  return results;
}

export function competitiveService(engine: RookEngine): CompetitiveExecution {
  const executionIds = new Map<string, string>();
  return new CompetitiveExecution({
    store: engine.store, worktrees: engine.worktrees, verify: verifyCompetitiveCandidate,
    finalize: async (race, attempt) => {
      const id = executionIds.get(attempt.id); if (!id) return;
      // Keep uncertain execution records active so lifecycle eviction cannot race a live adapter.
      if (attempt.state === 'RECOVERY_REQUIRED') {
        await engine.executions.recordEvent(id, 'race.recovery-required', { raceId: race.id, attemptId: attempt.id }); return;
      }
      if (attempt.headSha) await engine.executions.recordFilesChanged(id, (await raceGit(race.repository, ['diff', '--name-only', race.baselineCommit, attempt.headSha])).split('\n').filter(Boolean));
      const record = engine.executions.require(id);
      const revision = record.workspaceState?.revision ?? 0;
      const evidence = [];
      for (const check of attempt.checks ?? []) {
        const command = race.policy.checks.find(c => c.name === check.name)!;
        evidence.push(await engine.executions.recordEvidence(id, {
          type: command.oracle, oracle: command.oracle, revision, workspaceRevision: revision,
          command: [command.file, ...command.args].join(' '), exitCode: check.exitCode,
          status: check.passed ? 'PASS' : 'FAIL', output: check.output, durationMs: check.durationMs,
          metadata: { attemptId: attempt.id, patchHash: attempt.patchHash, outputHash: check.outputHash },
        }));
      }
      await engine.executions.setEvaluation(id, { success: attempt.state === 'VERIFIED', reasons: [attempt.failure ?? 'Independent race verification passed'], filesChanged: record.filesChanged, checks: [], evaluatedAt: new Date(), workspaceRevision: revision, evidence });
      await engine.executions.recordEvent(id, 'race.verification.completed', { raceId: race.id, attemptId: attempt.id, patchHash: attempt.patchHash, checks: attempt.checks, violations: attempt.violations });
      await engine.executions.setStatus(id, attempt.state === 'VERIFIED' ? 'completed' : attempt.state === 'CANCELLED' ? 'cancelled' : 'failed');
      executionIds.delete(attempt.id);
    },
    run: async ({ attempt, task, policy, signal, event }) => {
      const configuration = attempt.configuration;
      const registered = engine.agents.get(configuration.agent);
      const agent = registered?.descriptor.name === 'wazir-coding' ? createCodingAgent() : registered;
      if (!agent || agent.descriptor.strategy === 'external') throw new Error('external/ACP agents require a validated race isolation adapter and are not yet admitted');
      const runtimeId = configuration.provider;
      const adapter = engine.adapters.get(runtimeId) ?? engine.worker.adapterForModel(configuration.model);
      if (!adapter) throw new Error('no available runtime adapter');
      const planned = await planTask(engine, task, { type: 'coding', model: configuration.model, agent: configuration.agent, allowHosted: configuration.allowHosted });
      if (!planned.ok) throw new Error(('reasons' in planned ? planned.reasons : []).join('; '));
      const plan = planned.plan;
      if (plan.scheduling.runtimeId !== runtimeId) throw new Error('placement changed after race scheduling');
      const execution = await engine.executions.create({ task: { ...plan.task, id: attempt.id }, agentId: configuration.agent,
        computerId: plan.scheduling.computerId, runtimeId, modelId: configuration.model, workerId: engine.worker.id,
        workspaceRoot: attempt.worktree!.worktreeDir, scheduling: plan.scheduling, context: plan.context });
      const executionId = execution.execution.id;
      executionIds.set(attempt.id, executionId);
      await event('execution-linked', { executionId });
      if (plan.scheduling.computerId) await engine.lifecycle.activateExecution(executionId, policy.maxTokens * 2);
      await engine.executions.setStatus(executionId, 'running');
      const capabilities = await adapter.getCapabilities();
      const root = attempt.worktree!.worktreeDir;
      let currentRequest: string | undefined; let calls = 0; let inputTokens = 0; let outputTokens = 0; let usageComplete = true;
      let toolCalls = 0; let toolFailures = 0; const started = Date.now(); let firstOutputMs: number | undefined;
      const accountId = engine.resources.resolveAccount(runtimeId, configuration.model);
      const account = accountId ? engine.resources.accounts.get(accountId) : undefined;
      const pricing = account?.kind === 'api' ? pricingFor(account, configuration.model) : undefined;
      const cancel = () => { if (currentRequest) void adapter.cancel?.(currentRequest).catch(() => undefined); };
      signal.addEventListener('abort', cancel, { once: true });
      const runtime: AgentRuntime = {
        tools: fileTools.map(t => ({ ...t.descriptor })), cancelCurrentTurn: cancel, runtimeCapabilities: capabilities, getCapabilities: () => capabilities,
        async *generate(request) {
          signal.throwIfAborted();
          if (++calls > policy.maxTurns) throw new Error('MAX_MODEL_CALLS');
          // Conservative per-call input/output ceiling; reject oversized context before dispatch.
          const serialized = JSON.stringify(request.messages) + JSON.stringify(request.tools ?? []);
          if (Buffer.byteLength(serialized) > policy.maxTokens) throw new Error('MAX_CONTEXT_BYTES');
          const requestId = randomUUID(); currentRequest = requestId; let observed = false;
          try {
            for await (const e of adapter.generate({ ...request, modelId: configuration.model, requestId, maxTokens: Math.min(request.maxTokens ?? 4096, policy.maxTokens), stream: true,
              resourceContext: { taskId: attempt.id, agent: configuration.agent, workload: 'routine' } })) {
              signal.throwIfAborted();
              if (e.type === 'token' && firstOutputMs === undefined) firstOutputMs = Date.now() - started;
              if (e.type === 'completed' && e.usage) {
                inputTokens += e.usage.inputTokens; outputTokens += e.usage.outputTokens; observed = true;
                await engine.executions.recordUsage(executionId, { input: e.usage.inputTokens, output: e.usage.outputTokens, total: e.usage.inputTokens + e.usage.outputTokens });
                await event('usage', { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, runtime: runtimeId, model: configuration.model });
              }
              yield e;
            }
          } finally { if (!observed) usageComplete = false; currentRequest = undefined; }
        },
        async executeTool(name, input) {
          signal.throwIfAborted(); toolCalls++;
          if (toolCalls > policy.maxTurns * 8) throw new Error('MAX_TOOL_CALLS');
          const begin = Date.now();
          let result;
          try {
            const file = String(input.path ?? '.');
            const resolved = await resolveInsideProject(root, file);
            const relative = path.relative(await fs.realpath(root), resolved.real).split(path.sep).join('/');
            if (!raceToolAllowed(name, relative, policy)) throw new Error('competitive tool policy denied');
            const decision = engine.policy.classify({ tool: name, input, projectRoot: root });
            if (decision.decision !== 'allow') throw new Error(`policy ${decision.decision}: ${decision.rule}`);
            const tool = fileTools.find(t => t.descriptor.name === name)!;
            result = await tool.execute(input, { projectRoot: root, executionId: attempt.id, networkAllowed: false, signal });
          } catch (e) { result = { ok: false, output: '', error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - begin }; }
          if (!result.ok) toolFailures++;
          await event('tool', { tool: name, ok: result.ok, durationMs: result.durationMs });
          return result;
        },
      };
      try {
        for await (const turn of agent.run({ modelId: configuration.model, taskDescription: `${task}\nIndependent race: only source file tools are available. Implement the task; trusted verification runs separately.`, taskType: 'coding', projectRoot: root,
          maxTurns: policy.maxTurns, maxTokens: policy.maxTokens * policy.maxTurns, maxWallClockMs: policy.timeoutMs, maxModelEscalations: 0, subagentDepth: 1, isCancelled: () => signal.aborted }, runtime)) {
          signal.throwIfAborted();
          await event('agent', { kind: turn.kind, phase: turn.phase, terminationReason: turn.terminationReason });
          // Agent-reported verification is deliberately not winner evidence.
          if (turn.kind === 'error' && ['infrastructure', 'protocol', 'cancelled'].includes(turn.errorKind ?? '')) throw new Error(`agent failure: ${turn.errorKind}`);
        }
      } finally { signal.removeEventListener('abort', cancel); }
      await engine.executions.setStatus(executionId, 'verifying');
      const measurement: AttemptMeasurement = { firstOutputMs, toolCalls, toolFailures, quotaRequests: calls };
      if (usageComplete && calls > 0) {
        measurement.inputTokens = inputTokens; measurement.outputTokens = outputTokens;
        if (pricing) measurement.estimatedCostUsd = costUsd(pricing, inputTokens, outputTokens);
      }
      return measurement;
    },
  });
}

export interface CompetitiveOptions extends ExecuteTaskOptions {
  race?: string; routing?: RoutingPreference; racePolicy?: string; maxCost?: string; timeout?: string; progressive?: boolean;
}
export async function runCompetitiveTask(engine: RookEngine, prompt: string, options: CompetitiveOptions): Promise<RaceRecord> {
  if (options.preset || options.expectedFiles || options.fullVerification) throw new Error('race tools and acceptance criteria must be declared in the trusted race policy');
  if (!options.racePolicy) throw new Error('race mode requires --race-policy <trusted.json> with objective checks and source ownership');
  const count = options.race === undefined ? 1 : Number(options.race);
  if (!Number.isSafeInteger(count) || count < 1 || count > 8) throw new Error('--race must be an integer from 1 to 8');
  if (options.routing && !['auto', 'cheapest', 'highest-quality'].includes(options.routing)) throw new Error('invalid --routing preference');
  const policy = JSON.parse(await fs.readFile(path.resolve(options.racePolicy), 'utf8')) as RacePolicy;
  if (options.maxTurns !== undefined) policy.maxTurns = Number(options.maxTurns);
  if (options.timeout !== undefined) policy.timeoutMs = Number(options.timeout) * 1000;
  if (options.maxCost !== undefined) policy.maxCostUsd = Number(options.maxCost);
  if (options.progressive) policy.progressive = true;
  validateRacePolicy(policy);
  const selected = await planTask(engine, prompt, { ...options, type: 'coding' });
  if (!selected.ok) throw new Error(('reasons' in selected ? selected.reasons : []).join('; '));
  const plans = [selected.plan];
  // Controlled model-only experiments: same agent implementation, tool surface, baseline and checks.
  for (const model of engine.models.list()) {
    if (model.id === selected.plan.scheduling.modelId || options.model) continue;
    const p = await planTask(engine, prompt, { ...options, type: 'coding', model: model.id, agent: selected.plan.agent.descriptor.name });
    if (p.ok) plans.push(p.plan);
  }
  const configurations: RaceConfiguration[] = plans.map(p => {
    if (p.agent.descriptor.strategy === 'external') throw new Error('ACP/external race isolation adapter not yet validated');
    if (p.scheduling.computerId && p.scheduling.computerId !== engine.worker.computerId) throw new Error('remote worktree isolation is not yet supported in race mode');
    const provider = p.scheduling.runtimeId; const model = p.scheduling.modelId;
    const accountId = engine.resources.resolveAccount(provider, model); const account = accountId ? engine.resources.accounts.get(accountId) : undefined;
    const pricing = account?.kind === 'api' ? pricingFor(account, model) : undefined;
    return { id: `${p.agent.descriptor.name}:${model}:${provider}`, agent: p.agent.descriptor.name, model, provider, version: engine.models.get(model)?.version,
      allowHosted: options.allowHosted, agentVersion: p.agent.descriptor.version, providerVersion: engine.runtimes.get(provider)?.version,
      pricing: account?.kind === 'local' ? 'local' : pricing ? 'metered' : account?.kind === 'subscription' ? 'subscription' : 'unknown',
      maxCostUsd: pricing ? costUsd(pricing, policy.maxTokens * policy.maxTurns, policy.maxTokens * policy.maxTurns) : undefined };
  });
  const routed = options.routing ? await engine.scheduler.rankCompetitiveConfigurations(selected.plan.task, configurations, raceHash(JSON.stringify(policy)), options.routing) : { configurations, reasons: ['existing scheduler order; explicit independent race'] };
  if (routed.configurations.length < count) throw new Error(`only ${routed.configurations.length} eligible independent configurations; requested ${count}`);
  if (sandboxStatus().mode === 'none') throw new Error('race verification requires a usable OS sandbox');
  const service = competitiveService(engine);
  const record = await service.create({ repository: engine.projectRoot, task: prompt, configurations: routed.configurations.slice(0, count), policy, parentTaskId: selected.plan.task.id, routingRationale: routed.reasons });
  const cancel = () => { void service.cancel(record.id); };
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try { return await service.run(record.id); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
