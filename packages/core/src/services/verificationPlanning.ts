import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ImpactAnalysisResult,
  AffectedSymbolInfo,
  VerificationPlan,
  VerificationPlanCheck,
  VerificationScope,
} from '../types/changeImpact.js';
import type { SymbolGraph } from './symbolGraph.js';
import type { ArtifactIntelligenceService } from './artifactIntelligenceService.js';

export interface ChangeImpactAnalyzerOptions {
  symbolGraph?: SymbolGraph;
  artifactService?: ArtifactIntelligenceService;
  workspaceRoot?: string;
}

export class ChangeImpactAnalyzer {
  private readonly symbolGraph?: SymbolGraph;
  private readonly artifactService?: ArtifactIntelligenceService;
  private readonly root: string;

  constructor(options: ChangeImpactAnalyzerOptions = {}) {
    this.symbolGraph = options.symbolGraph;
    this.artifactService = options.artifactService;
    this.root = options.workspaceRoot ?? process.cwd();
  }

  public async analyze(
    changedFiles: string[],
    workspaceRevision: number,
  ): Promise<ImpactAnalysisResult> {
    const affectedSymbols: AffectedSymbolInfo[] = [];
    const affectedPackages = new Set<string>();
    const affectedTests = new Set<string>();
    const affectedBuildTargets = new Set<string>();
    const affectedArtifacts = new Set<string>();
    const ambiguityReasons: string[] = [];
    let isAmbiguous = false;

    // Scan manifests if artifactService available
    const manifests = this.artifactService
      ? await this.artifactService.scanManifests(this.root)
      : [];

    for (const changedFile of changedFiles) {
      const normalizedPath = changedFile.replace(/\\/g, '/');
      const baseName = path.basename(normalizedPath);

      // 1. Root configuration or build file change triggers ambiguous wide impact
      if (
        baseName === 'package.json' ||
        baseName === 'package-lock.json' ||
        baseName === 'tsconfig.json' ||
        baseName === 'Cargo.toml' ||
        baseName === 'pyproject.toml' ||
        baseName === 'go.mod'
      ) {
        isAmbiguous = true;
        ambiguityReasons.push(
          `Mutation in critical package or build configuration '${normalizedPath}' may impact entire workspace`,
        );
      }

      // 2. Identify package membership
      let matchedPkg: string | undefined;
      for (const m of manifests) {
        const pkgDir = path.dirname(m.file).replace(/\\/g, '/');
        if (pkgDir === '.' || normalizedPath.startsWith(pkgDir + '/')) {
          if (!matchedPkg || pkgDir.length > matchedPkg.length) {
            matchedPkg = m.name;
          }
        }
      }
      if (matchedPkg) {
        affectedPackages.add(matchedPkg);
        affectedBuildTargets.add(`${matchedPkg}:build`);
        affectedBuildTargets.add(`${matchedPkg}:typecheck`);
      } else {
        // Fallback package extraction from directory path (e.g. packages/core/...)
        const segments = normalizedPath.split('/');
        if (segments[0] === 'packages' || segments[0] === 'apps') {
          const pkgName = segments.length >= 2 ? `@wazir/${segments[1]}` : segments[0];
          affectedPackages.add(pkgName);
          affectedBuildTargets.add(`${pkgName}:build`);
        }
      }

      // 3. Structural symbol analysis
      if (this.symbolGraph) {
        const nodes = this.symbolGraph.findNodesByFile(normalizedPath);

        if (
          nodes.length === 0 &&
          (normalizedPath.endsWith('.ts') ||
            normalizedPath.endsWith('.js') ||
            normalizedPath.endsWith('.py'))
        ) {
          // Code file has no indexed symbols -> ambiguous dependency resolution
          ambiguityReasons.push(
            `No symbol graph index found for code file '${normalizedPath}'`,
          );
        }

        for (const node of nodes) {
          const callers = this.symbolGraph.findCallers(node.name);
          const callerNames = callers.map((c) => `${c.name} (${c.file})`);

          affectedSymbols.push({
            name: node.name,
            file: normalizedPath,
            callers: callerNames,
            dependents: callerNames,
          });

          // Transitive test discovery through call graph
          const visitedCallers = new Set<string>();
          const callerQueue = [...callers];
          for (const c of callers) visitedCallers.add(c.id);

          while (callerQueue.length > 0) {
            const current = callerQueue.shift()!;
            if (current.file.includes('test') || current.file.includes('spec')) {
              affectedTests.add(current.file);
            }
            const parents = this.symbolGraph.findCallers(current.name);
            for (const p of parents) {
              if (!visitedCallers.has(p.id)) {
                visitedCallers.add(p.id);
                callerQueue.push(p);
              }
            }
          }
        }

        // Test associations via findTests
        const directTests = this.symbolGraph.findTests(normalizedPath);
        for (const t of directTests) {
          affectedTests.add(t.file);
        }
      } else {
        ambiguityReasons.push('SymbolGraph is not configured; cannot determine symbol-level call edges');
      }

      // Add conventional test if matching test file exists pattern
      if (!normalizedPath.includes('.test.') && !normalizedPath.includes('.spec.')) {
        const ext = path.extname(normalizedPath);
        const nameWithoutExt = normalizedPath.slice(0, -ext.length);
        const candidateTest = `${nameWithoutExt}.test${ext}`;
        affectedTests.add(candidateTest);
      } else {
        affectedTests.add(normalizedPath);
      }
    }

    const confidence = isAmbiguous
      ? 'ambiguous'
      : ambiguityReasons.length > 0
        ? 'medium'
        : 'high';

    return {
      workspaceRevision,
      changedFiles,
      affectedSymbols,
      affectedPackages: Array.from(affectedPackages),
      affectedTests: Array.from(affectedTests),
      affectedBuildTargets: Array.from(affectedBuildTargets),
      affectedArtifacts: Array.from(affectedArtifacts),
      confidence,
      ambiguityReasons: ambiguityReasons.length > 0 ? ambiguityReasons : undefined,
    };
  }
}

