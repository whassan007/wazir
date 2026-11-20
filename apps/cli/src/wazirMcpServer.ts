import os from 'node:os';
import path from 'node:path';
import type { RoutingMode, TaskType } from '@wazir/core';
import { getBuildInfo } from './version.js';

function ensureStandardToolPathsOnEnv(): void {
  const sep = path.delimiter;
  const current = (process.env.PATH ?? '').split(sep).filter(Boolean);
  const extra = [
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  for (const candidate of extra) {
    if (!current.includes(candidate)) current.unshift(candidate);
  }
  process.env.PATH = current.join(sep);
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

const WAZIR_MCP_TOOLS = [
  {
    name: 'wazir_fleet_status',
    description:
      'Inspect Wazir control-plane and multi-host fleet status (online computers such as Apple M5 Pro, Mac Studio M4 Max, and NVIDIA DGX Spark GB10, healthy runtimes, discovered models, and active executions).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Optional workspace directory path.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wazir_models_list',
    description:
      'List all models registered and loaded across Wazir local and fleet runtimes (MLX, LM Studio, Ollama, Mac Studio, DGX Spark, and configured providers).',
    inputSchema: {
      type: 'object',
      properties: {
        localOnly: {
          type: 'boolean',
          description: 'When true, return only local/fleet models and omit hosted API models.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wazir_agents_status',
    description:
      'Inspect Wazir native and external coding agents (wazir-coding, antigravity, codex, claude-code, qwen-code), including vendor CLI discovery and preflight readiness.',
    inputSchema: {
      type: 'object',
      properties: {
        probe: {
          type: 'boolean',
          description: 'When true, run a fresh bounded preflight check on external agents.',
        },
        agent: {
          type: 'string',
          description: 'Optional single external agent name to probe when probe=true.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wazir_ask',
    description:
      'Send a governed single-turn prompt to Wazir across local or fleet hardware (e.g., qwen/qwen3-30b-a3b on Mac Studio M4 Max or qwen3-coder:30b on NVIDIA DGX Spark GB10).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Prompt or question to execute.',
        },
        model: {
          type: 'string',
          description: 'Optional model identifier (e.g. qwen/qwen3-30b-a3b or qwen3-coder:30b).',
        },
        computer: {
          type: 'string',
          description: 'Optional target computer ID (e.g. local, mac_studio, dgx_spark).',
        },
        localOnly: {
          type: 'boolean',
          description: 'Restrict execution to local/fleet hardware.',
        },
        routingMode: {
          type: 'string',
          enum: ['AUTO', 'NVIDIA', 'LOCAL_ONLY', 'HYBRID', 'PROVIDER_ONLY'],
          description: 'Optional routing policy mode.',
        },
        workspace: {
          type: 'string',
          description: 'Optional workspace directory.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'wazir_exec',
    description:
      'Execute a governed non-interactive coding or verification task through Wazir with policy enforcement, repo integrity checks, and fleet/agent routing.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Task description to execute.',
        },
        workspace: {
          type: 'string',
          description: 'Target workspace root directory (defaults to current working directory).',
        },
        model: {
          type: 'string',
          description: 'Optional explicit model ID.',
        },
        agent: {
          type: 'string',
          description: 'Optional explicit agent ID (e.g. wazir-coding, qwen-code, codex).',
        },
        type: {
          type: 'string',
          description: 'Optional task type (coding, review, research, chat).',
        },
        maxTurns: {
          type: 'number',
          description: 'Optional maximum agent turns.',
        },
        routingMode: {
          type: 'string',
          enum: ['AUTO', 'NVIDIA', 'LOCAL_ONLY', 'HYBRID', 'PROVIDER_ONLY'],
          description: 'Optional routing policy mode.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
];

const WAZIR_MCP_RESOURCES = [
  {
    uri: 'wazir://fleet/status',
    name: 'Wazir Fleet Status',
    description: 'Live JSON snapshot of Wazir computers, runtimes, and discovered fleet models.',
    mimeType: 'application/json',
  },
  {
    uri: 'wazir://agents/status',
    name: 'Wazir Agents Status',
    description: 'Registered native and external coding agents with discovery and preflight metadata.',
    mimeType: 'application/json',
  },
];

function normalizeRoutingMode(raw?: string): RoutingMode | undefined {
  if (!raw) return undefined;
  const upper = raw.trim().toUpperCase();
  const valid = new Set<RoutingMode>(['AUTO', 'NVIDIA', 'LOCAL_ONLY', 'HYBRID', 'PROVIDER_ONLY']);
  return valid.has(upper as RoutingMode) ? (upper as RoutingMode) : undefined;
}

async function buildFleetSnapshot(workspace?: string) {
  const { createEngine } = await import('./engine.js');
  const { getStatus } = await import('./status.js');
  const engine = await createEngine({
    projectRoot: workspace ? path.resolve(workspace) : process.cwd(),
    readOnlyLifecycle: true,
    quiet: true,
  });
  const summary = getStatus(engine);
  const computers = engine.computers.list().map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    local: c.local,
    runtimes: c.runtimes,
    models: c.models,
    hardware: c.hardware,
  }));
  const runtimes = engine.runtimes.list().map((r) => ({
    id: r.id,
    type: r.type,
    url: r.url,
    health: r.health,
    computerId: r.computerId,
    loadedModels: r.loadedModels,
  }));
  return { summary, computers, runtimes };
}

async function buildAgentsSnapshot(options: { probe?: boolean; agent?: string; workspace?: string } = {}) {
  const { createEngine } = await import('./engine.js');
  const { AgentConnectionManager } = await import('./agentConnectionManager.js');
  const engine = await createEngine({
    projectRoot: options.workspace ? path.resolve(options.workspace) : process.cwd(),
    readOnlyLifecycle: true,
    quiet: true,
  });
  const manager = new AgentConnectionManager(engine);
  const preflight = options.probe
    ? await manager.connect(options.agent ? [options.agent] : [], { fresh: true, timeoutMs: 45_000 })
    : undefined;
  return {
    registered: engine.agents.list().map((entry) => ({
      name: entry.descriptor.name,
      source: entry.source,
      strategy: entry.descriptor.strategy,
      capabilities: entry.descriptor.capabilities,
      description: entry.descriptor.description,
    })),
    discovered: manager.discover(),
    ...(preflight ? { preflight } : {}),
  };
}

async function handleToolCall(name: string, args: Record<string, any> = {}): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    if (name === 'wazir_fleet_status') {
      const data = await buildFleetSnapshot(typeof args.workspace === 'string' ? args.workspace : undefined);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    if (name === 'wazir_models_list') {
      const { createEngine } = await import('./engine.js');
      const engine = await createEngine({ readOnlyLifecycle: true, quiet: true });
      const localOnly = Boolean(args.localOnly);
      const loadedSet = new Set(engine.runtimes.list().flatMap((r) => r.loadedModels ?? []));
      const models = engine.models
        .list()
        .filter((m) => (!localOnly ? true : m.local !== false))
        .map((m) => ({
          id: m.id,
          name: m.name,
          provider: m.provider,
          family: m.family,
          local: m.local,
          loaded: loadedSet.has(m.id),
          contextMax: m.contextMax,
          configuredContext: m.configuredContext,
          capabilities: m.capabilities,
        }));
      return { content: [{ type: 'text', text: JSON.stringify({ count: models.length, models }, null, 2) }] };
    }

    if (name === 'wazir_agents_status') {
      const data = await buildAgentsSnapshot({
        probe: Boolean(args.probe),
        agent: typeof args.agent === 'string' ? args.agent : undefined,
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }

    if (name === 'wazir_ask') {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) {
        return { isError: true, content: [{ type: 'text', text: 'wazir_ask requires a non-empty prompt.' }] };
      }
      const { createEngine } = await import('./engine.js');
      const { askCommand } = await import('./commands.js');
      const engine = await createEngine({
        projectRoot: typeof args.workspace === 'string' ? path.resolve(args.workspace) : process.cwd(),
        readOnlyLifecycle: true,
        quiet: true,
      });
      const result = await askCommand(engine, prompt, {
        model: typeof args.model === 'string' ? args.model : undefined,
        computer: typeof args.computer === 'string' ? args.computer : undefined,
        localOnly: Boolean(args.localOnly),
        routingMode: normalizeRoutingMode(typeof args.routingMode === 'string' ? args.routingMode : undefined),
        json: true,
      });
      return {
        isError: result.code !== 0,
        content: [{ type: 'text', text: result.output || (result.code === 0 ? '{"ok":true}' : '{"ok":false}') }],
      };
    }

    if (name === 'wazir_exec') {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) {
        return { isError: true, content: [{ type: 'text', text: 'wazir_exec requires a non-empty prompt.' }] };
      }
      const { createEngine } = await import('./engine.js');
      const { runTaskCommand } = await import('./commands.js');
      const engine = await createEngine({
        projectRoot: typeof args.workspace === 'string' ? path.resolve(args.workspace) : process.cwd(),
        readOnlyLifecycle: true,
        quiet: true,
      });
      const result = await runTaskCommand(engine, prompt, {
        model: typeof args.model === 'string' ? args.model : undefined,
        agent: typeof args.agent === 'string' ? args.agent : undefined,
        type: (typeof args.type === 'string' ? args.type : 'coding') as TaskType,
        maxTurns: typeof args.maxTurns === 'number' ? args.maxTurns : undefined,
        routingMode: normalizeRoutingMode(typeof args.routingMode === 'string' ? args.routingMode : undefined),
        json: true,
      });
      return {
        isError: result.code !== 0,
        content: [{ type: 'text', text: result.output }],
      };
    }

    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown Wazir MCP tool: ${name}` }],
    };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    };
  }
}

/**
 * Runs Wazir as a Model Context Protocol (MCP) stdio server for external hosts
 * such as Google Antigravity (`agy mcp add wazir wa mcp host`), Antigravity IDE,
 * Claude Desktop, Cursor, or Zed.
 */
export async function runWazirMcpStdioServer(): Promise<void> {
  ensureStandardToolPathsOnEnv();
  const writeStdout = process.stdout.write.bind(process.stdout);
  // Ensure internal diagnostic logging and direct stdout writes never corrupt JSON-RPC frames on stdout.
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  const redirectToStderr = (...items: unknown[]) => {
    process.stderr.write(items.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ') + '\n');
  };
  console.log = redirectToStderr;
  console.info = redirectToStderr;
  console.warn = redirectToStderr;

  const sendMessage = (payload: Record<string, unknown>, framed = false) => {
    const serialized = JSON.stringify(payload);
    if (framed) {
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      writeStdout(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
    } else {
      writeStdout(`${serialized}\n`);
    }
  };

  const dispatchRequest = async (req: JsonRpcRequest, framed: boolean) => {
    const id = req.id;
    const method = req.method ?? '';

    // JSON-RPC notifications omit `id` and expect no response.
    if (id === undefined) return;

    try {
      if (method === 'initialize') {
        const requestedVersion = typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : '2025-03-26';
        const supportedVersions = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);
        const protocolVersion = supportedVersions.has(requestedVersion) ? requestedVersion : '2025-03-26';
        sendMessage(
          {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false },
              },
              serverInfo: {
                name: 'wazir',
                version: getBuildInfo().version,
              },
            },
          },
          framed,
        );
        return;
      }

      if (method === 'ping') {
        sendMessage({ jsonrpc: '2.0', id, result: {} }, framed);
        return;
      }

      if (method === 'tools/list') {
        sendMessage({ jsonrpc: '2.0', id, result: { tools: WAZIR_MCP_TOOLS } }, framed);
        return;
      }

      if (method === 'tools/call') {
        const toolName = String(req.params?.name ?? '');
        const toolArgs = (req.params?.arguments && typeof req.params.arguments === 'object' ? req.params.arguments : {}) as Record<string, any>;
        const toolResult = await handleToolCall(toolName, toolArgs);
        sendMessage({ jsonrpc: '2.0', id, result: toolResult }, framed);
        return;
      }

      if (method === 'resources/list') {
        sendMessage({ jsonrpc: '2.0', id, result: { resources: WAZIR_MCP_RESOURCES } }, framed);
        return;
      }

      if (method === 'resources/read') {
        const uri = String(req.params?.uri ?? '');
        if (uri === 'wazir://fleet/status') {
          const snapshot = await buildFleetSnapshot();
          sendMessage(
            {
              jsonrpc: '2.0',
              id,
              result: {
                contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(snapshot, null, 2) }],
              },
            },
            framed,
          );
          return;
        }
        if (uri === 'wazir://agents/status') {
          const snapshot = await buildAgentsSnapshot();
          sendMessage(
            {
              jsonrpc: '2.0',
              id,
              result: {
                contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(snapshot, null, 2) }],
              },
            },
            framed,
          );
          return;
        }
        sendMessage(
          {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Unknown resource URI: ${uri}` },
          },
          framed,
        );
        return;
      }

      if (method === 'prompts/list') {
        sendMessage({ jsonrpc: '2.0', id, result: { prompts: [] } }, framed);
        return;
      }

      sendMessage(
        {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        },
        framed,
      );
    } catch (error) {
      sendMessage(
        {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        },
        framed,
      );
    }
  };

  await new Promise<void>((resolve) => {
    let buffer = Buffer.alloc(0);

    const drainBuffer = () => {
      while (buffer.length > 0) {
        const prefix = buffer.subarray(0, Math.min(buffer.length, 32)).toString('utf8');
        if (/^Content-Length:/i.test(prefix)) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;
          const headerText = buffer.subarray(0, headerEnd).toString('utf8');
          const match = /Content-Length:\s*(\d+)/i.exec(headerText);
          if (!match) {
            buffer = buffer.subarray(headerEnd + 4);
            continue;
          }
          const contentLen = Number(match[1]);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + contentLen) return;
          const rawJson = buffer.subarray(bodyStart, bodyStart + contentLen).toString('utf8');
          buffer = buffer.subarray(bodyStart + contentLen);
          try {
            const parsed = JSON.parse(rawJson) as JsonRpcRequest;
            void dispatchRequest(parsed, true);
          } catch {
            // Ignore malformed frame
          }
          continue;
        }

        const newlineIdx = buffer.indexOf(0x0a); // '\n'
        if (newlineIdx === -1) return;
        const line = buffer.subarray(0, newlineIdx).toString('utf8').trim();
        buffer = buffer.subarray(newlineIdx + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as JsonRpcRequest;
          void dispatchRequest(parsed, false);
        } catch {
          // Ignore malformed line
        }
      }
    };

    process.stdin.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      buffer = Buffer.concat([buffer, buf]);
      drainBuffer();
    });
    process.stdin.on('end', () => resolve());
    process.stdin.on('close', () => resolve());
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
    process.stdin.resume();
  });
}
