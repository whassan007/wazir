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
