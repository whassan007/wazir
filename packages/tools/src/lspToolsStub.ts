/**
 * Stub for LSP tools — returns an empty array so the tools package compiles
 * cleanly without requiring a built language-server binary at build time.
 * The real implementation lives in packages/lsp/src/tools.ts.
 */
import type { Tool } from '@wazir/core';

export const lspTools: Tool[] = [];
