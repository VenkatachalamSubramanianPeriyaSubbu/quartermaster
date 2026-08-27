import { SqliteStore } from './sqlite-store.js';
import { startHttpServer } from './http.js';

/**
 * Entry point for the commerce MCP server.
 *
 * Register the printed URL with TrueForge as a remote MCP server, then attach
 * it to the agent spec by name. See docs/runbook.md.
 */

const port = Number(process.env.MCP_COMMERCE_PORT ?? '8931');
const dbPath = process.env.MCP_COMMERCE_DB ?? './data/commerce.sqlite';

const store = new SqliteStore(dbPath);
const server = await startHttpServer({ store, port });

console.log(`quartermaster-ledger listening on ${server.url}`);
console.log(`store: ${dbPath}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => {
      store.close();
      process.exit(0);
    });
  });
}
