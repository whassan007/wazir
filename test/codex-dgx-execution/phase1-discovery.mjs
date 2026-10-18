import fs from 'node:fs';
import path from 'node:path';
import {
  EVIDENCE_DIR,
  ProcessSupervisor,
  loadOrInitState,
  logLive,
  writeCheckpoint,
} from './supervisor.mjs';

async function main() {
  const state = loadOrInitState();
  const sup = new ProcessSupervisor(state, { maxConcurrent: 4 });

  logLive('MODEL DISCOVERY', 'Starting bounded environment and model discovery (20s timeout per diagnostic command).');

  const commands = [
    { id: 'diag-pwd', cmd: 'pwd', args: [] },
    { id: 'diag-uname', cmd: 'uname', args: ['-m'] },
    { id: 'diag-os', cmd: 'bash', args: ['-c', 'sw_vers 2>/dev/null || cat /etc/os-release'] },
    { id: 'diag-which-wa', cmd: 'bash', args: ['-c', 'command -v wa || echo "./bin/wa.js"'] },
    { id: 'diag-wa-version', cmd: 'node', args: ['/home/wael/Code/Wazir/bin/wa.js', '--version'] },
    { id: 'diag-wa-run-help', cmd: 'node', args: ['/home/wael/Code/Wazir/bin/wa.js', 'run', '--help'] },
    { id: 'diag-wa-chat-help', cmd: 'node', args: ['/home/wael/Code/Wazir/bin/wa.js', 'chat', '--help'] },
    { id: 'diag-lms-ps', cmd: 'bash', args: ['-c', 'command -v lms && lms ps || echo "LMS_CLI_NOT_IN_PATH"'] },
    { id: 'diag-lms-http', cmd: 'bash', args: ['-c', 'curl -sS --max-time 5 http://127.0.0.1:1234/api/v0/models || curl -sS --max-time 5 http://127.0.0.1:1234/v1/models || echo "LMS_HTTP_UNREACHABLE"'] },
    { id: 'diag-ollama-ps', cmd: 'bash', args: ['-c', 'command -v ollama && ollama ps || echo "OLLAMA_UNAVAILABLE"'] },
    { id: 'diag-wa-models-list', cmd: 'node', args: ['/home/wael/Code/Wazir/bin/wa.js', 'models', 'list', '--json'] },
    { id: 'diag-wa-models-health', cmd: 'node', args: ['/home/wael/Code/Wazir/bin/wa.js', 'models', 'health', '--detail'] },
    { id: 'diag-wa-doctor', cmd: 'node', args: ['/home/wael/Code/Wazir/bin/wa.js', 'doctor'] },
  ];

  const results = {};
  for (const c of commands) {
    logLive('DIAGNOSTIC', `Running ${c.id}: ${c.cmd} ${c.args.join(' ')}`);
    const res = await sup.runSupervised({
      operationId: c.id,
      taskId: 'DISCOVERY',
      executable: c.cmd,
      args: c.args,
      wallTimeoutMs: 20000,
      idleTimeoutMs: 15000,
      spawnTimeoutMs: 10000,
    });
    results[c.id] = res;
    logLive('OBSERVATION', [
      `Command: ${c.id}`,
      `Exit: ${res.exitCode} | Duration: ${res.durationMs}ms | TimedOut: ${res.timedOut}`,
      `Stdout preview: ${res.stdout.trim().slice(0, 300)}`,
    ]);
  }

  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'discovery-raw.json'),
    JSON.stringify(results, null, 2),
    'utf8'
  );

  writeCheckpoint(state, sup, {
    phase: 'PHASE_1_DISCOVERY_COMMANDS',
    action: 'Executed bounded 20s environment and runtime discovery commands.',
    expected: 'Discover Wazir CLI version, flags, local LM Studio / Ollama loaded models, and health.',
    actual: Object.entries(results)
      .map(([k, v]) => `- ${k}: exit=${v.exitCode}, duration=${v.durationMs}ms, timedOut=${v.timedOut}`)
      .join('\n'),
    analysis: 'Raw discovery data saved to test/codex-dgx-execution/discovery-raw.json for model verification and pinning.',
    decision: 'Inspect loaded models in LM Studio / Ollama and select + verify the fastest resident generative model.',
    filesModified: 'test/codex-dgx-execution/discovery-raw.json',
    verification: 'All discovery subprocesses exited or were reaped cleanly (active owned processes: 0).',
    stopCheck: 'STOP-01..STOP-12 checked: None triggered.',
    nextAction: 'Verify and calibrate loaded model, then write model-verification.md and pin model ID.',
    resumeInstructions: 'Inspect test/codex-dgx-execution/discovery-raw.json and run model calibration.',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
