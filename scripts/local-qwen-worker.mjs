#!/usr/bin/env node
/**
 * Local Qwen Worker Dispatcher
 * Dispatches tasks to verified local/fleet Qwen models (DGX Spark qwen3-coder:30b
 * or local MLX Qwen3.5-9B-6bit) and logs utilization metrics to
 * test/reports/local-compute-utilization.csv.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const UTIL_CSV = path.join(REPO_ROOT, 'test/reports/local-compute-utilization.csv');

function ensureCsvHeader() {
  fs.mkdirSync(path.dirname(UTIL_CSV), { recursive: true });
  if (!fs.existsSync(UTIL_CSV)) {
    fs.writeFileSync(
      UTIL_CSV,
      'timestamp,machine,model,task_id,prompt_tokens,completion_tokens,duration_ms,locality,status\n',
    );
  }
}

function appendMetric(row) {
  ensureCsvHeader();
  const line = [
    new Date().toISOString(),
    row.machine,
    row.model,
    row.taskId,
    row.promptTokens,
    row.completionTokens,
    row.durationMs,
    'local',
    row.status,
  ].join(',');
  fs.appendFileSync(UTIL_CSV, `${line}\n`);
}

async function runOllama(endpoint, model, prompt, taskId, machine) {
  const start = Date.now();
  const res = await fetch(`${endpoint}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'user', content: prompt }],
      options: { temperature: 0.2 },
    }),
  });
  const durationMs = Date.now() - start;
  if (!res.ok) {
    appendMetric({ machine, model, taskId, promptTokens: 0, completionTokens: 0, durationMs, status: `http_${res.status}` });
    throw new Error(`Ollama HTTP ${res.status}`);
  }
  const data = await res.json();
  const promptTokens = Number(data.prompt_eval_count ?? 0);
  const completionTokens = Number(data.eval_count ?? 0);
  appendMetric({ machine, model, taskId, promptTokens, completionTokens, durationMs, status: 'ok' });
  return { content: data.message?.content ?? '', promptTokens, completionTokens, durationMs };
}

async function runOpenAiCompat(endpoint, model, prompt, taskId, machine) {
  const start = Date.now();
  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 4096,
    }),
  });
  const durationMs = Date.now() - start;
  if (!res.ok) {
    appendMetric({ machine, model, taskId, promptTokens: 0, completionTokens: 0, durationMs, status: `http_${res.status}` });
    throw new Error(`OpenAI-compat HTTP ${res.status}`);
  }
  const data = await res.json();
  const promptTokens = Number(data.usage?.prompt_tokens ?? 0);
  const completionTokens = Number(data.usage?.completion_tokens ?? 0);
  appendMetric({ machine, model, taskId, promptTokens, completionTokens, durationMs, status: 'ok' });
  return { content: data.choices?.[0]?.message?.content ?? '', promptTokens, completionTokens, durationMs };
}

const args = process.argv.slice(2);
const target = args[0] || 'dgx';
const taskId = args[1] || 'ad-hoc';
const promptFile = args[2];
const outFile = args[3];

if (!promptFile) {
  console.error('Usage: local-qwen-worker.mjs <dgx|mlx|local-ollama> <taskId> <promptFile> [outFile]');
  process.exit(1);
}

const prompt = fs.readFileSync(promptFile, 'utf8');
let result;
if (target === 'dgx') {
  result = await runOllama('http://100.113.62.112:11434', 'qwen3-coder:30b', prompt, taskId, 'dgx_spark');
} else if (target === 'mlx') {
  result = await runOpenAiCompat('http://127.0.0.1:8080', 'mlx-community/Qwen3.5-9B-6bit', prompt, taskId, 'WaelMacPro.local');
} else {
  result = await runOllama('http://127.0.0.1:11434', 'qwen3.5:9b', prompt, taskId, 'WaelMacPro.local');
}

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, result.content);
} else {
  process.stdout.write(result.content);
}
console.error(`[local-qwen-worker] ${target} ${taskId}: ${result.promptTokens}+${result.completionTokens} tokens in ${result.durationMs}ms`);
