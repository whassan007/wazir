/**
 * Opt-in live integration test against a real nats-server (NATS Core, no JetStream).
 *
 * Skipped unless WAZIR_NATS_LIVE_URL is set, e.g.:
 *   docker run -d --name wazir-nats-v043 -p 14222:4222 nats:2.10
 *   WAZIR_NATS_LIVE_URL=nats://127.0.0.1:14222 \
 *   WAZIR_NATS_LIVE_CONTAINER=wazir-nats-v043 \
 *     npx vitest run packages/core/tests/coordinationFabric.natsLive.test.ts
 *
 * The test stops and restarts the container (`docker stop` / `docker start`) mid-stream, so
 * WAZIR_NATS_LIVE_CONTAINER must name a disposable container that publishes the URL's port.
 * DOCKER_HOST / DOCKER_CONFIG are inherited from the environment.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CoordinationFabric,
  NatsWireTransport,
  type CoordinationEventEnvelope,
} from '../src/services/coordinationFabric.js';

const LIVE_URL = process.env.WAZIR_NATS_LIVE_URL?.trim();
const CONTAINER = process.env.WAZIR_NATS_LIVE_CONTAINER?.trim() || 'wazir-nats-v043';
const N = Number.parseInt(process.env.WAZIR_NATS_LIVE_EVENTS ?? '40', 10);
const STOP_AFTER = Math.floor(N / 2);

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[nats-live ${new Date().toISOString()}] ${msg}`);
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Consumer whose side effect (a ledger credit) is applied once per idempotency key. */
class IdempotentConsumer {
  readonly deliveries: string[] = [];
  readonly ledger = new Map<string, number>();
  duplicatesSuppressed = 0;

  handle(ev: CoordinationEventEnvelope): void {
    if (ev.workflow_id !== this.workflowId) return;
    const key = ev.idempotency_key ?? ev.event_id;
    this.deliveries.push(key);
    if (this.ledger.has(key)) {
      this.duplicatesSuppressed += 1;
      return;
    }
    this.ledger.set(key, 1); // side effect applied exactly once per key
  }

  constructor(private readonly workflowId: string) {}
}

describe.skipIf(!LIVE_URL)('CoordinationFabric over a live nats-server (opt-in)', () => {
  it(
    'buffers to the outbox while the broker is down, drains after restart, and an idempotent consumer applies each effect once',
    async () => {
      const url = LIVE_URL!;
      const workflowId = `wf-live-${Date.now()}`;
      const fabricDir = mkdtempSync(path.join(os.tmpdir(), 'wazir-nats-live-'));
      tempDirs.push(fabricDir);

      const consumer = new IdempotentConsumer(workflowId);
      const consumerTransport = new NatsWireTransport({ url, connectTimeoutMs: 1000, clientName: 'wazir-live-consumer' });
      consumerTransport.subscribe((ev) => consumer.handle(ev));
      await consumerTransport.connect();
      log(`consumer connected to ${url}; server=${JSON.stringify(consumerTransport.getServerInfo()?.version)}`);

      // NATS Core transports do not reconnect on their own; the consumer runs its own loop.
      let reconnecting = true;
      const reconnectLoop = (async () => {
        while (reconnecting) {
          if (!consumerTransport.isConnected()) {
            try {
              await consumerTransport.connect(500);
              log('consumer reconnected (SUB re-sent)');
            } catch {
              // broker still down
            }
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      })();

      const producer = new CoordinationFabric({
        fabricDir,
        natsUrl: url,
        connectTimeoutMs: 500,
        maxRetries: 10_000,
        // Long auto-retry delay: the test drives the drain explicitly after the consumer is back,
        // because NATS Core does not buffer for disconnected subscribers.
        retryBaseDelayMs: 60_000,
        retryMaxDelayMs: 60_000,
        circuitFailureThreshold: 3,
        circuitCooldownMs: 200,
      });

      const publishOne = async (i: number) => {
        await producer.publish({
          event_id: `evt-${workflowId}-${i}`,
          idempotency_key: `credit-${workflowId}-${i}`,
          type: 'task.progress',
          workflow_id: workflowId,
          payload: { i, amount: 1 },
        });
        return producer.flush(1500);
      };

      try {
        // Phase 1: broker up.
        for (let i = 0; i < STOP_AFTER; i += 1) {
          await publishOne(i);
        }
        await waitFor(async () => (await producer.listOutbox('delivered')).length === STOP_AFTER, 5000, 'phase-1 delivered');
        await waitFor(() => consumer.ledger.size === STOP_AFTER, 5000, 'consumer saw phase-1 events');
        log(`phase 1: ${STOP_AFTER} delivered and consumed`);

        // Phase 2: kill broker mid-stream.
        log(`docker stop ${CONTAINER}: ${docker('stop', '-t', '1', CONTAINER)}`);
        for (let i = STOP_AFTER; i < N; i += 1) {
          await publishOne(i);
        }
        const outbox = await producer.listOutbox();
        const undelivered = outbox.filter((e) => e.status === 'pending' || e.status === 'failed');
        log(`phase 2: broker down; outbox undelivered=${undelivered.length} delivered=${outbox.filter((e) => e.status === 'delivered').length} dlq=${(await producer.listDeadLetters()).length}`);
        expect(undelivered.length).toBe(N - STOP_AFTER);
        expect((await producer.getStatus()).circuitState).not.toBe('closed');
        expect(consumer.ledger.size).toBe(STOP_AFTER);

        // Phase 3: restart broker; wait for consumer to resubscribe, then drain the outbox.
        log(`docker start ${CONTAINER}: ${docker('start', CONTAINER)}`);
        await waitFor(() => consumerTransport.isConnected(), 15_000, 'consumer reconnect');
        await new Promise((r) => setTimeout(r, 300)); // allow circuit cooldown -> half-open
        await waitFor(
          async () => {
            await producer.flush(2000);
            const left = (await producer.listOutbox()).filter((e) => e.status === 'pending' || e.status === 'failed');
            return left.length === 0;
          },
          20_000,
          'outbox drained',
        );
        log(`phase 3: outbox drained; status=${JSON.stringify(await producer.getStatus())}`);

        // Inject an at-least-once style duplicate (as a retry after a lost PONG would) to prove
        // the consumer's idempotency guard.
        const dupSource = (await producer.listOutbox('delivered'))[0]!.envelope;
        const dupTransport = new NatsWireTransport({ url, connectTimeoutMs: 1000, clientName: 'wazir-live-dup' });
        await dupTransport.connect();
        await dupTransport.publishBatch([dupSource, dupSource]);
        await dupTransport.close();

        await waitFor(() => consumer.ledger.size === N && consumer.duplicatesSuppressed >= 2, 10_000, 'all effects applied');
        for (let i = 0; i < N; i += 1) {
          expect(consumer.ledger.get(`credit-${workflowId}-${i}`)).toBe(1);
        }
        expect([...consumer.ledger.values()].reduce((a, b) => a + b, 0)).toBe(N);
        expect((await producer.listDeadLetters()).length).toBe(0);
        log(
          `RESULT: N=${N} deliveries=${consumer.deliveries.length} uniqueEffects=${consumer.ledger.size} duplicatesSuppressed=${consumer.duplicatesSuppressed}`,
        );
      } finally {
        reconnecting = false;
        await reconnectLoop;
        await producer.close();
        await consumerTransport.close();
        try {
          docker('start', CONTAINER);
        } catch {
          // leave container state to the operator
        }
      }
    },
    90_000,
  );
});
