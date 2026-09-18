import type { ChildProcess } from 'node:child_process';
import type {
  InitializeParams,
  InitializeResult,
  Notification,
  Request,
  Response,
} from '@wazir/shared';

export interface MCPTransport {
  open(): Promise<void>;
  close(): Promise<void>;
  send(request: Request): Promise<void>;
  receive(): Promise<Notification | Response | null>;
}

export interface MCPOptions {
  transport: MCPTransport;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 30_000;

export class MCPClient {
  private readonly transport: MCPTransport;
  private readonly timeoutMs: number;
  private initialized = false;
  private capabilities: InitializeResult['capabilities'] = {};

  constructor(options: MCPOptions) {
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  }

  async initialize(params?: Partial<InitializeParams>): Promise<InitializeResult> {
    const request: Request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'wazir',
          version: '0.2.0',
        },
        ...params,
      },
    };

    await this.transport.send(request);
    const response = await this.waitForResponse();

    if (!response || !('result' in response)) {
      throw new Error('Failed to initialize MCP client');
    }

    this.initialized = true;
    this.capabilities = (response.result as InitializeResult).capabilities;

    return response.result as InitializeResult;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const notification: Notification = {
      jsonrpc: '2.0',
      method,
      params: params as any,
    };
    await this.transport.send(notification as Request);
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.initialized) {
      throw new Error('MCP client not initialized');
    }

    const id = Date.now();
    const request: Request = {
      jsonrpc: '2.0',
      id,
      method,
      params: params as any,
    };

    await this.transport.send(request);
    const response = await this.waitForResponse();

    if (!response) {
      throw new Error(`Request ${method} timed out`);
    }

    if ('error' in response) {
      throw new Error(`MCP error: ${(response.error as any).message}`);
    }

    return response.result as T;
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    if (!this.capabilities.tools) {
      throw new Error('MCP server does not support tools');
    }
    return this.request<Array<{ name: string; description?: string; inputSchema?: unknown }>>('tools/list');
  }

  async callTool(name: string, arguments_?: Record<string, unknown>): Promise<unknown> {
    if (!this.capabilities.tools) {
      throw new Error('MCP server does not support tools');
    }
    return this.request<Record<string, unknown>>('tools/call', { name, arguments: arguments_ });
  }

  async close(): Promise<void> {
    await this.transport.close();
    this.initialized = false;
  }

  getCapabilities(): InitializeResult['capabilities'] {
    return this.capabilities;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private async waitForResponse(): Promise<Response | null> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs);
    });

    try {
      const response = await Promise.race([this.transport.receive(), timeoutPromise]);
      return (response as Response | null) ?? null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class StdioTransport implements MCPTransport {
  private process: import('node:child_process').ChildProcess | null = null;

  constructor(private readonly options: StdioTransportOptions) {}

  async open(): Promise<void> {
    const { spawn } = await import('node:child_process');
    this.process = spawn(this.options.command, this.options.args ?? [], {
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const processRef = this.process as ChildProcess;
    void processRef.stdout?.on('data', () => {
      // Handle stdout
    });

    void processRef.stderr?.on('data', () => {
      // Handle stderr
    });
  }

  async close(): Promise<void> {
    if (this.process) {
      this.process.kill();
      void this.process;
    }
  }

  async send(_request: import('@wazir/shared').Request): Promise<void> {
    if (!this.process) {
      throw new Error('Transport not open');
    }
    // In a real implementation, we'd serialize and write to stdin
  }

  async receive(): Promise<import('@wazir/shared').Notification | import('@wazir/shared').Response | null> {
    if (!this.process) {
      return null;
    }
    // In a real implementation, we'd read from stdout
    return null;
  }
}

export interface HTTPTransportOptions {
  url: string;
  headers?: Record<string, string>;
}

export class HTTPTransport implements MCPTransport {
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(options: HTTPTransportOptions) {
    this.url = options.url;
    this.headers = options.headers ?? {};
  }

  async open(): Promise<void> {
    // No-op for HTTP
  }

  async close(): Promise<void> {
    // No-op for HTTP
  }

  async send(request: import('@wazir/shared').Request): Promise<void> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  async receive(): Promise<import('@wazir/shared').Notification | import('@wazir/shared').Response | null> {
    // HTTP transport doesn't support push notifications
    return null;
  }
}

export function createStdioTransport(options: StdioTransportOptions): MCPTransport {
  return new StdioTransport(options);
}

export function createHTTPTransport(options: HTTPTransportOptions): MCPTransport {
  return new HTTPTransport(options);
}
