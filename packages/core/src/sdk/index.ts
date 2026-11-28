export type WazirExtensionLicense = 'AGPL-3.0-only' | 'Apache-2.0' | 'MIT' | 'COMMERCIAL_AUTHORIZED';

export interface WazirExtensionManifest {
  id: string;
  name: string;
  version: string;
  domain: string;
  license: WazirExtensionLicense;
  sdkVersionConstraint: string;
  ontologies: string[];
  workflows: string[];
  rubrics: string[];
  qualityGates: string[];
  tools: string[];
  dashboards: string[];
  reports: string[];
}

export interface WazirExtensionPlugin {
  manifest: WazirExtensionManifest;
}

export const BUILTIN_REFERENCE_EXTENSIONS: WazirExtensionManifest[] = [
  {
    id: 'lorecraft',
    name: 'Lorecraft Extension',
    version: '1.0.0',
    domain: 'narrative-worldbuilding',
    license: 'AGPL-3.0-only',
    sdkVersionConstraint: '>=0.5.0',
    ontologies: ['WorldEntity', 'CharacterArc', 'CanonTimeline'],
    workflows: ['lore-consistency-check', 'chapter-draft-and-critic'],
    rubrics: ['canon-fidelity', 'narrative-coherence'],
    qualityGates: ['no-canon-contradiction'],
    tools: ['lore_graph_query', 'timeline_validator'],
    dashboards: ['lorecraft-canon-board'],
    reports: ['canon-audit-report'],
  },
  {
    id: '90nf-forge',
    name: '90NF Forge Extension',
    version: '1.0.0',
    domain: 'sovereign-engineering',
    license: 'AGPL-3.0-only',
    sdkVersionConstraint: '>=0.5.0',
    ontologies: ['ForgeCard', 'WorktreeWave', 'ReleaseGate'],
    workflows: ['fs5-parallel-wave', 'sovereign-release-verify'],
    rubrics: ['build-determinism', 'zero-regression'],
    qualityGates: ['independent-verifier-pass'],
    tools: ['forge_wave_dispatch', 'forge_gate_check'],
    dashboards: ['forge-wave-monitor'],
    reports: ['forge-qualification-report'],
  },
  {
    id: 'bazaar',
    name: 'Bazaar Extension',
    version: '1.0.0',
    domain: 'commerce-marketplace',
    license: 'AGPL-3.0-only',
    sdkVersionConstraint: '>=0.5.0',
    ontologies: ['Listing', 'MerchantPolicy', 'Settlement'],
    workflows: ['listing-compliance-audit'],
    rubrics: ['policy-safety', 'pricing-integrity'],
    qualityGates: ['merchant-verification-gate'],
    tools: ['bazaar_catalog_check'],
    dashboards: ['bazaar-ops-console'],
    reports: ['bazaar-compliance-report'],
  },
  {
    id: 'robotics-simulation',
    name: 'Robotics Simulation Extension',
    version: '1.0.0',
    domain: 'autonomous-robotics',
    license: 'AGPL-3.0-only',
    sdkVersionConstraint: '>=0.5.0',
    ontologies: ['Scenario', 'SensorEnvelope', 'SafetyInvariant'],
    workflows: ['scenic-scenario-sweep', 'verifai-falsification'],
    rubrics: ['collision-free-rate', 'braking-envelope'],
    qualityGates: ['zero-safety-violation'],
    tools: ['scenic_generate', 'verifai_falsify'],
    dashboards: ['robotics-sim-telemetry'],
    reports: ['safety-falsification-report'],
  },
  {
    id: 'research-evaluation',
    name: 'Research & Evaluation Extension',
    version: '1.0.0',
    domain: 'research-benchmarking',
    license: 'AGPL-3.0-only',
    sdkVersionConstraint: '>=0.5.0',
    ontologies: ['Experiment', 'Hypothesis', 'BenchmarkMatrix'],
    workflows: ['ablation-sweep', 'reproducibility-audit'],
    rubrics: ['statistical-significance', 'reproducibility'],
    qualityGates: ['evidence-backed-claim'],
    tools: ['benchmark_runner', 'stat_significance_test'],
    dashboards: ['research-eval-matrix'],
    reports: ['experiment-comparison-report'],
  },
  {
    id: 'software-development',
    name: 'Software Development Extension',
    version: '1.0.0',
    domain: 'software-engineering',
    license: 'AGPL-3.0-only',
    sdkVersionConstraint: '>=0.5.0',
    ontologies: ['Repository', 'PullRequest', 'TestSuite'],
    workflows: ['plan-implement-verify-repair'],
    rubrics: ['typecheck-pass', 'unit-test-pass', 'diff-minimality'],
    qualityGates: ['ci-regression-gate'],
    tools: ['git_worktree_isolate', 'vitest_runner'],
    dashboards: ['dev-pipeline-studio'],
    reports: ['release-readiness-report'],
  },
];

export class WazirExtensionRegistry {
  private readonly plugins = new Map<string, WazirExtensionPlugin>();

  constructor(includeBuiltins = true) {
    if (includeBuiltins) {
      for (const manifest of BUILTIN_REFERENCE_EXTENSIONS) {
        this.plugins.set(manifest.id, { manifest });
      }
    }
  }

  register(plugin: WazirExtensionPlugin): void {
    if (!plugin.manifest.id) throw new Error('Extension id cannot be empty.');
    this.plugins.set(plugin.manifest.id, plugin);
  }

  get(id: string): WazirExtensionPlugin | undefined {
    return this.plugins.get(id);
  }

  list(): WazirExtensionManifest[] {
    return Array.from(this.plugins.values())
      .map((p) => p.manifest)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
