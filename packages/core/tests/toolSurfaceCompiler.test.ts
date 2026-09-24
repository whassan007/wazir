import { describe, it, expect } from 'vitest';
import {
  ToolSurfaceCompiler,
  optimizeToolSchema,
  estimateSchemaTokens,
  selectProtocol,
  normalizeMCPToolDescriptor,
  classifyToolSource,
  MUTATION_TOOLS,
  VERIFICATION_TOOLS,
} from '../src/services/toolSurfaceCompiler.js';
import type { Tool, ToolDescriptor } from '../src/types/tool.js';
import type { ToolSurfaceRequest } from '../src/types/toolSurface.js';
import type { RuntimeCapabilities } from '@wazir/runtimes-interfaces';

describe('ToolSurfaceCompiler & Action Architecture', () => {
  const mockTools: Tool[] = [
    {
      descriptor: {
        name: 'read',
        description: 'Read file contents from the workspace.',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          title: 'ReadFileInput',
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file' },
          },
          required: ['path'],
        },
        permissions: ['filesystem_read'],
        riskLevel: 'low',
        environment: 'local',
      },
      execute: async () => ({ ok: true, output: 'file content', durationMs: 5 }),
    },
    {
      descriptor: {
        name: 'write',
        description: 'Write file contents to the workspace.',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          title: 'WriteFileInput',
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative path to file' },
            content: { type: 'string', description: 'New contents' },
          },
          required: ['path', 'content'],
        },
        permissions: ['filesystem_write'],
        riskLevel: 'medium',
        environment: 'local',
      },
      execute: async () => ({ ok: true, output: 'ok', durationMs: 5 }),
    },
    {
      descriptor: {
        name: 'edit',
        description: 'Edit a file using search and replace.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_str: { type: 'string' },
            new_str: { type: 'string' },
          },
          required: ['path', 'old_str', 'new_str'],
        },
        permissions: ['filesystem_write'],
        riskLevel: 'medium',
        environment: 'local',
      },
      execute: async () => ({ ok: true, output: 'ok', durationMs: 5 }),
    },
    {
      descriptor: {
        name: 'code_mode',
        description: 'Execute JavaScript program against the typed Wazir SDK.',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string' },
          },
          required: ['script'],
        },
        permissions: ['filesystem_read', 'filesystem_write'],
        riskLevel: 'medium',
        environment: 'local',
      },
      execute: async () => ({ ok: true, output: 'ok', durationMs: 10 }),
    },
    {
      descriptor: {
        name: 'test',
        description: 'Run project tests.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
        },
        permissions: ['test_run'],
        riskLevel: 'low',
        environment: 'local',
      },
      execute: async () => ({ ok: true, output: 'pass', durationMs: 20 }),
    },
    {
      descriptor: {
        name: 'build',
        description: 'Build project targets.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
          },
        },
        permissions: ['build_run'],
        riskLevel: 'low',
        environment: 'local',
      },
      execute: async () => ({ ok: true, output: 'build ok', durationMs: 30 }),
    },
    {
      descriptor: {
        name: 'goToDefinition',
        description: 'Find definition locations for a symbol.',
        inputSchema: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'number' },
            character: { type: 'number' },
          },
          required: ['file', 'line', 'character'],
        },
        permissions: ['filesystem_read'],
        riskLevel: 'low',
        environment: 'local',
      },
      execute: async () => ({ ok: true, output: '[]', durationMs: 5 }),
    },
    {
      descriptor: {
        name: 'mcp.database.query',
        description: 'Query database through connected MCP server.',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string' },
          },
          required: ['sql'],
        },
        permissions: ['mcp'],
        riskLevel: 'high',
        environment: 'local',
        provenance: {
          source: 'mcp',
          serverId: 'database',
          tool: 'query',
          trust: 'untrusted',
        },
      },
      execute: async () => ({ ok: true, output: '[]', durationMs: 15 }),
    },
  ];

  const compiler = new ToolSurfaceCompiler();

  // Test 1: runtime reports native tool capability
  it('1. correctly selects native_tool_call when runtime reports nativeToolCalling', () => {
    const caps: RuntimeCapabilities = {
      nativeToolCalling: true,
      parallelToolCalling: true,
      strictJsonSchema: true,
      structuredOutput: true,
      streamingToolCalls: true,
      promptCaching: false,
    };
    const selection = selectProtocol(caps);
    expect(selection.protocol).toBe('native_tool_call');
    expect(selection.reason).toContain('nativeToolCalling');
  });

  // Test 2: runtime reports no native capability
  it('2. falls back to structured_output or legacy_text when runtime lacks native tool calling', () => {
    const structuredCaps: Partial<RuntimeCapabilities> = {
      nativeToolCalling: false,
      structuredOutput: true,
    };
    const structuredSel = selectProtocol(structuredCaps);
    expect(structuredSel.protocol).toBe('structured_output');
    expect(structuredSel.reason).toContain('structured output');

    const legacyCaps: Partial<RuntimeCapabilities> = {
      nativeToolCalling: false,
      structuredOutput: false,
      strictJsonSchema: false,
    };
    const legacySel = selectProtocol(legacyCaps);
    expect(legacySel.protocol).toBe('legacy_text');
    expect(legacySel.reason).toContain('legacy text action protocol');
  });

  // Test 6: PLAN excludes mutation tools
  it('6. PLAN excludes mutation tools (write, edit, code_mode)', () => {
    const surface = compiler.compile(mockTools, {
      phase: 'plan',
      runtimeCapabilities: { nativeToolCalling: true },
    });

    const exposedNames = surface.tools.map((t) => t.descriptor.name);
    expect(exposedNames).toContain('read');
    expect(exposedNames).toContain('goToDefinition');
    expect(exposedNames).not.toContain('write');
    expect(exposedNames).not.toContain('edit');
    expect(exposedNames).not.toContain('code_mode');

    const writeOmission = surface.omissions.find((o) => o.name === 'write');
    expect(writeOmission).toBeDefined();
    expect(writeOmission?.reason).toContain('Mutation tools are excluded');
  });

  // Test 7: IMPLEMENT includes required mutation tools
  it('7. IMPLEMENT includes required mutation tools', () => {
    const surface = compiler.compile(mockTools, {
      phase: 'implement',
      runtimeCapabilities: { nativeToolCalling: true },
    });

    const exposedNames = surface.tools.map((t) => t.descriptor.name);
    expect(exposedNames).toContain('read');
    expect(exposedNames).toContain('write');
    expect(exposedNames).toContain('edit');
    expect(exposedNames).toContain('code_mode');
    expect(exposedNames).toContain('test');
    expect(exposedNames).toContain('build');
  });

  // Test 8: VERIFY receives verification tools and excludes mutation tools
  it('8. VERIFY receives verification tools and excludes mutation tools', () => {
    const surface = compiler.compile(mockTools, {
      phase: 'verify',
      runtimeCapabilities: { nativeToolCalling: true },
    });

    const exposedNames = surface.tools.map((t) => t.descriptor.name);
    expect(exposedNames).toContain('test');
    expect(exposedNames).toContain('build');
    expect(exposedNames).toContain('read');
    expect(exposedNames).not.toContain('write');
    expect(exposedNames).not.toContain('edit');
    expect(exposedNames).not.toContain('code_mode');

    const editOmission = surface.omissions.find((o) => o.name === 'edit');
    expect(editOmission).toBeDefined();
    expect(editOmission?.reason).toContain('verification integrity');
  });

  // Test 9: unavailable tool is not serialized
  it('9. unavailable or gated tools are not serialized into the surface', () => {
    // A: Disabled via request
    const disabledSurface = compiler.compile(mockTools, {
      phase: 'implement',
      disabledToolNames: ['edit'],
    });
    expect(disabledSurface.tools.some((t) => t.descriptor.name === 'edit')).toBe(false);
    expect(disabledSurface.serializedSchemas.some((s) => s.name === 'edit')).toBe(false);

    // B: Code Intelligence disabled
    const noCodeIntelSurface = compiler.compile(mockTools, {
      phase: 'implement',
      availableCodeIntelligence: false,
    });
    expect(noCodeIntelSurface.tools.some((t) => t.descriptor.name === 'goToDefinition')).toBe(false);

    // C: Code Mode disabled
    const noCodeModeSurface = compiler.compile(mockTools, {
      phase: 'implement',
      availableCodeMode: false,
    });
    expect(noCodeModeSurface.tools.some((t) => t.descriptor.name === 'code_mode')).toBe(false);

    // D: Connected MCP gating
    const mcpSurface = compiler.compile(mockTools, {
      phase: 'implement',
      connectedMCPCapabilities: ['other-server'], // database server not in connected capabilities
    });
    expect(mcpSurface.tools.some((t) => t.descriptor.name === 'mcp.database.query')).toBe(false);
  });

  // Test 10: schema-token count decreases when surface narrows
  it('10. schema-token count decreases when surface narrows from IMPLEMENT to PLAN or VERIFY', () => {
    const implementSurface = compiler.compile(mockTools, { phase: 'implement' });
    const planSurface = compiler.compile(mockTools, { phase: 'plan' });
    const verifySurface = compiler.compile(mockTools, { phase: 'verify' });

    expect(planSurface.totalSchemaTokens).toBeLessThan(implementSurface.totalSchemaTokens);
    expect(verifySurface.totalSchemaTokens).toBeLessThan(implementSurface.totalSchemaTokens);
    expect(planSurface.totalToolsExposed).toBeLessThan(implementSurface.totalToolsExposed);
    expect(planSurface.reductionRatio).toBeGreaterThan(0);
  });

  // Test 14: MCP descriptor can be normalized if connected
  it('14. normalizes MCP tool definitions into canonical ToolDescriptor', () => {
    const remoteMCP = {
      name: 'list_tables',
      description: 'List all tables in the SQL database.',
      inputSchema: {
        type: 'object',
        properties: {
          schema: { type: 'string' },
        },
      },
    };

    const normalized = normalizeMCPToolDescriptor(remoteMCP, 'postgres');
    expect(normalized.name).toBe('mcp.postgres.list_tables');
    expect(normalized.description).toContain('[MCP: postgres]');
    expect(normalized.permissions).toContain('mcp');
    expect(normalized.riskLevel).toBe('low'); // read-only prefix
    expect(normalized.sideEffectClass).toBe('READ_ONLY');
    expect(normalized.provenance).toEqual({
      source: 'mcp',
      serverId: 'postgres',
      tool: 'list_tables',
      trust: 'untrusted',
    });
  });

  // Schema optimization
  it('optimizes schemas by stripping $schema and title while preserving parameters and constraints', () => {
    const rawSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'FileInput',
      type: 'object',
      properties: {
        path: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          title: 'PathProp',
          type: 'string',
          description: 'The file path',
        },
      },
      required: ['path'],
    };

    const optimized = optimizeToolSchema(rawSchema);
    expect(optimized.$schema).toBeUndefined();
    expect(optimized.title).toBeUndefined();
    expect(optimized.type).toBe('object');
    expect(optimized.required).toEqual(['path']);
    expect((optimized.properties as any).path.$schema).toBeUndefined();
    expect((optimized.properties as any).path.title).toBeUndefined();
    expect((optimized.properties as any).path.type).toBe('string');
  });

  // Tool classification
  it('correctly classifies tool source kinds', () => {
    const readSource = classifyToolSource(mockTools[0]);
    expect(readSource).toBe('builtin');

    const codeModeSource = classifyToolSource(mockTools[3]);
    expect(codeModeSource).toBe('code_mode');

    const codeIntelSource = classifyToolSource(mockTools[6]);
    expect(codeIntelSource).toBe('code_intelligence');

    const mcpSource = classifyToolSource(mockTools[7]);
    expect(mcpSource).toBe('mcp');
  });
});
