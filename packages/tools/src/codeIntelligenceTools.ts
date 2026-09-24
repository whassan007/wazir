import type { Tool, ToolResult } from '@wazir/core';
import { CodeIntelligenceService } from '@wazir/core';

let sharedService: CodeIntelligenceService | undefined;

export function getCodeIntelligenceService(projectRoot?: string): CodeIntelligenceService {
  if (!sharedService || (projectRoot && sharedService.getProjectRoot() !== projectRoot)) {
    sharedService = new CodeIntelligenceService({ projectRoot: projectRoot ?? process.cwd() });
  }
  return sharedService;
}

export function setSharedCodeIntelligenceService(service: CodeIntelligenceService): void {
  sharedService = service;
}

export const goToDefinitionTool: Tool = {
  descriptor: {
    name: 'goToDefinition',
    description: 'Find definition locations for a symbol at a given file and position using AST/LSP.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Relative or absolute path to the source file.' },
        line: { type: 'integer', description: '1-based line number.' },
        character: { type: 'integer', description: '0-based character offset.' },
      },
      required: ['file', 'line', 'character'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const { file, line, character } = input as { file: string; line: number; character: number };
      const service = getCodeIntelligenceService(ctx?.projectRoot);
      const locs = await service.goToDefinition(file, line, character);
      return {
        ok: true,
        output: JSON.stringify(locs, null, 2),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        output: '',
        error: `goToDefinition failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      };
    }
  },
};

export const findReferencesTool: Tool = {
  descriptor: {
    name: 'findReferences',
    description: 'Find references to a symbol at a given file and position.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Source file path.' },
        line: { type: 'integer', description: '1-based line number.' },
        character: { type: 'integer', description: '0-based character offset.' },
      },
      required: ['file', 'line', 'character'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const { file, line, character } = input as { file: string; line: number; character: number };
      const service = getCodeIntelligenceService(ctx?.projectRoot);
      const refs = await service.findReferences(file, line, character);
      return {
        ok: true,
        output: JSON.stringify(refs, null, 2),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        output: '',
        error: `findReferences failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      };
    }
  },
};

export const findCallersTool: Tool = {
  descriptor: {
    name: 'findCallers',
    description: 'Find all functions or methods that call the specified symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Symbol name or identifier (e.g. ModelLifecycleService.ensureReady or ensureReady).' },
      },
      required: ['symbol'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const { symbol } = input as { symbol: string };
      const service = getCodeIntelligenceService(ctx?.projectRoot);
      const callers = await service.findCallers(symbol);
      return {
        ok: true,
        output: JSON.stringify(callers, null, 2),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        output: '',
        error: `findCallers failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      };
    }
  },
};

export const documentSymbolsTool: Tool = {
  descriptor: {
    name: 'documentSymbols',
    description: 'Get all symbols (classes, interfaces, functions, methods) defined in a source file.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Source file path.' },
      },
      required: ['file'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const { file } = input as { file: string };
      const service = getCodeIntelligenceService(ctx?.projectRoot);
      await service.indexFile(file);
      const symbols = await service.documentSymbols(file);
      return {
        ok: true,
        output: JSON.stringify(symbols, null, 2),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        output: '',
        error: `documentSymbols failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      };
    }
  },
};

export const workspaceSymbolsTool: Tool = {
  descriptor: {
    name: 'workspaceSymbols',
    description: 'Search for symbols across the workspace by name substring.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name substring to search for.' },
      },
      required: ['query'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const { query } = input as { query: string };
      const service = getCodeIntelligenceService(ctx?.projectRoot);
      const symbols = await service.workspaceSymbols(query);
      return {
        ok: true,
        output: JSON.stringify(symbols, null, 2),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        output: '',
        error: `workspaceSymbols failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      };
    }
  },
};

export const relatedTestsTool: Tool = {
  descriptor: {
    name: 'relatedTests',
    description: 'Find all test suites related to a source file or symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Source file path.' },
      },
      required: ['file'],
    },
    permissions: ['filesystem_read'],
    riskLevel: 'low',
    environment: 'local',
  },
  async execute(input, ctx): Promise<ToolResult> {
    const started = Date.now();
    try {
      const { file } = input as { file: string };
      const service = getCodeIntelligenceService(ctx?.projectRoot);
      const tests = await service.relatedTests(file);
      return {
        ok: true,
        output: JSON.stringify(tests, null, 2),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        output: '',
        error: `relatedTests failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - started,
      };
    }
  },
};

export const codeIntelligenceTools: Tool[] = [
  goToDefinitionTool,
  findReferencesTool,
  findCallersTool,
  documentSymbolsTool,
  workspaceSymbolsTool,
  relatedTestsTool,
];
