import { describe, expect, it } from 'vitest';
import {
  asId,
  isErr,
  unwrap,
  type CandidateId,
  type ItemId,
  type ListId,
  type OrderId,
} from '@quartermaster/shared';
import { createBudget, reserve } from './budget.js';
import { money } from './money.js';
import { lineTotal, orderTotals, validateOrderDraft, type OrderViolationCode } from './order.js';
import type { Candidate, Item, OrderDraft, OrderLine, ShoppingList } from './types.js';

const usd = (minorUnits: number) => money(minorUnits, 'USD');

const SKIRT = asId<ItemId>('item_skirt');
const MUG = asId<ItemId>('item_mug');
const LIST = asId<ListId>('list_1');
const ORDER = asId<OrderId>('order_1');
const SKIRT_CANDIDATE = asId<CandidateId>('cand_skirt');
const MUG_CANDIDATE = asId<CandidateId>('cand_mug');

const skirtItem: Item = {
  id: SKIRT,
  description: 'navy floral midi skirt',
  quantity: 1,
  required: true,
};
const mugItem: Item = { id: MUG, description: 'stoneware mug', quantity: 2, required: false };

const list: ShoppingList = {
  id: LIST,
  currency: 'USD',
  items: [skirtItem, mugItem],
};

const candidates: Candidate[] = [
  {
    id: SKIRT_CANDIDATE,
    itemId: SKIRT,
    source: 'bright-data:serp',
    title: 'Navy Floral Midi Skirt',
    url: 'https://example.test/skirt',
    unitPrice: usd(4200),
    shipping: usd(500),
    availability: 'in_stock',
  },
  {
    id: MUG_CANDIDATE,
    itemId: MUG,
    source: 'bright-data:serp',
    title: 'Stoneware Mug',
    url: 'https://example.test/mug',
    unitPrice: usd(1200),
    shipping: usd(0),
    availability: 'in_stock',
  },
];

const skirtLine: OrderLine = {
  itemId: SKIRT,
  candidateId: SKIRT_CANDIDATE,
  quantity: 1,
  unitPrice: usd(4200),
  shipping: usd(500),
};

const mugLine: OrderLine = {
  itemId: MUG,
  candidateId: MUG_CANDIDATE,
  quantity: 2,
  unitPrice: usd(1200),
  shipping: usd(0),
};

function draftWith(lines: OrderLine[]): OrderDraft {
  return { id: ORDER, listId: LIST, lines };
}

/** Pull the violation codes out of a failed validation. */
function codesFrom(result: ReturnType<typeof validateOrderDraft>): OrderViolationCode[] {
  if (result.ok) throw new Error('expected the order to be rejected');
  return result.error.map((violation) => violation.code);
}

const budget = createBudget(usd(10_000));

describe('totals', () => {
  it('computes a line total as price times quantity plus shipping', () => {
    expect(lineTotal(mugLine)).toEqual(usd(2400));
    expect(lineTotal(skirtLine)).toEqual(usd(4700));
  });

  it('separates subtotal from shipping', () => {
    const totals = orderTotals(draftWith([skirtLine, mugLine]), list);
    expect(totals.subtotal).toEqual(usd(6600));
    expect(totals.shipping).toEqual(usd(500));
    expect(totals.total).toEqual(usd(7100));
    expect(totals.lineCount).toBe(2);
  });
});

describe('a valid order', () => {
  it('passes and returns its totals', () => {
    const totals = unwrap(
      validateOrderDraft({ draft: draftWith([skirtLine, mugLine]), list, candidates, budget }),
    );
    expect(totals.total).toEqual(usd(7100));
  });

  it('passes with only the required item', () => {
    const result = validateOrderDraft({ draft: draftWith([skirtLine]), list, candidates, budget });
    expect(result.ok).toBe(true);
  });
});

describe('price integrity', () => {
  it('rejects a unit price the agent invented', () => {
    // The headline case: the model claims a cheaper price than was recorded.
    const lying = { ...skirtLine, unitPrice: usd(2000) };
    const result = validateOrderDraft({ draft: draftWith([lying]), list, candidates, budget });
    expect(codesFrom(result)).toContain('price_mismatch');
    if (!result.ok) {
      expect(result.error[0]?.message).toContain('$20.00');
      expect(result.error[0]?.message).toContain('$42.00');
    }
  });

  it('rejects an invented shipping figure', () => {
    const lying = { ...skirtLine, shipping: usd(0) };
    expect(
      codesFrom(validateOrderDraft({ draft: draftWith([lying]), list, candidates, budget })),
    ).toContain('shipping_mismatch');
  });

  it('rejects a price inflated upwards too, not just downwards', () => {
    const lying = { ...skirtLine, unitPrice: usd(9900) };
    expect(
      codesFrom(validateOrderDraft({ draft: draftWith([lying]), list, candidates, budget })),
    ).toContain('price_mismatch');
  });
});

