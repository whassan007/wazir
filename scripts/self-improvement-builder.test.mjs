import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
test('phase receipts require fresh identity and available reviewed evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-builder-receipt-'));
  try {
    const prompt = path.join(root, 'prompt'); fs.writeFileSync(prompt, 'original requirements');
    const artifact = path.join(root, 'evidence'); fs.writeFileSync(artifact, 'independent test output');
    const receipt = path.join(root, 'receipt.json');
    const base = { phase: 1, head: 'abc', promptSha256: crypto.createHash('sha256').update(fs.readFileSync(prompt)).digest('hex'), decision: 'PASS', reviewer: 'recovery-supervisor', requirements: [1,2,3].map(i => ({ requirement: String(i), status: 'PASS', evidence: [artifact] })) };
    const run = value => {
      if (value) fs.writeFileSync(receipt, JSON.stringify(value));
      return spawnSync(process.execPath, [path.join(directory, 'self-improvement-phase-receipt.mjs'), receipt, '1', 'abc', prompt]);
    };
    assert.equal(run().status, 1);
    assert.equal(run(base).status, 0);
    assert.equal(run({ ...base, head: 'stale' }).status, 1);
    assert.equal(run({ ...base, requirements: [] }).status, 1);
    assert.equal(run({ ...base, reviewer: 'coding-model' }).status, 1);
    assert.equal(run({ ...base, requirements: base.requirements.map(r => ({ ...r, status: 'BLOCKED' })) }).status, 1);
    fs.unlinkSync(artifact); assert.equal(run(base).status, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resume reuses existing service and preserves prompts, config and logs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-builder-resume-'));
  try {
    const app = path.join(root, '.local/share/wazir-self-improvement-builder');
    const state = path.join(root, '.local/state/wazir-self-improvement-builder');
    const bin = path.join(root, 'bin'); const worktree = path.join(root, 'candidate');
    for (const dir of [app, state, bin, worktree, path.join(app, 'prompts')]) fs.mkdirSync(dir, { recursive: true });
    const config = `WORKTREE='${worktree}'\nWA_BIN=/bin/true\n`;
    fs.writeFileSync(path.join(app, 'config.sh'), config);
    fs.writeFileSync(path.join(app, 'prompts/1.txt'), 'original operator prompt');
    fs.writeFileSync(path.join(state, 'build.log'), 'previous failure evidence');
    const trace = path.join(root, 'systemctl.log');
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\nif [ "$2" = is-active ]; then exit 3; fi\nprintf '%s\\n' "$*" >> '${trace}'\n`, { mode: 0o700 });
    const result = spawnSync('/bin/bash', [path.join(directory, 'self-improvement-builder.sh'), 'resume'], { env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(app, 'config.sh'), 'utf8'), config);
    assert.equal(fs.readFileSync(path.join(app, 'prompts/1.txt'), 'utf8'), 'original operator prompt');
    assert.equal(fs.readFileSync(path.join(state, 'build.log'), 'utf8'), 'previous failure evidence');
    assert.equal(fs.readFileSync(trace, 'utf8').trim(), '--user start wazir-self-improvement-builder.service');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Regression tests for the 2026-10-15 builder failure classification defect.
// Fixture lines are verbatim excerpts of the real attempt logs from waelbot.
const ROUTER_LINE = "- model: explicitly requested model 'nvidia/nemotron-3-nano-omni' | required capability: implementation | resource (routine, account local:lmstudio): score 2.3148 = quality 1.00, reliability 0.98, capacity 1.00, cost 0.00, latency 0.55, quota risk 0.00";
const classify = (code, lines) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-builder-classify-'));
  try {
    const log = path.join(root, 'attempt.log');
    fs.writeFileSync(log, lines.join('\n') + '\n');
    const result = spawnSync('/bin/bash', [path.join(directory, 'self-improvement-builder.sh'), 'classify', String(code), log], { encoding: 'utf8', env: { ...process.env, HOME: root } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};

test('REPEATED_ACTION with router "quota risk" text is MODEL_CAPABILITY, not QUOTA', () => {
  assert.equal(classify(1, [
    'Execution exec-mv998n15-1', ROUTER_LINE,
    "ACTION_BLOCKED_DUPLICATE: 'search' repeated 3 times",
    'REPEATED_ACTION: circuit breaker: model called search with identical input 4 times in a row without making progress; the model ignored the duplicate-action correction',
    '  Task failed', '    no files changed',
  ]), 'MODEL_CAPABILITY 20 final');
});

test('NO_PROGRESS after INVALID_JSON_ACTION is a final MODEL_CAPABILITY failure', () => {
  assert.equal(classify(1, [ROUTER_LINE, 'INVALID_JSON_ACTION: model response did not parse as a JSON action',
    'NO_PROGRESS: 6 consecutive tool calls produced no file change and no new information']), 'MODEL_CAPABILITY 20 final');
});

test('transport, quota, timeout and generic failures map to distinct classes', () => {
  assert.equal(classify(1, [ROUTER_LINE, 'Error: connect ECONNREFUSED 127.0.0.1:1234']), 'RUNTIME_UNAVAILABLE 23 retryable');
  assert.equal(classify(1, [ROUTER_LINE, 'Error: HTTP 429 Too Many Requests: rate limit exceeded']), 'QUOTA 24 final');
  assert.equal(classify(124, [ROUTER_LINE]), 'TIMEOUT 22 final');
  assert.equal(classify(1, [ROUTER_LINE, 'something unexpected']), 'EXECUTION_FAILED 25 final');
  assert.equal(classify(1, ['ACTION_VALIDATION_FAILED: \'read\' missing path']), 'PROTOCOL 21 final');
});

test('model gate refuses a model/agent pair after repeated capability failures unless overridden', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-builder-gate-'));
  try {
    const failures = path.join(root, '.local/state/wazir-self-improvement-builder/model-failures');
    fs.mkdirSync(failures, { recursive: true });
    const gate = (env = {}) => spawnSync('/bin/bash', [path.join(directory, 'self-improvement-builder.sh'), 'check-model', 'wazir-coding', 'nvidia/nemotron-3-nano-omni'], { encoding: 'utf8', env: { ...process.env, HOME: root, ...env } });
    assert.equal(gate().status, 0, 'no history: allowed');
    const file = path.join(failures, 'wazir-coding__nvidia_nemotron-3-nano-omni');
    fs.writeFileSync(file, '2026-10-15T00:39:57-07:00 MODEL_CAPABILITY exec-mv985i4m-1\n');
    assert.equal(gate().status, 0, 'one failure: allowed');
    fs.appendFileSync(file, '2026-10-15T01:08:19-07:00 MODEL_CAPABILITY exec-mv998n15-1\n');
    const blocked = gate();
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /BLOCKED: agent=wazir-coding model=nvidia\/nemotron-3-nano-omni has 2 recorded MODEL_CAPABILITY failures/);
    assert.equal(gate({ BUILDER_ALLOW_FAILED_MODEL: '1' }).status, 0, 'explicit override');
    const other = spawnSync('/bin/bash', [path.join(directory, 'self-improvement-builder.sh'), 'check-model', 'wazir-coding', 'qwen/qwen3-coder-next'], { encoding: 'utf8', env: { ...process.env, HOME: root } });
    assert.equal(other.status, 0, 'other models unaffected');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
