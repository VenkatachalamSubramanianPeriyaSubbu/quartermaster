import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { asId, type ItemId, type ListId } from '@quartermaster/shared';
import { money } from '@quartermaster/domain';
import { MemoryStore } from './memory-store.js';
import { createCommerceServer } from './server.js';

/**
 * These tests drive the server through a real MCP `Client` over a linked
 * in-memory transport, not by calling the handler functions directly.
 *
 * That distinction matters. Going through the protocol exercises the JSON
 * schemas we generate from zod, the tool annotations TrueForge will read, and
 * the error envelope — all of which are part of the contract with the harness
 * and none of which a direct function call would touch.
 */

const usd = (minorUnits: number) => money(minorUnits, 'USD');
const LIST = asId<ListId>('list_1');
const SKIRT = asId<ItemId>('item_skirt');
const MUG = asId<ItemId>('item_mug');

interface Harness {
  client: Client;
  store: MemoryStore;
  close: () => Promise<void>;
}

async function connect(): Promise<Harness> {
  const store = new MemoryStore();
  const server = createCommerceServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    store,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Read the structured payload back off a tool result. */
function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const structured = result.structuredContent;
  if (structured === undefined) throw new Error('tool returned no structured content');
  return structured as Record<string, unknown>;
}

let harness: Harness;

beforeEach(async () => {
  harness = await connect();
  harness.store.createList({ id: LIST, ceiling: usd(10_000) });
  harness.store.addItem(LIST, {
    id: SKIRT,
    description: 'navy floral midi skirt',
    quantity: 1,
    required: true,
  });
  harness.store.addItem(LIST, { id: MUG, description: 'mug', quantity: 2, required: false });
});

afterEach(async () => {
  await harness.close();
});

describe('tool discovery', () => {
  it('advertises the four read-side tools', async () => {
    // The server also carries the money tools; those are asserted in
    // write-tools.test.ts. Here we only care that the read side is present.
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'get_budget_status',
        'get_shopping_list',
        'list_candidates',
        'record_candidate',
      ]),
    );
  });

  it('marks the genuinely read-only tools as such', async () => {
    // TrueForge's `@read-only` selector keys off these hints. Getting them
    // wrong would either hide tools from the agent or slip a writer into a set
    // the agent was told was safe.
    const { tools } = await harness.client.listTools();
    const readOnly = tools
      .filter((tool) => tool.annotations?.readOnlyHint === true)
      .map((tool) => tool.name)
      .sort();
    expect(readOnly).toEqual(['get_budget_status', 'get_shopping_list', 'list_candidates']);
  });

  it('does not mark record_candidate read-only, because it writes', async () => {
    const { tools } = await harness.client.listTools();
    const record = tools.find((tool) => tool.name === 'record_candidate');
    expect(record?.annotations?.readOnlyHint).toBe(false);
    expect(record?.annotations?.destructiveHint).toBe(false);
  });

  it('publishes an input schema for every tool', async () => {
    const { tools } = await harness.client.listTools();
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.description ?? '').not.toBe('');
    }
  });
});

