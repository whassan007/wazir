import { describe, it, expect, vi } from 'vitest';
import { AcpClientAdapter, type AcpConnectionLike } from '../src/acp/acpClient.js';

function mockConn(overrides: Partial<AcpConnectionLike> = {}): AcpConnectionLike {
  return {
    initialize: vi.fn().mockResolvedValue({}),
    newSession: vi.fn().mockResolvedValue({ sessionId: 's1' }),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

async function clientHandlerFor(onRequestPermission?: ConstructorParameters<typeof AcpClientAdapter>[0]['onRequestPermission']) {
  let handler: any;
  const client = new AcpClientAdapter({
    name: 't', command: 'dummy', onRequestPermission,
    connect: async (cl) => { handler = cl; return mockConn(); },
  });
  await client.ensureConnection();
  return handler;
}

const options = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'deny', name: 'Reject', kind: 'reject_once' },
];

describe('AcpClientAdapter permission safety', () => {
  it('denies (cancels) when no operator resolver is configured', async () => {
    const handler = await clientHandlerFor(undefined);
    const res = await handler.requestPermission({ sessionId: 's1', title: 'rm -rf build', options });
    expect(res.outcome.outcome).toBe('cancelled');
  });

  it('denies when the resolver makes no decision', async () => {
    const handler = await clientHandlerFor(async () => ({}));
    const res = await handler.requestPermission({ sessionId: 's1', title: 'x', options });
    expect(res.outcome.outcome).toBe('cancelled');
  });

  it('denies when the resolver throws', async () => {
    const handler = await clientHandlerFor(async () => { throw new Error('ui gone'); });
    const res = await handler.requestPermission({ sessionId: 's1', title: 'x', options });
    expect(res.outcome.outcome).toBe('cancelled');
  });

  it('rejects an optionId that was not offered', async () => {
    const handler = await clientHandlerFor(async () => ({ optionId: 'allow_always_everything' }));
    const res = await handler.requestPermission({ sessionId: 's1', title: 'x', options });
    expect(res.outcome.outcome).toBe('cancelled');
  });
});

describe('AcpClientAdapter failure containment', () => {
  it('a failing prompt turn is reported, not raised as an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const activity: string[] = [];
    try {
      const client = new AcpClientAdapter({
        name: 't', command: 'dummy',
        onActivity: (a) => activity.push(`${a.kind}:${a.text}`),
        connect: async () => mockConn({ prompt: vi.fn().mockRejectedValue(new Error('agent crashed')) }),
      });
      const sid = await client.createSession();
      await client.prompt(sid, 'go');
      await new Promise((r) => setTimeout(r, 30));
      expect(unhandled).not.toHaveBeenCalled();
      expect(activity.some((a) => a.includes('Turn failed') && a.includes('agent crashed'))).toBe(true);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a missing executable rejects ensureConnection instead of crashing the process', async () => {
    const client = new AcpClientAdapter({ name: 't', command: '/nonexistent/wazir-acp-agent' });
    await expect(client.ensureConnection()).rejects.toThrow();
  });
});