describe('referential integrity', () => {
  it('rejects an unknown candidate', () => {
    const ghost = { ...skirtLine, candidateId: asId<CandidateId>('cand_nonexistent') };
    expect(
      codesFrom(validateOrderDraft({ draft: draftWith([ghost]), list, candidates, budget })),
    ).toContain('unknown_candidate');
  });

  it('rejects an item that is not on the list', () => {
    const stray = { ...skirtLine, itemId: asId<ItemId>('item_unlisted') };
    expect(
      codesFrom(validateOrderDraft({ draft: draftWith([stray]), list, candidates, budget })),
    ).toContain('unknown_item');
  });

  it('rejects a candidate matched to the wrong item', () => {
    const crossed = {
      ...mugLine,
      candidateId: SKIRT_CANDIDATE,
      unitPrice: usd(4200),
      shipping: usd(500),
    };
    expect(
      codesFrom(validateOrderDraft({ draft: draftWith([crossed]), list, candidates, budget })),
    ).toContain('candidate_item_mismatch');
  });

  it('rejects the same item on two lines', () => {
    expect(
      codesFrom(
        validateOrderDraft({ draft: draftWith([skirtLine, skirtLine]), list, candidates, budget }),
      ),
    ).toContain('duplicate_item');
  });
});

describe('quantities and availability', () => {
  it('rejects a quantity that does not match the list', () => {
    const wrong = { ...mugLine, quantity: 5 };
    expect(
      codesFrom(
        validateOrderDraft({ draft: draftWith([skirtLine, wrong]), list, candidates, budget }),
      ),
    ).toContain('quantity_mismatch');
  });

  it.each([0, -1, 1.5])('rejects an invalid quantity of %s', (quantity) => {
    const wrong = { ...mugLine, quantity };
    expect(
      codesFrom(
        validateOrderDraft({ draft: draftWith([skirtLine, wrong]), list, candidates, budget }),
      ),
    ).toContain('invalid_quantity');
  });

  it('rejects an out-of-stock candidate', () => {
    const gone = candidates.map((c) =>
      c.id === SKIRT_CANDIDATE ? { ...c, availability: 'out_of_stock' as const } : c,
    );
    expect(
      codesFrom(
        validateOrderDraft({ draft: draftWith([skirtLine]), list, candidates: gone, budget }),
      ),
    ).toContain('out_of_stock');
  });
});

describe('caps and required items', () => {
  it('rejects a unit price above the item cap', () => {
    const capped: ShoppingList = {
      ...list,
      items: [{ ...skirtItem, maxUnitPrice: usd(3000) }],
    };
    expect(
      codesFrom(
        validateOrderDraft({ draft: draftWith([skirtLine]), list: capped, candidates, budget }),
      ),
    ).toContain('exceeds_max_unit_price');
  });

  it('rejects an order missing a required item', () => {
    expect(
      codesFrom(validateOrderDraft({ draft: draftWith([mugLine]), list, candidates, budget })),
    ).toContain('missing_required_item');
  });

  it('rejects an empty order', () => {
    expect(
      codesFrom(validateOrderDraft({ draft: draftWith([]), list, candidates, budget })),
    ).toContain('empty_order');
  });
});

describe('budget interaction', () => {
  it('rejects an order beyond the remaining budget', () => {
    const tight = createBudget(usd(5000));
    expect(
      codesFrom(
        validateOrderDraft({
          draft: draftWith([skirtLine, mugLine]),
          list,
          candidates,
          budget: tight,
        }),
      ),
    ).toContain('exceeds_budget');
  });

  it('accounts for funds already reserved by another order', () => {
    // $100 ceiling, $95 already held, $71 order — must be refused.
    const held = unwrap(reserve(createBudget(usd(10_000)), usd(9500)));
    expect(
      codesFrom(
        validateOrderDraft({
          draft: draftWith([skirtLine, mugLine]),
          list,
          candidates,
          budget: held,
        }),
      ),
    ).toContain('exceeds_budget');
  });

  it('allows an order that exactly exhausts the budget', () => {
    const exact = createBudget(usd(7100));
    const result = validateOrderDraft({
      draft: draftWith([skirtLine, mugLine]),
      list,
      candidates,
      budget: exact,
    });
    expect(result.ok).toBe(true);
  });

  it('does not check the budget while figures are still untrustworthy', () => {
    // A bad price makes the total meaningless, so reporting "over budget" on
    // top would be noise. Fix the price first, then the total means something.
    const lying = { ...skirtLine, unitPrice: usd(1) };
    const tiny = createBudget(usd(1));
    const codes = codesFrom(
      validateOrderDraft({ draft: draftWith([lying]), list, candidates, budget: tiny }),
    );
    expect(codes).toContain('price_mismatch');
    expect(codes).not.toContain('exceeds_budget');
  });
});

describe('reporting', () => {
  it('reports every problem at once rather than one per turn', () => {
    const bad: OrderLine = {
      itemId: MUG,
      candidateId: MUG_CANDIDATE,
      quantity: 9,
      unitPrice: usd(1),
      shipping: usd(1),
    };
    const codes = codesFrom(
      validateOrderDraft({ draft: draftWith([bad]), list, candidates, budget }),
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        'quantity_mismatch',
        'price_mismatch',
        'shipping_mismatch',
        'missing_required_item',
      ]),
    );
    expect(isErr(validateOrderDraft({ draft: draftWith([bad]), list, candidates, budget }))).toBe(
      true,
    );
  });
});
