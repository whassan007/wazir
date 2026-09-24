import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ArtifactIntelligenceService } from '../src/index.js';

describe('Gate 7: Artifact and Dependency Intelligence', () => {
  let tempDir: string;
  let service: ArtifactIntelligenceService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wazir-art-test-'));
    service = new ArtifactIntelligenceService({ workspaceRoot: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('scans package manifests and parses dependencies across ecosystems', async () => {
    // 1. Setup npm package.json
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify(
        {
          name: '@wazir/test-pkg',
          version: '1.2.3',
          scripts: {
            build: 'tsc',
            test: 'vitest run',
          },
          dependencies: {
            typescript: '^5.6.0',
            cheerio: '^1.0.0',
          },
          devDependencies: {
            vitest: '^2.0.0',
          },
        },
        null,
        2,
      ),
    );

    // 2. Setup Cargo.toml
    const cargoDir = path.join(tempDir, 'crates', 'core-rs');
    await fs.mkdir(cargoDir, { recursive: true });
    await fs.writeFile(
      path.join(cargoDir, 'Cargo.toml'),
      `[package]
name = "core-rs"
version = "0.5.0"

[dependencies]
serde = "1.0"
tokio = "1.28"
`,
    );

    const manifests = await service.scanManifests(tempDir);
    expect(manifests.length).toBe(2);

    const npmManifest = manifests.find((m) => m.ecosystem === 'npm');
    expect(npmManifest).toBeDefined();
    expect(npmManifest?.name).toBe('@wazir/test-pkg');
    expect(npmManifest?.dependencies['cheerio']).toBe('^1.0.0');
    expect(npmManifest?.devDependencies?.['vitest']).toBe('^2.0.0');
    expect(npmManifest?.scripts?.['build']).toBe('tsc');

    const cargoManifest = manifests.find((m) => m.ecosystem === 'cargo');
    expect(cargoManifest).toBeDefined();
    expect(cargoManifest?.name).toBe('core-rs');
    expect(cargoManifest?.dependencies['tokio']).toBe('1.28');
  });

  it('analyzes external dependencies and correlates with security advisories', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'app',
        version: '1.0.0',
        dependencies: {
          'lodash': '4.17.20',
        },
        devDependencies: {
          'debug': '4.3.0',
        },
      }),
    );

    // Register known advisory
    service.registerAdvisory('lodash', {
      id: 'GHSA-35jh-r3h4-6jhm',
      severity: 'high',
      summary: 'Prototype pollution in lodash',
      affectedVersions: '<4.17.21',
      fixedIn: '4.17.21',
    });

    const deps = await service.analyzeDependencies(tempDir);
    expect(deps.length).toBe(2);

    const lodashDep = deps.find((d) => d.name === 'lodash');
    expect(lodashDep).toBeDefined();
    expect(lodashDep?.version).toBe('4.17.20');
    expect(lodashDep?.direct).toBe(true);
    expect(lodashDep?.advisories).toBeDefined();
    expect(lodashDep?.advisories?.length).toBe(1);
    expect(lodashDep?.advisories?.[0].severity).toBe('high');

    const debugDep = deps.find((d) => d.name === 'debug');
    expect(debugDep).toBeDefined();
    expect(debugDep?.direct).toBe(false);
  });

  it('constructs a structured build graph from package manifests and script targets', async () => {
    await fs.writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'my-service',
        scripts: {
          build: 'tsc -p tsconfig.json',
          bundle: 'esbuild src/index.ts --bundle',
        },
        dependencies: {
          express: '^4.18.0',
        },
      }),
    );

    const buildGraph = await service.buildGraph(tempDir);
    expect(buildGraph.nodes.length).toBeGreaterThan(1);

    const pkgNode = buildGraph.nodes.find((n) => n.id === 'pkg:my-service');
    expect(pkgNode).toBeDefined();
    expect(pkgNode?.target).toBe('my-service');

    const scriptNode = buildGraph.nodes.find((n) => n.id === 'pkg:my-service:build');
    expect(scriptNode).toBeDefined();
    expect(scriptNode?.command).toBe('tsc -p tsconfig.json');

    const edge = buildGraph.edges.find((e) => e.from === 'pkg:my-service' && e.to === 'pkg:my-service:build');
    expect(edge).toBeDefined();
  });

  it('tracks generated physical artifacts with size and SHA256 content hashing', async () => {
    const distDir = path.join(tempDir, 'dist');
    await fs.mkdir(distDir, { recursive: true });
    const bundleFile = path.join(distDir, 'bundle.js');
    await fs.writeFile(bundleFile, 'console.log("compiled bundle");\n', 'utf8');

    const artifact = await service.trackArtifact({
      name: 'bundle.js',
      path: bundleFile,
      type: 'build_output',
      executionId: 'exec-build-1',
      producedByStep: 'compile-step',
      metadata: { target: 'node20' },
    });

    expect(artifact.id).toMatch(/^art-/);
    expect(artifact.name).toBe('bundle.js');
    expect(artifact.sizeBytes).toBeGreaterThan(0);
    expect(artifact.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.type).toBe('build_output');
    expect(artifact.executionId).toBe('exec-build-1');

    const list = service.listArtifacts('exec-build-1');
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(artifact.id);
  });
});
