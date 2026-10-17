import { it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const OPERATOR_TOKEN = 'operator-token-0123456789abcdef';
const REMOTE_TOKEN = 'remote-host-token-0123456789abcdef';

let upstream: http.Server;
let remoteUpstream: http.Server;
let web: ChildProcess;
let webPort: number;
const seen: Array<{ server: 'local' | 'remote'; auth?: string; targetHeader?: string }> = [];

function echoServer(name: 'local' | 'remote'): http.Server {
  return http.createServer((req, res) => {
    seen.push({ server: name, auth: req.headers.authorization, targetHeader: req.headers['x-wazir-target-host'] as string | undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
}

async function listen(server: http.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

/** Raw request so the test controls Host/Origin exactly (fetch forbids setting Host). */
function request(headers: Record<string, string>, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: webPort, path: '/api/v1/overview', method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  upstream = echoServer('local');
  remoteUpstream = echoServer('remote');
  const apiPort = await listen(upstream);
  const remotePort = await listen(remoteUpstream);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-web-trust-'));
  fs.writeFileSync(path.join(home, 'hosts.json'), JSON.stringify({
    activeHostId: 'local',
    hosts: [{ id: 'dgx', url: `http://127.0.0.1:${remotePort}`, accessToken: REMOTE_TOKEN }],
  }));
  web = spawn(process.execPath, ['apps/web/server.js'], {
    env: { ...process.env, PORT: '0', WAZIR_WEB_HOST: '127.0.0.1', WAZIR_HOME: home,
      WAZIR_API: `http://127.0.0.1:${apiPort}`, WAZIR_API_TOKEN: OPERATOR_TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  webPort = await new Promise<number>((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(new Error('web startup timeout')), 5000);
    web.stdout!.on('data', (chunk) => {
      data += chunk;
      const m = data.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    web.on('error', reject);
  });
});

afterAll(async () => {
  web.kill();
  await once(web, 'exit');
  upstream.close();
  remoteUpstream.close();
});

it('attaches the operator token for loopback, same-origin requests', async () => {
  seen.length = 0;
  expect(await request({ Host: `127.0.0.1:${webPort}`, Origin: `http://127.0.0.1:${webPort}` }, 'POST')).toBe(200);
  expect(seen).toEqual([{ server: 'local', auth: `Bearer ${OPERATOR_TOKEN}`, targetHeader: undefined }]);
});

it('refuses cross-origin requests before they reach the API (CSRF)', async () => {
  seen.length = 0;
  expect(await request({ Host: `127.0.0.1:${webPort}`, Origin: 'https://evil.example' }, 'POST')).toBe(403);
  expect(seen).toEqual([]);
});

it('does not attach the operator token when the Host header is not loopback (DNS rebinding)', async () => {
  seen.length = 0;
  expect(await request({ Host: `evil.example:${webPort}` })).toBe(200);
  expect(seen).toEqual([{ server: 'local', auth: undefined, targetHeader: undefined }]);
});

it('ignores x-wazir-target-host from untrusted callers and never leaks saved remote tokens', async () => {
  seen.length = 0;
  await request({ Host: `evil.example:${webPort}`, 'x-wazir-target-host': 'dgx' });
  expect(seen).toEqual([{ server: 'local', auth: undefined, targetHeader: undefined }]);
});

it('lets trusted callers select a saved remote host and strips the selector header', async () => {
  seen.length = 0;
  await request({ Host: `127.0.0.1:${webPort}`, 'x-wazir-target-host': 'dgx' });
  expect(seen).toEqual([{ server: 'remote', auth: `Bearer ${REMOTE_TOKEN}`, targetHeader: undefined }]);
});

it('forwards a caller-supplied Authorization header unchanged when untrusted', async () => {
  seen.length = 0;
  await request({ Host: `evil.example:${webPort}`, Authorization: 'Bearer caller-own-token' });
  expect(seen).toEqual([{ server: 'local', auth: 'Bearer caller-own-token', targetHeader: undefined }]);
});

it('refuses Sec-Fetch-Site: cross-site requests and cross-origin Referer on mutating requests', async () => {
  seen.length = 0;
  expect(await request({ Host: `127.0.0.1:${webPort}`, 'sec-fetch-site': 'cross-site' }, 'POST')).toBe(403);
  expect(await request({ Host: `127.0.0.1:${webPort}`, Referer: 'https://evil.example/page' }, 'POST')).toBe(403);
  expect(seen).toEqual([]);
});

it('prevents an unauthenticated untrusted proxy client from executing tasks, loading/unloading models, changing config, approving ops, or reading executions even if API has allowUnauthenticated=true', async () => {
  const { createApiState, createApp } = await import('../../apps/api/src/server.js');
  const state = await createApiState({ auth: { allowUnauthenticated: true } });
  const app = createApp(state);
  const realApi = http.createServer(app);
  const realApiPort = await listen(realApi);
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-web-trust-real-'));
  const web2 = spawn(process.execPath, ['apps/web/server.js'], {
    env: {
      ...process.env,
      PORT: '0',
      WAZIR_WEB_HOST: '127.0.0.1',
      WAZIR_HOME: home2,
      WAZIR_API: `http://127.0.0.1:${realApiPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const web2Port = await new Promise<number>((resolve, reject) => {
    let data = '';
    const timer = setTimeout(() => reject(new Error('web2 startup timeout')), 5000);
    web2.stdout!.on('data', (chunk) => {
      data += chunk;
      const m = data.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    web2.on('error', reject);
  });

  const rawToWeb2 = (reqPath: string, method: string, headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: web2Port, path: reqPath, method, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });

  try {
    const untrustedHeaders = { Host: `remote-client.tailnet.ts.net:${web2Port}` };
    // Unauthenticated remote client cannot execute tasks, load/unload models, change config, approve ops, or read executions
    expect(await rawToWeb2('/api/v1/tasks/dispatch', 'POST', untrustedHeaders)).toBe(401);
    expect(await rawToWeb2('/executions', 'POST', untrustedHeaders)).toBe(401);
    expect(await rawToWeb2('/api/v1/models/m1/load', 'POST', untrustedHeaders)).toBe(401);
    expect(await rawToWeb2('/api/v1/models/m1/unload', 'POST', untrustedHeaders)).toBe(401);
    expect(await rawToWeb2('/api/v1/autonomy', 'POST', untrustedHeaders)).toBe(401);
    expect(await rawToWeb2('/api/v1/mobile/approvals/a1/resolve', 'POST', untrustedHeaders)).toBe(401);
    expect(await rawToWeb2('/api/v1/executions', 'GET', untrustedHeaders)).toBe(401);

    // Trusted loopback development workflow remains preserved when allowUnauthenticated=true
    const trustedHeaders = { Host: `127.0.0.1:${web2Port}` };
    expect(await rawToWeb2('/api/v1/executions', 'GET', trustedHeaders)).toBe(200);
  } finally {
    web2.kill();
    await once(web2, 'exit');
    realApi.close();
  }
});

