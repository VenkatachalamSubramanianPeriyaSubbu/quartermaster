import { DatabaseSync } from 'node:sqlite';
import {
  asId,
  type CandidateId,
  type ItemId,
  type ListId,
  type OrderId,
} from '@quartermaster/shared';
import {
  money,
  type Availability,
  type Budget,
  type Candidate,
  type Currency,
  type Item,
  type ShoppingList,
} from '@quartermaster/domain';
import {
  StoreError,
  type NewList,
  type OrderStatus,
  type Store,
  type StoredOrder,
} from './store.js';

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

CREATE TABLE IF NOT EXISTS orders (
  id                  TEXT PRIMARY KEY,
  list_id             TEXT    NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  status              TEXT    NOT NULL,
  total_minor         INTEGER NOT NULL,
  settlement_key      TEXT,
  settlement_ref      TEXT,
  settlement_at       TEXT,
  settlement_provider TEXT,
  created_seq         INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS order_lines (
  order_id          TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id           TEXT    NOT NULL,
  candidate_id      TEXT    NOT NULL,
  quantity          INTEGER NOT NULL,
  unit_price_minor  INTEGER NOT NULL,
  shipping_minor    INTEGER NOT NULL,
  position          INTEGER NOT NULL,
  PRIMARY KEY (order_id, position)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id, position);
CREATE INDEX IF NOT EXISTS idx_candidates_list ON candidates(list_id, recorded_seq);
CREATE INDEX IF NOT EXISTS idx_candidates_item ON candidates(list_id, item_id);
CREATE INDEX IF NOT EXISTS idx_orders_list ON orders(list_id, created_seq);

-- A settlement key must be unique per list, enforced by the database rather
-- than by application logic. This is the last line of defence against a
-- double charge: even a race between two checkout calls cannot produce two
-- settled orders under the same key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_settlement_key
  ON orders(list_id, settlement_key) WHERE settlement_key IS NOT NULL;
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

interface OrderRow {
  id: string;
  list_id: string;
  status: string;
  total_minor: number;
  settlement_key: string | null;
  settlement_ref: string | null;
  settlement_at: string | null;
  settlement_provider: string | null;
}

interface OrderLineRow {
  item_id: string;
  candidate_id: string;
  quantity: number;
  unit_price_minor: number;
  shipping_minor: number;
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

  putOrder(order: StoredOrder): void {
    const list = this.#requireRow(order.listId);
    const existing = this.#db
      .prepare('SELECT created_seq FROM orders WHERE id = ?')
      .get(order.id) as { created_seq: number } | undefined;
    const seq =
      existing?.created_seq ??
      (
        this.#db
          .prepare('SELECT COUNT(*) AS count FROM orders WHERE list_id = ?')
          .get(order.listId) as {
          count: number;
        }
      ).count;

    if (order.total.currency !== list.currency) {
      throw new StoreError(
        'currency_mismatch',
        `Order total is in ${order.total.currency} but list ${order.listId} is in ${list.currency}.`,
      );
    }

    // Whole-order write: replacing the header and its lines together means a
    // partially-written order can never be observed.
    this.#db.exec('BEGIN');
    try {
      this.#db
        .prepare(
          `INSERT INTO orders
             (id, list_id, status, total_minor, settlement_key, settlement_ref,
              settlement_at, settlement_provider, created_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             total_minor = excluded.total_minor,
             settlement_key = excluded.settlement_key,
             settlement_ref = excluded.settlement_ref,
             settlement_at = excluded.settlement_at,
             settlement_provider = excluded.settlement_provider`,
        )
        .run(
          order.id,
          order.listId,
          order.status,
          order.total.minorUnits,
          order.settlementKey ?? null,
          order.settlement?.reference ?? null,
          order.settlement?.settledAt ?? null,
          order.settlement?.provider ?? null,
          seq,
        );

      this.#db.prepare('DELETE FROM order_lines WHERE order_id = ?').run(order.id);
      const insertLine = this.#db.prepare(
        `INSERT INTO order_lines
           (order_id, item_id, candidate_id, quantity, unit_price_minor, shipping_minor, position)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      order.lines.forEach((line, index) => {
        insertLine.run(
          order.id,
          line.itemId,
          line.candidateId,
          line.quantity,
          line.unitPrice.minorUnits,
          line.shipping.minorUnits,
          index,
        );
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  getOrder(listId: ListId, id: OrderId): StoredOrder | undefined {
    const list = this.#listRow(listId);
    if (list === undefined) return undefined;
    const row = this.#db
      .prepare('SELECT * FROM orders WHERE list_id = ? AND id = ?')
      .get(listId, id) as OrderRow | undefined;
    return row === undefined ? undefined : this.#toOrder(row, list.currency as Currency);
  }

  listOrders(listId: ListId): StoredOrder[] {
    const list = this.#requireRow(listId);
    const rows = this.#db
      .prepare('SELECT * FROM orders WHERE list_id = ? ORDER BY created_seq')
      .all(listId) as unknown as OrderRow[];
    return rows.map((row) => this.#toOrder(row, list.currency as Currency));
  }

  findBySettlementKey(listId: ListId, settlementKey: string): StoredOrder | undefined {
    const list = this.#listRow(listId);
    if (list === undefined) return undefined;
    const row = this.#db
      .prepare('SELECT * FROM orders WHERE list_id = ? AND settlement_key = ?')
      .get(listId, settlementKey) as OrderRow | undefined;
    return row === undefined ? undefined : this.#toOrder(row, list.currency as Currency);
  }

  #toOrder(row: OrderRow, currency: Currency): StoredOrder {
    const lines = this.#db
      .prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY position')
      .all(row.id) as unknown as OrderLineRow[];

    const settlement =
      row.settlement_ref === null || row.settlement_at === null || row.settlement_provider === null
        ? undefined
        : {
            reference: row.settlement_ref,
            amount: money(row.total_minor, currency),
            settledAt: row.settlement_at,
            provider: row.settlement_provider,
          };

    return {
      id: asId<OrderId>(row.id),
      listId: asId<ListId>(row.list_id),
      status: row.status as OrderStatus,
      total: money(row.total_minor, currency),
      lines: lines.map((line) => ({
        itemId: asId<ItemId>(line.item_id),
        candidateId: asId<CandidateId>(line.candidate_id),
        quantity: line.quantity,
        unitPrice: money(line.unit_price_minor, currency),
        shipping: money(line.shipping_minor, currency),
      })),
      // exactOptionalPropertyTypes: omit rather than set undefined.
      ...(settlement === undefined ? {} : { settlement }),
      ...(row.settlement_key === null ? {} : { settlementKey: row.settlement_key }),
    };
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
