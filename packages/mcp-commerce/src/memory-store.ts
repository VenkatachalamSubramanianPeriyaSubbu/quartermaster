import type { CandidateId, ItemId, ListId } from '@quartermaster/shared';
import {
  createBudget,
  type Budget,
  type Candidate,
  type Item,
  type ShoppingList,
} from '@quartermaster/domain';
import { StoreError, type NewList, type Store } from './store.js';

interface ListRecord {
  list: ShoppingList;
  budget: Budget;
  candidates: Map<CandidateId, Candidate>;
}

/**
 * In-memory store.
 *
 * Used by the test suite and by anyone who wants to poke at the server without
 * leaving a database file behind. Behaviour is verified against the same
 * conformance suite as the SQLite implementation.
 */
export class MemoryStore implements Store {
  readonly #lists = new Map<ListId, ListRecord>();

  createList({ id, ceiling }: NewList): ShoppingList {
    if (this.#lists.has(id)) {
      throw new StoreError('duplicate_list', `List ${id} already exists.`);
    }
    const list: ShoppingList = { id, currency: ceiling.currency, items: [] };
    this.#lists.set(id, { list, budget: createBudget(ceiling), candidates: new Map() });
    return list;
  }

  getList(id: ListId): ShoppingList | undefined {
    return this.#lists.get(id)?.list;
  }

  listLists(): ShoppingList[] {
    return [...this.#lists.values()].map((record) => record.list);
  }

  addItem(listId: ListId, item: Item): Item {
    const record = this.#require(listId);
    if (record.list.items.some((existing) => existing.id === item.id)) {
      throw new StoreError('duplicate_item', `Item ${item.id} is already on list ${listId}.`);
    }
    if (item.maxUnitPrice !== undefined && item.maxUnitPrice.currency !== record.list.currency) {
      throw new StoreError(
        'currency_mismatch',
        `Item cap is in ${item.maxUnitPrice.currency} but list ${listId} is in ${record.list.currency}.`,
      );
    }
    record.list = { ...record.list, items: [...record.list.items, item] };
    return item;
  }

  getBudget(listId: ListId): Budget | undefined {
    return this.#lists.get(listId)?.budget;
  }

  putBudget(listId: ListId, budget: Budget): void {
    const record = this.#require(listId);
    if (budget.ceiling.currency !== record.list.currency) {
      throw new StoreError(
        'currency_mismatch',
        `Budget is in ${budget.ceiling.currency} but list ${listId} is in ${record.list.currency}.`,
      );
    }
    record.budget = budget;
  }

  recordCandidate(listId: ListId, candidate: Candidate): Candidate {
    const record = this.#require(listId);
    if (record.candidates.has(candidate.id)) {
      throw new StoreError('duplicate_candidate', `Candidate ${candidate.id} is already recorded.`);
    }
    if (!record.list.items.some((item) => item.id === candidate.itemId)) {
      throw new StoreError(
        'item_not_found',
        `Item ${candidate.itemId} is not on list ${listId}; add it before recording candidates.`,
      );
    }
    if (candidate.unitPrice.currency !== record.list.currency) {
      throw new StoreError(
        'currency_mismatch',
        `Candidate is priced in ${candidate.unitPrice.currency} but list ${listId} is in ${record.list.currency}.`,
      );
    }
    record.candidates.set(candidate.id, candidate);
    return candidate;
  }

  getCandidate(listId: ListId, id: CandidateId): Candidate | undefined {
    return this.#lists.get(listId)?.candidates.get(id);
  }

  listCandidates(listId: ListId, itemId?: ItemId): Candidate[] {
    const record = this.#require(listId);
    const all = [...record.candidates.values()];
    return itemId === undefined ? all : all.filter((candidate) => candidate.itemId === itemId);
  }

  #require(listId: ListId): ListRecord {
    const record = this.#lists.get(listId);
    if (record === undefined) throw new StoreError('list_not_found', `List ${listId} not found.`);
    return record;
  }
}
