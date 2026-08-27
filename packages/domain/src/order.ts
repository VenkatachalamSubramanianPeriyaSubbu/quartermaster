import { err, ok, type Result } from '@quartermaster/shared';
import { add, equals, format, greaterThan, money, multiply, sum, type Money } from './money.js';
import { availableOf } from './budget.js';
import type { Budget, Candidate, OrderDraft, OrderLine, ShoppingList } from './types.js';

/**
 * Order validation.
 *
 * The agent proposes; this module disposes. Nothing the model claims about an
 * order is taken on trust — not the prices, not the quantities, not whether an
 * item is in stock. Every figure on a proposed line is re-checked against the
 * candidate that was actually recorded when the product was found.
 *
 * The price check is the one that earns its keep. Language models produce
 * plausible numbers, and a hallucinated unit price would otherwise flow
 * straight through the approval console to a human who has no way of knowing
 * the figure was invented.
 */

export type OrderViolationCode =
  | 'empty_order'
  | 'unknown_item'
  | 'unknown_candidate'
  | 'candidate_item_mismatch'
  | 'duplicate_item'
  | 'invalid_quantity'
  | 'quantity_mismatch'
  | 'price_mismatch'
  | 'shipping_mismatch'
  | 'out_of_stock'
  | 'exceeds_max_unit_price'
  | 'currency_mismatch'
  | 'missing_required_item'
  | 'exceeds_budget';

export interface OrderViolation {
  readonly code: OrderViolationCode;
  /** Written for the agent to read and correct, not for a stack trace. */
  readonly message: string;
  readonly itemId?: string;
  readonly candidateId?: string;
}

export interface OrderTotals {
  readonly subtotal: Money;
  readonly shipping: Money;
  readonly total: Money;
  readonly lineCount: number;
}

/** Unit price times quantity, plus shipping for that line. */
export function lineTotal(line: OrderLine): Money {
  return add(multiply(line.unitPrice, line.quantity), line.shipping);
}

export function orderTotals(draft: OrderDraft, list: ShoppingList): OrderTotals {
  const subtotal = sum(
    draft.lines.map((line) => multiply(line.unitPrice, line.quantity)),
    list.currency,
  );
  const shipping = sum(
    draft.lines.map((line) => line.shipping),
    list.currency,
  );
  return {
    subtotal,
    shipping,
    total: add(subtotal, shipping),
    lineCount: draft.lines.length,
  };
}

interface ValidationInput {
  readonly draft: OrderDraft;
  readonly list: ShoppingList;
  readonly candidates: readonly Candidate[];
  readonly budget: Budget;
}

/**
 * Check a proposed order against the list, the recorded candidates, and the
 * budget.
 *
 * Returns every violation rather than the first, so a rejected order tells the
 * agent everything wrong with it in one turn instead of one problem per round
 * trip.
 */
