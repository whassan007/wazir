import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  PackageManifest,
  ExternalDependency,
  BuildGraph,
  BuildGraphNode,
  BuildGraphEdge,
  GeneratedArtifact,
  SecurityAdvisory,
  Ecosystem,
} from '../types/index.js';

export interface ArtifactIntelligenceOptions {
  workspaceRoot?: string;
  advisoryDatabase?: Map<string, SecurityAdvisory[]>;
}

export class ArtifactIntelligenceService {
  private readonly artifacts = new Map<string, GeneratedArtifact>();
  private readonly advisoryDb: Map<string, SecurityAdvisory[]>;
  private readonly defaultWorkspaceRoot: string;

  constructor(options: ArtifactIntelligenceOptions = {}) {
    this.defaultWorkspaceRoot = options.workspaceRoot ?? process.cwd();
    this.advisoryDb = options.advisoryDatabase ?? new Map();
  }

  /**
   * Scans package manifests across the workspace (package.json, Cargo.toml, pyproject.toml, go.mod).
   */
  public async scanManifests(workspaceRoot?: string): Promise<PackageManifest[]> {
    const root = workspaceRoot ?? this.defaultWorkspaceRoot;
    const manifests: PackageManifest[] = [];

    const walk = async (dir: string, depth = 0) => {
      if (depth > 4) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.wazir') {
          continue;
        }
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          if (entry.name === 'package.json') {
            try {
              const content = await fs.readFile(fullPath, 'utf8');
              const json = JSON.parse(content);
              manifests.push({
                file: path.relative(root, fullPath),
                name: json.name ?? 'unnamed',
                version: json.version ?? '0.0.0',
                ecosystem: 'npm',
                dependencies: json.dependencies ?? {},
                devDependencies: json.devDependencies ?? {},
                peerDependencies: json.peerDependencies ?? {},
                scripts: json.scripts ?? {},
              });
            } catch {
              // ignore malformed package.json
            }
          } else if (entry.name === 'Cargo.toml') {
            try {
              const content = await fs.readFile(fullPath, 'utf8');
              const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
              const versionMatch = content.match(/version\s*=\s*"([^"]+)"/);
              manifests.push({
                file: path.relative(root, fullPath),
                name: nameMatch ? nameMatch[1] : 'cargo-package',
                version: versionMatch ? versionMatch[1] : '0.1.0',
                ecosystem: 'cargo',
                dependencies: this.parseSimpleTomlDependencies(content),
              });
            } catch {
              // ignore malformed Cargo.toml
            }
          } else if (entry.name === 'pyproject.toml') {
            try {
              const content = await fs.readFile(fullPath, 'utf8');
              const nameMatch = content.match(/name\s*=\s*"([^"]+)"/);
              manifests.push({
                file: path.relative(root, fullPath),
                name: nameMatch ? nameMatch[1] : 'py-project',
                version: '0.1.0',
                ecosystem: 'pypi',
                dependencies: {},
              });
            } catch {
              // ignore
            }
          }
        }
      }
    };

    await walk(root);
    return manifests;
  }

  /**
   * Extracts and normalizes external dependencies from scanned manifests,
   * correlating with known security advisories.
   */
  public async analyzeDependencies(workspaceRoot?: string): Promise<ExternalDependency[]> {
    const manifests = await this.scanManifests(workspaceRoot);
    const depsMap = new Map<string, ExternalDependency>();

    for (const manifest of manifests) {
      for (const [depName, version] of Object.entries(manifest.dependencies)) {
        const key = `${manifest.ecosystem}:${depName}`;
        const advisories = this.advisoryDb.get(depName);
        depsMap.set(key, {
          name: depName,
          version,
          ecosystem: manifest.ecosystem,
          direct: true,
          manifestFile: manifest.file,
          ...(advisories ? { advisories } : {}),
        });
      }

      if (manifest.devDependencies) {
        for (const [depName, version] of Object.entries(manifest.devDependencies)) {
          const key = `${manifest.ecosystem}:${depName}`;
          if (!depsMap.has(key)) {
            const advisories = this.advisoryDb.get(depName);
            depsMap.set(key, {
              name: depName,
              version,
              ecosystem: manifest.ecosystem,
              direct: false,
              manifestFile: manifest.file,
              ...(advisories ? { advisories } : {}),
            });
          }
        }
      }
    }

    return Array.from(depsMap.values());
  }

  /**
   * Builds a structured build dependency graph from package manifests and scripts.
   */
  public async buildGraph(workspaceRoot?: string): Promise<BuildGraph> {
    const manifests = await this.scanManifests(workspaceRoot);
    const nodes: BuildGraphNode[] = [];
    const edges: BuildGraphEdge[] = [];

    for (const manifest of manifests) {
      const pkgNodeId = `pkg:${manifest.name}`;
      nodes.push({
        id: pkgNodeId,
        target: manifest.name,
        inputs: [manifest.file],
        outputs: [`dist/${manifest.name}`],
      });

      if (manifest.scripts) {
        for (const [scriptName, cmd] of Object.entries(manifest.scripts)) {
          const scriptNodeId = `${pkgNodeId}:${scriptName}`;
          nodes.push({
            id: scriptNodeId,
            target: `${manifest.name}#${scriptName}`,
            inputs: [manifest.file],
            outputs: [],
            command: cmd,
          });
          edges.push({ from: pkgNodeId, to: scriptNodeId });
        }
      }

      // Inter-package dependency edges
      for (const depName of Object.keys(manifest.dependencies)) {
        const depPkgNodeId = `pkg:${depName}`;
        edges.push({ from: pkgNodeId, to: depPkgNodeId });
      }
    }

    return { nodes, edges };
  }

  /**
   * Tracks a generated physical artifact (binary, bundle, test report, package).
   */
  public async trackArtifact(
    params: Omit<GeneratedArtifact, 'id' | 'createdAt' | 'sizeBytes' | 'contentHash'> & {
      sizeBytes?: number;
      contentHash?: string;
    },
  ): Promise<GeneratedArtifact> {
    const artifactId = `art-${randomUUID()}`;
    let sizeBytes = params.sizeBytes ?? 0;
    let contentHash = params.contentHash ?? '';

    // If file exists on disk, inspect physical bytes
    try {
      const stat = await fs.stat(params.path);
      sizeBytes = stat.size;
      const buffer = await fs.readFile(params.path);
      contentHash = createHash('sha256').update(buffer).digest('hex');
    } catch {
      // Virtual or unwritten artifact fallback
      if (!contentHash) {
        contentHash = createHash('sha256').update(params.name).digest('hex');
      }
    }

    const artifact: GeneratedArtifact = {
      id: artifactId,
      name: params.name,
      path: params.path,
      type: params.type,
      sizeBytes,
      contentHash,
      producedByStep: params.producedByStep,
      executionId: params.executionId,
      createdAt: new Date(),
      metadata: params.metadata,
    };

    this.artifacts.set(artifactId, artifact);
    return artifact;
  }

  /**
   * Lists tracked artifacts, optionally filtered by execution ID.
   */
  public listArtifacts(executionId?: string): GeneratedArtifact[] {
    const all = Array.from(this.artifacts.values());
    if (!executionId) return all;
    return all.filter((a) => a.executionId === executionId);
  }

  /**
   * Registers a security advisory in the local intelligence catalog.
   */
  public registerAdvisory(packageName: string, advisory: SecurityAdvisory): void {
    let list = this.advisoryDb.get(packageName);
    if (!list) {
      list = [];
      this.advisoryDb.set(packageName, list);
    }
    list.push(advisory);
  }

  private parseSimpleTomlDependencies(toml: string): Record<string, string> {
    const deps: Record<string, string> = {};
    const lines = toml.split('\n');
    let inDeps = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '[dependencies]') {
        inDeps = true;
        continue;
      }
      if (inDeps && trimmed.startsWith('[')) {
        break;
      }
      if (inDeps) {
        const m = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*"([^"]+)"/);
        if (m) {
          deps[m[1]] = m[2];
        }
      }
    }
    return deps;
  }
}
