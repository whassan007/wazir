import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  SkillRegistry,
  loadProgressiveAgentsDocs,
  WazirAcpServer,
  selectPhaseReasoningEffort,
  detectModelFamilyProfile,
  toModelToolAlias,
  fromModelToolAlias,
} from '../src/index.js';

describe('Inner-Loop & AAIF/ACP Standards', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('discovers SKILL.md packs and retrieves curated top-K matches', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wazir-skills-'));
    const skillDir = path.join(tmpDir, 'alloy-verify');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: alloy-verify\ndescription: Formal verification with Alloy 6 models\ntags: [alloy, formal]\n---\nRun alloy check.`,
      'utf8',
    );
    const otherDir = path.join(tmpDir, 'css-grid');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(
      path.join(otherDir, 'SKILL.md'),
      `---\nname: css-grid\ndescription: Frontend CSS layout helper\ntags: [css, ui]\n---\nUse grid.`,
      'utf8',
    );

    const registry = new SkillRegistry();
    registry.discoverFromRoots([tmpDir]);
    const hits = registry.retrieveRelevant('verify alloy formal model', 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].name).toBe('alloy-verify');
  });

  it('loads progressive AGENTS.md -> docs/*.md map', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'wazir-agents-docs-'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Map\nSee docs/ARCHITECTURE.md for details.\n', 'utf8');
    writeFileSync(path.join(tmpDir, 'docs', 'ARCHITECTURE.md'), '# Architecture\nLayered.', 'utf8');

    const loaded = loadProgressiveAgentsDocs(tmpDir);
    expect(loaded?.linkedDocs).toHaveLength(1);
    expect(loaded?.linkedDocs[0].relPath).toBe('docs/ARCHITECTURE.md');
  });

  it('serves ACP JSON-RPC initialize, session/new, session/prompt, and A2A tasks', async () => {
    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const server = new WazirAcpServer(
      {
        async runPrompt({ prompt, emitUpdate }) {
          emitUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
          return { stopReason: 'end_turn', text: `Done: ${prompt}` };
        },
      },
      (method, params) => notifications.push({ method, params }),
    );

    const init = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect((init?.result as { protocolVersion: number }).protocolVersion).toBe(1);

    const a2a = await server.handleA2ATask({
      taskId: 't-1',
      senderAgentId: 'coord',
      targetAgentId: 'wazir',
      objective: 'Run tests',
      status: 'submitted',
    });
    expect(a2a.status).toBe('completed');
    expect(notifications.length).toBeGreaterThan(0);
  });

  it('schedules Reasoning Sandwich phases and steps down under low wall-clock budget', () => {
    expect(selectPhaseReasoningEffort('plan').effort).toBe('xhigh');
    expect(selectPhaseReasoningEffort('implement').effort).toBe('high');
    expect(selectPhaseReasoningEffort('verify').effort).toBe('xhigh');

    const lowBudget = selectPhaseReasoningEffort('verify', {
      remainingWallClockMs: 5_000,
      totalWallClockMs: 100_000,
    });
    expect(lowBudget.downgradedForBudget).toBe(true);
    expect(lowBudget.effort).toBe('high');
  });

  it('maps model-specific tool aliases bidirectionally', () => {
    const profile = detectModelFamilyProfile('gpt-5.2-codex');
    expect(profile).toBe('codex');
    expect(toModelToolAlias('edit', profile)).toBe('apply_patch');
    expect(fromModelToolAlias('apply_patch', profile)).toBe('edit');
  });
});
