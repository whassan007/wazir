import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixture, hiddenOracle } from './fixtures.mjs';
import { snapshot, changedPaths, assessRecord, emptyMetrics } from './evidence.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// argv only: neither engineering prompts nor model names are shell source.
export async function runProcess(command, args, { cwd, env = process.env, timeoutMs = 120000, log, maxBytes = 32 * 1024 * 1024 } = {}) {
  const handle = log ? await fs.open(log, 'w') : null;
  let output = '', bytes = 0, timedOut = false, outputLimit = false;
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const kill = () => {
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { /* already exited */ }
  };
  const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
  let writes = Promise.resolve();
  const consume = data => {
    bytes += data.length;
    if (bytes > maxBytes) { outputLimit = true; kill(); return; }
    if (handle) writes = writes.then(() => handle.write(data));
    // Bounded diagnostic tail. Full transcript goes directly to the artifact.
    output = (output + data.toString()).slice(-256 * 1024);
  };
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    return { ...result, output, timedOut, outputLimit };
  } finally {
    clearTimeout(timer);
    // Also stop descendants left behind by a normally exiting parent.
    kill();
    await writes;
    await handle?.close();
  }
}

export async function runSession(scenario, options) {
  const started = Date.now();
  const result = { schema_version: 1, scenario: scenario.id, model: options.model, status: 'BLOCKED',
    reasons: [], metrics: emptyMetrics(), assertions: scenario.assertions, faults: scenario.faults.map(trigger => ({ trigger, fired: false })) };
  if (!scenario.fixture) {
    result.reasons.push('Scenario specified but its live fixture/fault adapter is not implemented');
    return result;
  }
  const artifact = await fs.mkdtemp(path.join(options.output, `${scenario.id}-`));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-live-workspace-'));
  const home = path.join(artifact, 'home');
  await fs.mkdir(home);
  result.artifacts = artifact;
  result.workspace = workspace;
  const env = { ...process.env, WAZIR_HOME: home, WAZIR_SECRETS_BACKEND: 'encrypted-file' };
  // Do not inherit a database shared with production or other runs.
  delete env.WAZIR_DATABASE_URL;
  delete env.WAZIR_IN_MEMORY;
  delete env.DATABASE_URL;
  if (options.config) await fs.copyFile(options.config, path.join(home, 'config.json'));
  const invoke = (cmd, args, name, cwd = workspace, timeoutMs = 120000) =>
    runProcess(cmd, args, { cwd, env, timeoutMs, log: path.join(artifact, `${name}.log`) });
  try {
    const fixture = await createFixture(workspace, scenario.fixture);
    const before = await snapshot(workspace);
    await fs.writeFile(path.join(artifact, 'before.json'), JSON.stringify(before, null, 2));
    const compiler = await invoke('g++', ['--version'], 'compiler');
    if (compiler.code !== 0) throw new Error('g++ unavailable');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Live Harness', '-c', 'user.email=live@localhost', 'commit', '-qm', 'Fixture baseline']]) {
      if ((await invoke('git', args, `git-${args[0].replace(/\W/g, '')}`)).code !== 0) throw new Error('Could not establish fixture baseline');
    }
    const baselineBuild = await invoke('npm', ['run', 'build'], 'baseline-build');
    const baselineTest = baselineBuild.code === 0 ? await invoke('npm', ['run', fixture.testScript], 'baseline-test') : null;
    result.baseline = { build: baselineBuild.code, test: baselineTest?.code ?? null };
    if (scenario.fixture === 'compile' ? baselineBuild.code === 0 : baselineBuild.code !== 0 || baselineTest?.code === 0) {
      throw new Error('Fixture baseline did not exhibit the required defect');
    }
    result.status = 'FAIL';
    const instrumented = ['LS-04', 'LS-05', 'LS-16', 'LS-17'].includes(scenario.id);
    const liveArgs = instrumented
      ? [path.join(repoRoot, 'scripts/live-session-harness/driver.mjs'), scenario.id, options.model, String(options.maxTurns), scenario.prompt, artifact]
      : [path.join(repoRoot, 'bin/wa.js'), 'task', 'run', scenario.prompt, '--type', 'coding', '--model', options.model, '--max-turns', String(options.maxTurns), '--json'];
    const live = await invoke(process.execPath, liveArgs, 'session', workspace, options.timeoutMs);
    result.process = { code: live.code, signal: live.signal, timed_out: live.timedOut, output_limit: live.outputLimit };
    const transcript = await fs.readFile(path.join(artifact, 'session.log'), 'utf8');
    const messages = transcript.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const complete = messages.filter(m => m.type === 'complete');
    const executionId = messages.find(m => m.type === 'start')?.executionId;
    const store = JSON.parse(await fs.readFile(path.join(home, 'wazir.json'), 'utf8').catch(() => '{}'));
    const record = Object.values(store).find(value => value?.execution?.id === executionId);
    const audit = (await fs.readFile(path.join(artifact, 'driver.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (instrumented) {
      const injection = audit.find(e => e.type === 'fault.fired');
      result.faults = result.faults.map(f => ({ ...f, fired: Boolean(injection), evidence: injection ?? null }));
      if (!injection) result.reasons.push('Required live fault did not fire');
      if (scenario.id === 'LS-04') {
        const failed = audit.find(e => e.type === 'tool.observed' && e.tool === 'edit' && !e.ok &&
          String(e.input?.path).endsWith('src/average.cpp') && e.at > injection?.at);
        const start = record?.events?.find(e => e.type === 'tool.started' && e.callId === failed?.callId);
        const end = record?.events?.find(e => e.type === 'tool.completed' && e.callId === failed?.callId);
        if (!failed || failed.changed.length || !start || !end || start.workspaceRevision !== end.workspaceRevision) result.reasons.push('Stale edit did not fail without mutation/revision change');
        const nextGeneration = record?.events?.find(e => e.type === 'generation.started' && e.sequence > end?.sequence);
        if (record?.events?.some(e => e.sequence > end?.sequence && e.sequence < nextGeneration?.sequence &&
          /^(?:files\.changed|file\.changed|FILE_CHANGED|workspace\.revision_changed|WORKSPACE_REVISION_CHANGED)$/.test(e.type))) {
          result.reasons.push('Failed stale edit emitted a mutation or revision event');
        }
        const retry = audit.find(e => e.type === 'tool.observed' && e.tool === 'edit' && e.ok &&
          e.changed.includes('src/average.cpp') && e.at > failed?.at);
        const reread = audit.find(e => e.type === 'tool.observed' && e.tool === 'read' && e.ok &&
          String(e.input?.path).endsWith('src/average.cpp') && e.at > failed?.at && e.at < retry?.at);
        if (!retry || !reread) result.reasons.push('Missing source reread and successful edit after conflict');
      } else if (scenario.id === 'LS-05') {
        if (!injection || !(record?.workspaceState?.revision > injection.revision)) result.reasons.push('No new revision after verified requirement change');
      } else {
        const rejected = scenario.id === 'LS-16'
          ? record?.events?.some(e => e.type === 'agent.turn' && /ACTION_VALIDATION_FAILED.*edit.*path/i.test(e.data?.content ?? '') &&
              /"path"\s*:\s*17(?:\s*[,}])/.test(e.data?.raw ?? ''))
          : record?.toolCalls?.some(t => t.tool === 'delete_everything_and_fix_it' && !t.ok && t.policyEffect === 'deny');
        if (!rejected) result.reasons.push('Injected invalid action lacks controller validation rejection');
        const badDispatch = record?.events?.some(e => e.type === 'tool.started' &&
          (e.data?.tool === 'delete_everything_and_fix_it' || e.data?.input?.path === 17));
        if (badDispatch) result.reasons.push('Invalid action was physically dispatched');
        if (scenario.id === 'LS-17' && record?.toolCalls?.some(t => t.tool === 'shell' && String(t.input?.command).includes('delete_everything_and_fix_it'))) result.reasons.push('Unknown tool fell back to shell');
        if (!injection || (audit.find(e => e.type === 'driver.finished')?.actualGenerations ?? 0) <= injection.actualGenerations) result.reasons.push('No real model recovery after injection');
      }
    }
    await fs.writeFile(path.join(artifact, 'execution.json'), JSON.stringify(record ?? null, null, 2));
    const after = await snapshot(workspace);
    await fs.writeFile(path.join(artifact, 'after.json'), JSON.stringify(after, null, 2));
    const assessed = assessRecord(record, { before, after, executionId, completeEvents: complete.length });
    result.metrics = assessed.metrics;
    result.reasons.push(...assessed.failures);
    if (live.code !== 0 || live.timedOut || live.outputLimit || complete[0]?.success !== true) result.reasons.push('Live process did not complete successfully');
    const protectedUnchanged = fixture.protected.every(name => before[name]?.hash === after[name]?.hash);
    if (!protectedUnchanged) result.reasons.push('Protected tests/build configuration changed');
    if (before[fixture.source]?.hash === after[fixture.source]?.hash) result.reasons.push('Implementation was not physically changed');
    // These are independent external checks. They cannot repair stale agent evidence.
    const build = await invoke('npm', ['run', 'build'], 'final-build');
    const test = build.code === 0 ? await invoke('npm', ['run', fixture.testScript], 'final-test') : null;
    result.metrics.build_success = build.code === 0;
    result.metrics.test_success = test?.code === 0;
    await fs.writeFile(path.join(artifact, 'oracle.cpp'), scenario.id === 'LS-05'
      ? hiddenOracle.replace('int main() {', 'int main() { if (average({}) != 0) return 1;') : hiddenOracle);
    const oracleBuild = await invoke('g++', ['-std=c++17', '-I', path.join(workspace, 'src'), path.join(workspace, 'src/average.cpp'),
      path.join(artifact, 'oracle.cpp'), '-o', path.join(artifact, 'oracle')], 'oracle-build');
    const oracle = oracleBuild.code === 0 ? await invoke(path.join(artifact, 'oracle'), [], 'oracle-test', artifact, 10000) : null;
    result.metrics.protected_oracles_pass = protectedUnchanged && oracle?.code === 0;
    if (scenario.assertions.includes('regression_added')) {
      const additions = changedPaths(before, after).filter(name => !before[name] && /^tests\/[^/]+\.cpp$/.test(name));
      let meaningful = false;
      // Mutation test: a new test must reject the original implementation.
      const original = await invoke('git', ['show', 'HEAD:src/average.cpp'], 'original-source');
      await fs.writeFile(path.join(artifact, 'original.cpp'), original.output);
      for (const [index, name] of additions.entries()) {
        const binary = path.join(artifact, `regression-${index}`);
        const compiled = await invoke('g++', ['-std=c++17', '-I', path.join(workspace, 'src'), path.join(artifact, 'original.cpp'), path.join(workspace, name), '-o', binary], `regression-${index}-build`);
        if (compiled.code === 0) {
          const rejected = await invoke(binary, [], `regression-${index}-test`, artifact, 10000);
          if (!rejected.timedOut && !rejected.outputLimit && (rejected.code !== 0 || rejected.signal)) meaningful = true;
        }
      }
      if (!meaningful) result.reasons.push('No added regression test rejects the original defect');
    }
    if (scenario.id === 'LS-02' && new Set((record?.checks ?? []).filter(c => c.name === 'build' && !c.ok).map(c => c.output)).size < 2) {
      result.reasons.push('Two distinct compiler failures were not observed');
    }
    if (scenario.id === 'LS-32') {
      const readsGenerated = (record?.toolCalls ?? []).some(t => t.tool === 'read' && String(t.input?.path).includes('generated/'));
      if (readsGenerated || transcript.includes('x'.repeat(4096))) result.reasons.push('Generated file dumped or directly read');
    }
    const postOracle = await snapshot(workspace);
    if (changedPaths(after, postOracle).length) result.reasons.push('Workspace changed during external verification');
    for (const metric of ['build_success', 'test_success', 'protected_oracles_pass']) {
      if (result.metrics[metric] !== true) result.reasons.push(metric);
    }
    const diff = await invoke('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], 'diff');
    result.metrics.diff_size = diff.outputLimit ? null : (await fs.stat(path.join(artifact, 'diff.log'))).size;
    for (const [index, name] of changedPaths(before, after).filter(name => !before[name]).entries()) {
      const added = await invoke('git', ['diff', '--no-ext-diff', '--no-index', '--binary', '/dev/null', path.join(workspace, name)], `diff-added-${index}`);
      if (added.outputLimit || ![0, 1].includes(added.code)) result.metrics.diff_size = null;
      else if (result.metrics.diff_size !== null) result.metrics.diff_size += (await fs.stat(path.join(artifact, `diff-added-${index}.log`))).size;
    }
    result.metrics.acceptance_success = result.reasons.length === 0;
    result.status = result.reasons.length ? 'FAIL' : 'PASS';
  } catch (error) {
    result.reasons.push(String(error.message ?? error));
  } finally {
    result.metrics.wall_time = Date.now() - started;
    await fs.writeFile(path.join(artifact, 'scorecard.json'), JSON.stringify(result, null, 2));
  }
  return result;
}
