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
