import { randomBytes } from 'node:crypto';

/**
 * Unpredictable identifier: 128 bits from the CSPRNG. `requestId`s and
 * `executionId`s double as the only handle on a dispatched task's status and
 * result routes, so they must not be enumerable from a timestamp plus
 * `Math.random()` (security review F-17).
 */
export function generateId(prefix: string = ''): string {
  return `${prefix}${randomBytes(16).toString('hex')}`;
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function calculateDurationMs(start: Date, end: Date): number {
  return end.getTime() - start.getTime();
}

/**
 * Calculate tokens per second from output tokens and duration in milliseconds.
 * Returns 0 if duration is 0 to avoid division by zero.
 */
export function tokensPerSecond(outputTokens: number, durationMs: number): number {
  if (durationMs === 0) return 0;
  const seconds = durationMs / 1000;
  return outputTokens / seconds;
}
