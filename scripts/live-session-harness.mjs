#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { scenarios, gates } from './live-session-harness/catalog.mjs';
import { runSession } from './live-session-harness/runner.mjs';

const { values } = parseArgs({ options: {
  list: { type: 'boolean' }, all: { type: 'boolean' }, gate: { type: 'string' }, session: { type: 'string', multiple: true },
  model: { type: 'string', multiple: true }, output: { type: 'string', default: '/tmp/wazir-live-results' },
  config: { type: 'string' }, 'max-turns': { type: 'string', default: '60' }, 'timeout-ms': { type: 'string', default: '1800000' },
} });
if (values.list) {
  console.log(JSON.stringify({ gates, scenarios }, null, 2));
} else {
  if (!values.model?.length) throw new Error('Specify at least one --model; live runs never substitute a mock model');
  if (values.gate && !gates[values.gate]) throw new Error(`Unknown gate: ${values.gate}`);
  for (const id of values.session ?? []) if (!scenarios.some(s => s.id === id)) throw new Error(`Unknown session: ${id}`);
  if ([values.all, Boolean(values.gate), Boolean(values.session?.length)].filter(Boolean).length !== 1) throw new Error('Select exactly one of --all, --gate, or --session');
  const maxTurns = Number(values['max-turns']), timeoutMs = Number(values['timeout-ms']);
  if (![maxTurns, timeoutMs].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Budgets must be positive integers');
  const output = path.resolve(values.output);
  await fs.mkdir(output, { recursive: true });
  const selected = scenarios.filter(s => values.all || values.session?.includes(s.id) || s.gates.includes(values.gate));
  const results = [];
  for (const model of values.model) for (const scenario of selected) {
    console.error(`Running ${scenario.id}: ${scenario.title} (${model})`);
    const result = await runSession(scenario, { model, output, config: values.config, maxTurns, timeoutMs });
    results.push(result);
    console.error(`${scenario.id}: ${result.status}${result.reasons.length ? ` — ${result.reasons.join('; ')}` : ''}`);
  }
  const report = { schema_version: 1, gate: values.gate ?? null, qualified: results.length > 0 && results.every(r => r.status === 'PASS'), results };
  const reportPath = path.join(output, `scorecard-${Date.now()}-${process.pid}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(reportPath);
  process.exitCode = report.qualified ? 0 : results.some(r => r.status === 'FAIL') ? 1 : 2;
}
