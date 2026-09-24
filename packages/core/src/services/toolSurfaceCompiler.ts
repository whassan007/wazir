import type { Tool, ToolDescriptor, ToolPermission } from '../types/tool.js';
import type {
  ExecutionPhase,
  ProtocolSelection,
  ToolSourceKind,
  ToolSurface,
  ToolSurfaceItem,
  ToolSurfaceOmission,
  ToolSurfaceRequest,
} from '../types/toolSurface.js';
import type { RuntimeCapabilities } from '@wazir/runtimes-interfaces';

/** Mutating tools that physically alter the workspace. */
export const MUTATION_TOOLS = new Set<string>([
  'write',
  'edit',
  'write_to_file',
  'replace_file_content',
  'code_mode',
]);

/** Verification and oracle inspection tools. */
export const VERIFICATION_TOOLS = new Set<string>([
  'test',
  'build',
  'lint',
  'typecheck',
  'git',
  'read',
  'search',
  'glob',
]);

/** Code Intelligence tools. */
export const CODE_INTELLIGENCE_TOOLS = new Set<string>([
  'goToDefinition',
  'findReferences',
  'getHover',
  'documentSymbols',
  'workspaceSymbols',
  'findImplementations',
  'code_intelligence',
]);

/** Non-mutating analysis and exploration tools allowed during planning. */
export const PLAN_ALLOWED_TOOLS = new Set<string>([
  'read',
  'search',
  'glob',
  'git',
  'dispatch_subagent',
  'compact_memory',
  'web_search',
  'web_fetch',
  ...CODE_INTELLIGENCE_TOOLS,
]);

/**
 * Strips redundant meta-schema fields ($schema, title) from tool parameter schemas
 * to reduce token consumption while strictly preserving semantic constraints.
 */
export function optimizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }

  const optimized: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(schema)) {
    // Strip redundant meta-schema fields
    if (key === '$schema' || key === 'title') {
      continue;
    }

    if (key === 'properties' && val && typeof val === 'object' && !Array.isArray(val)) {
      const properties: Record<string, unknown> = {};
      for (const [propName, propDef] of Object.entries(val as Record<string, unknown>)) {
        if (propDef && typeof propDef === 'object' && !Array.isArray(propDef)) {
          properties[propName] = optimizeToolSchema(propDef as Record<string, unknown>);
        } else {
          properties[propName] = propDef;
        }
      }
      optimized.properties = properties;
    } else if (key === 'items' && val && typeof val === 'object' && !Array.isArray(val)) {
      optimized.items = optimizeToolSchema(val as Record<string, unknown>);
    } else {
      optimized[key] = val;
    }
  }

  // Ensure minimum valid OpenAI/JSON schema shape
  if (!optimized.type) {
    optimized.type = 'object';
  }

  return optimized;
}

/**
 * Estimates the token cost of a serialized schema using standard ~4 chars/token heuristic.
 */
export function estimateSchemaTokens(schema: unknown): number {
  const json = typeof schema === 'string' ? schema : JSON.stringify(schema);
  return Math.ceil(json.length / 4);
}

/**
 * Classifies a tool's source kind based on its descriptor metadata.
 */
export function classifyToolSource(tool: Tool): ToolSourceKind {
  const provenance = tool.descriptor.provenance as { source?: string } | undefined;
  if (provenance?.source === 'mcp' || tool.descriptor.permissions?.includes('mcp')) {
    return 'mcp';
  }
  if (tool.descriptor.name === 'code_mode') {
    return 'code_mode';
  }
  if (CODE_INTELLIGENCE_TOOLS.has(tool.descriptor.name) || tool.descriptor.name.startsWith('code_intel')) {
    return 'code_intelligence';
  }
  if (
    [
      'read',
      'write',
      'edit',
      'search',
      'glob',
      'shell',
      'git',
      'test',
      'lint',
      'typecheck',
      'build',
      'dispatch_subagent',
      'compact_memory',
    ].includes(tool.descriptor.name)
  ) {
    return 'builtin';
  }
  return 'custom';
}

/**
 * Selects the optimal interaction protocol based on runtime capabilities.
 * Explicitly distinguishes native tool calling, structured JSON output, and legacy text fallback.
 */
