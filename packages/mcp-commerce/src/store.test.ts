import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  asId,
  unwrap,
  type CandidateId,
  type ItemId,
  type ListId,
  type OrderId,
} from '@quartermaster/shared';
import { availableOf, createBudget, money, reserve } from '@quartermaster/domain';
import { MemoryStore } from './memory-store.js';
import { SqliteStore } from './sqlite-store.js';
import { StoreError, type Store, type StoredOrder } from './store.js';
import type { Budget, Candidate, Item, OrderLine } from '@quartermaster/domain';

/** Narrow away the undefined a lookup can return, failing loudly if absent. */
function unwrapBudget(budget: Budget | undefined): Budget {
  if (budget === undefined) throw new Error('expected the list to have a budget');
  return budget;
}

/**
 * One conformance suite, run against every implementation.
 *
 * The in-memory store is what the tool tests use and the SQLite store is what
 * actually ships, so "it worked in tests" is only meaningful if the two behave
 * identically. Running the same assertions against both is what makes that
 * true rather than hoped for.
 */

const usd = (minorUnits: number) => money(minorUnits, 'USD');
const LIST = asId<ListId>('list_1');
const SKIRT = asId<ItemId>('item_skirt');
const MUG = asId<ItemId>('item_mug');

const skirtItem: Item = { id: SKIRT, description: 'navy skirt', quantity: 1, required: true };
const mugItem: Item = { id: MUG, description: 'mug', quantity: 2, required: false };

function candidateFor(id: string, itemId: ItemId, price: number): Candidate {
  return {
    id: asId<CandidateId>(id),
    itemId,
    source: 'bright-data:serp',
    title: id,
    url: `https://example.test/${id}`,
    unitPrice: usd(price),
    shipping: usd(0),
    availability: 'in_stock',
  };
}

const implementations: { name: string; create: () => Store & { close?: () => void } }[] = [
  { name: 'MemoryStore', create: () => new MemoryStore() },
  { name: 'SqliteStore', create: () => new SqliteStore(':memory:') },
];

