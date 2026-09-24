import { createHash, randomUUID } from 'node:crypto';
import type {
  EmbeddingProvider,
  SemanticIndexUnit,
  SemanticUnitKind,
  SemanticQueryOptions,
  SemanticSearchResult,
  HybridRankingWeights,
  DiagnosticScoreBreakdown,
} from '../types/semanticIndex.js';
import type { SymbolGraph } from './symbolGraph.js';
import type { EpisodicRecord, ProceduralRecipe } from '@wazir/memory';

export interface SemanticIndexOptions {
  embeddingProvider: EmbeddingProvider;
  defaultRepositoryScope?: string;
  symbolGraph?: SymbolGraph;
  defaultWeights?: Partial<HybridRankingWeights>;
}

export class SemanticIndexService {
  private readonly provider: EmbeddingProvider;
  private readonly defaultScope: string;
  private readonly symbolGraph?: SymbolGraph;
  private readonly defaultWeights: HybridRankingWeights;

  // Primary unit store: unitId -> unit
  private readonly units = new Map<string, SemanticIndexUnit>();
  // Index maps: filePath -> Set<unitId>
  private readonly fileUnits = new Map<string, Set<string>>();
  // Track indexed content hashes: filePath -> contentHash
  private readonly fileHashes = new Map<string, string>();

  constructor(options: SemanticIndexOptions) {
    this.provider = options.embeddingProvider;
    this.defaultScope = options.defaultRepositoryScope ?? 'default';
    this.symbolGraph = options.symbolGraph;
    this.defaultWeights = {
      wAst: options.defaultWeights?.wAst ?? 0.25,
      wLexical: options.defaultWeights?.wLexical ?? 0.25,
      wEmbedding: options.defaultWeights?.wEmbedding ?? 0.30,
      wDependency: options.defaultWeights?.wDependency ?? 0.10,
      wContext: options.defaultWeights?.wContext ?? 0.10,
    };
  }

  /**
   * Adds or updates a pre-chunked semantic unit with vector embeddings.
   */
  public async indexUnit(
    unitInput: Omit<SemanticIndexUnit, 'id' | 'embedding' | 'contentHash'> & {
      id?: string;
      contentHash?: string;
    },
  ): Promise<SemanticIndexUnit> {
    const id = unitInput.id ?? `sem-${randomUUID()}`;
    const contentHash = unitInput.contentHash ?? this.hash(unitInput.content);

    // Compute embedding
    const [embedRes] = await this.provider.embed([unitInput.content]);
    const caps = this.provider.capabilities();

    const unit: SemanticIndexUnit = {
      ...unitInput,
      id,
      contentHash,
      embedding: embedRes.vector,
      embeddingModel: caps.modelName,
      embeddingVersion: '1.0',
    };

    this.units.set(id, unit);

    let set = this.fileUnits.get(unit.path);
    if (!set) {
      set = new Set();
      this.fileUnits.set(unit.path, set);
    }
    set.add(id);

    return unit;
  }

  /**
   * Incrementally indexes a source file. If the file's content hash is unchanged,
   * no embedding or indexing work is performed. If changed, previous units for this
   * file are removed and fresh structural units are extracted and embedded.
   */
  public async updateFile(
    filePath: string,
    content: string,
    workspaceRevision: number,
    repositoryScope?: string,
  ): Promise<{ updated: boolean; unitsIndexed: number }> {
    const scope = repositoryScope ?? this.defaultScope;
    const contentHash = this.hash(content);
    const existingHash = this.fileHashes.get(filePath);

    if (existingHash === contentHash) {
      return { updated: false, unitsIndexed: 0 };
    }

    // Invalidate prior units for this file
    this.deleteFile(filePath);

    // Extract structural units (functions, classes, interfaces, modules)
    const extracted = this.extractUnits(filePath, content, scope, workspaceRevision);

    if (extracted.length > 0) {
      const texts = extracted.map((u) => u.content);
      const embeddings = await this.provider.embed(texts);
      const caps = this.provider.capabilities();

      for (let i = 0; i < extracted.length; i++) {
        const u = extracted[i];
        const unit: SemanticIndexUnit = {
          ...u,
          embedding: embeddings[i].vector,
          embeddingModel: caps.modelName,
          embeddingVersion: '1.0',
        };
        this.units.set(unit.id, unit);

        let set = this.fileUnits.get(filePath);
        if (!set) {
          set = new Set();
          this.fileUnits.set(filePath, set);
        }
        set.add(unit.id);
      }
    }

    this.fileHashes.set(filePath, contentHash);
    return { updated: true, unitsIndexed: extracted.length };
  }

  /**
   * Deletes a file and all its associated semantic units from the index.
   */
  public deleteFile(filePath: string): void {
    const unitIds = this.fileUnits.get(filePath);
    if (unitIds) {
      for (const id of unitIds) {
        this.units.delete(id);
      }
      this.fileUnits.delete(filePath);
    }
    this.fileHashes.delete(filePath);
  }

