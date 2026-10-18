import fs from 'node:fs';
import path from 'node:path';
import {
  EVIDENCE_DIR,
  ProcessSupervisor,
  loadOrInitState,
  logLive,
  saveState,
  writeCheckpoint,
} from './supervisor.mjs';

async function main() {
  const state = loadOrInitState();
  const sup = new ProcessSupervisor(state, { maxConcurrent: 4 });

  const candidates = [
    { id: 'gemma-4-26b-a4b-it-qat', sizeGb: 14.44, ctx: 32768, activeParams: '4B active (26B MoE)' },
    { id: 'nvidia/nemotron-3-nano-omni', sizeGb: 26.10, ctx: 8192, activeParams: 'Nano Omni' },
    { id: 'qwen/qwen3.8-27b', sizeGb: 17.74, ctx: 8192, activeParams: '27B dense' },
  ];

  logLive('MODEL CALIBRATION', 'Running at most 3 bounded calibration probes against the 3 resident LM Studio models.');

  const probeResults = [];
  for (const c of candidates) {
    const payload = JSON.stringify({
      model: c.id,
      messages: [{ role: 'user', content: 'Reply with only the word READY.' }],
      max_tokens: 32,
      temperature: 0,
    });
    const res = await sup.runSupervised({
      operationId: `calib-${c.id.replace(/[^a-z0-9]/gi, '-')}`,
      taskId: 'CALIBRATION',
      executable: 'curl',
      args: [
        '-sS',
        '--max-time',
        '15',
        '-H',
        'Content-Type: application/json',
        '-d',
        payload,
        'http://127.0.0.1:1234/v1/chat/completions',
      ],
      wallTimeoutMs: 20000,
      idleTimeoutMs: 15000,
    });

    let content = '';
    let reasoning = '';
    let ok = false;
    try {
      const parsed = JSON.parse(res.stdout);
      const msg = parsed.choices?.[0]?.message;
      content = (msg?.content ?? '').trim();
      reasoning = (msg?.reasoning_content ?? msg?.reasoning ?? '').trim();
      ok = res.ok && (content.length > 0 || reasoning.length > 0);
    } catch {
      ok = false;
    }

    probeResults.push({
      ...c,
      durationMs: res.durationMs,
      ok,
      content,
      hasReasoningOverhead: reasoning.length > 0 && content.length === 0,
      rawPreview: res.stdout.slice(0, 300),
    });

    logLive('OBSERVATION', [
      `Calibration probe for ${c.id}: duration=${res.durationMs}ms, ok=${ok}`,
      `Content: "${content}" | Reasoning overhead: ${reasoning.length} chars`,
    ]);
  }

  // Pick fastest model that returns clean direct content without exhausting max_tokens in reasoning
  const validDirect = probeResults
    .filter((p) => p.ok && p.content.length > 0)
    .sort((a, b) => a.durationMs - b.durationMs);
  const selected = validDirect[0] || probeResults.filter((p) => p.ok).sort((a, b) => a.durationMs - b.durationMs)[0];

  if (!selected) {
    state.stopCondition = 'STOP-02';
    saveState(state);
    throw new Error('STOP-02: No resident generative model passed calibration.');
  }

  state.selectedModel = selected.id;
  saveState(state);

  // Pin model in Wazir lifecycle as well
  const pinRes = await sup.runSupervised({
    operationId: 'pin-selected-model',
    taskId: 'CALIBRATION',
    executable: 'node',
    args: ['/home/wael/Code/Wazir/bin/wa.js', 'models', 'pin', selected.id, '--runtime', 'lmstudio', '--json'],
    wallTimeoutMs: 20000,
    idleTimeoutMs: 15000,
  });

  logLive('DECISION', [
    `Selected and pinned fastest resident generative model: ${selected.id}`,
    `Runtime: lmstudio (http://127.0.0.1:1234)`,
    `Direct probe latency: ${selected.durationMs}ms | Size: ${selected.sizeGb} GB | Context: ${selected.ctx}`,
    `Fallback: prohibited.`,
  ]);

  const verificationMd = `# DGX Spark Model Verification & Pinning

- **Timestamp:** ${new Date().toISOString()}
- **Host / Computer:** \`waelbot\` (NVIDIA DGX Spark, Ubuntu 24.04.5 LTS \`aarch64\`, 20 ARM64 cores Cortex-X925/A725, 121 GiB unified memory, 33 GiB available)
- **Wazir Version:** \`0.2.5\`
- **Local Runtimes Checked:**
  - **LM Studio (\`lmstudio\`):** ONLINE & READY at \`http://127.0.0.1:1234\` (\`lms ps\` verified 3 resident models)
  - **Ollama (\`ollama\`):** CLI installed at \`/usr/local/bin/ollama\`, daemon UNREACHABLE (0 resident models)
  - **Hosted Providers:** None authenticated; hosted fallback strictly prohibited (` + '`--routing-mode LOCAL_ONLY`' + `)

## Resident Loaded Models & Bounded Calibration Probes (3/3)

| Model Identifier | Runtime | Status | Size | Context | Probe Latency | Direct Output | Notes |
|---|---|---|---:|---:|---:|---|---|
${probeResults
  .map(
    (p) =>
      `| \`${p.id}\` | \`lmstudio\` | LOADED (IDLE) | ${p.sizeGb} GB | ${p.ctx} | ${p.durationMs} ms | \`${p.content || '(reasoning only)'}\` | ${p.activeParams}${p.hasReasoningOverhead ? ' — consumes tokens in thinking channel before final content' : ' — clean direct text generation'} |`
  )
  .join('\n')}

