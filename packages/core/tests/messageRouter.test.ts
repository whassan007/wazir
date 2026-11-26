import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CoordinationFabric } from '../src/services/coordinationFabric.js';
import {
  InboxBackpressureError,
  MessageAuthorizationError,
  MessageLoopError,
  MessageReplayError,
  MessageRouter,
} from '../src/services/messageRouter.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'wazir-router-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('MessageRouter', () => {
  it('enforces workflow ACLs, revocation, and control command authorization', async () => {
    const fabricDir = makeTempDir();
    const fabric = new CoordinationFabric({ fabricDir });
    const router = new MessageRouter({ fabric, requireExplicitWorkflowAuth: true });

    await expect(
      router.send({
        workflowId: 'wf-1',
        fromAgent: 'agent-a',
        toAgent: 'agent-b',
        payload: { hello: 'world' },
      }),
    ).rejects.toBeInstanceOf(MessageAuthorizationError);

    router.authorizeAgentWorkflow('agent-a', 'wf-1', { trustedControl: false });
    router.authorizeAgentWorkflow('agent-b', 'wf-1');

    await router.send({
      workflowId: 'wf-1',
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      payload: { hello: 'world' },
    });

    await expect(
      router.send({
        workflowId: 'wf-1',
        fromAgent: 'agent-a',
        toAgent: 'agent-b',
        type: 'control.command',
        controlAction: 'cancel',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(MessageAuthorizationError);

    router.revokeAgentWorkflow('agent-a', 'wf-1');
    expect(router.isAgentAuthorized('agent-a', 'wf-1')).toBe(false);
    await fabric.close();
  });

  it('detects direct loops, causation loops, and replay attacks', async () => {
    const fabricDir = makeTempDir();
    const fabric = new CoordinationFabric({ fabricDir });
    const router = new MessageRouter({ fabric });

    await expect(
      router.send({
        workflowId: 'wf-loop',
        fromAgent: 'agent-a',
        toAgent: 'agent-a',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(MessageLoopError);

    await expect(
      router.send({
        workflowId: 'wf-loop',
        fromAgent: 'agent-b',
        toAgent: 'agent-a',
        causationChain: ['agent-a'],
        payload: {},
      }),
    ).rejects.toBeInstanceOf(MessageLoopError);

    await router.send({
      workflowId: 'wf-replay',
      fromAgent: 'agent-a',
      toAgent: 'agent-b',
      idempotencyKey: 'idem-1',
      payload: { n: 1 },
    });

    await expect(
      router.send({
        workflowId: 'wf-replay',
        fromAgent: 'agent-a',
        toAgent: 'agent-b',
        idempotencyKey: 'idem-1',
        payload: { n: 1 },
      }),
    ).rejects.toBeInstanceOf(MessageReplayError);

    await fabric.close();
  });

  it('enforces bounded inbox backpressure and recovers from corrupt inbox JSON', async () => {
    const fabricDir = makeTempDir();
    const fabric = new CoordinationFabric({ fabricDir });
    const router = new MessageRouter({ fabric, maxInboxSize: 2 });

    await router.send({ workflowId: 'wf-bp', fromAgent: 'a', toAgent: 'b', payload: { i: 1 } });
    await router.send({ workflowId: 'wf-bp', fromAgent: 'a', toAgent: 'b', payload: { i: 2 } });

    await expect(
      router.send({ workflowId: 'wf-bp', fromAgent: 'a', toAgent: 'b', payload: { i: 3 } }),
    ).rejects.toBeInstanceOf(InboxBackpressureError);

    // Corrupt inbox file recovery
    const inboxDir = path.join(fabricDir, 'inboxes', 'corrupt-agent');
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(path.join(inboxDir, 'inbox.json'), '{bad json', 'utf8');
    const msgs = await router.receive('corrupt-agent');
    expect(msgs).toEqual([]);

    await fabric.close();
  });
});