describe('get_shopping_list', () => {
  it('returns the list with its items', async () => {
    const payload = payloadOf(
      await harness.client.callTool({ name: 'get_shopping_list', arguments: { listId: LIST } }),
    );
    expect(payload.id).toBe(LIST);
    expect(payload.currency).toBe('USD');
    expect(payload.items).toHaveLength(2);
  });

  it('reports a missing list as an error, not as an empty success', async () => {
    // If isError were omitted the model would read this as a list that exists
    // and happens to be empty, and carry on shopping for nothing.
    const result = await harness.client.callTool({
      name: 'get_shopping_list',
      arguments: { listId: 'does_not_exist' },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toBe('list_not_found');
  });
});

describe('get_budget_status', () => {
  it('returns every figure, including the derived ones', async () => {
    const payload = payloadOf(
      await harness.client.callTool({ name: 'get_budget_status', arguments: { listId: LIST } }),
    );
    expect(payload.ceiling).toMatchObject({ minorUnits: 10_000, display: '$100.00' });
    expect(payload.available).toMatchObject({ minorUnits: 10_000, display: '$100.00' });
    expect(payload.encumbered).toMatchObject({ minorUnits: 0 });
  });

  it('sends money as minor units and a display string together', async () => {
    // Given only the integer a model will report "$10000"; given only the
    // string it will try decimal arithmetic on it. Sending both removes the
    // need for it to convert at all.
    const payload = payloadOf(
      await harness.client.callTool({ name: 'get_budget_status', arguments: { listId: LIST } }),
    );
    expect(payload.ceiling).toEqual({
      minorUnits: 10_000,
      currency: 'USD',
      display: '$100.00',
    });
  });
});

describe('record_candidate', () => {
  const validArgs = {
    listId: LIST,
    candidateId: 'cand_a',
    itemId: SKIRT,
    source: 'bright-data:serp',
    title: 'Navy Floral Midi Skirt',
    url: 'https://example.test/skirt',
    unitPriceMinorUnits: 4200,
    shippingMinorUnits: 500,
    availability: 'in_stock',
  };

  it('records a candidate and echoes it back', async () => {
    const payload = payloadOf(
      await harness.client.callTool({ name: 'record_candidate', arguments: validArgs }),
    );
    expect(payload.recorded).toMatchObject({
      id: 'cand_a',
      unitPrice: { minorUnits: 4200, display: '$42.00' },
    });
    expect(harness.store.listCandidates(LIST)).toHaveLength(1);
  });

  it('rejects a candidate for an item not on the list', async () => {
    const result = await harness.client.callTool({
      name: 'record_candidate',
      arguments: { ...validArgs, itemId: 'item_ghost' },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toBe('item_not_found');
  });

  it('rejects a duplicate candidate id', async () => {
    await harness.client.callTool({ name: 'record_candidate', arguments: validArgs });
    const result = await harness.client.callTool({
      name: 'record_candidate',
      arguments: validArgs,
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toBe('duplicate_candidate');
  });

  /**
   * Schema violations come back as `isError: true` results rather than as
   * protocol-level rejections. That is the better shape for our purposes: the
   * model receives a readable explanation and can correct itself on the next
   * turn instead of the turn failing outright.
   */
  it.each([
    ['a fractional price', { unitPriceMinorUnits: 42.5 }],
    ['a negative price', { unitPriceMinorUnits: -1 }],
    ['a fractional shipping cost', { shippingMinorUnits: 0.5 }],
    ['an availability value outside the enum', { availability: 'probably_in_stock' }],
    ['a malformed url', { url: 'not a url' }],
    ['an empty title', { title: '' }],
  ])('rejects %s at the schema boundary', async (_label, override) => {
    const result = await harness.client.callTool({
      name: 'record_candidate',
      arguments: { ...validArgs, ...override },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('validation error');
    // Nothing may be written when validation fails.
    expect(harness.store.listCandidates(LIST)).toHaveLength(0);
  });
});

describe('list_candidates', () => {
  beforeEach(async () => {
    const base = {
      listId: LIST,
      source: 'test',
      url: 'https://example.test/x',
      shippingMinorUnits: 0,
      availability: 'in_stock',
    };
    await harness.client.callTool({
      name: 'record_candidate',
      arguments: {
        ...base,
        candidateId: 'c1',
        itemId: SKIRT,
        title: 'a',
        unitPriceMinorUnits: 4200,
      },
    });
    await harness.client.callTool({
      name: 'record_candidate',
      arguments: {
        ...base,
        candidateId: 'c2',
        itemId: SKIRT,
        title: 'b',
        unitPriceMinorUnits: 3900,
      },
    });
    await harness.client.callTool({
      name: 'record_candidate',
      arguments: { ...base, candidateId: 'c3', itemId: MUG, title: 'c', unitPriceMinorUnits: 1200 },
    });
  });

  it('returns everything recorded for the list', async () => {
    const payload = payloadOf(
      await harness.client.callTool({ name: 'list_candidates', arguments: { listId: LIST } }),
    );
    expect(payload.count).toBe(3);
  });

  it('narrows to a single item when asked', async () => {
    const payload = payloadOf(
      await harness.client.callTool({
        name: 'list_candidates',
        arguments: { listId: LIST, itemId: SKIRT },
      }),
    );
    expect(payload.count).toBe(2);
  });

  it('returns an empty result for an item with no candidates', async () => {
    harness.store.addItem(LIST, {
      id: asId<ItemId>('item_lamp'),
      description: 'lamp',
      quantity: 1,
      required: false,
    });
    const payload = payloadOf(
      await harness.client.callTool({
        name: 'list_candidates',
        arguments: { listId: LIST, itemId: 'item_lamp' },
      }),
    );
    expect(payload.count).toBe(0);
  });
});
