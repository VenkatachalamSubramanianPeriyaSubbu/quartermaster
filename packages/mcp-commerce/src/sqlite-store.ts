import { DatabaseSync } from 'node:sqlite';
import { asId, type CandidateId, type ItemId, type ListId } from '@quartermaster/shared';
import {
  money,
  type Availability,
  type Budget,
  type Candidate,
  type Currency,
  type Item,
  type ShoppingList,
} from '@quartermaster/domain';
import { StoreError, type NewList, type Store } from './store.js';

/**
 * SQLite-backed store, using Node's built-in `node:sqlite`.
 *
 * Chosen over better-sqlite3 or Prisma to keep the dependency count at zero for
 * persistence — it ships with the runtime we already require. It is still
 * flagged experimental upstream, which is acceptable for a local-first tool
 * whose database is a single file on the operator's machine.
 *
 * Every monetary column is an INTEGER count of minor units, matching the domain
 * model. SQLite INTEGERs are 64-bit, so there is no precision to lose. There is
 * deliberately no REAL column anywhere in this schema.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lists (
  id               TEXT PRIMARY KEY,
  currency         TEXT    NOT NULL,
  ceiling_minor    INTEGER NOT NULL,
  committed_minor  INTEGER NOT NULL DEFAULT 0,
  reserved_minor   INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS items (
  id                    TEXT PRIMARY KEY,
  list_id               TEXT    NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  description           TEXT    NOT NULL,
  quantity              INTEGER NOT NULL,
  required              INTEGER NOT NULL,
  max_unit_price_minor  INTEGER,
  position              INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS candidates (
  id                TEXT PRIMARY KEY,
  list_id           TEXT    NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  item_id           TEXT    NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source            TEXT    NOT NULL,
  title             TEXT    NOT NULL,
  url               TEXT    NOT NULL,
  unit_price_minor  INTEGER NOT NULL,
  shipping_minor    INTEGER NOT NULL,
  availability      TEXT    NOT NULL,
  recorded_seq      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id, position);
CREATE INDEX IF NOT EXISTS idx_candidates_list ON candidates(list_id, recorded_seq);
CREATE INDEX IF NOT EXISTS idx_candidates_item ON candidates(list_id, item_id);
`;

interface ListRow {
  id: string;
  currency: string;
  ceiling_minor: number;
  committed_minor: number;
  reserved_minor: number;
}

interface ItemRow {
  id: string;
  description: string;
  quantity: number;
  required: number;
  max_unit_price_minor: number | null;
}

interface CandidateRow {
  id: string;
  item_id: string;
  source: string;
  title: string;
  url: string;
  unit_price_minor: number;
  shipping_minor: number;
  availability: string;
}

export class SqliteStore implements Store {
  readonly #db: DatabaseSync;

  /** `:memory:` gives an ephemeral database, which the tests use. */
  constructor(location = ':memory:') {
    this.#db = new DatabaseSync(location);
    this.#db.exec('PRAGMA foreign_keys = ON;');
    this.#db.exec(SCHEMA);
  }

  close(): void {
    this.#db.close();
  }

  createList({ id, ceiling }: NewList): ShoppingList {
    if (this.#listRow(id) !== undefined) {
      throw new StoreError('duplicate_list', `List ${id} already exists.`);
    }
    this.#db
      .prepare(
        'INSERT INTO lists (id, currency, ceiling_minor, committed_minor, reserved_minor) VALUES (?, ?, ?, 0, 0)',
      )
      .run(id, ceiling.currency, ceiling.minorUnits);
    return { id, currency: ceiling.currency, items: [] };
  }

  getList(id: ListId): ShoppingList | undefined {
    const row = this.#listRow(id);
    if (row === undefined) return undefined;
    return {
      id,
      currency: row.currency as Currency,
      items: this.#itemsOf(id, row.currency as Currency),
    };
  }

  listLists(): ShoppingList[] {
    const rows = this.#db.prepare('SELECT id FROM lists ORDER BY id').all() as { id: string }[];
    return rows.flatMap((row) => {
      const list = this.getList(asId<ListId>(row.id));
      return list === undefined ? [] : [list];
    });
  }

  addItem(listId: ListId, item: Item): Item {
    const list = this.#requireRow(listId);
    if (this.#db.prepare('SELECT id FROM items WHERE id = ?').get(item.id) !== undefined) {
      throw new StoreError('duplicate_item', `Item ${item.id} is already on list ${listId}.`);
    }
    if (item.maxUnitPrice !== undefined && item.maxUnitPrice.currency !== list.currency) {
      throw new StoreError(
        'currency_mismatch',
        `Item cap is in ${item.maxUnitPrice.currency} but list ${listId} is in ${list.currency}.`,
      );
    }
    const { count } = this.#db
      .prepare('SELECT COUNT(*) AS count FROM items WHERE list_id = ?')
      .get(listId) as { count: number };

    this.#db
      .prepare(
        `INSERT INTO items (id, list_id, description, quantity, required, max_unit_price_minor, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        listId,
        item.description,
        item.quantity,
        item.required ? 1 : 0,
        item.maxUnitPrice?.minorUnits ?? null,
        count,
      );
    return item;
  }

  getBudget(listId: ListId): Budget | undefined {
    const row = this.#listRow(listId);
    if (row === undefined) return undefined;
    const currency = row.currency as Currency;
    return {
      ceiling: money(row.ceiling_minor, currency),
      committed: money(row.committed_minor, currency),
      reserved: money(row.reserved_minor, currency),
    };
  }

  putBudget(listId: ListId, budget: Budget): void {
    const row = this.#requireRow(listId);
    if (budget.ceiling.currency !== row.currency) {
      throw new StoreError(
        'currency_mismatch',
        `Budget is in ${budget.ceiling.currency} but list ${listId} is in ${row.currency}.`,
      );
    }
    this.#db
      .prepare(
        'UPDATE lists SET ceiling_minor = ?, committed_minor = ?, reserved_minor = ? WHERE id = ?',
      )
      .run(
        budget.ceiling.minorUnits,
        budget.committed.minorUnits,
        budget.reserved.minorUnits,
        listId,
      );
  }

  recordCandidate(listId: ListId, candidate: Candidate): Candidate {
    const list = this.#requireRow(listId);
    if (
      this.#db.prepare('SELECT id FROM candidates WHERE id = ?').get(candidate.id) !== undefined
    ) {
      throw new StoreError('duplicate_candidate', `Candidate ${candidate.id} is already recorded.`);
    }
    const item = this.#db
      .prepare('SELECT id FROM items WHERE id = ? AND list_id = ?')
      .get(candidate.itemId, listId);
    if (item === undefined) {
      throw new StoreError(
        'item_not_found',
        `Item ${candidate.itemId} is not on list ${listId}; add it before recording candidates.`,
      );
    }
    if (candidate.unitPrice.currency !== list.currency) {
      throw new StoreError(
        'currency_mismatch',
        `Candidate is priced in ${candidate.unitPrice.currency} but list ${listId} is in ${list.currency}.`,
      );
    }
    const { count } = this.#db
      .prepare('SELECT COUNT(*) AS count FROM candidates WHERE list_id = ?')
      .get(listId) as { count: number };

    this.#db
      .prepare(
        `INSERT INTO candidates
           (id, list_id, item_id, source, title, url, unit_price_minor, shipping_minor, availability, recorded_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        candidate.id,
        listId,
        candidate.itemId,
        candidate.source,
        candidate.title,
        candidate.url,
        candidate.unitPrice.minorUnits,
        candidate.shipping.minorUnits,
        candidate.availability,
        count,
      );
    return candidate;
  }

  getCandidate(listId: ListId, id: CandidateId): Candidate | undefined {
    const row = this.#listRow(listId);
    if (row === undefined) return undefined;
    const candidate = this.#db
      .prepare('SELECT * FROM candidates WHERE list_id = ? AND id = ?')
      .get(listId, id) as CandidateRow | undefined;
    return candidate === undefined
      ? undefined
      : this.#toCandidate(candidate, row.currency as Currency);
  }

  listCandidates(listId: ListId, itemId?: ItemId): Candidate[] {
    const list = this.#requireRow(listId);
    const currency = list.currency as Currency;
    const rows =
      itemId === undefined
        ? (this.#db
            .prepare('SELECT * FROM candidates WHERE list_id = ? ORDER BY recorded_seq')
            .all(listId) as unknown as CandidateRow[])
        : (this.#db
            .prepare(
              'SELECT * FROM candidates WHERE list_id = ? AND item_id = ? ORDER BY recorded_seq',
            )
            .all(listId, itemId) as unknown as CandidateRow[]);
    return rows.map((row) => this.#toCandidate(row, currency));
  }

  #toCandidate(row: CandidateRow, currency: Currency): Candidate {
    return {
      id: asId<CandidateId>(row.id),
      itemId: asId<ItemId>(row.item_id),
      source: row.source,
      title: row.title,
      url: row.url,
      unitPrice: money(row.unit_price_minor, currency),
      shipping: money(row.shipping_minor, currency),
      availability: row.availability as Availability,
    };
  }

  #itemsOf(listId: ListId, currency: Currency): Item[] {
    const rows = this.#db
      .prepare('SELECT * FROM items WHERE list_id = ? ORDER BY position')
      .all(listId) as unknown as ItemRow[];
    return rows.map((row) => ({
      id: asId<ItemId>(row.id),
      description: row.description,
      quantity: row.quantity,
      required: row.required === 1,
      // exactOptionalPropertyTypes: omit the key entirely rather than set undefined.
      ...(row.max_unit_price_minor === null
        ? {}
        : { maxUnitPrice: money(row.max_unit_price_minor, currency) }),
    }));
  }

  #listRow(id: ListId): ListRow | undefined {
    return this.#db.prepare('SELECT * FROM lists WHERE id = ?').get(id) as ListRow | undefined;
  }

  #requireRow(id: ListId): ListRow {
    const row = this.#listRow(id);
    if (row === undefined) throw new StoreError('list_not_found', `List ${id} not found.`);
    return row;
  }
}
