import { beforeEach, describe, expect, it } from 'vitest';
import {
  asId,
  isErr,
  unwrap,
  type CandidateId,
  type ItemId,
  type ListId,
  type OrderId,
} from '@quartermaster/shared';
import {
  availableOf,
  money,
  type Budget,
  type Candidate,
  type OrderLine,
} from '@quartermaster/domain';
import { MemoryStore } from './memory-store.js';
import { MockMerchant } from './merchant.js';
import { cancelOrder, checkout, createDraft, reserveFunds } from './orders.js';
import type { Store, StoredOrder } from './store.js';

const usd = (minorUnits: number) => money(minorUnits, 'USD');
const LIST = asId<ListId>('list_1');
const SKIRT = asId<ItemId>('item_skirt');
const MUG = asId<ItemId>('item_mug');
const ORDER = asId<OrderId>('order_1');
const SKIRT_CAND = asId<CandidateId>('cand_skirt');
const MUG_CAND = asId<CandidateId>('cand_mug');
const KEY = 'settle-key-0001';

function candidate(id: CandidateId, itemId: ItemId, price: number, shipping = 0): Candidate {
  return {
    id,
    itemId,
    source: 'test',
    title: String(id),
    url: 'https://example.test/x',
    unitPrice: usd(price),
    shipping: usd(shipping),
    availability: 'in_stock',
  };
}

const skirtLine: OrderLine = {
  itemId: SKIRT,
  candidateId: SKIRT_CAND,
  quantity: 1,
  unitPrice: usd(4200),
  shipping: usd(500),
};

const mugLine: OrderLine = {
  itemId: MUG,
  candidateId: MUG_CAND,
  quantity: 2,
  unitPrice: usd(1200),
  shipping: usd(0),
};

let store: Store;
let merchant: MockMerchant;

/** Narrow away the undefined these lookups can return, failing loudly instead. */
function budgetOf(s: Store): Budget {
  const budget = s.getBudget(LIST);
  if (budget === undefined) throw new Error('expected the list to have a budget');
  return budget;
}

function orderOf(s: Store, orderId: OrderId): StoredOrder {
  const order = s.getOrder(LIST, orderId);
  if (order === undefined) throw new Error(`expected order ${orderId} to exist`);
  return order;
}

function seed(ceiling = 10_000): void {
  store = new MemoryStore();
  merchant = new MockMerchant({ now: () => '2026-08-27T00:00:00.000Z' });
  store.createList({ id: LIST, ceiling: usd(ceiling) });
  store.addItem(LIST, { id: SKIRT, description: 'skirt', quantity: 1, required: true });
  store.addItem(LIST, { id: MUG, description: 'mug', quantity: 2, required: false });
  store.recordCandidate(LIST, candidate(SKIRT_CAND, SKIRT, 4200, 500));
  store.recordCandidate(LIST, candidate(MUG_CAND, MUG, 1200, 0));
}

beforeEach(() => {
  seed();
});

describe('createDraft', () => {
  it('creates a draft without touching the budget', () => {
    const order = unwrap(createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] }));
    expect(order.status).toBe('draft');
    expect(order.total).toEqual(usd(4700));
    // Drafting is free; nothing is held yet.
    expect(availableOf(budgetOf(store))).toEqual(usd(10_000));
  });

  it('rejects a draft whose price does not match the recorded candidate', () => {
    const lying = { ...skirtLine, unitPrice: usd(1000) };
    const result = createDraft(store, { listId: LIST, orderId: ORDER, lines: [lying] });
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.code).toBe('validation_failed');
      expect(result.error.violations?.map((v) => v.code)).toContain('price_mismatch');
    }
    expect(store.getOrder(LIST, ORDER)).toBeUndefined();
  });

  it('rejects a duplicate order id', () => {
    createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
    const again = createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
    if (!again.ok) expect(again.error.code).toBe('duplicate_order');
    else throw new Error('expected a duplicate order rejection');
  });

  it('rejects a draft beyond the budget', () => {
    seed(1000);
    const result = createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
    if (!result.ok) expect(result.error.violations?.map((v) => v.code)).toContain('exceeds_budget');
    else throw new Error('expected a budget rejection');
  });
});

