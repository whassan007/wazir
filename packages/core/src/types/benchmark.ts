export interface BenchmarkResult {
  id: string;
  modelId: string;
  runtimeId: string;
  computerId: string;
  prompt: string;
  response: string;
  ttftMs: number;
  totalMs: number;
  tokensPerSecond: number;
  inputTokens: number;
  outputTokens: number;
  ok: boolean;
  error?: string;
  testedAt: Date;
}