describe.each(implementations)('$name', ({ create }) => {
  let store: Store & { close?: () => void };
  const open = (): Store => {
    store = create();
    return store;
  };

  afterEach(() => {
    store.close?.();
  });

  describe('lists', () => {
    it('creates a list and reads it back', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      const list = s.getList(LIST);
      expect(list?.id).toBe(LIST);
      expect(list?.currency).toBe('USD');
      expect(list?.items).toEqual([]);
    });

    it('derives the list currency from the budget ceiling', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: money(5000, 'GBP') });
      expect(s.getList(LIST)?.currency).toBe('GBP');
    });

    it('returns undefined for a list that does not exist', () => {
      expect(open().getList(asId<ListId>('nope'))).toBeUndefined();
    });

    it('rejects a duplicate list', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      expect(() => s.createList({ id: LIST, ceiling: usd(500) })).toThrow(StoreError);
    });
  });

  describe('items', () => {
    it('preserves insertion order', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      s.addItem(LIST, skirtItem);
      s.addItem(LIST, mugItem);
      expect(s.getList(LIST)?.items.map((item) => item.id)).toEqual([SKIRT, MUG]);
    });

    it('round-trips every field, including an absent price cap', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      s.addItem(LIST, skirtItem);
      const stored = s.getList(LIST)?.items[0];
      expect(stored).toEqual(skirtItem);
      // exactOptionalPropertyTypes: the key must be absent, not set to undefined.
      expect(stored !== undefined && 'maxUnitPrice' in stored).toBe(false);
    });

    it('round-trips a price cap when present', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      s.addItem(LIST, { ...skirtItem, maxUnitPrice: usd(3000) });
      expect(s.getList(LIST)?.items[0]?.maxUnitPrice).toEqual(usd(3000));
    });

    it('rejects an item on a list that does not exist', () => {
      expect(() => open().addItem(LIST, skirtItem)).toThrow(StoreError);
    });

    it('rejects a duplicate item', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      s.addItem(LIST, skirtItem);
      expect(() => s.addItem(LIST, skirtItem)).toThrow(StoreError);
    });

    it('rejects a price cap in the wrong currency', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      expect(() => s.addItem(LIST, { ...skirtItem, maxUnitPrice: money(100, 'EUR') })).toThrow(
        StoreError,
      );
    });
  });

  describe('budget', () => {
    it('starts at the ceiling with nothing spent or held', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      const budget = unwrapBudget(s.getBudget(LIST));
      expect(budget).toEqual(createBudget(usd(10_000)));
      expect(availableOf(budget)).toEqual(usd(10_000));
    });

    it('persists a reservation', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      const held = unwrap(reserve(unwrapBudget(s.getBudget(LIST)), usd(2500)));
      s.putBudget(LIST, held);
      expect(availableOf(unwrapBudget(s.getBudget(LIST)))).toEqual(usd(7500));
    });

    it('rejects a budget in the wrong currency', () => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      expect(() => {
        s.putBudget(LIST, createBudget(money(100, 'EUR')));
      }).toThrow(StoreError);
    });
  });

  describe('candidates', () => {
    const seeded = (): Store => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      s.addItem(LIST, skirtItem);
      s.addItem(LIST, mugItem);
      return s;
    };

    it('records and reads back a candidate', () => {
      const s = seeded();
      s.recordCandidate(LIST, candidateFor('cand_a', SKIRT, 4200));
      expect(s.getCandidate(LIST, asId<CandidateId>('cand_a'))).toEqual(
        candidateFor('cand_a', SKIRT, 4200),
      );
    });

    it('filters by item', () => {
      const s = seeded();
      s.recordCandidate(LIST, candidateFor('cand_a', SKIRT, 4200));
      s.recordCandidate(LIST, candidateFor('cand_b', SKIRT, 3900));
      s.recordCandidate(LIST, candidateFor('cand_c', MUG, 1200));
      expect(s.listCandidates(LIST, SKIRT).map((c) => c.id)).toEqual(['cand_a', 'cand_b']);
      expect(s.listCandidates(LIST)).toHaveLength(3);
    });

    it('preserves the order candidates were recorded in', () => {
      const s = seeded();
      s.recordCandidate(LIST, candidateFor('cand_c', SKIRT, 100));
      s.recordCandidate(LIST, candidateFor('cand_a', SKIRT, 200));
      s.recordCandidate(LIST, candidateFor('cand_b', SKIRT, 300));
      expect(s.listCandidates(LIST).map((c) => c.id)).toEqual(['cand_c', 'cand_a', 'cand_b']);
    });

    it('refuses a candidate for an item not on the list', () => {
      const s = seeded();
      expect(() =>
        s.recordCandidate(LIST, candidateFor('cand_x', asId<ItemId>('item_ghost'), 100)),
      ).toThrow(StoreError);
    });

    it('refuses a duplicate candidate id', () => {
      const s = seeded();
      s.recordCandidate(LIST, candidateFor('cand_a', SKIRT, 4200));
      expect(() => s.recordCandidate(LIST, candidateFor('cand_a', SKIRT, 9999))).toThrow(
        StoreError,
      );
    });

    it('refuses a candidate priced in the wrong currency', () => {
      const s = seeded();
      const wrong = { ...candidateFor('cand_x', SKIRT, 100), unitPrice: money(100, 'EUR') };
      expect(() => s.recordCandidate(LIST, wrong)).toThrow(StoreError);
    });

    it('returns an empty list rather than throwing when nothing is recorded', () => {
      expect(seeded().listCandidates(LIST)).toEqual([]);
    });
  });

  describe('orders', () => {
    const ORDER = asId<OrderId>('order_1');

    const line: OrderLine = {
      itemId: SKIRT,
      candidateId: asId<CandidateId>('cand_a'),
      quantity: 1,
      unitPrice: usd(4200),
      shipping: usd(500),
    };

    const draft: StoredOrder = {
      id: ORDER,
      listId: LIST,
      status: 'draft',
      lines: [line],
      total: usd(4700),
    };

    const seeded = (): Store => {
      const s = open();
      s.createList({ id: LIST, ceiling: usd(10_000) });
      s.addItem(LIST, skirtItem);
      s.recordCandidate(LIST, candidateFor('cand_a', SKIRT, 4200));
      return s;
    };

    it('round-trips a draft order with its lines', () => {
      const s = seeded();
      s.putOrder(draft);
      expect(s.getOrder(LIST, ORDER)).toEqual(draft);
    });

    it('updates an existing order in place rather than duplicating it', () => {
      const s = seeded();
      s.putOrder(draft);
      s.putOrder({ ...draft, status: 'reserved' });
      expect(s.listOrders(LIST)).toHaveLength(1);
      expect(s.getOrder(LIST, ORDER)?.status).toBe('reserved');
    });

    it('round-trips a settled order including its receipt', () => {
      const s = seeded();
      const settled: StoredOrder = {
        ...draft,
        status: 'settled',
        settlementKey: 'settle-key-0001',
        settlement: {
          reference: 'mock_settle-key-0001',
          amount: usd(4700),
          settledAt: '2026-08-27T00:00:00.000Z',
          provider: 'mock',
        },
      };
      s.putOrder(settled);
      expect(s.getOrder(LIST, ORDER)).toEqual(settled);
    });

    it('omits settlement fields entirely when absent', () => {
      // exactOptionalPropertyTypes: absent, not set to undefined.
      const s = seeded();
      s.putOrder(draft);
      const stored = s.getOrder(LIST, ORDER);
      expect(stored !== undefined && 'settlement' in stored).toBe(false);
      expect(stored !== undefined && 'settlementKey' in stored).toBe(false);
    });

    it('finds a settled order by its settlement key', () => {
      // This lookup is what makes a repeated checkout safe, so it has to work
      // identically in both stores.
      const s = seeded();
      s.putOrder({ ...draft, status: 'settled', settlementKey: 'settle-key-0001' });
      expect(s.findBySettlementKey(LIST, 'settle-key-0001')?.id).toBe(ORDER);
      expect(s.findBySettlementKey(LIST, 'some-other-key')).toBeUndefined();
    });

    it('does not match an order that has no settlement key', () => {
      const s = seeded();
      s.putOrder(draft);
      expect(s.findBySettlementKey(LIST, 'settle-key-0001')).toBeUndefined();
    });

    it('preserves line order across a rewrite', () => {
      const s = seeded();
      s.addItem(LIST, mugItem);
      s.recordCandidate(LIST, candidateFor('cand_b', MUG, 1200));
      const second: OrderLine = {
        itemId: MUG,
        candidateId: asId<CandidateId>('cand_b'),
        quantity: 2,
        unitPrice: usd(1200),
        shipping: usd(0),
      };
      s.putOrder({ ...draft, lines: [line, second], total: usd(7100) });
      s.putOrder({ ...draft, lines: [second, line], total: usd(7100) });
      expect(s.getOrder(LIST, ORDER)?.lines.map((l) => l.itemId)).toEqual([MUG, SKIRT]);
    });

    it('returns undefined for an order on an unknown list', () => {
      expect(open().getOrder(asId<ListId>('nope'), ORDER)).toBeUndefined();
    });

    it('rejects an order total in the wrong currency', () => {
      const s = seeded();
      expect(() => {
        s.putOrder({ ...draft, total: money(4700, 'EUR') });
      }).toThrow(StoreError);
    });
  });
});

describe('SqliteStore persistence', () => {
  it('survives closing and reopening the database', () => {
    // The reason this store exists at all: budget state must outlive the
    // process, or the "restart the server, state intact" demo beat is a lie.
    // An in-memory database would pass every other test and still fail here.
    const dir = mkdtempSync(join(tmpdir(), 'quartermaster-'));
    const path = join(dir, 'commerce.sqlite');

    try {
      const first = new SqliteStore(path);
      first.createList({ id: LIST, ceiling: usd(10_000) });
      first.addItem(LIST, skirtItem);
      first.recordCandidate(LIST, candidateFor('cand_a', SKIRT, 4200));
      first.putBudget(LIST, unwrap(reserve(unwrapBudget(first.getBudget(LIST)), usd(2500))));
      first.close();

      const second = new SqliteStore(path);
      expect(second.getList(LIST)?.items).toEqual([skirtItem]);
      expect(second.listCandidates(LIST)).toEqual([candidateFor('cand_a', SKIRT, 4200)]);
      expect(availableOf(unwrapBudget(second.getBudget(LIST)))).toEqual(usd(7500));
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
