import { describe, it, expect, vi } from 'vitest';
import { AcpClientAdapter, type AcpConnectionLike } from '../src/acp/acpClient.js';

describe('ACP session lifecycle', () => {
  it('keeps one session identity across ordered turns and records queued steering', async () => {
    let finishFirst: ((value: { stopReason: string }) => void) | undefined;
    const connection: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ agentCapabilities: { loadSession: false } }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 'stable-session', modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] } }),
      prompt: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; })).mockResolvedValue({ stopReason: 'end_turn' }),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const client = new AcpClientAdapter({ name: 'agent', command: 'fake', connect: async () => connection });
    const id = await client.createSession({ cwd: '/workspace' });
    await client.prompt(id, 'initial');
    const steering = await client.steer(id, 'course correction');
    expect(steering.status).toBe('queued');
    expect(client.getSessionState(id)?.capabilities).toMatchObject({ loadSession: false, steering: 'queued_follow_up', currentModeId: 'code' });
    expect(client.getSessionState(id)?.messages.map((m) => [m.text, m.status])).toEqual([
      ['initial', 'sent'], ['course correction', 'queued'],
    ]);
    finishFirst?.({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(connection.prompt).toHaveBeenCalledTimes(2));
    expect((connection.prompt as any).mock.calls.map((call: any[]) => call[0].sessionId)).toEqual([id, id]);
    expect((connection.prompt as any).mock.calls.map((call: any[]) => call[0].prompt[0].text)).toEqual(['initial', 'course correction']);
    await vi.waitFor(() => expect(client.getSessionState(id)?.messages.at(-1)?.text).toContain('Turn ended'));
  });

  it('rejects loadSession unless advertised by the agent', async () => {
    const connection: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({ agentCapabilities: { loadSession: false } }),
      newSession: vi.fn().mockResolvedValue({ sessionId: 's' }), prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }), cancel: vi.fn(),
    };
    const client = new AcpClientAdapter({ name: 'agent', command: 'fake', connect: async () => connection });
    await expect(client.loadSession('prior-session')).rejects.toThrow('does not support session/load');
  });

  it('deduplicates tool updates and records evidence without inventing output or duration', async () => {
    let handler: any;
    const timeline: any[] = [];
    const telemetry: any[] = [];
    const connection: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({}), newSession: vi.fn().mockResolvedValue({ sessionId: 's' }),
      prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }), cancel: vi.fn(),
    };
    const client = new AcpClientAdapter({ name: 'agent', command: 'fake', connect: async (clientHandler) => { handler = clientHandler; return connection; }, onTimelineEvent: (_sid, event) => timeline.push(event), onToolTelemetry: (_sid, value) => telemetry.push(value) });
    const id = await client.createSession();
    await handler.sessionUpdate({ sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', kind: 'edit', title: 'Patch file' } });
    await handler.sessionUpdate({ sessionId: id, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' } });
    await handler.sessionUpdate({ sessionId: id, update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' } });
    expect(timeline.filter((event) => event.kind === 'tool' && event.status === 'completed')).toHaveLength(1);
    expect(telemetry.at(-1)).toMatchObject({ toolCallId: 'tool-1', status: 'completed', durationMs: expect.any(Number) });
    expect(telemetry.at(-1).rawOutput).toBeUndefined();
  });

  it('records queued messages as failed when cancellation rejects delivery', async () => {
    let finish: ((value: { stopReason: string }) => void) | undefined;
    const connection: AcpConnectionLike = {
      initialize: vi.fn().mockResolvedValue({}), newSession: vi.fn().mockResolvedValue({ sessionId: 's' }),
      prompt: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; })), cancel: vi.fn().mockResolvedValue(undefined),
    };
    const client = new AcpClientAdapter({ name: 'agent', command: 'fake', connect: async () => connection });
    const id = await client.createSession();
    await client.prompt(id, 'active');
    await client.steer(id, 'queued direction');
    await client.cancelSession(id);
    finish?.({ stopReason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.getSessionState(id)?.messages.find((message) => message.text === 'queued direction')?.status).toBe('failed');
  });
});
