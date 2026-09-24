import { createHash } from 'node:crypto';
import type {
  EmbeddingProvider,
  EmbeddingCapabilities,
  EmbeddingResult,
} from '../types/semanticIndex.js';

/**
 * Deterministic local embedding provider that creates normalized semantic vectors
 * using hashed n-gram token projections. Ideal for hermetic tests, offline operation,
 * and as an instantaneous zero-overhead fallback.
 */
export class DeterministicLocalEmbeddingProvider implements EmbeddingProvider {
  private readonly dimensions: number;
  private readonly model: string;

  constructor(options: { dimensions?: number; modelName?: string } = {}) {
    this.dimensions = options.dimensions ?? 64;
    this.model = options.modelName ?? 'wazir-local-hash-embedding-v1';
  }

  capabilities(): EmbeddingCapabilities {
    return {
      dimensions: this.dimensions,
      maxBatchSize: 100,
      modelName: this.model,
      supportsNormalizedVectors: true,
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    return texts.map((text) => ({
      text,
      vector: this.computeVector(text),
      dimensions: this.dimensions,
    }));
  }

  private computeVector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);

    if (tokens.length === 0) {
      return vector;
    }

    for (const token of tokens) {
      // 1-gram
      this.projectToken(token, 1.0, vector);
      // character 3-grams for subword matching
      if (token.length >= 3) {
        for (let i = 0; i <= token.length - 3; i++) {
          const gram = token.slice(i, i + 3);
          this.projectToken(gram, 0.4, vector);
        }
      }
    }

    // Normalize to unit length (L2 norm)
    let sumSq = 0;
    for (let i = 0; i < this.dimensions; i++) {
      sumSq += vector[i] * vector[i];
    }

    if (sumSq > 0) {
      const norm = Math.sqrt(sumSq);
      for (let i = 0; i < this.dimensions; i++) {
        vector[i] = Number((vector[i] / norm).toFixed(6));
      }
    }

    return vector;
  }

  private projectToken(token: string, weight: number, vector: number[]): void {
    const hash = createHash('sha256').update(token).digest();
    const bucket = hash.readUInt16BE(0) % this.dimensions;
    const sign = (hash[2] & 1) === 0 ? 1 : -1;
    vector[bucket] += sign * weight;
  }
}

/**
 * Ollama Embedding Provider for local LLM runtimes.
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(options: { baseUrl?: string; model?: string; dimensions?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = options.model ?? 'nomic-embed-text';
    this.dimensions = options.dimensions ?? 768;
  }

  capabilities(): EmbeddingCapabilities {
    return {
      dimensions: this.dimensions,
      maxBatchSize: 32,
      modelName: this.model,
      supportsNormalizedVectors: true,
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      const resp = await fetch(`${this.baseUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
      if (!resp.ok) {
        throw new Error(`Ollama embed failed: HTTP ${resp.status} ${resp.statusText}`);
      }
      const data = (await resp.json()) as { embedding: number[] };
      results.push({
        text,
        vector: data.embedding,
        dimensions: data.embedding.length,
      });
    }
    return results;
  }
}

/**
 * OpenAI / LM Studio compatible embedding provider.
 */
export class LMStudioEmbeddingProvider implements EmbeddingProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly dimensions: number;

  constructor(options: { baseUrl?: string; model?: string; dimensions?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:1234/v1').replace(/\/+$/, '');
    this.model = options.model ?? 'text-embedding-nomic-embed-text-v1.5';
    this.dimensions = options.dimensions ?? 768;
  }

  capabilities(): EmbeddingCapabilities {
    return {
      dimensions: this.dimensions,
      maxBatchSize: 64,
      modelName: this.model,
      supportsNormalizedVectors: true,
    };
  }

  async embed(texts: string[]): Promise<EmbeddingResult[]> {
    const resp = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!resp.ok) {
      throw new Error(`LM Studio embed failed: HTTP ${resp.status} ${resp.statusText}`);
    }
    const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((item, idx) => ({
      text: texts[idx],
      vector: item.embedding,
      dimensions: item.embedding.length,
    }));
  }
}
