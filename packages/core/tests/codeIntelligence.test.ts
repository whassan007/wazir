import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import {
  CodeIntelligenceService,
  SymbolGraph,
  ContextCompiler,
  type LspProvider,
} from '../src/index.js';

describe('Code Intelligence & Symbol Graph', () => {
  let service: CodeIntelligenceService;
  const projectRoot = '/mock/wazir/project';

  beforeEach(() => {
    service = new CodeIntelligenceService({ projectRoot });
  });

  describe('SymbolGraph primitives', () => {
    it('manages nodes and directed typed edges', () => {
      const graph = new SymbolGraph();
      graph.addNode({
        id: 'fileA.ts:MyClass:class',
        name: 'MyClass',
        kind: 'class',
        language: 'typescript',
        file: '/mock/fileA.ts',
        range: { start: { line: 1, character: 0 }, end: { line: 10, character: 1 } },
      });

      expect(graph.getNode('fileA.ts:MyClass:class')).toBeDefined();
      expect(graph.findNodesByName('MyClass')).toHaveLength(1);
      expect(graph.findNodesByFile('/mock/fileA.ts')).toHaveLength(1);

      graph.addEdge({
        from: 'fileA.ts:MyClass:class',
        to: 'fileB.ts:OtherClass:class',
        type: 'CALLS',
      });

      expect(graph.getOutEdges('fileA.ts:MyClass:class', 'CALLS')).toHaveLength(1);
      expect(graph.getInEdges('fileB.ts:OtherClass:class', 'CALLS')).toHaveLength(1);
    });
  });

  describe('AST Indexing & Symbol Operations', () => {
    const serviceFile = path.resolve(projectRoot, 'packages/core/src/service.ts');
    const clientFile = path.resolve(projectRoot, 'packages/core/src/client.ts');
    const testFile = path.resolve(projectRoot, 'packages/core/tests/service.test.ts');

    const serviceCode = `
      export interface ServiceContract {
        execute(): Promise<void>;
      }

      export class ModelLifecycleService implements ServiceContract {
        async ensureReady(): Promise<boolean> {
          return true;
        }

        async execute(): Promise<void> {
          await this.ensureReady();
        }
      }
    `;

    const clientCode = `
      import { ModelLifecycleService } from './service.js';

      export class Scheduler {
        private lifecycle: ModelLifecycleService;

        async route(): Promise<void> {
          await this.lifecycle.ensureReady();
        }
      }
    `;

    const testCode = `
      import { ModelLifecycleService } from '../src/service.js';

      describe('ModelLifecycleService', () => {
        it('ensures ready', async () => {
          const svc = new ModelLifecycleService();
          await svc.ensureReady();
        });
      });
    `;

    beforeEach(async () => {
      await service.indexFile(serviceFile, serviceCode);
      await service.indexFile(clientFile, clientCode);
      await service.indexFile(testFile, testCode);
    });

    it('extracts document symbols (classes, interfaces, methods)', async () => {
      const symbols = await service.documentSymbols(serviceFile);
      const names = symbols.map((s) => s.name);
      expect(names).toContain('ServiceContract');
      expect(names).toContain('ModelLifecycleService');
      expect(names).toContain('ensureReady');
      expect(names).toContain('execute');
    });

    it('searches workspace symbols across files', async () => {
      const symbols = await service.workspaceSymbols('ModelLifecycle');
      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols[0].name).toBe('ModelLifecycleService');
    });

    it('finds implementations of an interface', async () => {
      const locs = await service.findImplementations(serviceFile, 2, 24);
      expect(locs.some((l) => l.preview === 'ModelLifecycleService')).toBe(true);
    });

    it('finds callers of a method across the codebase', async () => {
      const callers = await service.findCallers('this.lifecycle.ensureReady');
      expect(callers.length).toBeGreaterThan(0);
      expect(callers.some((c) => c.name === 'route')).toBe(true);
    });

    it('finds callees called by a function/method', async () => {
      const callees = await service.findCallees('packages/core/src/client.ts:Scheduler.route:method');
      expect(callees.length).toBeGreaterThan(0);
    });

    it('resolves definition lookup via AST when cursor is on symbol', async () => {
      // Line 6 in clientCode: "await this.lifecycle.ensureReady();"
      const locs = await service.goToDefinition(clientFile, 7, 33);
      expect(locs.length).toBeGreaterThan(0);
      expect(locs.some((l) => l.file === serviceFile)).toBe(true);
    });

    it('resolves references to symbol across files', async () => {
      const refs = await service.findReferences(serviceFile, 7, 15);
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.some((r) => r.file === clientFile)).toBe(true);
    });

    it('identifies related tests for source file and symbols', async () => {
      const tests = await service.relatedTests(serviceFile);
      expect(tests).toContain(testFile);
    });

    it('tracks dependency edges between packages', async () => {
      const schedulerPkgFile = path.resolve(projectRoot, 'packages/scheduler/src/index.ts');
      const corePkgFile = path.resolve(projectRoot, 'packages/core/src/index.ts');
      await service.indexFile(corePkgFile, 'export const core = 1;');
      await service.indexFile(schedulerPkgFile, "import { core } from '@wazir/core';");

      const deps = await service.dependencies('packages/scheduler');
      expect(deps).toContain('packages/core');

      const dependents = await service.dependents('packages/core');
      expect(dependents).toContain('packages/scheduler');
    });

    it('handles incremental update after file mutation', async () => {
      const updatedCode = `
        export class NewRefactoredService {
          perform(): void {}
        }
      `;
      await service.updateFile(serviceFile, updatedCode);

      const symbols = await service.documentSymbols(serviceFile);
      const names = symbols.map((s) => s.name);
      expect(names).toContain('NewRefactoredService');
      expect(names).not.toContain('ModelLifecycleService');
      expect(names).not.toContain('ensureReady');
    });

    it('handles file deletion by pruning nodes and edges', async () => {
      await service.removeFile(clientFile);
      const symbols = await service.documentSymbols(clientFile);
      expect(symbols).toHaveLength(0);

      const callers = await service.findCallers('this.lifecycle.ensureReady');
      expect(callers.filter((c) => c.file === clientFile)).toHaveLength(0);
    });

    it('handles rename where supported', async () => {
      const renamedCode = `
        export class RenamedLifecycleService {
          async ensureReady(): Promise<boolean> { return true; }
        }
      `;
      await service.updateFile(serviceFile, renamedCode);
      const symbols = await service.workspaceSymbols('RenamedLifecycleService');
      expect(symbols).toHaveLength(1);
      expect(symbols[0].name).toBe('RenamedLifecycleService');
    });

    it('captures malformed source diagnostics without throwing', async () => {
      const malformedPath = path.resolve(projectRoot, 'packages/core/src/broken.ts');
      const brokenCode = `
        class IncompleteClass {
          method( {
      `;
      await service.indexFile(malformedPath, brokenCode);
      const diags = await service.diagnostics(malformedPath);
      expect(diags.length).toBeGreaterThan(0);
      expect(diags[0].severity).toBe('error');
    });

    it('seamlessly falls back to AST when LSP is unavailable or throws', async () => {
      const failingLsp: LspProvider = {
        async sendRequest() {
          throw new Error('LSP connection refused: server not running');
        },
      };

      const lspService = new CodeIntelligenceService({
        projectRoot,
        lspProvider: failingLsp,
      });

      await lspService.indexFile(serviceFile, serviceCode);
      await lspService.indexFile(clientFile, clientCode);

      // Should not throw, should fall back to AST definition
      const locs = await lspService.goToDefinition(clientFile, 7, 33);
      expect(locs.length).toBeGreaterThan(0);
      expect(locs.some((l) => l.file === serviceFile)).toBe(true);
    });
  });

  describe('ContextCompiler Integration', () => {
    it('automatically considers symbols, callers, and tests before recent history', async () => {
      const targetFile = path.resolve(projectRoot, 'packages/core/src/modelLifecycleService.ts');
      const callerFile = path.resolve(projectRoot, 'packages/core/src/scheduler.ts');
      const testFile = path.resolve(projectRoot, 'packages/core/tests/modelLifecycleAdmission.test.ts');

      await service.indexFile(
        targetFile,
        `
        export interface ModelLifecycleContract {
          ensureReady(): Promise<void>;
        }
        export class ModelLifecycleService implements ModelLifecycleContract {
          async ensureReady(): Promise<void> {}
        }
        `,
      );

      await service.indexFile(
        callerFile,
        `
        import { ModelLifecycleService } from './modelLifecycleService.js';
        export class Scheduler {
          private svc: ModelLifecycleService;
          async route(): Promise<void> {
            await this.svc.ensureReady();
          }
        }
        `,
      );

      await service.indexFile(
        testFile,
        `
        import { ModelLifecycleService } from '../src/modelLifecycleService.js';
        describe('ModelLifecycleService', () => {});
        `,
      );

      const compiler = new ContextCompiler({
        codeIntelligence: service,
      });

      const snapshot = await compiler.compileSnapshot({
        executionId: 'exec-gate-1',
        taskDescription: 'Refactor ModelLifecycleService ensureReady logic',
        activeFiles: [targetFile],
        recentHistory: [
          {
            kind: 'conversation',
            label: 'Old conversation turn 1',
            content: 'Unrelated past chat message about something else',
            priority: 50,
          },
          {
            kind: 'conversation',
            label: 'Old conversation turn 2',
            content: 'Another old conversation message',
            priority: 50,
          },
        ],
        effectiveContextWindow: 32000,
      });

      // Verify structural code intelligence candidates are included in the compiled snapshot
      const allParts = [
        ...(snapshot.active ?? []),
        ...(snapshot.relevant ?? []),
        ...(snapshot.pinned ?? []),
        ...(snapshot.tail ?? []),
      ];
      const symbolsItem = allParts.find((i) => i.id === `intel-symbols-${targetFile}`);
      const callersItem = allParts.find((i) => i.id === `intel-callers-${targetFile}`);
      const testsItem = allParts.find((i) => i.id === `intel-tests-${targetFile}`);

      expect(symbolsItem).toBeDefined();
      expect(callersItem).toBeDefined();
      expect(testsItem).toBeDefined();

      // Check content reflects structural code intelligence
      expect(symbolsItem!.content).toContain('ModelLifecycleService');
      expect(symbolsItem!.content).toContain('ModelLifecycleContract');
      expect(callersItem!.content).toContain('Scheduler');
      expect(testsItem!.content).toContain(testFile);

      // Verify structural relevance outranks simple textual recency (priority > 50)
      expect(symbolsItem!.priority).toBeGreaterThan(50);
      expect(callersItem!.priority).toBeGreaterThan(50);
      expect(testsItem!.priority).toBeGreaterThan(50);
    });
  });
});
