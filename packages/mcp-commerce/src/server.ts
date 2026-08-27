import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from './store.js';
import { registerReadTools } from './tools.js';

export const SERVER_NAME = 'quartermaster-ledger';
export const SERVER_VERSION = '0.1.0';

/**
 * Build the commerce MCP server.
 *
 * Kept free of transport concerns so the tests can drive it over an in-memory
 * pipe while the real process serves it over HTTP.
 */
export function createCommerceServer(store: Store): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerReadTools(server, store);
  return server;
}
