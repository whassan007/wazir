import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAction,
  normalizeAction,
  missingRequiredFields,
  REQUIRED_TOOL_FIELDS,
} from '@wazir/agents';
import type { RookEngine } from '../engine.js';
import { color } from '../colors.js';
import { executeTask } from '../run.js';
import { table } from './formatters.js';

interface ActionProtocolCase {
  description: string;
  raw: string;
  expected: 'VALID' | 'INVALID';
}

// Real-world cases: `write`'s own `content` field is a plain string (never the sole key,
// never itself an object) so it's exempt from the content-wrapper case; the brace-in-prose
// case reproduces the exact live transcript that exposed extractFirstObject()'s bug
// (quoting "the array {5,3,1,4,2}" before the real action).
const ACTION_PROTOCOL_CASES: ActionProtocolCase[] = [
  { description: 'read(path="src/main.cpp")', raw: '{"action":"tool","tool":"read","input":{"path":"src/main.cpp"}}', expected: 'VALID' },
  { description: 'read(path="") — blank path', raw: '{"action":"tool","tool":"read","input":{"path":""}}', expected: 'VALID' },
  { description: 'read({}) — missing path', raw: '{"action":"tool","tool":"read","input":{}}', expected: 'INVALID' },
  { description: 'write(path, content)', raw: '{"action":"tool","tool":"write","input":{"path":"main.cpp","content":"int main(){}"}}', expected: 'VALID' },
  { description: 'write(path, content="") — legitimate empty file', raw: '{"action":"tool","tool":"write","input":{"path":"empty.txt","content":""}}', expected: 'VALID' },
  { description: 'write(path) — missing content', raw: '{"action":"tool","tool":"write","input":{"path":"main.cpp"}}', expected: 'INVALID' },
  { description: 'write(content) — missing path', raw: '{"action":"tool","tool":"write","input":{"content":"x"}}', expected: 'INVALID' },
  { description: 'write({}) — missing both', raw: '{"action":"tool","tool":"write","input":{}}', expected: 'INVALID' },
  { description: 'shell(command="ls")', raw: '{"action":"tool","tool":"shell","input":{"command":"ls"}}', expected: 'VALID' },
  { description: 'shell({}) — missing command', raw: '{"action":"tool","tool":"shell","input":{}}', expected: 'INVALID' },
  { description: 'glob(pattern="*.cpp")', raw: '{"action":"tool","tool":"glob","input":{"pattern":"*.cpp"}}', expected: 'VALID' },
  { description: 'glob({}) — missing pattern', raw: '{"action":"tool","tool":"glob","input":{}}', expected: 'INVALID' },
  {
    description: 'real bug: shell args wrapped one level too deep under "content"',
    raw: '{"action":"tool","tool":"shell","input":{"content":{"command":"ls -la"}}}',
    expected: 'VALID',
  },
  {
    description: 'real bug: task prose quotes a brace before the real action',
    raw: 'The user asked to sort the array {5,3,1,4,2}.\n{"action":"plan","content":"go"}',
    expected: 'VALID',
  },
  { description: 'not JSON at all', raw: 'I will now think about this for a while.', expected: 'INVALID' },
];

/**
 * `wa test action-protocol` — the parser/validator matrix from the follow-up architecture
 * review's "test I would run right now", made real: never invokes a model, only exercises
 * parseAction -> normalizeAction -> missingRequiredFields exactly as the live agent loop
 * does, and asserts the deterministic pipeline (§10 there): INVALID never reaches Policy or
 * the tool executor. Fast enough for CI; the companion `wa test model-protocol` is the one
 * that needs a real runtime.
 */
export function actionProtocolTestCommand(): { code: number; output: string } {
  const toolNames = new Set(Object.keys(REQUIRED_TOOL_FIELDS));
  const rows: string[][] = [];
  let failures = 0;

  for (const c of ACTION_PROTOCOL_CASES) {
    const action = normalizeAction(parseAction(c.raw), toolNames);
    let actual: 'VALID' | 'INVALID';
    let detail = '';
    if (!action) {
      actual = 'INVALID';
      detail = 'unparseable';
    } else if (action.action === 'tool' && action.tool) {
      const missing = missingRequiredFields(action.tool, action.input ?? {});
      actual = missing.length === 0 ? 'VALID' : 'INVALID';
      detail = missing.length > 0 ? `missing: ${missing.join(', ')}` : '';
    } else {
      actual = 'VALID';
      detail = `action=${action.action}`;
    }

    const status = actual === c.expected ? color.green('PASS') : color.red('FAIL');
    if (actual !== c.expected) failures += 1;
    rows.push([c.description, c.expected, actual, status, detail]);
  }

  const lines = [
    color.bold('Action protocol matrix (no model invoked)'),
    '',
    table(['case', 'expected', 'actual', 'status', 'detail'], rows),
    '',
    `${rows.length - failures}/${rows.length} passed`,
  ];
  return { code: failures === 0 ? 0 : 1, output: lines.join('\n') };
}

