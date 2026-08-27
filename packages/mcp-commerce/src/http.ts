import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Store } from './store.js';
import { createCommerceServer } from './server.js';

/**
 * Serve the commerce server over Streamable HTTP.
 *
 * TrueForge only supports remote MCP servers — `McpServerType` has exactly one
 * value, `"remote"`, and the manifest requires a URL. There is no stdio option,
 * so this listener is not a convenience, it is the only way the harness can
 * reach these tools.
 */

export interface HttpServerOptions {
  readonly store: Store;
  readonly port?: number;
  readonly host?: string;
  /** Path the harness connects to. Registered as the MCP server's URL. */
  readonly path?: string;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startHttpServer({
  store,
  port = 8931,
  host = '127.0.0.1',
  path = '/mcp',
}: HttpServerOptions): Promise<RunningServer> {
  const mcp = createCommerceServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });

  // The SDK declares Transport's optional callbacks as `onclose?: () => void`
  // while the interface requires `() => void`, which only conflicts under
  // exactOptionalPropertyTypes. The transport is the SDK's own implementation
  // of its own interface, so the mismatch is in their declarations rather than
  // in our usage — narrow cast rather than relaxing the compiler for the
  // whole package.
  await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);

  const http: Server = createServer((req, res) => {
    if (!req.url?.startsWith(path)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', message: `Expected ${path}` }));
      return;
    }
    // The transport owns request parsing, streaming, and session headers.
    void transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    http.listen(port, host, resolve);
  });

  const address = http.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    url: `http://${host}:${String(boundPort)}${path}`,
    port: boundPort,
    close: async () => {
      await transport.close();
      await mcp.close();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    },
  };
}
