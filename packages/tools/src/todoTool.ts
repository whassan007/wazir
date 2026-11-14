import type { Tool, ToolResult } from '@wazir/core';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export const todoWriteTool: Tool = {
  descriptor: {
    name: 'todo_write',
    description:
      'Maintain a lightweight in-memory task checklist for complex multi-step work (3+ steps). Skip for trivial single-file edits or direct questions.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Short stable identifier (e.g. "1")' },
              content: { type: 'string', description: 'Concise action item' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current status of this step',
              },
            },
            required: ['id', 'content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    permissions: [],
    riskLevel: 'low',
    environment: 'local',
    sideEffectClass: 'READ_ONLY',
    concurrencySafety: 'parallel',
  },
  async execute(input): Promise<ToolResult> {
    const rawTodos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : [];
    const lines = rawTodos.map((item) => {
      const marker = item.status === 'completed' ? '[x]' : item.status === 'in_progress' ? '[>]' : '[ ]';
      return `${marker} (${item.id}) ${item.content}`;
    });
    const completed = rawTodos.filter((t) => t.status === 'completed').length;
    const summary =
      lines.length > 0
        ? `Checklist updated (${completed}/${rawTodos.length} completed):\n${lines.join('\n')}`
        : 'Checklist cleared.';
    return {
      ok: true,
      output: summary,
      durationMs: 0,
      metadata: { todos: rawTodos },
    };
  },
};
