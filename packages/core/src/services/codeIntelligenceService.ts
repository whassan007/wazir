import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type {
  DiagnosticItem,
  SymbolKind,
  SymbolLocation,
  SymbolNode,
  SymbolRange,
} from '../types/codeIntelligence.js';
import { SymbolGraph } from './symbolGraph.js';

export interface LspProvider {
  sendRequest<T>(language: string, method: string, params: unknown, workspaceRoot: string): Promise<T>;
  isAvailable?(language: string): boolean;
}

export interface CodeIntelligenceOptions {
  projectRoot?: string;
  lspProvider?: LspProvider;
}

export class CodeIntelligenceService {
  readonly graph: SymbolGraph;
  private readonly projectRoot: string;
  private readonly lspProvider?: LspProvider;
  private readonly fileDiagnostics = new Map<string, DiagnosticItem[]>();
  private readonly fileContents = new Map<string, string>();

  constructor(options: CodeIntelligenceOptions = {}) {
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.lspProvider = options.lspProvider;
    this.graph = new SymbolGraph();
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Index a single source file into the SymbolGraph via TypeScript AST parsing.
   */
  async indexFile(filePath: string, content?: string): Promise<void> {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.projectRoot, filePath);

    let sourceText = content;
    if (sourceText === undefined) {
      try {
        sourceText = await fs.promises.readFile(resolvedPath, 'utf8');
      } catch {
        return;
      }
    }

    // Cache source content in memory for fast symbol lookup
    this.fileContents.set(resolvedPath, sourceText);

    // Clear previous symbols for this file
    this.graph.clearFile(resolvedPath);
    this.fileDiagnostics.delete(resolvedPath);

    const isTs = /\.[cm]?[jt]sx?$/.test(resolvedPath);
    if (!isTs) {
      // Basic fallback node for non-JS/TS files
      const relPath = path.relative(this.projectRoot, resolvedPath);
      const pkg = this.extractPackage(relPath);
      this.graph.addNode({
        id: `${resolvedPath}:file`,
        name: path.basename(resolvedPath),
        kind: 'file',
        language: path.extname(resolvedPath).slice(1) || 'unknown',
        file: resolvedPath,
        package: pkg,
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
      });
      return;
    }

    const scriptKind = resolvedPath.endsWith('.tsx')
      ? ts.ScriptKind.TSX
      : resolvedPath.endsWith('.jsx')
        ? ts.ScriptKind.JSX
        : resolvedPath.endsWith('.js')
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS;

    const sourceFile = ts.createSourceFile(
      resolvedPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    // Extract parse diagnostics
    const parseDiags = (sourceFile as any).parseDiagnostics as ts.Diagnostic[] | undefined;
    if (parseDiags && parseDiags.length > 0) {
      const diags: DiagnosticItem[] = parseDiags.map((d) => {
        const start = d.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
        const length = d.length ?? 0;
        const end = d.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(d.start + length) : start;
        return {
          file: resolvedPath,
          range: {
            start: { line: start.line + 1, character: start.character },
            end: { line: end.line + 1, character: end.character },
          },
          message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
          severity: 'error',
          code: d.code,
          source: 'typescript-parser',
        };
      });
      this.fileDiagnostics.set(resolvedPath, diags);
    }

    const relPath = path.relative(this.projectRoot, resolvedPath);
    const pkg = this.extractPackage(relPath);
    const isTestFile = /\.(test|spec)\.[cm]?[jt]sx?$/.test(resolvedPath) || relPath.includes('/tests/') || relPath.includes('/test/');

    // Traverse AST and populate symbols & relationships
    this.traverseAst(sourceFile, resolvedPath, pkg, isTestFile);
  }

  /**
   * Traverse TypeScript AST to extract symbols, classes, interfaces, functions,
   * calls, imports, exports, extends, implements, and tests.
   */
  private traverseAst(
    sourceFile: ts.SourceFile,
    filePath: string,
    pkg?: string,
    isTestFile?: boolean,
  ): void {
    const fileNodeId = `${filePath}:file`;
    this.graph.addNode({
      id: fileNodeId,
      name: path.basename(filePath),
      kind: 'file',
      language: 'typescript',
      file: filePath,
      package: pkg,
      range: {
        start: { line: 1, character: 0 },
        end: sourceFile.getLineAndCharacterOfPosition(sourceFile.text.length),
      },
    });

    const currentScope: SymbolNode[] = [];

    const getRange = (node: ts.Node): SymbolRange => {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      return {
        start: { line: start.line + 1, character: start.character },
        end: { line: end.line + 1, character: end.character },
      };
    };

    const visit = (node: ts.Node) => {
      // 1. Imports
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          const importTarget = moduleSpecifier.text;
          const targetResolved = this.resolveImportTarget(filePath, importTarget);
          
          this.graph.addEdge({
            from: filePath,
            to: targetResolved,
            type: 'IMPORTS',
            metadata: { specifier: importTarget },
          });

          if (pkg) {
            const targetPkg = importTarget.startsWith('@wazir/')
              ? `packages/${importTarget.slice('@wazir/'.length)}`
              : this.extractPackage(path.relative(this.projectRoot, targetResolved));
            if (targetPkg && targetPkg !== pkg) {
              this.graph.addEdge({
                from: pkg,
                to: targetPkg,
                type: 'DEPENDS_ON',
              });
            }
          }

          if (isTestFile) {
            this.graph.addEdge({
              from: filePath,
              to: targetResolved,
              type: 'TESTS',
            });
          }
        }
      }

      // 2. Class Declaration
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const classNodeId = `${filePath}:${className}:class`;
        const classNode: SymbolNode = {
          id: classNodeId,
          name: className,
          kind: 'class',
          language: 'typescript',
          file: filePath,
          package: pkg,
          range: getRange(node),
        };
        this.graph.addNode(classNode);
        this.graph.addEdge({ from: fileNodeId, to: classNodeId, type: 'DEFINES' });

        // Heritage clauses: extends & implements
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const type of clause.types) {
              const targetName = type.expression.getText(sourceFile);
              if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                this.graph.addEdge({
                  from: classNodeId,
                  to: targetName,
                  type: 'EXTENDS',
                });
              } else if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
                this.graph.addEdge({
                  from: classNodeId,
                  to: targetName,
                  type: 'IMPLEMENTS',
                });
              }
            }
          }
        }

        currentScope.push(classNode);
        ts.forEachChild(node, visit);
        currentScope.pop();
        return;
      }

      // 3. Interface Declaration
      if (ts.isInterfaceDeclaration(node)) {
        const interfaceName = node.name.text;
        const interfaceNodeId = `${filePath}:${interfaceName}:interface`;
        const interfaceNode: SymbolNode = {
          id: interfaceNodeId,
          name: interfaceName,
          kind: 'interface',
          language: 'typescript',
          file: filePath,
          package: pkg,
          range: getRange(node),
        };
        this.graph.addNode(interfaceNode);
        this.graph.addEdge({ from: fileNodeId, to: interfaceNodeId, type: 'DEFINES' });

        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const type of clause.types) {
              const targetName = type.expression.getText(sourceFile);
              this.graph.addEdge({
                from: interfaceNodeId,
                to: targetName,
                type: 'EXTENDS',
              });
            }
          }
        }

        currentScope.push(interfaceNode);
        ts.forEachChild(node, visit);
        currentScope.pop();
        return;
      }

      // 4. Type Alias
      if (ts.isTypeAliasDeclaration(node)) {
        const typeName = node.name.text;
        const typeNodeId = `${filePath}:${typeName}:typeAlias`;
        const typeNode: SymbolNode = {
          id: typeNodeId,
          name: typeName,
          kind: 'typeAlias',
          language: 'typescript',
          file: filePath,
          package: pkg,
          range: getRange(node),
        };
        this.graph.addNode(typeNode);
        this.graph.addEdge({ from: fileNodeId, to: typeNodeId, type: 'DEFINES' });
      }

      // 5. Function Declaration
      if (ts.isFunctionDeclaration(node) && node.name) {
        const fnName = node.name.text;
        const fnNodeId = `${filePath}:${fnName}:function`;
        const fnNode: SymbolNode = {
          id: fnNodeId,
          name: fnName,
          kind: 'function',
          language: 'typescript',
          file: filePath,
          package: pkg,
          range: getRange(node),
        };
        this.graph.addNode(fnNode);
        this.graph.addEdge({ from: fileNodeId, to: fnNodeId, type: 'DEFINES' });

        currentScope.push(fnNode);
        ts.forEachChild(node, visit);
        currentScope.pop();
        return;
      }

      // 6. Method Declaration
      if (ts.isMethodDeclaration(node) && node.name) {
        const methodName = node.name.getText(sourceFile);
        const parent = currentScope[currentScope.length - 1];
        const container = parent ? parent.name : '';
        const methodNodeId = `${filePath}:${container}.${methodName}:method`;
        const methodNode: SymbolNode = {
          id: methodNodeId,
          name: methodName,
          kind: 'method',
          language: 'typescript',
          file: filePath,
          package: pkg,
          containerName: container,
          range: getRange(node),
        };
        this.graph.addNode(methodNode);
        if (parent) {
          this.graph.addEdge({ from: parent.id, to: methodNodeId, type: 'DEFINES' });
        }

        currentScope.push(methodNode);
        ts.forEachChild(node, visit);
        currentScope.pop();
        return;
      }

      // 7. Call Expressions (CALLS edges & TESTS edges)
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        let callTarget = '';
        if (ts.isIdentifier(expr)) {
          callTarget = expr.text;
        } else if (ts.isPropertyAccessExpression(expr)) {
          callTarget = expr.getText(sourceFile);
        }

        if (callTarget) {
          const caller = currentScope[currentScope.length - 1];
          const callerId = caller ? caller.id : fileNodeId;

          this.graph.addEdge({
            from: callerId,
            to: callTarget,
            type: 'CALLS',
          });

          // Test suite runners (describe/it/test)
          if ((callTarget === 'describe' || callTarget === 'it' || callTarget === 'test') && node.arguments.length > 0) {
            const firstArg = node.arguments[0];
            if (ts.isStringLiteral(firstArg)) {
              this.graph.addEdge({
                from: fileNodeId,
                to: firstArg.text,
                type: 'TESTS',
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  private extractPackage(relativePath: string): string | undefined {
    const parts = relativePath.split(path.sep);
    if (parts[0] === 'packages' && parts.length > 1) {
      return `packages/${parts[1]}`;
    }
    if (parts[0] === 'apps' && parts.length > 1) {
      return `apps/${parts[1]}`;
    }
    return undefined;
  }

  private resolveImportTarget(sourceFile: string, specifier: string): string {
    if (specifier.startsWith('.')) {
      const dir = path.dirname(sourceFile);
      const joined = path.resolve(dir, specifier);
      const baseJoined = joined.replace(/\.[cm]?[jt]sx?$/, '');
      const candidates = [
        joined,
        baseJoined + '.ts',
        baseJoined + '.tsx',
        baseJoined + '.js',
        baseJoined + '.jsx',
        baseJoined + '/index.ts',
        baseJoined + '/index.js',
      ];
      for (const candidate of candidates) {
        if (this.fileContents.has(candidate)) return candidate;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      }
      return joined;
    }
    // Package alias resolution: @wazir/core, @wazir/shared, etc.
    if (specifier.startsWith('@wazir/')) {
      const sub = specifier.slice('@wazir/'.length);
      const pkgPath = path.resolve(this.projectRoot, 'packages', sub, 'src', 'index.ts');
      if (this.fileContents.has(pkgPath)) return pkgPath;
      if (fs.existsSync(pkgPath)) return pkgPath;
      return path.resolve(this.projectRoot, 'packages', sub);
    }
    return specifier;
  }

  /**
   * Update file incrementally after mutation.
   */
  async updateFile(filePath: string, newContent: string): Promise<void> {
    await this.indexFile(filePath, newContent);
  }

  /**
   * Remove a file and all associated nodes/edges.
   */
  async removeFile(filePath: string): Promise<void> {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.projectRoot, filePath);
    this.graph.clearFile(resolved);
    this.fileDiagnostics.delete(resolved);
    this.fileContents.delete(resolved);
  }

  /**
   * Batch index a workspace directory recursively.
   */
  async indexWorkspace(dir: string = this.projectRoot, options: { maxFiles?: number } = {}): Promise<void> {
    const maxFiles = options.maxFiles ?? 2000;
    let indexed = 0;

    const walk = async (currentDir: string) => {
      if (indexed >= maxFiles) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (indexed >= maxFiles) break;
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
          continue;
        }
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) {
          await this.indexFile(fullPath);
          indexed++;
        }
      }
    };

    await walk(dir);
  }

  /**
   * Go to definition: finds definition locations for symbol at file, line, character.
   * If LSP is available, queries LSP; falls back to AST / SymbolGraph.
   */
  async goToDefinition(file: string, line: number, character: number): Promise<SymbolLocation[]> {
    const resolvedPath = path.isAbsolute(file) ? file : path.resolve(this.projectRoot, file);

    if (this.lspProvider?.sendRequest) {
      try {
        const lang = this.detectLanguage(resolvedPath);
        const locations = await this.lspProvider.sendRequest<any[]>(
          lang,
          'textDocument/definition',
          {
            textDocument: { uri: `file://${resolvedPath}` },
            position: { line: Math.max(0, line - 1), character },
          },
          this.projectRoot,
        );
        if (locations && locations.length > 0) {
          return locations.map((loc) => ({
            file: loc.uri.replace(/^file:\/\//, ''),
            range: {
              start: { line: loc.range.start.line + 1, character: loc.range.start.character },
              end: { line: loc.range.end.line + 1, character: loc.range.end.character },
            },
          }));
        }
      } catch {
        // Fall back to AST SymbolGraph
      }
    }

    // AST / SymbolGraph fallback
    const word = await this.getWordAtPosition(resolvedPath, line, character);
    if (word) {
      const matches = this.graph.findNodesByName(word);
      if (matches.length > 0) {
        return matches.map((m) => ({ file: m.file, range: m.range, preview: m.name }));
      }
    }

    const symbol = this.getSymbolAtPosition(resolvedPath, line, character);
    if (symbol) {
      return [{ file: symbol.file, range: symbol.range, preview: symbol.name }];
    }

    return [];
  }

  /**
   * Find references to symbol at file, line, character.
   */
  async findReferences(file: string, line: number, character: number): Promise<SymbolLocation[]> {
    const resolvedPath = path.isAbsolute(file) ? file : path.resolve(this.projectRoot, file);

    if (this.lspProvider?.sendRequest) {
      try {
        const lang = this.detectLanguage(resolvedPath);
        const refs = await this.lspProvider.sendRequest<any[]>(
          lang,
          'textDocument/references',
          {
            textDocument: { uri: `file://${resolvedPath}` },
            position: { line: Math.max(0, line - 1), character },
            context: { includeDeclaration: true },
          },
          this.projectRoot,
        );
        if (refs && refs.length > 0) {
          return refs.map((loc) => ({
            file: loc.uri.replace(/^file:\/\//, ''),
            range: {
              start: { line: loc.range.start.line + 1, character: loc.range.start.character },
              end: { line: loc.range.end.line + 1, character: loc.range.end.character },
            },
          }));
        }
      } catch {
        // Fall back
      }
    }

    const word = await this.getWordAtPosition(resolvedPath, line, character);
    if (!word) return [];

    const results: SymbolLocation[] = [];
    const targetNodes = this.graph.findNodesByName(word);
    const targetIds = new Set(targetNodes.map((n) => n.id));
    targetIds.add(word);

    for (const edge of this.graph.getEdges()) {
      if ((edge.type === 'CALLS' || edge.type === 'REFERENCES' || edge.type === 'EXTENDS' || edge.type === 'IMPLEMENTS') &&
          (targetIds.has(edge.to) || edge.to.endsWith(`.${word}`))) {
        const caller = this.graph.getNode(edge.from);
        if (caller) {
          results.push({ file: caller.file, range: caller.range, preview: caller.name });
        }
      }
    }

    return results;
  }

  /**
   * Find implementations for interface / abstract symbol.
   */
  async findImplementations(file: string, line: number, character: number): Promise<SymbolLocation[]> {
    const resolvedPath = path.isAbsolute(file) ? file : path.resolve(this.projectRoot, file);
    const word = await this.getWordAtPosition(resolvedPath, line, character);
    if (!word) return [];

    const implNodes = this.graph.findImplementations(word);
    return implNodes.map((n) => ({ file: n.file, range: n.range, preview: n.name }));
  }

  /**
   * Find all callers of a symbol.
   */
  async findCallers(symbolNameOrId: string): Promise<SymbolNode[]> {
    return this.graph.findCallers(symbolNameOrId);
  }

  /**
   * Find all callees called by a symbol.
   */
  async findCallees(symbolNameOrId: string): Promise<SymbolNode[]> {
    return this.graph.findCallees(symbolNameOrId);
  }

  /**
   * Document symbols for a single file.
   */
  async documentSymbols(file: string): Promise<SymbolNode[]> {
    const resolved = path.isAbsolute(file) ? file : path.resolve(this.projectRoot, file);
    return this.graph.findNodesByFile(resolved).filter((n) => n.kind !== 'file');
  }

  /**
   * Workspace-wide symbol search by substring query.
   */
  async workspaceSymbols(query: string): Promise<SymbolNode[]> {
    const lower = query.toLowerCase();
    return this.graph.query(
      (n) => n.kind !== 'file' && n.name.toLowerCase().includes(lower),
    );
  }

  /**
   * Get diagnostics (syntax / semantic errors) for file.
   */
  async diagnostics(file: string): Promise<DiagnosticItem[]> {
    const resolved = path.isAbsolute(file) ? file : path.resolve(this.projectRoot, file);
    return this.fileDiagnostics.get(resolved) ?? [];
  }

  /**
   * Find dependencies of file or package.
   */
  async dependencies(fileOrPackage: string): Promise<string[]> {
    const resolved = path.isAbsolute(fileOrPackage)
      ? fileOrPackage
      : path.resolve(this.projectRoot, fileOrPackage);
    const result = this.graph.findDependencies(resolved);
    if (result.length > 0) return result;
    return this.graph.findDependencies(fileOrPackage);
  }

  /**
   * Find dependents of file or package.
   */
  async dependents(fileOrPackage: string): Promise<string[]> {
    const resolved = path.isAbsolute(fileOrPackage)
      ? fileOrPackage
      : path.resolve(this.projectRoot, fileOrPackage);
    const result = this.graph.findDependents(resolved);
    if (result.length > 0) return result;
    return this.graph.findDependents(fileOrPackage);
  }

  /**
   * Find tests related to a source file or symbol.
   */
  async relatedTests(filePath: string): Promise<string[]> {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.projectRoot, filePath);

    const testFiles = new Set<string>();

    // Check direct TESTS edges to this file
    for (const edge of this.graph.getInEdges(resolved, 'TESTS')) {
      testFiles.add(edge.from);
    }

    // Check TESTS edges to symbols defined in this file
    const symbolsInFile = this.graph.findNodesByFile(resolved);
    for (const sym of symbolsInFile) {
      for (const testNode of this.graph.findTests(sym.name)) {
        testFiles.add(testNode.file);
      }
    }

    // Heuristic test naming convention: foo.ts -> foo.test.ts, tests/foo.test.ts
    const basename = path.basename(filePath).replace(/\.[cm]?[jt]sx?$/, '');
    for (const node of this.graph.getNodes()) {
      if (node.kind === 'file' && (node.file.includes(`${basename}.test`) || node.file.includes(`${basename}.spec`))) {
        testFiles.add(node.file);
      }
    }

    return Array.from(testFiles);
  }

  private detectLanguage(filePath: string): string {
    if (/\.[cm]?tsx?$/.test(filePath)) return 'typescript';
    if (/\.[cm]?jsx?$/.test(filePath)) return 'javascript';
    if (filePath.endsWith('.py')) return 'python';
    if (filePath.endsWith('.go')) return 'go';
    return 'plaintext';
  }

  private getSymbolAtPosition(file: string, line: number, character: number): SymbolNode | undefined {
    const nodes = this.graph.findNodesByFile(file);
    return nodes.find((n) => {
      if (n.kind === 'file') return false;
      const { start, end } = n.range;
      if (line < start.line || line > end.line) return false;
      if (line === start.line && character < start.character) return false;
      if (line === end.line && character > end.character) return false;
      return true;
    });
  }

  private async getWordAtPosition(file: string, line: number, character: number): Promise<string | null> {
    try {
      let content = this.fileContents.get(file);
      if (!content) {
        content = await fs.promises.readFile(file, 'utf8');
      }
      const lines = content.split('\n');
      if (line < 1 || line > lines.length) return null;
      const lineText = lines[line - 1];
      if (character < 0 || character >= lineText.length) {
        const trimmed = lineText.trim();
        return trimmed.length > 0 ? trimmed.split(/\s+/)[0] : null;
      }

      let start = character;
      while (start > 0 && /[a-zA-Z0-9_$]/.test(lineText[start - 1])) {
        start--;
      }
      let end = character;
      while (end < lineText.length && /[a-zA-Z0-9_$]/.test(lineText[end])) {
        end++;
      }
      return lineText.slice(start, end) || null;
    } catch {
      return null;
    }
  }
}
