import type { ArtifactType } from './artifact.js';

export type Ecosystem = 'npm' | 'cargo' | 'pypi' | 'golang' | 'maven' | 'other';

export interface PackageManifest {
  file: string;
  name: string;
  version: string;
  ecosystem: Ecosystem;
  dependencies: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface SecurityAdvisory {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  affectedVersions: string;
  fixedIn?: string;
  url?: string;
}

export interface ExternalDependency {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  direct: boolean;
  license?: string;
  manifestFile: string;
  advisories?: SecurityAdvisory[];
}

export interface BuildGraphNode {
  id: string;
  target: string;
  inputs: string[];
  outputs: string[];
  command?: string;
}

export interface BuildGraphEdge {
  from: string;
  to: string;
}

export interface BuildGraph {
  nodes: BuildGraphNode[];
  edges: BuildGraphEdge[];
}

export interface GeneratedArtifact {
  id: string;
  name: string;
  path: string;
  type: ArtifactType;
  sizeBytes: number;
  contentHash: string;
  producedByStep?: string;
  executionId?: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}
