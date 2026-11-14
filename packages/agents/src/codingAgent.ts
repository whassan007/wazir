import { supportsNativeToolCalling } from '@wazir/runtimes-interfaces';
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentRunRequest,
  AgentRuntime,
  AgentTurn,
} from '@wazir/core';
import {
  LegacyJsonCodingAgent,
  type CodingAgentOptions,
} from './legacyCodingAgent.js';
import { WazirQwenAgent } from './qwenCore/wazirQwenAgent.js';

export * from './legacyCodingAgent.js';
export * from './qwenCore/index.js';

/**
 * Primary Wazir Coding Agent.
 *
 * Routes all native tool-calling runtimes (`openai`, `anthropic`, `google`, `lmstudio`,
 * `ollama`, `nvidia`) to `WazirQwenAgent` (Qwen Code 1.0 unified multi-tool ReAct loop),
 * while retaining `LegacyJsonCodingAgent` as a fallback for text-only/non-tool-calling
 * models or when `options.legacyJsonLoop` / `WAZIR_LEGACY_JSON_AGENT=1` is explicitly set.
 */
export class CodingAgent implements AgentAdapter {
  readonly descriptor: AgentDescriptor;
  private readonly qwenAgent: WazirQwenAgent;
  private readonly legacyAgent: LegacyJsonCodingAgent;
  private readonly forceLegacyJsonLoop: boolean;

  constructor(options: CodingAgentOptions = {}) {
    this.qwenAgent = new WazirQwenAgent(options);
    this.legacyAgent = new LegacyJsonCodingAgent(options);
    this.forceLegacyJsonLoop = options.legacyJsonLoop === true;
    this.descriptor = this.qwenAgent.descriptor;
  }

  run(request: AgentRunRequest, runtime: AgentRuntime): AsyncIterable<AgentTurn> {
    if (this.forceLegacyJsonLoop || process.env.WAZIR_LEGACY_JSON_AGENT === '1') {
      return this.legacyAgent.run(request, runtime);
    }
    const capabilities = runtime.getCapabilities?.() ?? runtime.runtimeCapabilities;
    if (supportsNativeToolCalling(capabilities)) {
      return this.qwenAgent.run(request, runtime);
    }
    return this.legacyAgent.run(request, runtime);
  }
}

export function createCodingAgent(options: CodingAgentOptions = {}): CodingAgent {
  return new CodingAgent(options);
}
