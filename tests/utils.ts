import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

// Global test utilities

export function mockDate(date: Date): () => void {
  const originalDate = global.Date;
  
  // @ts-expect-error - we're replacing the global
  global.Date = class extends Date {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(date);
      } else {
        super(...args);
      }
    }
    
    static now() {
      return date.getTime();
    }
  };
  
  // Restore original
  return () => {
    global.Date = originalDate;
  };
}

export function mockTimers(): { restore: () => void; tick: (ms: number) => void } {
  const timers: { id: NodeJS.Timeout; delay: number; callback: (...args: any[]) => void }[] = [];
  
  // @ts-expect-error - we're replacing the global
  global.setTimeout = (callback: (...args: any[]) => void, delay?: number): NodeJS.Timeout => {
    const id = { _idleTimeout: delay } as unknown as NodeJS.Timeout;
    timers.push({ id, delay: delay ?? 0, callback });
    return id;
  };
  
  // @ts-expect-error - we're replacing the global
  global.clearTimeout = (id: NodeJS.Timeout): void => {
    const index = timers.findIndex(t => t.id === id);
    if (index !== -1) timers.splice(index, 1);
  };
  
  return {
    restore: () => {
      // @ts-expect-error
      global.setTimeout = setTimeout;
      // @ts-expect-error
      global.clearTimeout = clearTimeout;
    },
    tick: (ms: number): void => {
      const now = Date.now();
      timers.forEach(timer => {
        if (timer.delay <= ms) {
          timer.callback();
        }
      });
      timers.splice(0, timers.length);
    },
  };
}
