// LSP tool wrappers for Wazir

import { Tool, ToolDescriptor, ToolResult } from '@wazir/core';
import LspManager from '@wazir/lsp/src/LspManager';
import * as path from 'path';
import { Logger } from '@wazir/shared/src/logger';

/**
 * Helper to get (or create) a LspManager for a workspace.
 * The manager is cached per workspace path.
 */
const managers = new Map<string, LspManager>();
function getManager(workspaceRoot: string): LspManager {
  if (!managers.has(workspaceRoot)) {
    managers.set(workspaceRoot, new LspManager(workspaceRoot));
  }
  return managers.get(workspaceRoot)!;
}

/**
 * Generic helper to send an LSP request and await the response.
 */
async function sendRequest<T>(
  language: string,
  method: string,
  params: any,
  workspaceRoot: string,
): Promise<T> {
  const manager = getManager(workspaceRoot);
  const server = manager.getServer(language);
  const logger = new Logger({ component: 'LspTool', workspace: workspaceRoot });

  // Simple JSON‑RPC 2.0 framing over stdio
  const id = Math.floor(Math.random() * 1_000_000);
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  server.stdin.write(request);

  return new Promise<T>((resolve, reject) => {
    const onData = (data: Buffer) => {
      try {
        const messages = data
          .toString('utf8')
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l));
        for (const msg of messages) {
          if (msg.id === id) {
            server.stdout.off('data', onData);
            if (msg.error) {
              logger.error(`LSP ${method} error: ${msg.error.message}`);
              reject(new Error(msg.error.message));
            } else {
              resolve(msg.result as T);
            }
            break;
          }
        }
      } catch (e) {
        // keep listening – malformed data may be part of a larger message
        logger.debug(`LSP parsing error: ${(e as Error).message}`);
      }
    };
    server.stdout.on('data', onData);
  });
}

/**
 * goToDefinition – returns an array of location objects.
 */
export const goToDefinition: Tool = {
  descriptor: {
    name: 'goToDefinition',
    description: 'Find the definition locations for a symbol at a given file and position.',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'Programming language (typescript, python, go).' },
        file: { type: 'string', description: 'Absolute path to the source file.' },
        line: { type: 'integer', description: '1‑based line number.' },
        character: { type: 'integer', description: '0‑based character offset on the line.' },
        workspaceRoot: { type: 'string', description: 'Root directory of the workspace.' },
      },
      required: ['language', 'file', 'line', 'character', 'workspaceRoot'],
    },
    permissions: ['filesystem'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, _ctx): Promise<ToolResult> {
    try {
      const { language, file, line, character, workspaceRoot } = input as any;
      const params = {
        textDocument: { uri: `file://${path.resolve(file)}` },
        position: { line: line - 1, character },
      };
      const locations = await sendRequest<any[]>(
        language,
        'textDocument/definition',
        params,
        workspaceRoot,
      );
      return { ok: true, output: JSON.stringify(locations), error: '', durationMs: 0 };
    } catch (e) {
      return { ok: false, output: '', error: (e as Error).message, durationMs: 0 };
    }
  },
} as const;

/**
 * findReferences – returns an array of reference locations.
 */
export const findReferences: Tool = {
  descriptor: {
    name: 'findReferences',
    description: 'Find all references for a symbol at a given file and position.',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        file: { type: 'string' },
        line: { type: 'integer' },
        character: { type: 'integer' },
        workspaceRoot: { type: 'string' },
      },
      required: ['language', 'file', 'line', 'character', 'workspaceRoot'],
    },
    permissions: ['filesystem'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, _ctx): Promise<ToolResult> {
    try {
      const { language, file, line, character, workspaceRoot } = input as any;
      const params = {
        textDocument: { uri: `file://${path.resolve(file)}` },
        position: { line: line - 1, character },
        context: { includeDeclaration: true },
      };
      const refs = await sendRequest<any[]>(
        language,
        'textDocument/references',
        params,
        workspaceRoot,
      );
      return { ok: true, output: JSON.stringify(refs), error: '', durationMs: 0 };
    } catch (e) {
      return { ok: false, output: '', error: (e as Error).message, durationMs: 0 };
    }
  },
} as const;

/**
 * hover – returns hover information for a position.
 */
export const hover: Tool = {
  descriptor: {
    name: 'hover',
    description: 'Retrieve hover information (type, docs) for a position.',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        file: { type: 'string' },
        line: { type: 'integer' },
        character: { type: 'integer' },
        workspaceRoot: { type: 'string' },
      },
      required: ['language', 'file', 'line', 'character', 'workspaceRoot'],
    },
    permissions: ['filesystem'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, _ctx): Promise<ToolResult> {
    try {
      const { language, file, line, character, workspaceRoot } = input as any;
      const params = {
        textDocument: { uri: `file://${path.resolve(file)}` },
        position: { line: line - 1, character },
      };
      const hoverInfo = await sendRequest<any>(
        language,
        'textDocument/hover',
        params,
        workspaceRoot,
      );
      return { ok: true, output: JSON.stringify(hoverInfo), error: '', durationMs: 0 };
    } catch (e) {
      return { ok: false, output: '', error: (e as Error).message, durationMs: 0 };
    }
  },
} as const;

/**
 * documentSymbols – list symbols defined in a file.
 */
export const documentSymbols: Tool = {
  descriptor: {
    name: 'documentSymbols',
    description: 'Return a hierarchical list of symbols defined in a file.',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        file: { type: 'string' },
        workspaceRoot: { type: 'string' },
      },
      required: ['language', 'file', 'workspaceRoot'],
    },
    permissions: ['filesystem'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, _ctx): Promise<ToolResult> {
    try {
      const { language, file, workspaceRoot } = input as any;
      const params = { textDocument: { uri: `file://${path.resolve(file)}` } };
      const symbols = await sendRequest<any[]>(
        language,
        'textDocument/documentSymbol',
        params,
        workspaceRoot,
      );
      return { ok: true, output: JSON.stringify(symbols), error: '', durationMs: 0 };
    } catch (e) {
      return { ok: false, output: '', error: (e as Error).message, durationMs: 0 };
    }
  },
} as const;

// Export as an array for easy registration
export const lspTools = [goToDefinition, findReferences, hover, documentSymbols];
