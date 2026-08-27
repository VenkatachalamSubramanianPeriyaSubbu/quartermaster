import type { CandidateId, ItemId, ListId, OrderId } from '@quartermaster/shared';
import type { Currency, Money } from './money.js';

/** Why a candidate might not be buyable right now. */
export const AVAILABILITY = ['in_stock', 'out_of_stock', 'unknown'] as const;
export type Availability = (typeof AVAILABILITY)[number];

/** One thing the user wants. */
export interface Item {
  readonly id: ItemId;
  /** What the user asked for, in their own words. */
  readonly description: string;
  readonly quantity: number;
  /**
   * Required items must appear in any valid order. Optional ones are bought
   * only if budget remains after the required set is covered.
   */
  readonly required: boolean;
  /** Optional per-unit cap, independent of the overall budget. */
  readonly maxUnitPrice?: Money;
}

/** A specific purchasable thing the agent found for an item. */
export interface Candidate {
  readonly id: CandidateId;
  readonly itemId: ItemId;
  /** Where it was found — 'bright-data:amazon', 'bright-data:serp', etc. */
  readonly source: string;
  readonly title: string;
  readonly url: string;
  readonly unitPrice: Money;
  readonly shipping: Money;
  readonly availability: Availability;
}

export interface ShoppingList {
  readonly id: ListId;
  readonly currency: Currency;
  readonly items: readonly Item[];
}

/** One line of a proposed order. */
export interface OrderLine {
  readonly itemId: ItemId;
  readonly candidateId: CandidateId;
  readonly quantity: number;
  /**
   * The price the agent claims it will pay. Deliberately duplicated from the
   * candidate so validation can catch a hallucinated or stale number — see
   * validateOrderDraft.
   */
  readonly unitPrice: Money;
  readonly shipping: Money;
}

export interface OrderDraft {
  readonly id: OrderId;
  readonly listId: ListId;
  readonly lines: readonly OrderLine[];
}

/**
 * The budget, split three ways.
 *
 * `committed` is money already spent on settled orders. `reserved` is money
 * held against an order that has been approved but not yet settled. Anything
 * left is spendable. Keeping reserved separate is what stops two concurrent
 * orders from each seeing the same headroom and both being allowed.
 */
export interface Budget {
  readonly ceiling: Money;
  readonly committed: Money;
  readonly reserved: Money;
}
