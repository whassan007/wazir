import type {
  ContextCandidate,
  ContextProvider,
  ContextRequest,
} from '../types/context.js';
import { estimateTokens } from './contextCompiler.js';
import type { CodeIntelligenceService } from './codeIntelligenceService.js';

export class CodeIntelligenceContextProvider implements ContextProvider {
  readonly id = 'code_intelligence';
  private readonly codeIntelligence: CodeIntelligenceService;

  constructor(codeIntelligence: CodeIntelligenceService) {
    this.codeIntelligence = codeIntelligence;
  }

  async provide(request: ContextRequest): Promise<ContextCandidate[]> {
    const candidates: ContextCandidate[] = [];
    const activeFiles = request.activeFiles ?? [];
    if (activeFiles.length === 0) {
      return candidates;
    }

    for (const file of activeFiles) {
      // 1. Diagnostics for active file
      const diags = await this.codeIntelligence.diagnostics(file);
      if (diags.length > 0) {
        const diagContent = `Code Intelligence Diagnostics (${file}):\n` +
          diags.map((d) => `  [${d.severity.toUpperCase()}] Line ${d.range.start.line}: ${d.message}`).join('\n');
        candidates.push({
          id: `intel-diag-${file}`,
          source: this.id,
          kind: 'task',
          category: 'ACTIVE',
          label: `Diagnostics: ${file}`,
          content: diagContent,
          priority: 89,
          estimatedTokens: estimateTokens(diagContent),
          sourceUri: `${file}#diagnostics`,
          reasonIncluded: 'Structural diagnostics detected on active file',
        });
      }

      // 2. Document symbols (definitions, interfaces, types)
      const symbols = await this.codeIntelligence.documentSymbols(file);
      if (symbols.length > 0) {
        const symLines = symbols.map((s) => {
          const kindStr = s.kind.toUpperCase();
          const container = s.containerName ? `${s.containerName}.` : '';
          return `  - ${kindStr} ${container}${s.name} (Line ${s.range.start.line}-${s.range.end.line})`;
        });
        const symContent = `Structural Symbols & Definitions (${file}):\n` + symLines.join('\n');
        candidates.push({
          id: `intel-symbols-${file}`,
          source: this.id,
          kind: 'repository',
          category: 'ACTIVE',
          label: `Symbols: ${file}`,
          content: symContent,
          priority: 83,
          estimatedTokens: estimateTokens(symContent),
          sourceUri: `${file}#symbols`,
          reasonIncluded: 'Structural symbols and definitions for modified file',
        });

        // 3. Find callers of symbols in file (classes, methods, functions)
        const querySymbols = symbols.filter((s) => s.kind === 'class' || s.kind === 'function' || s.kind === 'method' || s.kind === 'interface');
        const callerLines: string[] = [];
        for (const topSym of querySymbols) {
          const callers = await this.codeIntelligence.findCallers(topSym.name);
          if (callers.length > 0) {
            callerLines.push(`  Callers of ${topSym.name}:`);
            for (const caller of callers.slice(0, 5)) {
              const container = caller.containerName ? `${caller.containerName}.` : '';
              callerLines.push(`    <- ${container}${caller.name} in ${caller.file} (Line ${caller.range.start.line})`);
            }
          }
        }
        if (callerLines.length > 0) {
          const callerContent = `Code Intelligence Callers (${file}):\n` + callerLines.join('\n');
          candidates.push({
            id: `intel-callers-${file}`,
            source: this.id,
            kind: 'repository',
            category: 'RELEVANT',
            label: `Callers: ${file}`,
            content: callerContent,
            priority: 81,
            estimatedTokens: estimateTokens(callerContent),
            sourceUri: `${file}#callers`,
            reasonIncluded: 'Callers and dependents of active symbols',
          });
        }
      }

      // 4. Related tests
      const tests = await this.codeIntelligence.relatedTests(file);
      if (tests.length > 0) {
        const testContent = `Related Tests (${file}):\n` +
          tests.map((t) => `  - ${t}`).join('\n');
        candidates.push({
          id: `intel-tests-${file}`,
          source: this.id,
          kind: 'repository',
          category: 'RELEVANT',
          label: `Related Tests: ${file}`,
          content: testContent,
          priority: 82,
          estimatedTokens: estimateTokens(testContent),
          sourceUri: `${file}#tests`,
          reasonIncluded: 'Test suites verifying active file or its symbols',
        });
      }
    }

    return candidates;
  }
}
