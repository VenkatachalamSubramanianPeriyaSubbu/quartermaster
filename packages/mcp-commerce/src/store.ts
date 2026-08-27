import type { CandidateId, ItemId, ListId } from '@quartermaster/shared';
import type { Budget, Candidate, Item, Money, ShoppingList } from '@quartermaster/domain';

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