export function selectProtocol(runtimeCapabilities?: Partial<RuntimeCapabilities>): {
  protocol: ProtocolSelection;
  reason: string;
} {
  if (runtimeCapabilities?.nativeToolCalling) {
    return {
      protocol: 'native_tool_call',
      reason: 'Runtime advertises nativeToolCalling capability; using OpenAI-compatible function calling.',
    };
  }

  if (runtimeCapabilities?.structuredOutput || runtimeCapabilities?.strictJsonSchema) {
    return {
      protocol: 'structured_output',
      reason:
        'Runtime does not support native tool calling, but supports structured output or strict JSON schema; using constrained JSON fallback.',
    };
  }

  return {
    protocol: 'legacy_text',
    reason:
      'Runtime does not advertise native tool calling or structured output; falling back to legacy text action protocol.',
  };
}

/**
 * Normalizes an MCP tool definition into Wazir's canonical ToolDescriptor.
 */
export function normalizeMCPToolDescriptor(
  remoteTool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  },
  serverId: string,
): ToolDescriptor {
  const name = `mcp.${serverId}.${remoteTool.name}`;
  const isReadOnly = /^(get|list|read|search|find|show|describe|inspect|status|lookup|fetch)(_|$)/i.test(
    remoteTool.name,
  );

  return {
    name,
    description: `[MCP: ${serverId}] ${remoteTool.description ?? remoteTool.name}`,
    inputSchema: remoteTool.inputSchema ?? { type: 'object', properties: {} },
    outputSchema: remoteTool.outputSchema,
    permissions: ['mcp'],
    riskLevel: isReadOnly ? 'low' : 'high',
    environment: 'local',
    sideEffectClass: isReadOnly ? 'READ_ONLY' : 'NON_IDEMPOTENT_WRITE',
    concurrencySafety: isReadOnly ? 'parallel' : 'exclusive',
    provenance: {
      source: 'mcp',
      serverId,
      tool: remoteTool.name,
      trust: 'untrusted',
    },
  };
}

export interface ToolSurfaceCompilerOptions {
  defaultMaxSchemaTokens?: number;
}

/**
 * ToolSurfaceCompiler
 *
 * Compiles a deterministic, phase-aware, capability-gated tool surface for each model invocation.
 * Models receive only the tools appropriate to their agent, phase, runtime, repository,
 * and connected capabilities.
 */
export class ToolSurfaceCompiler {
  private readonly defaultMaxSchemaTokens?: number;

  constructor(options: ToolSurfaceCompilerOptions = {}) {
    this.defaultMaxSchemaTokens = options.defaultMaxSchemaTokens;
  }

