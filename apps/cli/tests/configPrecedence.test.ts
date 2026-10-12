import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

const KEYS = ['WAZIR_HOME', 'WAZIR_LMSTUDIO_URL', 'WAZIR_OLLAMA_URL', 'WAZIR_API_URL', 'WAZIR_API_TOKEN', 'WAZIR_REGISTRATION_TOKEN'];

describe('config precedence', () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  let home: string | undefined;
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('environment variables override config.json (e.g. containers reaching host runtimes)', () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'wazir-cfg-'));
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      lmstudioUrl: 'http://localhost:1234/v1', ollamaUrl: 'http://localhost:11434',
      apiUrl: 'http://file-api', apiToken: 'file-token', registrationToken: 'file-reg',
    }));
    process.env.WAZIR_HOME = home;
    process.env.WAZIR_LMSTUDIO_URL = 'http://host.docker.internal:1234/v1';
    process.env.WAZIR_OLLAMA_URL = 'http://host.docker.internal:11434';
    process.env.WAZIR_API_URL = 'http://env-api';
    process.env.WAZIR_API_TOKEN = 'env-token';
    process.env.WAZIR_REGISTRATION_TOKEN = 'env-reg';

    const config = loadConfig();
    expect(config.lmstudioUrl).toBe('http://host.docker.internal:1234/v1');
    expect(config.ollamaUrl).toBe('http://host.docker.internal:11434');
    expect(config.apiUrl).toBe('http://env-api');
    expect(config.apiToken).toBe('env-token');
    expect(config.registrationToken).toBe('env-reg');
  });

  it('config.json still applies when the environment does not set a value', () => {
    home = mkdtempSync(path.join(os.tmpdir(), 'wazir-cfg-'));
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ lmstudioUrl: 'http://file-lmstudio/v1' }));
    process.env.WAZIR_HOME = home;
    delete process.env.WAZIR_LMSTUDIO_URL;
    expect(loadConfig().lmstudioUrl).toBe('http://file-lmstudio/v1');
  });
});
