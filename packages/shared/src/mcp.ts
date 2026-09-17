export interface InitializeParams {
  protocolVersion: number;
  capabilities: Record<string, unknown>;
  clientInfo?: {
    name: string;
    version: string;
  };
}

export interface InitializeResult {
  protocolVersion: number;
  capabilities: Record<string, unknown>;
  serverInfo?: {
    name: string;
    version: string;
  };
}

export type Notification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

export type Request = {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
};

export type Response = {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export enum TextDocumentSyncKind {
  None = 0,
  Full = 1,
  Incremental = 2,
}
