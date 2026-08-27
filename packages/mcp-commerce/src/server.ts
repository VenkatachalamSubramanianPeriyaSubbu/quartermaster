import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Merchant } from './merchant.js';
import { MockMerchant } from './merchant.js';
import type { Store } from './store.js';
import { registerReadTools } from './tools.js';
import { registerWriteTools } from './write-tools.js';

export const SERVER_NAME = 'quartermaster-ledger';
export const SERVER_VERSION = '0.1.0';

/**
 * Build the commerce MCP server.
 *
 * Kept free of transport concerns so the tests can drive it over an in-memory
 * pipe while the real process serves it over HTTP.
 *
 * The merchant defaults to the mock. Settling against anything real has to be
 * an explicit decision at the call site, never something that happens because
 * a default was left alone.
 */
export function createCommerceServer(
  store: Store,
  merchant: Merchant = new MockMerchant(),
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerReadTools(server, store);
  registerWriteTools(server, store, merchant);
  return server;
}
