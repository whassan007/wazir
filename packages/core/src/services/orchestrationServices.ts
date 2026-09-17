import type { JobMessage, JobArtifact } from '../types/index.js';
import { generateId } from '../types/utils.js';

export interface MessageRouterOptions {
  maxQueueSize?: number;
  persist?: (message: JobMessage) => void | Promise<void>;
}

export class MessageRouter {
  private readonly queues = new Map<string, JobMessage[]>();
  private readonly persist?: (message: JobMessage) => void | Promise<void>;
  private readonly maxQueueSize: number;

  constructor(options: MessageRouterOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 1000;
    this.persist = options.persist;
  }

  create(params: {
    jobId: string;
    taskId?: string;
    fromAgent?: string;
    toAgent?: string;
    type: JobMessage['type'];
    payload: unknown;
    artifactReferences?: string[];
    priority?: JobMessage['priority'];
  }): JobMessage {
    const message: JobMessage = {
      id: generateId('msg-'),
      jobId: params.jobId,
      taskId: params.taskId,
      fromAgent: params.fromAgent,
      toAgent: params.toAgent,
      type: params.type,
      payload: params.payload,
      artifactReferences: params.artifactReferences,
      priority: params.priority ?? 'normal',
      timestamp: new Date(),
    };

    this.enqueue(message);
    void this.persist?.(message);
    return message;
  }

  send(message: JobMessage): void {
    this.enqueue(message);
    void this.persist?.(message);
  }

  enqueue(message: JobMessage): void {
    const queue = this.getQueue(message.jobId);
    if (queue.length >= this.maxQueueSize) {
      queue.shift();
    }
    queue.push(message);
  }

  dequeue(jobId: string, toAgent?: string): JobMessage | undefined {
    const queue = this.queues.get(jobId);
    if (!queue || queue.length === 0) {
      return undefined;
    }

    let message: JobMessage | undefined;

    if (toAgent) {
      message = queue.find((m) => m.toAgent === toAgent);
    } else {
      const sorted = [...queue].sort(
        (a, b) =>
          this.priorityWeight(b.priority) - this.priorityWeight(a.priority),
      );
      message = sorted[0];
    }

    if (message) {
      const index = queue.indexOf(message);
      queue.splice(index, 1);
    }

    return message;
  }

  peek(jobId: string, toAgent?: string): JobMessage | undefined {
    const queue = this.queues.get(jobId);
    if (!queue || queue.length === 0) {
      return undefined;
    }

    let message: JobMessage | undefined;

    if (toAgent) {
      message = queue.find((m) => m.toAgent === toAgent);
    } else {
      const sorted = [...queue].sort(
        (a, b) =>
          this.priorityWeight(b.priority) - this.priorityWeight(a.priority),
      );
      message = sorted[0];
    }

    return message;
  }

  list(jobId: string): JobMessage[] {
    return [...(this.queues.get(jobId) ?? [])];
  }

  clear(jobId: string): void {
    this.queues.delete(jobId);
  }

  getQueueSize(jobId: string): number {
    return this.queues.get(jobId)?.length ?? 0;
  }

  hasMessages(jobId: string, toAgent?: string): boolean {
    const queue = this.queues.get(jobId);
    if (!queue || queue.length === 0) {
      return false;
    }
    if (toAgent) {
      return queue.some((m) => m.toAgent === toAgent);
    }
    return queue.length > 0;
  }

  async flush(jobId: string): Promise<void> {
    const queue = this.queues.get(jobId);
    if (!queue || queue.length === 0) {
      return;
    }

    for (const message of [...queue]) {
      await this.persist?.(message);
    }
  }

  private getQueue(jobId: string): JobMessage[] {
    let queue = this.queues.get(jobId);
    if (!queue) {
      queue = [];
      this.queues.set(jobId, queue);
    }
    return queue;
  }

  private priorityWeight(priority: JobMessage['priority']): number {
    switch (priority) {
      case 'critical':
        return 4;
      case 'high':
        return 3;
      case 'normal':
        return 2;
      case 'low':
        return 1;
      default:
        return 0;
    }
  }
}

export interface ArtifactStoreOptions {
  basePath?: string;
  persist?: (artifact: JobArtifact) => void | Promise<void>;
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, JobArtifact>();
  private readonly persist?: (artifact: JobArtifact) => void | Promise<void>;

  constructor(options: ArtifactStoreOptions = {}) {
    this.persist = options.persist;
  }

  create(params: {
    jobId: string;
    taskId?: string;
    name: string;
    path: string;
    type: JobArtifact['type'];
    content: unknown;
    metadata?: Record<string, unknown>;
  }): JobArtifact {
    const sizeBytes =
      typeof params.content === 'string'
        ? new TextEncoder().encode(params.content).length
        : JSON.stringify(params.content).length;

    const artifact: JobArtifact = {
      id: generateId('artifact-'),
      jobId: params.jobId,
      taskId: params.taskId,
      name: params.name,
      path: params.path,
      type: params.type,
      sizeBytes,
      mimeType: this.getMimeType(params.type),
      metadata: {
        ...(params.metadata ?? {}),
        createdAt: new Date().toISOString(),
      },
      createdAt: new Date(),
    };

    this.artifacts.set(artifact.id, artifact);
    void this.persist?.(artifact);
    return artifact;
  }

  get(id: string): JobArtifact | undefined {
    return this.artifacts.get(id);
  }

  listByJob(jobId: string): JobArtifact[] {
    const all = Array.from(this.artifacts.values());
    return all.filter((a) => a.jobId === jobId).sort(
      (a, b) =>
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async loadContent(artifact: JobArtifact): Promise<unknown> {
    if (artifact.type === 'json') {
      try {
        const content = await import('node:fs').then((fs) =>
          fs.promises.readFile(artifact.path, 'utf-8'),
        );
        return JSON.parse(content);
      } catch {
        return null;
      }
    } else if (artifact.type === 'markdown' || artifact.type === 'text') {
      try {
        const content = await import('node:fs').then((fs) =>
          fs.promises.readFile(artifact.path, 'utf-8'),
        );
        return content;
      } catch {
        return '';
      }
    }
    return null;
  }

  private getMimeType(type: JobArtifact['type']): string {
    switch (type) {
      case 'json':
        return 'application/json';
      case 'markdown':
        return 'text/markdown';
      case 'diff':
        return 'text/x-diff';
      case 'binary':
        return 'application/octet-stream';
      default:
        return 'text/plain';
    }
  }

  list(): JobArtifact[] {
    return Array.from(this.artifacts.values());
  }
}

export function createMessageRouter(options: MessageRouterOptions = {}): MessageRouter {
  return new MessageRouter(options);
}

export function createArtifactStore(options: ArtifactStoreOptions = {}): ArtifactStore {
  return new ArtifactStore(options);
}
