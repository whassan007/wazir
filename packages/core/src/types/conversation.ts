export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  /** Preserve provider correlation through the agent and runtime boundary. */
  toolCallId?: string;
  toolCalls?: Array<{ id?: string; name: string; arguments: unknown }>;
}
