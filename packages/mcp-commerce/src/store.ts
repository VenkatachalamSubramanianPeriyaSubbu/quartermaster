import type { CandidateId, ItemId, ListId, OrderId } from '@quartermaster/shared';
import type {
  Budget,
  Candidate,
  Item,
  Money,
  OrderLine,
  ShoppingList,
} from '@quartermaster/domain';
import type { Settlement } from './merchant.js';

/**
 * Where an order is in its life.
 *
 * `reserved` is the state that matters: budget is held but no money has moved,
 * so the order can still be cancelled without consequence. Only `settled` is
 * irreversible.
 */
export const ORDER_STATUSES = ['draft', 'reserved', 'settled', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface StoredOrder {
  readonly id: OrderId;
  readonly listId: ListId;
  readonly status: OrderStatus;
  readonly lines: readonly OrderLine[];
  readonly total: Money;
  /** Present once settled. */
  readonly settlement?: Settlement;
  /**
   * The idempotency key the settlement was attempted under.
   *
   * Recorded so a repeated checkout can be recognised and answered with the
   * original receipt instead of charging again.
   */
  readonly settlementKey?: string;
}

/**
 * The storage seam.
 *
 * Deliberately synchronous. Both implementations — an in-memory map and
 * `node:sqlite` — are synchronous, and pretending otherwise would add `await`
 * noise to every call site for a hypothetical future Postgres backend. If we
 * ever need one, this is the interface to widen, and it is small enough that
 * doing so is a contained change.
 */
export interface Store {
  createList(input: NewList): ShoppingList;
  getList(id: ListId): ShoppingList | undefined;
  listLists(): ShoppingList[];

  addItem(listId: ListId, item: Item): Item;

  getBudget(listId: ListId): Budget | undefined;
  putBudget(listId: ListId, budget: Budget): void;

  recordCandidate(listId: ListId, candidate: Candidate): Candidate;
  getCandidate(listId: ListId, id: CandidateId): Candidate | undefined;
  listCandidates(listId: ListId, itemId?: ItemId): Candidate[];

  putOrder(order: StoredOrder): void;
  getOrder(listId: ListId, id: OrderId): StoredOrder | undefined;
  listOrders(listId: ListId): StoredOrder[];
  /** Find an order already settled under this key, so retries do not recharge. */
  findBySettlementKey(listId: ListId, settlementKey: string): StoredOrder | undefined;
}

export interface NewList {
  readonly id: ListId;
  readonly ceiling: Money;
}

export type StoreErrorCode =
  | 'list_not_found'
  | 'item_not_found'
  | 'duplicate_list'
  | 'duplicate_item'
  | 'duplicate_candidate'
  | 'currency_mismatch';

export type { OrderId };

/**
 * A failure the caller can do something about.
 *
 * These become structured tool errors rather than stack traces, because the
 * consumer on the other side of the tool boundary is a language model that has
 * to read the message and decide what to do next.
 */
export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}
