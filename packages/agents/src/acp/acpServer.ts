import { randomUUID } from 'node:crypto';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpServerSession {
  sessionId: string;
  cwd: string;
  createdAt: string;
  cancelled: boolean;
}

export interface AcpPromptHandler {
  runPrompt(params: {
    sessionId: string;
    cwd: string;
    prompt: string;
    emitUpdate: (update: Record<string, unknown>) => void;
    isCancelled: () => boolean;
  }): Promise<{ stopReason: 'end_turn' | 'cancelled' | 'max_turns' | 'error'; text?: string }>;
}

export interface A2ATaskEnvelope {
  taskId: string;
  senderAgentId: string;
  targetAgentId: string;
  objective: string;
  artifacts?: Array<{ name: string; mimeType: string; content: string }>;
  status: 'submitted' | 'working' | 'completed' | 'failed';
}

/**
 * Bidirectional Agent Client Protocol (ACP) JSON-RPC 2.0 server (`wa --acp`)
 * allowing IDEs (Zed, JetBrains) and external meta-harnesses to drive Wazir,
 * paired with A2A task envelope translation.
 */
export class WazirAcpServer {
  private readonly sessions = new Map<string, AcpServerSession>();

  constructor(
    private readonly handler: AcpPromptHandler,
    private readonly emitNotification: (method: string, params: Record<string, unknown>) => void = () => undefined,
  ) {}

  async handleMessage(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;

    try {
      switch (req.method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: 'wazir', version: '0.3.2' },
              agentCapabilities: { loadSession: true, promptCapabilities: { image: false, audio: false } },
            },
          };
        }
        case 'session/new': {
          const cwd = typeof req.params?.cwd === 'string' ? req.params.cwd : process.cwd();
          const sessionId = `acp-${randomUUID()}`;
          this.sessions.set(sessionId, {
            sessionId,
            cwd,
            createdAt: new Date().toISOString(),
            cancelled: false,
          });
          return { jsonrpc: '2.0', id, result: { sessionId } };
        }
        case 'session/cancel': {
          const sessionId = String(req.params?.sessionId ?? '');
          const session = this.sessions.get(sessionId);
          if (session) session.cancelled = true;
          return id !== null ? { jsonrpc: '2.0', id, result: { cancelled: Boolean(session) } } : null;
        }
        case 'session/prompt': {
          const sessionId = String(req.params?.sessionId ?? '');
          const session = this.sessions.get(sessionId);
          if (!session) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown sessionId: ${sessionId}` } };
          }
          session.cancelled = false;
          const promptBlocks = Array.isArray(req.params?.prompt) ? req.params.prompt : [];
          const promptText = promptBlocks
            .map((b: unknown) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : String(b)))
            .join('\n')
            .trim() || String(req.params?.text ?? '');

          const outcome = await this.handler.runPrompt({
            sessionId,
            cwd: session.cwd,
            prompt: promptText,
            emitUpdate: (update) => {
              this.emitNotification('session/update', { sessionId, update });
            },
            isCancelled: () => session.cancelled,
          });
          return { jsonrpc: '2.0', id, result: outcome };
        }
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } };
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  /**
   * Translates an A2A (Agent2Agent) task envelope into an ACP prompt turn.
   */
  async handleA2ATask(envelope: A2ATaskEnvelope, cwd = process.cwd()): Promise<A2ATaskEnvelope> {
    const sessionRes = await this.handleMessage({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd } });
    const sessionId = (sessionRes?.result as { sessionId: string }).sessionId;
    const promptRes = await this.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId, prompt: [{ type: 'text', text: envelope.objective }] },
    });
    const result = promptRes?.result as { stopReason?: string; text?: string } | undefined;
    return {
      ...envelope,
      status: result?.stopReason === 'end_turn' ? 'completed' : 'failed',
      artifacts: result?.text
        ? [...(envelope.artifacts ?? []), { name: 'response.md', mimeType: 'text/markdown', content: result.text }]
        : envelope.artifacts,
    };
  }
}