  /**
   * Indexes an episodic memory record for conceptual retrieval.
   */
  public async indexEpisodicRecord(episode: EpisodicRecord): Promise<SemanticIndexUnit> {
    const textToEmbed = [
      `Task [${episode.taskType}]: ${episode.taskPrompt}`,
      episode.failurePattern ? `Failure: ${episode.failurePattern}` : '',
      episode.repairStrategy ? `Repair Strategy: ${episode.repairStrategy}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return this.indexUnit({
      id: `sem-epi-${episode.id}`,
      kind: 'episodic_summary',
      repositoryScope: episode.repositoryScope,
      path: episode.filesInvolved[0] ?? `episode/${episode.id}`,
      content: textToEmbed,
      workspaceRevision: episode.workspaceRevision,
      metadata: {
        episodeId: episode.id,
        attemptOutcome: episode.attemptOutcome,
        valid: episode.valid,
        filesInvolved: episode.filesInvolved,
      },
    });
  }

  /**
   * Indexes a verified procedural recipe for conceptual retrieval.
   */
  public async indexProceduralRecipe(recipe: ProceduralRecipe): Promise<SemanticIndexUnit> {
    const textToEmbed = [
      `Procedure [${recipe.kind}] ${recipe.name}`,
      `Trigger: ${recipe.triggerPattern}`,
      recipe.recipe.command ? `Command: ${recipe.recipe.command}` : '',
      recipe.recipe.steps ? `Steps: ${recipe.recipe.steps.join('; ')}` : '',
      recipe.recipe.workaroundNotes ? `Notes: ${recipe.recipe.workaroundNotes}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    return this.indexUnit({
      id: `sem-proc-${recipe.id}`,
      kind: 'procedural_recipe',
      repositoryScope: recipe.repositoryScope,
      path: recipe.associatedFiles[0] ?? `procedure/${recipe.id}`,
      symbolName: recipe.name,
      content: textToEmbed,
      workspaceRevision: 0,
      metadata: {
        procedureId: recipe.id,
        kind: recipe.kind,
        valid: recipe.valid,
        verifiedByEvidenceId: recipe.verifiedByEvidenceId,
        associatedFiles: recipe.associatedFiles,
      },
    });
  }

  /**
   * Performs hybrid ranking combining AST, Lexical, Vector Embedding, Dependency,
   * and Active Context signals. Exposes diagnostic score breakdowns.
   */
  public async search(options: SemanticQueryOptions): Promise<SemanticSearchResult[]> {
    const scope = options.repositoryScope;
    const weights: HybridRankingWeights = {
      wAst: options.weights?.wAst ?? this.defaultWeights.wAst,
      wLexical: options.weights?.wLexical ?? this.defaultWeights.wLexical,
      wEmbedding: options.weights?.wEmbedding ?? this.defaultWeights.wEmbedding,
      wDependency: options.weights?.wDependency ?? this.defaultWeights.wDependency,
      wContext: options.weights?.wContext ?? this.defaultWeights.wContext,
    };

    // Embed the query
    const [queryEmbed] = await this.provider.embed([options.query]);
    const qTokens = options.query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);

    let candidates = Array.from(this.units.values()).filter(
      (u) => u.repositoryScope === scope,
    );

    if (options.kinds && options.kinds.length > 0) {
      const kindSet = new Set(options.kinds);
      candidates = candidates.filter((u) => kindSet.has(u.kind));
    }

    const results: SemanticSearchResult[] = [];

    for (const unit of candidates) {
      // 1. Embedding cosine similarity
      const embeddingScore = unit.embedding
        ? this.cosineSimilarity(queryEmbed.vector, unit.embedding)
        : 0;

      // 2. Lexical similarity (token overlap / coverage)
      const lexicalScore = this.computeLexicalScore(options.query, unit, qTokens);

      // 3. Structural / AST relevance
      const astScore = this.computeAstScore(unit, options.activeSymbols);

      // 4. Dependency proximity
      const dependencyScore = this.computeDependencyScore(unit, options.activeContextFiles);

      // 5. Active context relevance
      const contextScore = this.computeContextScore(unit, options.activeContextFiles);

      // Calculate composite score
      const totalScore = Number(
        (
          weights.wEmbedding * embeddingScore +
          weights.wLexical * lexicalScore +
          weights.wAst * astScore +
          weights.wDependency * dependencyScore +
          weights.wContext * contextScore
        ).toFixed(4),
      );

      const breakdown: DiagnosticScoreBreakdown = {
        totalScore,
        astScore: Number(astScore.toFixed(4)),
        lexicalScore: Number(lexicalScore.toFixed(4)),
        embeddingScore: Number(embeddingScore.toFixed(4)),
        dependencyScore: Number(dependencyScore.toFixed(4)),
        contextScore: Number(contextScore.toFixed(4)),
      };

      const minScore = options.minScore ?? 0.1;
      if (totalScore >= minScore) {
        results.push({ unit, score: totalScore, breakdown });
      }
    }

    // Sort descending by totalScore
    results.sort((a, b) => b.score - a.score);

    const limit = options.limit ?? 10;
    return results.slice(0, limit);
  }

