export interface LayerRule {
  name: string;
  rank: number;
}

export interface FileDependencyEdge {
  fromFile: string;
  fromLayer: string;
  toFile: string;
  toLayer: string;
}

export interface ArchitectureLintViolation {
  fromFile: string;
  fromLayer: string;
  toFile: string;
  toLayer: string;
  remediation: string;
}

export interface SlopCollectionReport {
  violations: ArchitectureLintViolation[];
  staleArtifactPaths: string[];
  passed: boolean;
}

export const DEFAULT_FORWARD_LAYERS: LayerRule[] = [
  { name: 'types', rank: 0 },
  { name: 'config', rank: 1 },
  { name: 'repo', rank: 2 },
  { name: 'service', rank: 3 },
  { name: 'runtime', rank: 4 },
  { name: 'ui', rank: 5 },
];

/**
 * Self-healing forward-only architectural layer linter & background
 * "AI-slop" garbage collector (OpenAI harness-engineering pattern).
 * Checks that lower layers never import higher layers and injects actionable
 * remediation instructions directly into the agent's context.
 */
export function lintForwardOnlyLayers(
  edges: FileDependencyEdge[],
  layers: LayerRule[] = DEFAULT_FORWARD_LAYERS,
): ArchitectureLintViolation[] {
  const rankMap = new Map(layers.map((l) => [l.name, l.rank]));
  const violations: ArchitectureLintViolation[] = [];

  for (const edge of edges) {
    const fromRank = rankMap.get(edge.fromLayer);
    const toRank = rankMap.get(edge.toLayer);
    if (fromRank === undefined || toRank === undefined) continue;
    if (toRank > fromRank) {
      violations.push({
        fromFile: edge.fromFile,
        fromLayer: edge.fromLayer,
        toFile: edge.toFile,
        toLayer: edge.toLayer,
        remediation:
          `Layer violation: "${edge.fromFile}" (layer "${edge.fromLayer}", rank ${fromRank}) must not depend on ` +
          `"${edge.toFile}" (layer "${edge.toLayer}", rank ${toRank}). Extract shared interfaces into "${edge.fromLayer}" or "types".`,
      });
    }
  }

  return violations;
}

export function runSlopCollectionPass(params: {
  edges: FileDependencyEdge[];
  candidateStaleArtifacts?: string[];
  layers?: LayerRule[];
}): SlopCollectionReport {
  const violations = lintForwardOnlyLayers(params.edges, params.layers);
  const staleArtifactPaths = [...(params.candidateStaleArtifacts ?? [])];
  return {
    violations,
    staleArtifactPaths,
    passed: violations.length === 0 && staleArtifactPaths.length === 0,
  };
}
