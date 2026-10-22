import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
it('web proxy binds loopback by default instead of publishing the operator API token capability on every interface', async () => {
  const env = { ...process.env, PORT: '0' };
  delete env.WAZIR_WEB_HOST;
  const child = spawn(process.execPath, ['apps/web/server.js'], { env, stdio:['ignore','pipe','pipe'] });
  try {
    const line = await new Promise<string>((resolve,reject) => {
      let data = '';
      const timer = setTimeout(() => reject(new Error('web startup timeout')),5000);
      child.stdout.on('data', chunk => { data += chunk; if (/http:\/\/127\.0\.0\.1:\d+/.test(data)) {clearTimeout(timer);resolve(data);} });
      child.on('error',reject);
    });
    const url = line.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    expect((await fetch(url)).status).toBe(200);
  } finally { child.kill(); await once(child,'exit'); }
});