  /**
   * Compiles the tool surface for a given request.
   */
  compile(tools: Tool[], request: ToolSurfaceRequest): ToolSurface {
    const phase = (request.phase || 'implement').toLowerCase();
    const surfaceItems: ToolSurfaceItem[] = [];
    const omissions: ToolSurfaceOmission[] = [];
    const selectedTools: Tool[] = [];
    const descriptors: ToolDescriptor[] = [];

    // Calculate baseline unoptimized token metrics across all available tools
    let rawAvailableTokens = 0;
    for (const t of tools) {
      rawAvailableTokens += estimateSchemaTokens({
        name: t.descriptor.name,
        description: t.descriptor.description,
        parameters: t.descriptor.inputSchema,
      });
    }

    const { protocol, reason: protocolReason } = selectProtocol(request.runtimeCapabilities);

    const allowedNames = request.allowedToolNames ? new Set(request.allowedToolNames) : null;
    const disabledNames = request.disabledToolNames ? new Set(request.disabledToolNames) : null;

    for (const tool of tools) {
      const name = tool.descriptor.name;
      const source = classifyToolSource(tool);

      // Check explicit denylist
      if (disabledNames && disabledNames.has(name)) {
        omissions.push({
          name,
          reason: 'Tool is explicitly disabled in request',
          phase,
        });
        continue;
      }

      // Check explicit allowlist
      if (allowedNames && !allowedNames.has(name)) {
        omissions.push({
          name,
          reason: 'Tool is not in request allowedToolNames list',
          phase,
        });
        continue;
      }

      // Check Code Intelligence capability gating
      if (request.availableCodeIntelligence === false && source === 'code_intelligence') {
        omissions.push({
          name,
          reason: 'Code Intelligence capability is disabled or unavailable',
          phase,
        });
        continue;
      }

      // Check Code Mode capability gating
      if (request.availableCodeMode === false && source === 'code_mode') {
        omissions.push({
          name,
          reason: 'Code Mode capability is disabled or unavailable',
          phase,
        });
        continue;
      }

      // Check MCP capability gating
      if (source === 'mcp' && request.connectedMCPCapabilities) {
        const provenance = tool.descriptor.provenance as { serverId?: string } | undefined;
        if (provenance?.serverId && !request.connectedMCPCapabilities.includes(provenance.serverId)) {
          omissions.push({
            name,
            reason: `MCP server '${provenance.serverId}' is not in connectedMCPCapabilities`,
            phase,
          });
          continue;
        }
      }

      // Phase-aware filtering
      if (phase === 'plan' || phase === 'inspect') {
        if (MUTATION_TOOLS.has(name)) {
          omissions.push({
            name,
            reason: 'Mutation tools are excluded during planning and inspection phases',
            phase,
          });
          continue;
        }
        if (name === 'shell') {
          omissions.push({
            name,
            reason: 'Arbitrary shell execution is excluded during planning phase in favor of inspection tools',
            phase,
          });
          continue;
        }
      } else if (phase === 'verify' || phase === 'test') {
        if (MUTATION_TOOLS.has(name)) {
          omissions.push({
            name,
            reason: 'Mutation tools are excluded during verification to preserve verification integrity',
            phase,
          });
          continue;
        }
      }

      // Tool is included: optimize its schema
      const optimizedParameters = optimizeToolSchema(tool.descriptor.inputSchema);
      const serializedSchema = {
        name: tool.descriptor.name,
        description: tool.descriptor.description,
        parameters: optimizedParameters,
      };

      const tokens = estimateSchemaTokens(serializedSchema);

      const item: ToolSurfaceItem = {
        name,
        tool,
        descriptor: tool.descriptor,
        serializedSchema,
        reasonIncluded: `Included for phase '${phase}' from source '${source}'`,
        estimatedTokens: tokens,
        source,
      };

      surfaceItems.push(item);
      selectedTools.push(tool);
      descriptors.push(tool.descriptor);
    }

    // Check maxSchemaTokens limit if specified
    const maxTokens = request.maxSchemaTokens ?? this.defaultMaxSchemaTokens;
    if (maxTokens && maxTokens > 0) {
      let currentTokens = surfaceItems.reduce((acc, it) => acc + it.estimatedTokens, 0);
      if (currentTokens > maxTokens) {
        // Prune lower-priority custom or MCP tools first
        for (let i = surfaceItems.length - 1; i >= 0 && currentTokens > maxTokens; i--) {
          const it = surfaceItems[i];
          if (it.source === 'mcp' || it.source === 'custom') {
            currentTokens -= it.estimatedTokens;
            omissions.push({
              name: it.name,
              reason: `Omitted to fit within maxSchemaTokens limit (${maxTokens})`,
              phase,
            });
            surfaceItems.splice(i, 1);
            const toolIdx = selectedTools.findIndex((t) => t.descriptor.name === it.name);
            if (toolIdx !== -1) {
              selectedTools.splice(toolIdx, 1);
              descriptors.splice(toolIdx, 1);
            }
          }
        }
      }
    }

    const serializedSchemas = surfaceItems.map((item) => item.serializedSchema);
    const totalSchemaTokens = surfaceItems.reduce((acc, item) => acc + item.estimatedTokens, 0);
    const serializedJson = JSON.stringify(serializedSchemas);
    const totalSchemaBytes = Buffer.byteLength(serializedJson, 'utf8');

    const totalToolsAvailable = tools.length;
    const totalToolsExposed = selectedTools.length;
    const reductionRatio =
      rawAvailableTokens > 0 ? Number(((rawAvailableTokens - totalSchemaTokens) / rawAvailableTokens).toFixed(3)) : 0;

    return {
      phase,
      tools: selectedTools,
      descriptors,
      surfaceItems,
      omissions,
      serializedSchemas,
      totalSchemaTokens,
      totalSchemaBytes,
      totalToolsAvailable,
      totalToolsExposed,
      reductionRatio,
      selectedProtocol: protocol,
      protocolSelectionReason: protocolReason,
    };
  }
}