/**
 * `wa test model-protocol --model <id>` — runs one deterministic, easily-verified task
 * (write a known file with known content) through the real agent loop against a real
 * model/runtime, in an isolated throwaway project directory, and reports:
 *   - a per-turn trace (kind, tool, whether a locally-rejected/duplicate action fired)
 *   - whether the file actually ended up with the exact expected content on disk
 *   - the task's own deterministic evaluation (evaluateExecution)
 * This is the live counterpart to actionProtocolTestCommand() — comparing two models'
 * output here (`wa test model-protocol --model A` vs `--model B`) is exactly the
 * "if both fail identically, Wazir is the problem; if only one fails, it's a model/
 * protocol compatibility problem" comparison the architecture review asked for.
 */
export async function modelProtocolTestCommand(modelId: string): Promise<{ code: number; output: string }> {
  const { createEngine } = await import('../engine.js');
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-model-protocol-'));
  const targetFile = 'wazir-protocol-check.txt';
  const marker = 'WAZIR_OK';

  const lines: string[] = [
    color.bold(`Model protocol test — ${modelId}`),
    color.gray(`  task: create ${targetFile} containing exactly "${marker}"`),
    color.gray(`  workspace: ${projectRoot}`),
    '',
  ];

  try {
    const engine = await createEngine({ projectRoot, quiet: true });
    const description =
      `Create a file named ${targetFile} in the project root containing exactly the text ` +
      `${marker} and nothing else, then respond with the done action.`;

    const outcome = await executeTask(engine, description, {
      type: 'coding',
      model: modelId,
      maxTurns: 15,
      expectedFiles: [targetFile],
      quiet: true,
    });

    const record = engine.executions.require(outcome.executionId);
    const turnEvents = record.events.filter((e) => e.type === 'agent.turn') as Array<{
      data?: { kind?: string; tool?: string; content?: string; error?: string };
    }>;
    const PROTOCOL_PREFIXES = ['ACTION_VALIDATION_FAILED', 'ACTION_BLOCKED_DUPLICATE', 'INVALID_JSON_ACTION'];
    const isProtocolNote = (content?: string) => PROTOCOL_PREFIXES.some((p) => content?.startsWith(p));

    const rows = turnEvents.map((e, i) => {
      const d = e.data ?? {};
      const note = isProtocolNote(d.content) ? color.yellow('REJECTED') : d.error ? color.red('failed') : d.tool ? 'ok' : '';
      const summary = (d.content ?? d.error ?? '').slice(0, 70);
      return [String(i + 1), d.kind ?? '', d.tool ?? '', note, summary];
    });
    lines.push(table(['#', 'kind', 'tool', 'note', 'summary'], rows));

    const protocolCorrections = turnEvents.filter((e) => isProtocolNote(e.data?.content)).length;
    lines.push('');
    lines.push(`Protocol corrections needed: ${protocolCorrections}`);

    let actualContent = '';
    let fileOk = false;
    try {
      actualContent = (await fs.readFile(path.join(projectRoot, targetFile), 'utf8')).trim();
      fileOk = actualContent === marker;
    } catch {
      fileOk = false;
    }

    lines.push(
      `File has exact expected content: ${fileOk ? color.green('PASS') : color.red('FAIL')}` +
        (fileOk ? '' : ` (got ${JSON.stringify(actualContent.slice(0, 80))})`),
    );
    lines.push(`Task-level evaluation: ${outcome.success ? color.green('PASS') : color.red('FAIL')} (${outcome.reasons.join('; ')})`);

    const passed = fileOk && outcome.success;
    lines.push('');
    lines.push(passed ? color.green('RESULT: PASS') : color.red('RESULT: FAIL'));

    return { code: passed ? 0 : 1, output: lines.join('\n') };
  } catch (err) {
    lines.push(color.red(`error: ${err instanceof Error ? err.message : String(err)}`));
    return { code: 1, output: lines.join('\n') };
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface ProviderSummaryEntry {
  id: string;
  name: string;
  providerType: 'LOCAL_INFERENCE' | 'HOSTED_INFERENCE';
  resourceType: 'LOCAL_GPU_INFERENCE' | 'HOSTED_API_INFERENCE';
  endpoint?: string;
  state: 'configured' | 'authenticated' | 'healthy' | 'degraded' | 'unavailable';
  authenticated: boolean;
  credentialSource?: string;
  defaultModel?: string;
  modelsCount: number;
  models: string[];
  capabilities?: Record<string, unknown>;
}

export async function collectProvidersSummary(engine: RookEngine): Promise<ProviderSummaryEntry[]> {
  const entries: ProviderSummaryEntry[] = [];

  for (const disc of engine.discovered) {
    const rt = engine.runtimes.get(disc.id);
    const modelIds = disc.models.map((m) => m.id);
    entries.push({
      id: disc.id,
      name: disc.info.name || disc.id,
      providerType: 'LOCAL_INFERENCE',
      resourceType: 'LOCAL_GPU_INFERENCE',
      endpoint: disc.info.url,
      state: disc.health === 'healthy' ? 'healthy' : disc.health === 'degraded' ? 'degraded' : 'unavailable',
      authenticated: disc.health !== 'unavailable',
      credentialSource: 'local-endpoint',
      defaultModel: modelIds[0],
      modelsCount: modelIds.length,
      models: modelIds,
      capabilities: (rt?.capabilities ?? {}) as unknown as Record<string, unknown>,
    });
  }

  for (const [id, adapter] of engine.hostedAdapters) {
    const rt = engine.runtimes.get(id);
    const info = await adapter.discover().catch(() => ({ id, name: rt?.name ?? id, version: 'v1', url: rt?.url }));
    const auth = await adapter.status();
    const models = engine.models.list().filter((m) => m.provider === id);
    const defaultModel =
      typeof (adapter as any).getDefaultModel === 'function'
        ? (adapter as any).getDefaultModel()
        : models[0]?.id;
    let state: ProviderSummaryEntry['state'] = 'unavailable';
    if (rt?.health === 'healthy' && auth.authenticated) {
      state = 'healthy';
    } else if (rt?.health === 'degraded' && auth.authenticated) {
      state = 'degraded';
    } else if (auth.authenticated) {
      state = 'authenticated';
    } else if (id === 'nvidia' && engine.config.providers?.nvidia?.enabled) {
      state = 'configured';
    }
    entries.push({
      id,
      name: info.name || rt?.name || id,
      providerType: 'HOSTED_INFERENCE',
      resourceType: 'HOSTED_API_INFERENCE',
      endpoint: info.url ?? rt?.url,
      state,
      authenticated: auth.authenticated,
      credentialSource: auth.credentialSource ?? auth.method ?? 'none',
      defaultModel,
      modelsCount: models.length,
      models: models.map((m) => m.id),
      capabilities: (rt?.capabilities ?? (await adapter.getCapabilities())) as unknown as Record<string, unknown>,
    });
  }

  return entries;
}

export async function listProvidersCommand(
  engine: RookEngine,
  options: { json?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const providers = await collectProvidersSummary(engine);
  if (options.json) {
    return { code: 0, output: JSON.stringify({ providers }, null, 2) };
  }
  const rows = providers.map((p) => [
    p.id,
    p.name,
    p.providerType,
    p.state,
    p.authenticated ? `yes (${p.credentialSource})` : 'no',
    String(p.modelsCount),
    p.defaultModel ?? '—',
  ]);
  return {
    code: 0,
    output: table(['ID', 'NAME', 'TYPE', 'STATE', 'AUTH', 'MODELS', 'DEFAULT MODEL'], rows),
  };
}

export async function inspectProviderCommand(
  engine: RookEngine,
  providerId: string,
  options: { json?: boolean } = {},
): Promise<{ code: number; output: string }> {
  const normalized = providerId.toLowerCase();
  const providers = await collectProvidersSummary(engine);
  const found = providers.find((p) => p.id.toLowerCase() === normalized);
  if (!found) {
    const err = `Provider '${providerId}' not found. Available providers: ${providers.map((p) => p.id).join(', ')}`;
    return {
      code: 1,
      output: options.json ? JSON.stringify({ error: err }, null, 2) : color.red(err),
    };
  }
  const modelRecords = engine.models.list().filter((m) => m.provider === found.id);
  const account = engine.resources?.accounts?.candidates?.({ runtimeId: found.id })?.[0];
  const detail = {
    ...found,
    routingPolicy: {
      allowHostedProvidersDefault: engine.config.providers?.allowHostedProviders ?? false,
      routing: engine.config.routing,
      ...(found.id === 'nvidia' ? { nvidiaConfig: engine.config.providers?.nvidia } : {}),
    },
    account: account
      ? {
          id: account.id,
          kind: account.kind,
          maxConcurrent: account.maxConcurrent,
          allowPaid: account.allowPaid,
        }
      : undefined,
    modelDetails: modelRecords.map((m) => ({
      id: m.id,
      name: m.name,
      family: m.family,
      contextMax: m.contextMax,
      capabilities: m.capabilities,
      toolCalling: m.toolCalling,
      vision: m.vision,
      reasoning: m.reasoning,
      structuredOutput: m.structuredOutput,
    })),
  };

  if (options.json) {
    return { code: 0, output: JSON.stringify(detail, null, 2) };
  }

  const lines = [
    color.bold(`PROVIDER: ${found.name} (${found.id})`),
    '-'.repeat(56),
    `  Type:              ${found.providerType}`,
    `  Resource Type:     ${found.resourceType}`,
    `  State:             ${found.state}`,
    `  Authenticated:     ${found.authenticated ? color.green(`yes (${found.credentialSource})`) : color.yellow('no')}`,
    `  Endpoint:          ${found.endpoint ?? '—'}`,
    `  Default Model:     ${found.defaultModel ?? '—'}`,
    `  Registered Models: ${found.modelsCount}`,
  ];
  if (account) {
    lines.push(`  Resource Account:  ${account.id} (kind=${account.kind}, maxConcurrent=${account.maxConcurrent ?? 'unlimited'})`);
  }
  if (modelRecords.length > 0) {
    lines.push('');
    lines.push(color.bold('  Models:'));
    for (const m of modelRecords) {
      lines.push(
        `    - ${m.id} [ctx=${m.contextMax}, vision=${m.vision}, reasoning=${m.reasoning}, tools=${m.toolCalling}]`,
      );
    }
  }
  return { code: 0, output: lines.join('\n') };
}

export async function testProviderCommand(
  engine: RookEngine,
  providerId: string,
  options: { json?: boolean; prompt?: string; model?: string } = {},
): Promise<{ code: number; output: string }> {
  const normalized = providerId.toLowerCase();
  const hosted = engine.hostedAdapters.get(normalized as any);
  const disc = engine.discovered.find((d) => d.id.toLowerCase() === normalized);
  if (!hosted && !disc) {
    const err = `Provider '${providerId}' not found.`;
    return {
      code: 1,
      output: options.json ? JSON.stringify({ ok: false, error: err }, null, 2) : color.red(err),
    };
  }

  const adapter = hosted ?? disc!.adapter;
  const startedAt = Date.now();
  const health = await adapter.healthCheck();
  const latencyMs = Date.now() - startedAt;
  const models = await adapter.listModels().catch(() => []);
  const ok = health.status === 'healthy' || health.status === 'degraded';

  const resultPayload = {
    ok,
    provider: normalized,
    health: health.status,
    reason: health.reason,
    message: health.message,
    latencyMs,
    discoveredModelsCount: models.length,
    sampleModels: models.slice(0, 5).map((m) => m.id),
  };

  if (options.json) {
    return { code: ok ? 0 : 1, output: JSON.stringify(resultPayload, null, 2) };
  }

  const lines = [
    color.bold(`Provider Connectivity Test: ${normalized}`),
    `  status:    ${ok ? color.green(health.status) : color.red(health.status)}`,
    `  latency:   ${latencyMs}ms`,
    `  models:    ${models.length} discovered`,
    ...(health.message ? [`  message:   ${health.message}`] : []),
    ...(models.length > 0 ? [`  available: ${models.slice(0, 5).map((m) => m.id).join(', ')}`] : []),
  ];
  return { code: ok ? 0 : 1, output: lines.join('\n') };
}

export async function listProviders(engine: RookEngine, options: { json?: boolean } = {}) {
  const result = await listProvidersCommand(engine, options);
  if (options.json) {
    const parsed = JSON.parse(result.output);
    const providers = parsed.providers.map((p: any) => ({ ...p, displayName: p.name }));
    return { exitCode: result.code, output: JSON.stringify(providers) };
  }
  return { exitCode: result.code, output: result.output };
}

export async function inspectProvider(engine: RookEngine, providerId: string, options: { json?: boolean } = {}) {
  const result = await inspectProviderCommand(engine, providerId, options);
  if (options.json && result.code === 0) {
    const detail = JSON.parse(result.output);
    detail.displayName = detail.name;
    detail.models = (detail.modelDetails ?? []).map((m: any) => ({ id: m.id, name: m.name }));
    return { exitCode: result.code, output: JSON.stringify(detail) };
  }
  return { exitCode: result.code, output: result.output };
}

export async function testProvider(engine: RookEngine, providerId: string, options: { json?: boolean } = {}) {
  const result = await testProviderCommand(engine, providerId, options);
  return { exitCode: result.code, output: result.output };
}
