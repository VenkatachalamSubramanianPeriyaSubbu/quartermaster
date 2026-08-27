import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { asId, type CandidateId, type ItemId, type ListId } from '@quartermaster/shared';
import { money } from '@quartermaster/domain';
import { MemoryStore } from './memory-store.js';
import { MockMerchant } from './merchant.js';
import { createCommerceServer } from './server.js';
import { TOOLS_REQUIRING_APPROVAL } from './write-tools.js';

/**
 * The money tools, driven over real MCP.
 *
 * The gate itself lives in the TrueForge agent spec, not here, so what these
 * tests can prove is the other half of the contract: that the tools are
 * annotated the way the spec's selectors expect, and that even an approved
 * call cannot overspend or double-charge.
 */

const usd = (minorUnits: number) => money(minorUnits, 'USD');
const LIST = asId<ListId>('list_1');
const SKIRT = asId<ItemId>('item_skirt');
const SKIRT_CAND = asId<CandidateId>('cand_skirt');
const KEY = 'settle-key-0001';

interface Harness {
  client: Client;
  store: MemoryStore;
  merchant: MockMerchant;
  close: () => Promise<void>;
}

async function connect(ceiling = 10_000): Promise<Harness> {
  const store = new MemoryStore();
  const merchant = new MockMerchant({ now: () => '2026-08-27T00:00:00.000Z' });
  const server = createCommerceServer(store, merchant);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  store.createList({ id: LIST, ceiling: usd(ceiling) });
  store.addItem(LIST, { id: SKIRT, description: 'skirt', quantity: 1, required: true });
  store.recordCandidate(LIST, {
    id: SKIRT_CAND,
    itemId: SKIRT,
    source: 'test',
    title: 'skirt',
    url: 'https://example.test/skirt',
    unitPrice: usd(4200),
    shipping: usd(500),
    availability: 'in_stock',
  });

  return {
    client,
    store,
    merchant,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function payloadOf(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const structured = result.structuredContent;
  if (structured === undefined) throw new Error('tool returned no structured content');
  return structured as Record<string, unknown>;
}

const validLine = {
  itemId: SKIRT,
  candidateId: SKIRT_CAND,
  quantity: 1,
  unitPriceMinorUnits: 4200,
  shippingMinorUnits: 500,
};

let h: Harness;

beforeEach(async () => {
  h = await connect();
});

afterEach(async () => {
  await h.close();
});

async function draft(orderId = 'order_1', lines = [validLine]) {
  return h.client.callTool({
    name: 'create_order_draft',
    arguments: { listId: LIST, orderId, lines },
  });
}

describe('tool surface', () => {
  it('advertises the money tools alongside the read tools', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cancel_order',
      'checkout_order',
      'create_order_draft',
      'get_budget_status',
      'get_shopping_list',
      'list_candidates',
      'record_candidate',
      'reserve_funds',
    ]);
  });

  it('marks only checkout_order as destructive', async () => {
    // TrueForge's `@destructive` selector keys off this. Exactly one tool in
    // the system spends money, and it is the only one that should match.
    const { tools } = await h.client.listTools();
    const destructive = tools
      .filter((t) => t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    expect(destructive).toEqual(['checkout_order']);
  });

  it('marks every money tool as not read-only', async () => {
    const { tools } = await h.client.listTools();
    for (const name of ['create_order_draft', 'reserve_funds', 'cancel_order', 'checkout_order']) {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('exports the exact tool names the agent spec must gate', () => {
    // Exported so the spec in PR #6 cannot drift from the tools that exist.
    expect([...TOOLS_REQUIRING_APPROVAL]).toEqual(['reserve_funds', 'checkout_order']);
  });

  it('warns in the description that checkout is irreversible', async () => {
    const { tools } = await h.client.listTools();
    expect(tools.find((t) => t.name === 'checkout_order')?.description).toContain('IRREVERSIBLE');
  });
});

describe('create_order_draft', () => {
  it('creates a draft and reports the total', async () => {
    const payload = payloadOf(await draft());
    expect(payload.order).toMatchObject({
      status: 'draft',
      total: { minorUnits: 4700, display: '$47.00' },
    });
  });

  it('returns every violation when the price is invented', async () => {
    const result = await draft('order_1', [{ ...validLine, unitPriceMinorUnits: 1000 }]);
    expect(result.isError).toBe(true);
    const payload = payloadOf(result);
    expect(payload.error).toBe('validation_failed');
    expect(JSON.stringify(payload.violations)).toContain('price_mismatch');
  });

  it('rejects an empty line array at the schema boundary', async () => {
    const result = await draft('order_1', []);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('validation error');
  });
});

describe('checkout_order', () => {
  it('settles and reports the resulting budget', async () => {
    await draft();
    const payload = payloadOf(
      await h.client.callTool({
        name: 'checkout_order',
        arguments: { listId: LIST, orderId: 'order_1', settlementKey: KEY },
      }),
    );
    expect(payload.order).toMatchObject({ status: 'settled' });
    expect(payload.idempotentReplay).toBe(false);
    expect(payload.budget).toMatchObject({
      committed: { minorUnits: 4700 },
      available: { minorUnits: 5300, display: '$53.00' },
    });
  });

  it('charges once when retried with the same key', async () => {
    await draft();
    const args = { listId: LIST, orderId: 'order_1', settlementKey: KEY };
    await h.client.callTool({ name: 'checkout_order', arguments: args });
    const second = payloadOf(await h.client.callTool({ name: 'checkout_order', arguments: args }));

    expect(second.idempotentReplay).toBe(true);
    expect(h.merchant.attempts).toHaveLength(1);
    expect(h.store.getBudget(LIST)?.committed).toEqual(usd(4700));
  });

  it('rejects a settlement key that is too short to be unique', async () => {
    await draft();
    const result = await h.client.callTool({
      name: 'checkout_order',
      arguments: { listId: LIST, orderId: 'order_1', settlementKey: 'short' },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('validation error');
    expect(h.merchant.attempts).toHaveLength(0);
  });

  it('cannot exceed the budget even when called directly', async () => {
    // The point of enforcing the ceiling in code rather than in the prompt: a
    // model that ignores every instruction still cannot get past this.
    const tight = await connect(1000);
    try {
      const result = await tight.client.callTool({
        name: 'create_order_draft',
        arguments: { listId: LIST, orderId: 'order_1', lines: [validLine] },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(payloadOf(result).violations)).toContain('exceeds_budget');
      expect(tight.merchant.attempts).toHaveLength(0);
    } finally {
      await tight.close();
    }
  });

  it('releases the hold and stays at draft when payment is declined', async () => {
    await draft();
    h.merchant.failNext({ code: 'declined', message: 'card declined' });
    const result = await h.client.callTool({
      name: 'checkout_order',
      arguments: { listId: LIST, orderId: 'order_1', settlementKey: KEY },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toBe('settlement_failed');
    expect(h.store.getBudget(LIST)?.reserved).toEqual(usd(0));
    expect(h.store.getOrder(LIST, asId('order_1'))?.status).toBe('draft');
  });
});

describe('reserve_funds and cancel_order', () => {
  it('holds and then releases the budget', async () => {
    await draft();
    const held = payloadOf(
      await h.client.callTool({
        name: 'reserve_funds',
        arguments: { listId: LIST, orderId: 'order_1' },
      }),
    );
    expect(held.order).toMatchObject({ status: 'reserved' });
    expect(held.budget).toMatchObject({ available: { minorUnits: 5300 } });

    const freed = payloadOf(
      await h.client.callTool({
        name: 'cancel_order',
        arguments: { listId: LIST, orderId: 'order_1' },
      }),
    );
    expect(freed.order).toMatchObject({ status: 'cancelled' });
    expect(freed.budget).toMatchObject({ available: { minorUnits: 10_000 } });
  });

  it('refuses to cancel a settled order', async () => {
    await draft();
    await h.client.callTool({
      name: 'checkout_order',
      arguments: { listId: LIST, orderId: 'order_1', settlementKey: KEY },
    });
    const result = await h.client.callTool({
      name: 'cancel_order',
      arguments: { listId: LIST, orderId: 'order_1' },
    });
    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toBe('invalid_state');
  });
});
