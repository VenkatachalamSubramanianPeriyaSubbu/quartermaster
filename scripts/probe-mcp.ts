/**
 * Inspect a running MCP server's tool surface.
 *
 *   pnpm run probe:mcp [url]
 *
 * Exists because the tool annotations are part of our contract with TrueForge —
 * `@read-only`, `@write`, and `@destructive` selectors all key off them — and
 * the unit tests only prove what the in-process server advertises. This checks
 * what a client actually sees over HTTP, which is what the harness will see.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const target = process.argv[2] ?? 'http://127.0.0.1:8931/mcp';

async function main(): Promise<void> {
  const client = new Client({ name: 'quartermaster-probe', version: '0.1.0' });

  try {
    // Same SDK/exactOptionalPropertyTypes mismatch as in packages/mcp-commerce
    // http.ts: the SDK's own transport does not satisfy its own Transport
    // interface under this compiler setting. Narrow cast at the boundary.
    const transport = new StreamableHTTPClientTransport(new URL(target));
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  } catch (error) {
    console.error(`\n  FAIL  cannot reach ${target}`);
    console.error(`        ${error instanceof Error ? error.message : String(error)}`);
    console.error('        Start it with: pnpm --filter @quartermaster/mcp-commerce start\n');
    process.exit(1);
  }

  const { tools } = await client.listTools();
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));

  console.log(`\n${target} — ${String(sorted.length)} tool(s)\n`);
  console.log(`  ${'TOOL'.padEnd(20)} ${'READ-ONLY'.padEnd(11)} DESTRUCTIVE`);
  console.log(`  ${'-'.repeat(20)} ${'-'.repeat(11)} -----------`);

  for (const tool of sorted) {
    const readOnly = tool.annotations?.readOnlyHint ?? false;
    const destructive = tool.annotations?.destructiveHint ?? false;
    console.log(`  ${tool.name.padEnd(20)} ${String(readOnly).padEnd(11)} ${String(destructive)}`);
  }

  const gated = sorted.filter((tool) => tool.annotations?.destructiveHint === true);
  console.log(
    `\n  Gate these in the agent spec: ${gated.map((tool) => tool.name).join(', ') || '(none)'}\n`,
  );

  await client.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
