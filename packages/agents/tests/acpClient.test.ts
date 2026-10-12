import { describe, it, expect, vi } from 'vitest';
import { AcpClientAdapter, type AcpConnectionLike } from '../src/acp/acpClient.js';

describe('AcpClientAdapter (Adapted from Qwen-Live-Harness)', () => {
  it('initializes connection and creates multiplexed sessions', async () => {
    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ protocolVersion: 1 }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-acp-1' }),
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const client = new AcpClientAdapter({
      name: 'test-acp',
      command: 'dummy',
      connect: async () => mockConn,
    });

    const sessionId = await client.createSession({ cwd: '/tmp' });
    expect(sessionId).toBe('session-acp-1');
    expect(mockConn.newSession).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('enforces preemption safety: queues subsequent prompts while a turn is active', async () => {
    let finishPrompt: (val: unknown) => void = () => {};
    const promptPromise = new Promise((resolve) => {
      finishPrompt = resolve;
    });

    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({}),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-acp-2' }),
      prompt: vi.fn().mockImplementation(() => promptPromise),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const client = new AcpClientAdapter({
      name: 'test-acp',
      command: 'dummy',
      connect: async () => mockConn,
    });

    const sessionId = await client.createSession({ cwd: '/tmp' });

    // First prompt starts immediately
    const p1 = await client.prompt(sessionId, 'First task');
    expect(p1.status).toBe('accepted');

    // Second prompt sent while first is still in flight -> must be QUEUED, not aborting turn
    const p2 = await client.prompt(sessionId, 'Second task');
    expect(p2.status).toBe('queued');

    // Complete the first prompt
    finishPrompt({ stopReason: 'end_turn' });
    await new Promise((res) => setTimeout(res, 20));

    // Verify both prompts ran in order
    expect(mockConn.prompt).toHaveBeenCalledTimes(2);
  });

  it('forwards permission requests to custom resolver', async () => {
    const mockConn: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({}),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'session-acp-3' }),
      prompt: vi.fn().mockResolvedValue({}),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    let clientHandler: any;
    const client = new AcpClientAdapter({
      name: 'test-acp',
      command: 'dummy',
      connect: async (cl) => {
        clientHandler = cl;
        return mockConn;
      },
      onRequestPermission: async ({ title }) => {
        expect(title).toContain('Delete production files');
        return { optionId: 'opt-allow' };
      },
    });

    await client.ensureConnection();

    // Trigger requestPermission from agent client handler
    const response = await clientHandler.requestPermission({
      requestId: 'perm-99',
      sessionId: 'session-acp-3',
      title: 'Delete production files',
      options: [
        { id: 'opt-allow', title: 'Allow once' },
        { id: 'opt-deny', title: 'Deny' },
      ],
    });

    expect(response.outcome.selected).toBe(undefined);
    expect(response.outcome.outcome).toBe('selected');
    expect(response.outcome.optionId).toBe('opt-allow');
  });
});
