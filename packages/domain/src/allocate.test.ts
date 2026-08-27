import { describe, expect, it } from 'vitest';
import { asId, type CandidateId, type ItemId, type ListId } from '@quartermaster/shared';
import { allocate, coversAllRequired } from './allocate.js';
import { createBudget } from './budget.js';
import { money } from './money.js';
import type { Candidate, Item, ShoppingList } from './types.js';

const usd = (minorUnits: number) => money(minorUnits, 'USD');
const item = (name: string) => asId<ItemId>(`item_${name}`);
const cand = (name: string) => asId<CandidateId>(`cand_${name}`);

function candidate(
  id: string,
  itemId: ItemId,
  unitPrice: number,
  shipping = 0,
  availability: Candidate['availability'] = 'in_stock',
): Candidate {
  return {
    id: cand(id),
    itemId,
    source: 'test',
    title: id,
    url: `https://example.test/${id}`,
    unitPrice: usd(unitPrice),
    shipping: usd(shipping),
    availability,
  };
}

const SKIRT = item('skirt');
const MUG = item('mug');
const LAMP = item('lamp');

const skirtItem: Item = { id: SKIRT, description: 'skirt', quantity: 1, required: true };
const mugItem: Item = { id: MUG, description: 'mug', quantity: 2, required: false };
const lampItem: Item = { id: LAMP, description: 'lamp', quantity: 1, required: false };

const list: ShoppingList = {
  id: asId<ListId>('list_1'),
  currency: 'USD',
  items: [skirtItem, mugItem, lampItem],
};

describe('allocate', () => {
  it('picks the cheapest total, not the cheapest unit price', () => {
    // Cheaper unit price but punitive shipping should lose.
    const candidates = [
      candidate('a', SKIRT, 4000, 2000), // $60 total
      candidate('b', SKIRT, 4500, 200), // $47 total
    ];
    const result = allocate({ ...list, items: [skirtItem] }, candidates, createBudget(usd(10_000)));
    expect(result.lines[0]?.candidateId).toBe(cand('b'));
    expect(result.total).toEqual(usd(4700));
  });

  it('accounts for quantity when comparing candidates', () => {
    // Two mugs: unit price dominates once quantity is applied.
    const twoMugs: ShoppingList = { ...list, items: [{ ...mugItem, required: true }] };
    const candidates = [
      candidate('cheap-unit', MUG, 1000, 900), // 2*10 + 9 = $29
      candidate('cheap-ship', MUG, 1400, 0), // 2*14 + 0 = $28
    ];
    const result = allocate(twoMugs, candidates, createBudget(usd(10_000)));
    expect(result.lines[0]?.candidateId).toBe(cand('cheap-ship'));
  });

  it('covers required items before optional ones', () => {
    // Only enough for the skirt or the lamp, not both. Required wins.
    const candidates = [candidate('skirt', SKIRT, 4000), candidate('lamp', LAMP, 4000)];
    const result = allocate(list, candidates, createBudget(usd(5000)));
    expect(result.lines.map((line) => line.itemId)).toEqual([SKIRT]);
    expect(result.skipped).toContainEqual({ itemId: LAMP, reason: 'insufficient_budget' });
    expect(coversAllRequired(list, result)).toBe(true);
  });

  it('fits as many optional items as the remainder allows, cheapest first', () => {
    const candidates = [
      candidate('skirt', SKIRT, 4000),
      candidate('mug', MUG, 500), // 2 * $5 = $10
      candidate('lamp', LAMP, 2000), // $20
    ];
    // $40 skirt + $10 mugs = $50; the $20 lamp will not fit in $60.
    const result = allocate(list, candidates, createBudget(usd(6000)));
    expect(result.lines.map((line) => line.itemId)).toEqual([SKIRT, MUG]);
    expect(result.skipped).toContainEqual({ itemId: LAMP, reason: 'insufficient_budget' });
    expect(result.remaining).toEqual(usd(1000));
  });

  it('never exceeds the budget', () => {
    const candidates = [
      candidate('skirt', SKIRT, 4000),
      candidate('mug', MUG, 3000),
      candidate('lamp', LAMP, 3000),
    ];
    const result = allocate(list, candidates, createBudget(usd(5000)));
    expect(result.total.minorUnits).toBeLessThanOrEqual(5000);
    expect(result.remaining.minorUnits).toBeGreaterThanOrEqual(0);
  });

  it('respects funds already reserved elsewhere', () => {
    const candidates = [candidate('skirt', SKIRT, 4000)];
    const budget = { ...createBudget(usd(10_000)), reserved: usd(9000) };
    const result = allocate(list, candidates, budget);
    expect(result.lines).toHaveLength(0);
    expect(result.skipped).toContainEqual({ itemId: SKIRT, reason: 'insufficient_budget' });
    expect(coversAllRequired(list, result)).toBe(false);
  });
});

describe('skip reasons', () => {
  it('distinguishes an item with no candidates', () => {
    const result = allocate(list, [], createBudget(usd(10_000)));
    expect(result.skipped).toContainEqual({ itemId: SKIRT, reason: 'no_candidates' });
  });

  it('distinguishes an item whose candidates are all out of stock', () => {
    const candidates = [candidate('skirt', SKIRT, 4000, 0, 'out_of_stock')];
    const result = allocate(list, candidates, createBudget(usd(10_000)));
    expect(result.skipped).toContainEqual({ itemId: SKIRT, reason: 'all_out_of_stock' });
  });

  it('distinguishes an item priced above its own cap', () => {
    const capped: ShoppingList = {
      ...list,
      items: [{ ...skirtItem, maxUnitPrice: usd(3000) }],
    };
    const candidates = [candidate('skirt', SKIRT, 4000)];
    const result = allocate(capped, candidates, createBudget(usd(10_000)));
    expect(result.skipped).toContainEqual({ itemId: SKIRT, reason: 'over_item_cap' });
  });

  it('treats unknown availability as buyable', () => {
    // Refusing to buy anything we could not confirm would reject most of the
    // open web. Unknown is a candidate; out_of_stock is not.
    const candidates = [candidate('skirt', SKIRT, 4000, 0, 'unknown')];
    const result = allocate(list, candidates, createBudget(usd(10_000)));
    expect(result.lines).toHaveLength(1);
  });
});

describe('degenerate inputs', () => {
  it('handles an empty list', () => {
    const empty: ShoppingList = { ...list, items: [] };
    const result = allocate(empty, [], createBudget(usd(10_000)));
    expect(result.lines).toHaveLength(0);
    expect(result.total).toEqual(usd(0));
    expect(coversAllRequired(empty, result)).toBe(true);
  });

  it('handles a zero budget', () => {
    const candidates = [candidate('skirt', SKIRT, 4000)];
    const result = allocate(list, candidates, createBudget(usd(0)));
    expect(result.lines).toHaveLength(0);
    expect(result.remaining).toEqual(usd(0));
  });

  it('allows a free item even on a zero budget', () => {
    const candidates = [candidate('skirt', SKIRT, 0, 0)];
    const result = allocate(list, candidates, createBudget(usd(0)));
    expect(result.lines).toHaveLength(1);
  });
});
