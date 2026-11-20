import { PassThrough } from 'node:stream';
import type http from 'node:http';
import { describe, it, expect } from 'vitest';
import { SecretBroker, TokenInjectingEgressProxy } from '../src/index.js';
import type { SecretBackend } from '../src/backend.js';

class MemorySecretBackend implements SecretBackend {
  readonly name = 'encrypted-file' as const;
  private readonly map = new Map<string, string>();
  async get(key: string) { return this.map.get(key); }
  async set(key: string, value: string) { this.map.set(key, value); }
  async delete(key: string) { return this.map.delete(key); }
  async list() { return [...this.map.keys()]; }
}

function makeMockReq(method: string, url: string, headers: Record<string, string>): http.IncomingMessage {
  const stream = new PassThrough() as unknown as http.IncomingMessage;
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  stream.end();
  return stream;
}

function makeMockRes(): { res: http.ServerResponse; done: Promise<{ statusCode: number; body: string }> } {
  const stream = new PassThrough() as unknown as http.ServerResponse & { statusCode: number };
  let statusCode = 200;
  const chunks: Buffer[] = [];
  stream.writeHead = ((code: number) => {
    statusCode = code;
    return stream;
  }) as unknown as http.ServerResponse['writeHead'];
  stream.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<{ statusCode: number; body: string }>((resolve) => {
    stream.on('end', () => resolve({ statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  return { res: stream, done };
}

describe('TokenInjectingEgressProxy', () => {
  it('injects secret header on allowlisted route and blocks unapproved routes', async () => {
    let seenAuth = '';
    const mockTransport = ((
      _url: URL,
      opts: http.RequestOptions,
      cb: (res: http.IncomingMessage) => void,
    ) => {
      const headers = (opts.headers ?? {}) as Record<string, string>;
      seenAuth = String(headers.authorization ?? '');
      const upstreamReq = new PassThrough() as unknown as http.ClientRequest;
      upstreamReq.on('finish', () => {
        const upstreamRes = new PassThrough() as unknown as http.IncomingMessage;
        upstreamRes.statusCode = 200;
        upstreamRes.headers = { 'content-type': 'application/json' };
        cb(upstreamRes);
        upstreamRes.end(JSON.stringify({ ok: true }));
      });
      return upstreamReq;
    }) as unknown as typeof http.request;

    const broker = new SecretBroker(new MemorySecretBackend());
    await broker.putCredential('github_token', 'ghp_super_secret_123');

    const proxy = new TokenInjectingEgressProxy({
      broker,
      rules: [
        {
          id: 'gh-api',
          targetOrigin: 'https://api.github.com',
          pathPrefix: '/repos/',
          secretKey: 'github_token',
        },
      ],
      requestTransport: mockTransport,
    });

    // Allowed route -> secret injected
    const okMock = makeMockRes();
    await proxy.dispatchRequest(
      makeMockReq('GET', '/repos/org/app', { 'x-wazir-target-url': 'https://api.github.com/repos/org/app' }),
      okMock.res,
    );
    const okOut = await okMock.done;
    expect(okOut.statusCode).toBe(200);
    expect(seenAuth).toBe('Bearer ghp_super_secret_123');

    // Disallowed path -> 403
    const deniedMock = makeMockRes();
    await proxy.dispatchRequest(
      makeMockReq('GET', '/admin/secrets', { 'x-wazir-target-url': 'https://api.github.com/admin/secrets' }),
      deniedMock.res,
    );
    const deniedOut = await deniedMock.done;
    expect(deniedOut.statusCode).toBe(403);
    expect(proxy.getAuditLog().some((a) => a.status === 'denied')).toBe(true);
  });
});
