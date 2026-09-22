/** Official SDK transports; never interpret protocol frames in Wazir. */
import { StreamableHTTPClientTransport, type Transport, type StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
export type MCPTransport = Transport;
export function createStdioTransport(options: { command: string; args?: string[]; env?: Record<string, string> }): MCPTransport {
  return new StdioClientTransport({ ...options, env: { ...getDefaultEnvironment(), ...options.env }, stderr: 'ignore', maxBufferSize: 4 * 1024 * 1024 });
}
export function createHTTPTransport(options: { url: string; headers?: Record<string, string>; authProvider?: StreamableHTTPClientTransportOptions['authProvider'] }): MCPTransport {
  return new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: options.headers, redirect: 'error' }, authProvider: options.authProvider,
    reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 500, maxReconnectionDelay: 5000, reconnectionDelayGrowFactor: 2 },
  });
}