export class VerificationPlanner {
  public plan(impact: ImpactAnalysisResult): VerificationPlan {
    const planId = `vplan-${randomUUID()}`;
    const checks: VerificationPlanCheck[] = [];

    // Escalation: if confidence is ambiguous, widen to full workspace verification
    if (impact.confidence === 'ambiguous') {
      const escalationReason =
        impact.ambiguityReasons?.join('; ') ??
        'Impact cannot be determined with structural confidence; widening verification to full workspace';

      checks.push(
        {
          id: `chk-typecheck-full`,
          name: 'Full Workspace Typecheck',
          kind: 'typecheck',
          target: 'workspace',
          command: 'npm run typecheck',
          reason: escalationReason,
          scope: 'full',
        },
        {
          id: `chk-build-full`,
          name: 'Full Workspace Build',
          kind: 'build',
          target: 'workspace',
          command: 'npm run build',
          reason: escalationReason,
          scope: 'full',
        },
        {
          id: `chk-test-full`,
          name: 'Comprehensive Test Suite',
          kind: 'test',
          target: 'workspace',
          command: 'npm test',
          reason: escalationReason,
          scope: 'full',
        },
      );

      return {
        id: planId,
        workspaceRevision: impact.workspaceRevision,
        scope: 'full',
        changedFiles: impact.changedFiles,
        affectedPackages: impact.affectedPackages,
        checks,
        summary: `Escalated to full workspace verification due to: ${escalationReason}`,
        escalationReason,
        generatedAt: new Date(),
      };
    }

    // High confidence -> Targeted verification
    if (impact.confidence === 'high') {
      // 1. Target-specific tests
      for (const testFile of impact.affectedTests) {
        checks.push({
          id: `chk-test-${path.basename(testFile, path.extname(testFile))}`,
          name: `Test ${path.basename(testFile)}`,
          kind: 'test',
          target: testFile,
          command: `npx vitest run ${testFile}`,
          reason: `Directly covers mutated files: ${impact.changedFiles.join(', ')}`,
          scope: 'targeted',
        });
      }

      // 2. Package-level build check
      for (const pkg of impact.affectedPackages) {
        checks.push({
          id: `chk-build-${pkg.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          name: `Build ${pkg}`,
          kind: 'build',
          target: pkg,
          command: `npm run build --workspace ${pkg}`,
          reason: `Package ${pkg} contains modified symbols: ${impact.affectedSymbols.map((s) => s.name).join(', ') || 'module code'}`,
          scope: 'targeted',
        });
      }

      return {
        id: planId,
        workspaceRevision: impact.workspaceRevision,
        scope: 'targeted',
        changedFiles: impact.changedFiles,
        affectedPackages: impact.affectedPackages,
        checks,
        summary: `Targeted verification of ${checks.length} check(s) covering ${impact.changedFiles.length} file(s)`,
        generatedAt: new Date(),
      };
    }

    // Medium confidence -> Package level verification
    for (const pkg of impact.affectedPackages) {
      checks.push(
        {
          id: `chk-typecheck-${pkg.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          name: `Typecheck ${pkg}`,
          kind: 'typecheck',
          target: pkg,
          command: `npx tsc --project packages/${pkg.replace('@wazir/', '')}/tsconfig.json`,
          reason: `Package-level type validation for ${pkg}`,
          scope: 'package',
        },
        {
          id: `chk-test-${pkg.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          name: `Test Suite ${pkg}`,
          kind: 'test',
          target: pkg,
          command: `npx vitest run packages/${pkg.replace('@wazir/', '')}/tests/`,
          reason: `Package-level test regression suite for ${pkg}`,
          scope: 'package',
        },
      );
    }

    return {
      id: planId,
      workspaceRevision: impact.workspaceRevision,
      scope: 'package',
      changedFiles: impact.changedFiles,
      affectedPackages: impact.affectedPackages,
      checks,
      summary: `Package-scoped verification across ${impact.affectedPackages.join(', ')}`,
      generatedAt: new Date(),
    };
  }
}
