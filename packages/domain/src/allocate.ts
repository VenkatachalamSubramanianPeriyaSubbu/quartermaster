import type { ItemId } from '@quartermaster/shared';
import { add, atLeast, multiply, subtract, zero, type Money } from './money.js';
import { availableOf } from './budget.js';
import type { Budget, Candidate, Item, OrderLine, ShoppingList } from './types.js';

/**
 * A deterministic reference allocator.
 *
 * This is not meant to be the clever one. In PR #11 the agent writes its own
 * optimiser and runs it in the sandbox, which is the interesting demo — but an
 * agent-written optimiser is unverified code, and we need something trustworthy
 * to compare it against. This greedy pass is that baseline: required items
 * first, cheapest total per item, stop when the money runs out.
 *
 * If the agent's proposal covers fewer items than this does, its optimiser is
 * worse than greedy and we should say so rather than quietly accept it.
 */

export type SkipReason =
  'no_candidates' | 'all_out_of_stock' | 'over_item_cap' | 'insufficient_budget';

export interface SkippedItem {
  readonly itemId: ItemId;
  readonly reason: SkipReason;
}

export interface Allocation {
  readonly lines: readonly OrderLine[];
  readonly skipped: readonly SkippedItem[];
  readonly total: Money;
  readonly remaining: Money;
}

/** What one candidate would cost for the full quantity of an item. */
function totalCostFor(candidate: Candidate, item: Item): Money {
  return add(multiply(candidate.unitPrice, item.quantity), candidate.shipping);
}

/**
 * Pick the cheapest viable candidate for an item.
 *
 * Returns the reason nothing was viable so the caller can explain the gap
 * rather than silently dropping the item.
 */
function cheapestViable(
  item: Item,
  candidates: readonly Candidate[],
): { candidate: Candidate; cost: Money } | { reason: SkipReason } {
  const forItem = candidates.filter((candidate) => candidate.itemId === item.id);
  if (forItem.length === 0) return { reason: 'no_candidates' };

  const inStock = forItem.filter((candidate) => candidate.availability !== 'out_of_stock');
  if (inStock.length === 0) return { reason: 'all_out_of_stock' };

  // Bound to a local so the compiler narrows it inside the closure.
  const cap = item.maxUnitPrice;
  const withinCap =
    cap === undefined ? inStock : inStock.filter((candidate) => atLeast(cap, candidate.unitPrice));
  if (withinCap.length === 0) return { reason: 'over_item_cap' };

  // Safe without an initial value: the length check above guarantees at least
  // one element, and reduce over a non-empty array cannot throw.
  return withinCap
    .map((candidate) => ({ candidate, cost: totalCostFor(candidate, item) }))
    .reduce((best, next) => (next.cost.minorUnits < best.cost.minorUnits ? next : best));
}

/**
 * Allocate the budget across a shopping list.
 *
 * Required items are attempted first and in list order, so a budget that
 * cannot cover everything still covers what the user said mattered. Optional
 * items are then taken cheapest-first to fit as many as possible into what is
 * left.
 */
export function allocate(
  list: ShoppingList,
  candidates: readonly Candidate[],
  budget: Budget,
): Allocation {
  const lines: OrderLine[] = [];
  const skipped: SkippedItem[] = [];
  let remaining = availableOf(budget);
  let total = zero(list.currency);

  const required = list.items.filter((item) => item.required);
  const optional = list.items.filter((item) => !item.required);

  // Optional items are ordered cheapest-first to maximise how many fit.
  const optionalByCost = optional
    .map((item) => ({ item, pick: cheapestViable(item, candidates) }))
    .sort((a, b) => {
      const costA = 'cost' in a.pick ? a.pick.cost.minorUnits : Number.MAX_SAFE_INTEGER;
      const costB = 'cost' in b.pick ? b.pick.cost.minorUnits : Number.MAX_SAFE_INTEGER;
      return costA - costB;
    });

  const ordered = [
    ...required.map((item) => ({ item, pick: cheapestViable(item, candidates) })),
    ...optionalByCost,
  ];

  for (const { item, pick } of ordered) {
    if ('reason' in pick) {
      skipped.push({ itemId: item.id, reason: pick.reason });
      continue;
    }

    if (!atLeast(remaining, pick.cost)) {
      skipped.push({ itemId: item.id, reason: 'insufficient_budget' });
      continue;
    }

    lines.push({
      itemId: item.id,
      candidateId: pick.candidate.id,
      quantity: item.quantity,
      unitPrice: pick.candidate.unitPrice,
      shipping: pick.candidate.shipping,
    });
    remaining = subtract(remaining, pick.cost);
    total = add(total, pick.cost);
  }

  return { lines, skipped, total, remaining };
}

/** True when every required item made it into the allocation. */
export function coversAllRequired(list: ShoppingList, allocation: Allocation): boolean {
  const allocated = new Set(allocation.lines.map((line) => line.itemId));
  return list.items.filter((item) => item.required).every((item) => allocated.has(item.id));
}
