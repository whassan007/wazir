import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CoordinationFabric,
  NatsWireTransport,
  validateCoordinationEnvelope,
  type CoordinationEventEnvelope,
} from '../src/services/coordinationFabric.js';
import {
  COORDINATION_TRANSPORT_KINDS,
  normalizeCoordinationTransportKind,
  type CoordinationTransportAdapter,
} from '../src/types/coordination.js';

const tempDirs: string[] = [];

function makeTempDir(prefix = 'wazir-coord-'): string {
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

describe('CoordinationFabric', () => {
  it('validates envelopes and rejects malformed inputs', () => {
    expect(validateCoordinationEnvelope(null).valid).toBe(false);
    expect(validateCoordinationEnvelope({ event_id: 'e1' }).valid).toBe(false);
    expect(
      validateCoordinationEnvelope({
        event_id: 'e1',
        schema_version: '1.0',
        type: 'task.started',
        workflow_id: 'wf-1',
        correlation_id: 'corr-1',
        timestamp: new Date().toISOString(),
        payload: { ok: true },
        artifact_refs: [],
      }).valid,
    ).toBe(true);
  });

  it('deduplicates repeated publish and publishInProcess calls with the same event_id', async () => {
    const fabricDir = makeTempDir();
    const fabric = new CoordinationFabric({ fabricDir });
    const received: CoordinationEventEnvelope[] = [];
    fabric.subscribe('*', (ev) => {
      received.push(ev);
    });

    await fabric.publish({
      event_id: 'evt-dup-1',
      type: 'task.progress',
      workflow_id: 'wf-dup',
      payload: { step: 1 },
    });
    await fabric.publish({
      event_id: 'evt-dup-1',
      type: 'task.progress',
      workflow_id: 'wf-dup',
      payload: { step: 1 },
    });
    fabric.publishInProcess({
      event_id: 'evt-dup-1',
      type: 'task.progress',
      workflow_id: 'wf-dup',
      payload: { step: 1 },
    });

    expect(received).toHaveLength(1);
    const replayed = await fabric.replayEvents({ workflowId: 'wf-dup' });
    expect(replayed).toHaveLength(1);
    await fabric.close();
  });

  it('offloads large payloads to artifacts and blocks path traversal on loadArtifact', async () => {
    const fabricDir = makeTempDir();
    const fabric = new CoordinationFabric({ fabricDir, maxInlinePayloadBytes: 64 });

    const bigPayload = { data: 'x'.repeat(512) };
    const env = await fabric.publish({
      type: 'agent.evidence',
      workflow_id: 'wf-art',
      payload: bigPayload,
    });

    expect((env.payload as { offloaded?: boolean }).offloaded).toBe(true);
    expect(env.artifact_refs).toHaveLength(1);
    const loaded = await fabric.loadArtifact(env.artifact_refs[0]!);
    expect(loaded).toEqual(bigPayload);

    await expect(fabric.loadArtifact('../../etc/passwd')).rejects.toThrow(/escapes fabric directory/);
    await fabric.close();
  });

  it('flushes to transport and opens circuit breaker on repeated failures then moves to DLQ', async () => {
    const published: CoordinationEventEnvelope[] = [];
    let shouldFail = false;
    const mockTransport = {
      kind: 'nats-core' as const,
      isConnected: () => true,
      connect: async () => {},
      publishBatch: async (events: CoordinationEventEnvelope[]) => {
        if (shouldFail) throw new Error('broker down');
        published.push(...events);
      },
      subscribe: () => () => {},
      close: async () => {},
    };

    const fabricDir = makeTempDir();
    const fabric = new CoordinationFabric({
      fabricDir,
      transport: mockTransport,
      maxRetries: 2,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 50,
    });

    await fabric.publish({
      type: 'job.started',
      workflow_id: 'wf-nats',
      payload: { ok: true },
    });

    await fabric.flush(2000);
    expect(published.length).toBeGreaterThanOrEqual(1);
    const delivered = await fabric.listOutbox('delivered');
    expect(delivered).toHaveLength(1);

    shouldFail = true;
    await fabric.publish({
      type: 'job.failed',
      workflow_id: 'wf-nats',
      payload: { ok: false },
    });
    await fabric.flush(2000);
    const status = await fabric.getStatus();
    expect(['open', 'half-open', 'closed']).toContain(status.circuitState);

    await fabric.close();
  });

  it('exposes only implemented transport kinds and maps legacy nats-jetstream to nats-core', () => {
    expect([...COORDINATION_TRANSPORT_KINDS]).toEqual(['in-process', 'durable-local', 'nats-core']);
    expect(normalizeCoordinationTransportKind('nats-jetstream')).toBe('nats-core');
    expect(normalizeCoordinationTransportKind('NATS-JETSTREAM')).toBe('nats-core');
    expect(normalizeCoordinationTransportKind('durable-local')).toBe('durable-local');
    expect(normalizeCoordinationTransportKind('bogus')).toBeUndefined();
    expect(normalizeCoordinationTransportKind(undefined)).toBeUndefined();
  });

  it('reports nats-core in status when a legacy adapter still claims nats-jetstream', async () => {
    const legacyAdapter = {
      kind: 'nats-jetstream',
      isConnected: () => false,
      connect: async () => {},
      publishBatch: async () => {},
      subscribe: () => () => {},
      close: async () => {},
    } as unknown as CoordinationTransportAdapter;
    const fabric = new CoordinationFabric({ fabricDir: makeTempDir(), transport: legacyAdapter });
    const status = await fabric.getStatus();
    expect(status.transport).toBe('nats-core');
    expect(status.natsConfigured).toBe(true);
    await fabric.close();
  });

  it('keeps events in the outbox when the NATS server never confirms the publish (no PONG)', async () => {
    // Minimal fake NATS server: sends INFO, swallows everything, never answers PING.
    const sockets: net.Socket[] = [];
    const server = net.createServer((sock) => {
      sockets.push(sock);
      sock.on('error', () => undefined);
      sock.write('INFO {"server_id":"fake","version":"0.0.0","max_payload":1048576}\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    const transport = new NatsWireTransport({
      url: `nats://127.0.0.1:${port}`,
      connectTimeoutMs: 500,
      publishAckTimeoutMs: 150,
    });
    const fabric = new CoordinationFabric({
      fabricDir: makeTempDir(),
      transport,
      maxRetries: 10,
      retryBaseDelayMs: 10_000,
    });
    try {
      await fabric.publish({ type: 'task.progress', workflow_id: 'wf-noack', payload: { n: 1 } });
      const result = await fabric.flush(2000);
      expect(result.flushed).toBe(0);
      expect(result.failed).toBe(1);
      const failed = await fabric.listOutbox('failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.lastError).toMatch(/PONG|closed/);
      expect(await fabric.listOutbox('delivered')).toHaveLength(0);
    } finally {
      await fabric.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
