import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asId, unwrap, type CandidateId, type ItemId, type ListId } from '@quartermaster/shared';
import { availableOf, createBudget, money, reserve } from '@quartermaster/domain';
import { MemoryStore } from './memory-store.js';
import { SqliteStore } from './sqlite-store.js';
import { StoreError, type Store } from './store.js';
import type { Budget, Candidate, Item } from '@quartermaster/domain';

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