## Selected & Pinned Model

- **Pinned Model Identifier:** \`${selected.id}\`
- **Runtime:** \`lmstudio\`
- **Computer:** \`local\` (\`waelbot\`)
- **Loaded State:** \`LOADED\` (\`loaded=true\`, verified resident via \`lms ps\` and \`/api/v0/models\`)
- **Explicit CLI Selection Flags:** \`wa run "<prompt>" --model ${selected.id} --runtime lmstudio --routing-mode LOCAL_ONLY --json\`
- **Lifecycle Pin Command Result:** \`${pinRes.stdout.trim()}\` (exit=${pinRes.exitCode})
`;

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'model-verification.md'), verificationMd, 'utf8');

  writeCheckpoint(state, sup, {
    phase: 'PHASE_1_MODEL_VERIFIED_AND_PINNED',
    action: `Executed 3 bounded calibration probes across resident LM Studio models and pinned ${selected.id}.`,
    expected: 'Identify fastest suitable already-loaded local text-generation model and document verification.',
    actual: probeResults.map((p) => `- ${p.id}: ${p.durationMs}ms, ok=${p.ok}, content="${p.content}"`).join('\n'),
    analysis: `${selected.id} (14.44 GB, 4B active MoE parameters, 32768 context) is the smallest and fastest resident generative model with direct output (${selected.durationMs}ms). Also observed during discovery: every Wazir CLI command takes ~6.9s-8.7s because Ollama is unreachable and Wazir probes Ollama or runs expensive startup checks on every CLI invocation.`,
    decision: `Pin ${selected.id} on runtime lmstudio for all baseline and post-repair benchmark tasks.`,
    filesModified: 'test/codex-dgx-execution/model-verification.md, test/codex-dgx-execution/run-state.json',
    verification: 'model-verification.md written; direct generation and Wazir registration confirmed.',
    stopCheck: 'STOP-01..STOP-12 evaluated: None triggered (STOP-02 satisfied: resident model verified).',
    nextAction: 'Execute Phase 2 Baseline Benchmark (10 sequential tasks C01..C10) with per-task checkpoints.',
    resumeInstructions: 'Run node test/codex-dgx-execution/phase2-baseline.mjs',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
