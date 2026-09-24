import { it, expect } from 'vitest';
import { ToolRegistry, executeTool } from '../src/registry.js';
import { createWebTools } from '../src/web.js';
import { WebGroundingService, WebProviderRegistry, PolicyEngine } from '@wazir/core';

it('hides tools from agents without capability and enforces capability at dispatch', async () => {
  const service = new WebGroundingService({ providers: new WebProviderRegistry(), policy: new PolicyEngine({ projectRoot: '/tmp', networkAllowed: true }), emit: async () => {} });
  const registry = new ToolRegistry(createWebTools(service));
  expect(registry.forModel()).toHaveLength(0);
  expect(registry.forModel(undefined, ['web.search']).map(t => t.name)).toEqual(['web_search']);
  const result = await executeTool(registry, 'web_fetch', { url: 'https://example.com' }, { projectRoot: '/tmp' });
  expect(result.error).toBe('WEB_POLICY_DENIED');
  expect((await executeTool(registry, 'web_search', { query: 4 }, { projectRoot: '/tmp', agentCapabilities: ['web.search'] })).failureClass).toBe('TOOL_VALIDATION_FAILED');
});