describe('reserveFunds', () => {
  it('holds the total and reduces what is available', () => {
    createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
    const order = unwrap(reserveFunds(store, { listId: LIST, orderId: ORDER }));
    expect(order.status).toBe('reserved');
    expect(availableOf(budgetOf(store))).toEqual(usd(5300));
  });

  it('refuses to reserve twice', () => {
    createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
    reserveFunds(store, { listId: LIST, orderId: ORDER });
    const again = reserveFunds(store, { listId: LIST, orderId: ORDER });
    if (!again.ok) expect(again.error.code).toBe('invalid_state');
    else throw new Error('expected an invalid state error');
  });

  it('stops a second order spending the same headroom', () => {
    // $100 ceiling. First order holds $47. A second $71 order must be refused.
    createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
    reserveFunds(store, { listId: LIST, orderId: ORDER });

    const second = asId<OrderId>('order_2');
    const draft = createDraft(store, {
      listId: LIST,
      orderId: second,
      lines: [skirtLine, mugLine],
    });
    // The draft is refused outright, because available is now $53.
    if (!draft.ok) expect(draft.error.violations?.map((v) => v.code)).toContain('exceeds_budget');
    else throw new Error('expected the second draft to be refused');
  });
});

describe('cancelOrder', () => {
  it('releases a held reservation', () => {
    createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
    reserveFunds(store, { listId: LIST, orderId: ORDER });
    const cancelled = unwrap(cancelOrder(store, { listId: LIST, orderId: ORDER }));
    expect(cancelled.status).toBe('cancelled');
    expect(availableOf(budgetOf(store))).toEqual(usd(10_000));
  });

  it('is idempotent', () => {
    createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
    cancelOrder(store, { listId: LIST, orderId: ORDER });
    expect(unwrap(cancelOrder(store, { listId: LIST, orderId: ORDER })).status).toBe('cancelled');
    expect(availableOf(budgetOf(store))).toEqual(usd(10_000));
  });

  it('cancels a draft that never held funds', () => {
    createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
    expect(unwrap(cancelOrder(store, { listId: LIST, orderId: ORDER })).status).toBe('cancelled');
  });
});