export function validateOrderDraft({
  draft,
  list,
  candidates,
  budget,
}: ValidationInput): Result<OrderTotals, OrderViolation[]> {
  const violations: OrderViolation[] = [];

  const itemsById = new Map(list.items.map((item) => [item.id, item]));
  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seenItems = new Set<string>();

  if (draft.lines.length === 0) {
    violations.push({ code: 'empty_order', message: 'The order contains no lines.' });
  }

  if (draft.listId !== list.id) {
    violations.push({
      code: 'unknown_item',
      message: `Order references list ${draft.listId} but was validated against ${list.id}.`,
    });
  }

  for (const line of draft.lines) {
    const item = itemsById.get(line.itemId);
    const candidate = candidatesById.get(line.candidateId);

    if (item === undefined) {
      violations.push({
        code: 'unknown_item',
        message: `Item ${line.itemId} is not on this shopping list.`,
        itemId: line.itemId,
      });
      continue;
    }

    if (seenItems.has(line.itemId)) {
      violations.push({
        code: 'duplicate_item',
        message: `Item ${line.itemId} appears on more than one line. Combine them.`,
        itemId: line.itemId,
      });
    }
    seenItems.add(line.itemId);

    if (candidate === undefined) {
      violations.push({
        code: 'unknown_candidate',
        message: `Candidate ${line.candidateId} was never recorded. Search for it first.`,
        itemId: line.itemId,
        candidateId: line.candidateId,
      });
      continue;
    }

    if (candidate.itemId !== line.itemId) {
      violations.push({
        code: 'candidate_item_mismatch',
        message: `Candidate ${candidate.id} belongs to item ${candidate.itemId}, not ${line.itemId}.`,
        itemId: line.itemId,
        candidateId: candidate.id,
      });
    }

    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      violations.push({
        code: 'invalid_quantity',
        message: `Quantity must be a positive whole number, received ${String(line.quantity)}.`,
        itemId: line.itemId,
      });
    } else if (line.quantity !== item.quantity) {
      violations.push({
        code: 'quantity_mismatch',
        message: `Item ${line.itemId} needs ${String(item.quantity)}, the order has ${String(line.quantity)}.`,
        itemId: line.itemId,
      });
    }

    // The hallucination guard: the claimed price must match what was recorded.
    if (!equals(line.unitPrice, candidate.unitPrice)) {
      violations.push({
        code: 'price_mismatch',
        message:
          `Line claims ${format(line.unitPrice)} for candidate ${candidate.id}, ` +
          `but the recorded price is ${format(candidate.unitPrice)}. ` +
          `Re-check the listing rather than adjusting the number.`,
        itemId: line.itemId,
        candidateId: candidate.id,
      });
    }

    if (!equals(line.shipping, candidate.shipping)) {
      violations.push({
        code: 'shipping_mismatch',
        message:
          `Line claims ${format(line.shipping)} shipping for candidate ${candidate.id}, ` +
          `but the recorded figure is ${format(candidate.shipping)}.`,
        itemId: line.itemId,
        candidateId: candidate.id,
      });
    }

    if (candidate.availability === 'out_of_stock') {
      violations.push({
        code: 'out_of_stock',
        message: `Candidate ${candidate.id} is out of stock. Find an alternative.`,
        itemId: line.itemId,
        candidateId: candidate.id,
      });
    }

    if (line.unitPrice.currency !== list.currency) {
      violations.push({
        code: 'currency_mismatch',
        message: `Line is priced in ${line.unitPrice.currency} but the list is in ${list.currency}.`,
        itemId: line.itemId,
      });
    }

    if (item.maxUnitPrice !== undefined && greaterThan(line.unitPrice, item.maxUnitPrice)) {
      violations.push({
        code: 'exceeds_max_unit_price',
        message:
          `${format(line.unitPrice)} exceeds the ${format(item.maxUnitPrice)} cap ` +
          `set for item ${line.itemId}.`,
        itemId: line.itemId,
        candidateId: candidate.id,
      });
    }
  }

  for (const item of list.items) {
    if (item.required && !seenItems.has(item.id)) {
      violations.push({
        code: 'missing_required_item',
        message: `Required item ${item.id} (${item.description}) is not in the order.`,
        itemId: item.id,
      });
    }
  }

  // Only meaningful once the individual figures are trustworthy.
  if (violations.length === 0) {
    const totals = orderTotals(draft, list);
    const available = availableOf(budget);
    if (greaterThan(totals.total, available)) {
      violations.push({
        code: 'exceeds_budget',
        message:
          `Order total ${format(totals.total)} exceeds the remaining budget ` +
          `of ${format(available)}. Drop an optional item or find cheaper candidates.`,
      });
    }
  }

  if (violations.length > 0) return err(violations);
  return ok(orderTotals(draft, list));
}

/** Empty draft helper, mostly for tests and for seeding a new order. */
export function emptyDraft(id: OrderDraft['id'], listId: OrderDraft['listId']): OrderDraft {
  return { id, listId, lines: [] };
}

/** Zero totals in a given currency — used when an order has no lines yet. */
export function zeroTotals(list: ShoppingList): OrderTotals {
  const nothing = money(0, list.currency);
  return { subtotal: nothing, shipping: nothing, total: nothing, lineCount: 0 };
}
