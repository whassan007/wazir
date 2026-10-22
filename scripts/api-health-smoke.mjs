#!/usr/bin/env node
import { spawn } from 'node:child_process';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const port = process.env.WAZIR_SMOKE_PORT || '43127';
const child = spawn(npm, ['run', 'start', '--workspace', '@wazir/api'], { env: { ...process.env, PORT: port }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', (d) => { output += d; }); child.stderr.on('data', (d) => { output += d; });
const deadline = Date.now() + 30_000;
let healthy = false;
try {
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) { healthy = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} finally { child.kill('SIGTERM'); }
if (!healthy) { console.error(`API health check failed on port ${port}\n${output.slice(-2000)}`); process.exit(1); }
console.log(`API health check passed on port ${port}`);