describe('checkout', () => {
  const draftThen = (): void => {
    createDraft(store, { listId: LIST, orderId: ORDER, lines: [skirtLine] });
  };

  it('settles a draft, reserving on the way through', async () => {
    draftThen();
    const outcome = unwrap(
      await checkout(store, merchant, { listId: LIST, orderId: ORDER, settlementKey: KEY }),
    );
    expect(outcome.order.status).toBe('settled');
    expect(outcome.idempotentReplay).toBe(false);
    expect(outcome.order.settlement?.reference).toBe(`mock_${KEY}`);

    const budget = budgetOf(store);
    expect(budget.committed).toEqual(usd(4700));
    expect(budget.reserved).toEqual(usd(0));
    expect(availableOf(budget)).toEqual(usd(5300));
  });

  it('settles an already-reserved order without double-holding', async () => {
    draftThen();
    reserveFunds(store, { listId: LIST, orderId: ORDER });
    await checkout(store, merchant, { listId: LIST, orderId: ORDER, settlementKey: KEY });
    const budget = budgetOf(store);
    expect(budget.committed).toEqual(usd(4700));
    expect(availableOf(budget)).toEqual(usd(5300));
  });

  it('charges exactly once when called twice with the same key', async () => {
    // The property that matters most in the whole system.
    draftThen();
    const first = unwrap(
      await checkout(store, merchant, { listId: LIST, orderId: ORDER, settlementKey: KEY }),
    );
    const second = unwrap(
      await checkout(store, merchant, { listId: LIST, orderId: ORDER, settlementKey: KEY }),
    );

    expect(second.idempotentReplay).toBe(true);
    expect(second.order.settlement?.reference).toBe(first.order.settlement?.reference);
    // Not merely the same receipt — the merchant was never asked a second time.
    expect(merchant.attempts).toHaveLength(1);
    expect(budgetOf(store).committed).toEqual(usd(4700));
  });

  it('refuses to settle the same order under a second key', async () => {
    draftThen();
    await checkout(store, merchant, { listId: LIST, orderId: ORDER, settlementKey: KEY });
    const again = await checkout(store, merchant, {
      listId: LIST,
      orderId: ORDER,
      settlementKey: 'a-different-key',
    });
    if (!again.ok) expect(again.error.code).toBe('invalid_state');
    else throw new Error('expected a refusal to settle twice');
    expect(merchant.attempts).toHaveLength(1);
  });

  it('releases the hold when the payment is declined', async () => {
    draftThen();
    merchant.failNext({ code: 'declined', message: 'card declined' });
    const result = await checkout(store, merchant, {
      listId: LIST,
      orderId: ORDER,
      settlementKey: KEY,
    });

    if (!result.ok) expect(result.error.code).toBe('settlement_failed');
    else throw new Error('expected settlement to fail');

    // A declined payment must not leave the budget permanently encumbered.
    const budget = budgetOf(store);
    expect(budget.reserved).toEqual(usd(0));
    expect(budget.committed).toEqual(usd(0));
    expect(availableOf(budget)).toEqual(usd(10_000));
    expect(store.getOrder(LIST, ORDER)?.status).toBe('draft');
  });

  it('allows a retry after a decline', async () => {
    draftThen();
    merchant.failNext({ code: 'declined', message: 'card declined' });
    await checkout(store, merchant, { listId: LIST, orderId: ORDER, settlementKey: KEY });
    merchant.failNext(undefined);

    const retry = unwrap(
      await checkout(store, merchant, { listId: LIST, orderId: ORDER, settlementKey: KEY }),
    );
    expect(retry.order.status).toBe('settled');
    expect(budgetOf(store).committed).toEqual(usd(4700));
  });

  it('re-validates immediately before charging', async () => {
    // A price that moved between drafting and approval must not be charged
    // silently. The figures a human approved have to be the current figures.
    draftThen();
    const store2 = store;
    // Simulate the recorded candidate being superseded by a dearer one by
    // rebuilding the list with a different price.
    const fresh = new MemoryStore();
    fresh.createList({ id: LIST, ceiling: usd(10_000) });
    fresh.addItem(LIST, { id: SKIRT, description: 'skirt', quantity: 1, required: true });
    fresh.recordCandidate(LIST, candidate(SKIRT_CAND, SKIRT, 9900, 500));
    fresh.putOrder(orderOf(store2, ORDER));

    const result = await checkout(fresh, merchant, {
      listId: LIST,
      orderId: ORDER,
      settlementKey: KEY,
    });
    if (!result.ok) {
      expect(result.error.code).toBe('validation_failed');
      expect(result.error.violations?.map((v) => v.code)).toContain('price_mismatch');
    } else throw new Error('expected re-validation to reject the stale price');
    expect(merchant.attempts).toHaveLength(0);
  });

  it('refuses to settle a cancelled order', async () => {
    draftThen();
    cancelOrder(store, { listId: LIST, orderId: ORDER });
    const result = await checkout(store, merchant, {
      listId: LIST,
      orderId: ORDER,
      settlementKey: KEY,
    });
    if (!result.ok) expect(result.error.code).toBe('invalid_state');
    else throw new Error('expected a cancelled order to be unsettleable');
    expect(merchant.attempts).toHaveLength(0);
  });

  it('reports a missing order rather than inventing one', async () => {
    const result = await checkout(store, merchant, {
      listId: LIST,
      orderId: asId<OrderId>('order_ghost'),
      settlementKey: KEY,
    });
    if (!result.ok) expect(result.error.code).toBe('order_not_found');
    else throw new Error('expected order_not_found');
  });

  it('never lets committed plus reserved exceed the ceiling', async () => {
    // The system-wide invariant, exercised across a sequence of orders.
    seed(10_000);
    for (let i = 0; i < 5; i += 1) {
      const id = asId<OrderId>(`order_${String(i)}`);
      const draft = createDraft(store, { listId: LIST, orderId: id, lines: [skirtLine] });
      if (!draft.ok) continue;
      await checkout(store, merchant, {
        listId: LIST,
        orderId: id,
        settlementKey: `key-${String(i)}-pad`,
      });
      const budget = budgetOf(store);
      expect(budget.committed.minorUnits + budget.reserved.minorUnits).toBeLessThanOrEqual(10_000);
      expect(availableOf(budget).minorUnits).toBeGreaterThanOrEqual(0);
    }
    // $100 ceiling, $47 per order: exactly two fit.
    expect(budgetOf(store).committed).toEqual(usd(9400));
  });
});