  public getUnitCount(): number {
    return this.units.size;
  }

  public getUnit(id: string): SemanticIndexUnit | undefined {
    return this.units.get(id);
  }

  // --- Helper Methods ---

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    return Math.max(0, Math.min(1, (sim + 1) / 2)); // normalized to 0.0 - 1.0
  }

  private computeLexicalScore(query: string, unit: SemanticIndexUnit, qTokens: string[]): number {
    if (qTokens.length === 0) return 0;
    const unitText = `${unit.symbolName ?? ''} ${unit.path} ${unit.content}`.toLowerCase();
    let matches = 0;
    for (const token of qTokens) {
      if (unitText.includes(token)) matches++;
    }
    return matches / qTokens.length;
  }

  private computeAstScore(unit: SemanticIndexUnit, activeSymbols?: string[]): number {
    if (!this.symbolGraph || !unit.symbolName) {
      return unit.symbolName ? 0.4 : 0.1;
    }
    const nodes = this.symbolGraph.findNodesByName(unit.symbolName);
    if (nodes.length === 0) return 0.2;

    if (activeSymbols && activeSymbols.length > 0) {
      for (const active of activeSymbols) {
        if (unit.symbolName === active) return 1.0;
        const callers = this.symbolGraph.findCallers(unit.symbolName);
        if (callers.some((c) => c.name === active)) return 0.8;
      }
    }
    return 0.5;
  }

  private computeDependencyScore(unit: SemanticIndexUnit, activeFiles?: string[]): number {
    if (!activeFiles || activeFiles.length === 0) return 0.2;
    for (const af of activeFiles) {
      if (af === unit.path) return 1.0;
      // Proximity: shared directory
      const dirA = af.split('/').slice(0, -1).join('/');
      const dirB = unit.path.split('/').slice(0, -1).join('/');
      if (dirA && dirA === dirB) return 0.7;
    }
    return 0.1;
  }

  private computeContextScore(unit: SemanticIndexUnit, activeFiles?: string[]): number {
    if (!activeFiles || activeFiles.length === 0) return 0.1;
    return activeFiles.includes(unit.path) ? 1.0 : 0.0;
  }

  private extractUnits(
    filePath: string,
    content: string,
    repositoryScope: string,
    workspaceRevision: number,
  ): Omit<SemanticIndexUnit, 'embedding' | 'embeddingModel' | 'embeddingVersion'>[] {
    const units: Omit<SemanticIndexUnit, 'embedding' | 'embeddingModel' | 'embeddingVersion'>[] = [];
    const lang = this.detectLanguage(filePath);

    // Module-level summary unit
    units.push({
      id: `sem-${randomUUID()}`,
      kind: 'module',
      repositoryScope,
      path: filePath,
      language: lang,
      content: `Module ${filePath}\n${content.slice(0, 1500)}`,
      contentHash: this.hash(content),
      workspaceRevision,
    });

    // Extract function / class / interface declarations
    const lines = content.split('\n');
    let currentBlock: { name: string; kind: SemanticUnitKind; startLine: number; lines: string[] } | null = null;
    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fnMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z0-9_$]+)/);
      const classMatch = line.match(/(?:export\s+)?class\s+([a-zA-Z0-9_$]+)/);
      const interfaceMatch = line.match(/(?:export\s+)?interface\s+([a-zA-Z0-9_$]+)/);

      if (!currentBlock) {
        if (fnMatch) {
          currentBlock = { name: fnMatch[1], kind: 'function', startLine: i, lines: [line] };
          braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
        } else if (classMatch) {
          currentBlock = { name: classMatch[1], kind: 'class', startLine: i, lines: [line] };
          braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
        } else if (interfaceMatch) {
          currentBlock = { name: interfaceMatch[1], kind: 'interface', startLine: i, lines: [line] };
          braceCount = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
        }
      } else {
        currentBlock.lines.push(line);
        braceCount += (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;

        if (braceCount <= 0 || currentBlock.lines.length > 100) {
          const blockContent = currentBlock.lines.join('\n');
          units.push({
            id: `sem-${randomUUID()}`,
            kind: currentBlock.kind,
            repositoryScope,
            path: filePath,
            symbolName: currentBlock.name,
            language: lang,
            content: blockContent,
            contentHash: this.hash(blockContent),
            workspaceRevision,
            metadata: { startLine: currentBlock.startLine + 1, endLine: i + 1 },
          });
          currentBlock = null;
          braceCount = 0;
        }
      }
    }

    return units;
  }

  private detectLanguage(filePath: string): string {
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript';
    if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'javascript';
    if (filePath.endsWith('.py')) return 'python';
    if (filePath.endsWith('.rs')) return 'rust';
    if (filePath.endsWith('.go')) return 'go';
    if (filePath.endsWith('.json')) return 'json';
    if (filePath.endsWith('.md')) return 'markdown';
    return 'plaintext';
  }
}
