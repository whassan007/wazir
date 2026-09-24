import { it, expect } from 'vitest';
import { createCodingAgent } from '../src/codingAgent.js';
import { WebGroundingService, WebProviderRegistry, PolicyEngine, type AgentRuntime, type GroundedDocument } from '@wazir/core';
import { createWebTools, ToolRegistry, executeTool } from '@wazir/tools';

it('carries real service evidence through tools, model context, compaction and a cited answer', async () => {
  const providers = new WebProviderRegistry();
  providers.register({ metadata: { id: 'fixture', type: 'native', capabilities: ['fetch'], authentication: 'none', available: true, priority: 0, health: 'unknown' },
    fetch: async request => ({ url: request.url, finalUrl: request.url, body: '<h1>Release</h1><p>Version 22.</p><script>malicious()</script>', contentType: 'text/html', bytesDownloaded: 100 }) });
  const evidence: GroundedDocument[] = [];
  const service = new WebGroundingService({ providers, policy: new PolicyEngine({ projectRoot: '/tmp', networkAllowed: true }),
    resolver: async () => [{ address: '93.184.216.34', family: 4 }], emit: async () => {}, retain: async e => { evidence.push(e as GroundedDocument); } });
  const registry = new ToolRegistry(createWebTools(service));
  const agent = createCodingAgent({ webCapabilities: ['web.fetch'], maxTurns: 8 });
  let calls = 0; const contexts: string[] = [];
  const runtime: AgentRuntime = {
    tools: registry.forModel(undefined, agent.descriptor.capabilities),
    async *generate(request) {
      contexts.push(request.messages.map(m => m.content).join('\n'));
      calls++;
      const reply = calls === 1 ? { action: 'plan', content: 'Retrieve the release source.' } : calls === 2 ? { action: 'tool', tool: 'web_fetch', input: { url: 'https://example.com/release' } }
        : calls === 3 ? { action: 'plan', content: 'Use the retrieved evidence.' }
        : { action: 'done', summary: `Version 22 [source: ${evidence[0]?.citation.citationId}]` };
      const content = JSON.stringify(reply); yield { type: 'token', content }; yield { type: 'completed', content };
    },
    executeTool: (name, input) => executeTool(registry, name, input, { projectRoot: '/tmp', agentCapabilities: agent.descriptor.capabilities }),
  };
  const turns = [];
  for await (const turn of agent.run({ modelId: 'fixture', taskDescription: 'Research the release; cite retrieved evidence.', taskType: 'research', projectRoot: '/tmp', contextTokens: 4000 }, runtime)) turns.push(turn);
  expect(evidence).toHaveLength(1);
  const citation = evidence[0].citation.citationId;
  expect(contexts.slice(2).every(c => c.includes(citation))).toBe(true);
  expect(contexts.at(-1)).toContain('UNTRUSTED_EXTERNAL_CONTENT'); expect(contexts.at(-1)).not.toContain('<script>');
  expect(turns.filter(t => t.kind === 'done' || t.kind === 'error')).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'done', content: expect.stringContaining(citation) })]));
});
