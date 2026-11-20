import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { registerDiagnosticsRoutes } from '../src/diagnosticsRoutes.js';
import { registerPublicRoutes, getSanitizedDemoFleet } from '../src/publicRoutes.js';

describe('Diagnostics & Public Portal API routes', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wazir-api-diag-'));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('registers diagnostics and public routes on Express app', () => {
    const app = express();
    app.use(express.json());
    registerDiagnosticsRoutes(app, tmpHome);
    registerPublicRoutes(app, tmpHome);
    expect(app).toBeDefined();
  });

  it('sanitized demo fleet never leaks private hostnames or tokens', () => {
    const demo = getSanitizedDemoFleet();
    expect(demo.demo).toBe(true);
    expect(demo.sanitized).toBe(true);
    const serialized = JSON.stringify(demo);
    expect(serialized).not.toContain('100.113.62.112');
    expect(serialized).not.toContain('WaelMacPro');
    expect(serialized).not.toContain('waelbot');
    expect(demo.executionGraph.stages.length).toBe(7);
  });
});
