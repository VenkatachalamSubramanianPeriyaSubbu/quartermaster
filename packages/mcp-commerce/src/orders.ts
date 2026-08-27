import { err, ok, type Result } from '@quartermaster/shared';
import type { ListId, OrderId } from '@quartermaster/shared';
import {
  availableOf,
  format,
  orderTotals,
  release,
  reserve,
  settle,
  validateOrderDraft,
  type OrderLine,
  type OrderViolation,
} from '@quartermaster/domain';
import type { Merchant, MerchantFailure } from './merchant.js';
import type { Store, StoredOrder } from './store.js';

/**
 * The order lifecycle.
 *
 * draft ── reserve_funds ──▶ reserved ── checkout ──▶ settled
 *   │                            │
 *   └──── cancel ────────────────┴──────▶ cancelled
 *
 * Only the transition into `settled` is irreversible, and it is the only one
 * that touches a merchant. Everything before it can be undone by releasing the
 * reservation, which is why the human gate sits on checkout rather than on
 * draft creation.
 */

export type OrderFailureCode =
  | 'list_not_found'
  | 'order_not_found'
  | 'duplicate_order'
  | 'invalid_state'
  | 'validation_failed'
  | 'budget_rejected'
  | 'settlement_failed';

export interface OrderFailure {
  readonly code: OrderFailureCode;
  readonly message: string;
  /** Present when the domain rejected the order, so the agent can fix each one. */
  readonly violations?: readonly OrderViolation[];
}

function fail(code: OrderFailureCode, message: string): Result<never, OrderFailure> {
  return err({ code, message });
}

/**
 * Re-validate an order against current state.
 *
 * Called on draft creation *and* again at checkout. The second pass is not
 * redundant: prices, stock, and the remaining budget can all move between the
 * agent proposing an order and a human approving it, and the figures a person
 * approved must be the figures that get charged.
 */
function revalidate(store: Store, order: StoredOrder): Result<StoredOrder, OrderFailure> {
  const list = store.getList(order.listId);
  const budget = store.getBudget(order.listId);
  if (list === undefined || budget === undefined) {
    return fail('list_not_found', `List ${order.listId} not found.`);
  }

  // Funds this order already holds are not competition with itself.
  const budgetForCheck =
    order.status === 'reserved'
      ? { ...budget, reserved: subtractOwnHold(budget.reserved, order) }
      : budget;

  const result = validateOrderDraft({
    draft: { id: order.id, listId: order.listId, lines: order.lines },
    list,
    candidates: store.listCandidates(order.listId),
    budget: budgetForCheck,
  });

  if (!result.ok) {
    return err({
      code: 'validation_failed',
      message: `Order ${order.id} is no longer valid: ${String(result.error.length)} problem(s).`,
      violations: result.error,
    });
  }
  return ok({ ...order, total: result.value.total });
}

/** Remove this order's own reservation from the pool it is checked against. */
function subtractOwnHold(reserved: StoredOrder['total'], order: StoredOrder): StoredOrder['total'] {
  return {
    minorUnits: Math.max(0, reserved.minorUnits - order.total.minorUnits),
    currency: reserved.currency,
  };
}

export interface CreateDraftInput {
  readonly listId: ListId;
  readonly orderId: OrderId;
  readonly lines: readonly OrderLine[];
}

export function createDraft(
  store: Store,
  { listId, orderId, lines }: CreateDraftInput,
): Result<StoredOrder, OrderFailure> {
  const list = store.getList(listId);
  const budget = store.getBudget(listId);
  if (list === undefined || budget === undefined) {
    return fail('list_not_found', `List ${listId} not found.`);
  }
  if (store.getOrder(listId, orderId) !== undefined) {
    return fail('duplicate_order', `Order ${orderId} already exists. Use a new order id.`);
  }

  const validated = validateOrderDraft({
    draft: { id: orderId, listId, lines },
    list,
    candidates: store.listCandidates(listId),
    budget,
  });
  if (!validated.ok) {
    return err({
      code: 'validation_failed',
      message: `Order rejected with ${String(validated.error.length)} problem(s). Fix them and try again.`,
      violations: validated.error,
    });
  }

  const order: StoredOrder = {
    id: orderId,
    listId,
    status: 'draft',
    lines,
    total: validated.value.total,
  };
  store.putOrder(order);
  return ok(order);
}

export interface OrderRef {
  readonly listId: ListId;
  readonly orderId: OrderId;
}

/** Hold budget against a draft without spending it. Reversible. */
export function reserveFunds(
  store: Store,
  { listId, orderId }: OrderRef,
): Result<StoredOrder, OrderFailure> {
  const order = store.getOrder(listId, orderId);
  if (order === undefined) return fail('order_not_found', `Order ${orderId} not found.`);
  if (order.status !== 'draft') {
    return fail(
      'invalid_state',
      `Order ${orderId} is ${order.status}, so funds cannot be reserved.`,
    );
  }

  const revalidated = revalidate(store, order);
  if (!revalidated.ok) return revalidated;

  const budget = store.getBudget(listId);
  if (budget === undefined) return fail('list_not_found', `List ${listId} not found.`);

  const held = reserve(budget, revalidated.value.total);
  if (!held.ok) {
    return err({ code: 'budget_rejected', message: held.error.message });
  }

  store.putBudget(listId, held.value);
  const updated: StoredOrder = { ...revalidated.value, status: 'reserved' };
  store.putOrder(updated);
  return ok(updated);
}

/** Release any hold and close the order out. Always safe. */
export function cancelOrder(
  store: Store,
  { listId, orderId }: OrderRef,
): Result<StoredOrder, OrderFailure> {
  const order = store.getOrder(listId, orderId);
  if (order === undefined) return fail('order_not_found', `Order ${orderId} not found.`);
  if (order.status === 'settled') {
    return fail('invalid_state', `Order ${orderId} is already settled and cannot be cancelled.`);
  }
  if (order.status === 'cancelled') return ok(order);

  if (order.status === 'reserved') {
    const budget = store.getBudget(listId);
    if (budget === undefined) return fail('list_not_found', `List ${listId} not found.`);
    const freed = release(budget, order.total);
    if (!freed.ok) return err({ code: 'budget_rejected', message: freed.error.message });
    store.putBudget(listId, freed.value);
  }

  const updated: StoredOrder = { ...order, status: 'cancelled' };
  store.putOrder(updated);
  return ok(updated);
}

export interface CheckoutInput extends OrderRef {
  /**
   * Makes the whole operation safe to retry.
   *
   * A dropped response, a retried tool call, or an agent that loses track of
   * what it has already done must not cost the user twice.
   */
  readonly settlementKey: string;
}

export interface CheckoutOutcome {
  readonly order: StoredOrder;
  /** True when this call recognised an earlier settlement instead of charging. */
  readonly idempotentReplay: boolean;
}

/**
 * Settle an order. The only irreversible operation in the system.
 *
 * Ordering matters and is deliberate:
 *   1. recognise a replay and return the original receipt
 *   2. re-validate, because approved figures must be current figures
 *   3. reserve if not already reserved
 *   4. charge the merchant
 *   5. on success move reserved to committed; on failure release the hold
 *
 * Reserving *before* charging means a crash between the two leaves money held
 * rather than spent, which is the safe direction to fail in.
 */
export async function checkout(
  store: Store,
  merchant: Merchant,
  { listId, orderId, settlementKey }: CheckoutInput,
): Promise<Result<CheckoutOutcome, OrderFailure>> {
  const existing = store.findBySettlementKey(listId, settlementKey);
  if (existing !== undefined) {
    // Answer the replay without going near the merchant.
    return ok({ order: existing, idempotentReplay: true });
  }

  const order = store.getOrder(listId, orderId);
  if (order === undefined) return fail('order_not_found', `Order ${orderId} not found.`);
  if (order.status === 'settled') {
    return fail(
      'invalid_state',
      `Order ${orderId} is already settled under a different key. Do not settle it twice.`,
    );
  }
  if (order.status === 'cancelled') {
    return fail('invalid_state', `Order ${orderId} was cancelled and cannot be settled.`);
  }

  const revalidated = revalidate(store, order);
  if (!revalidated.ok) return revalidated;
  let current = revalidated.value;

  if (current.status === 'draft') {
    const held = reserveFunds(store, { listId, orderId });
    if (!held.ok) return held;
    current = held.value;
  }

  const settlement = await merchant.settle({
    orderId,
    amount: current.total,
    description: `Quartermaster order ${orderId} on list ${listId}`,
    idempotencyKey: settlementKey,
  });

  if (!settlement.ok) {
    // Give the money back. A declined payment must not leave the budget
    // permanently encumbered by an order that will never complete.
    const budget = store.getBudget(listId);
    if (budget !== undefined) {
      const freed = release(budget, current.total);
      if (freed.ok) store.putBudget(listId, freed.value);
    }
    store.putOrder({ ...current, status: 'draft' });
    return err({
      code: 'settlement_failed',
      message: settlementMessage(settlement.error),
    });
  }

  const budget = store.getBudget(listId);
  if (budget === undefined) return fail('list_not_found', `List ${listId} not found.`);
  const committed = settle(budget, current.total);
  if (!committed.ok) {
    return err({ code: 'budget_rejected', message: committed.error.message });
  }
  store.putBudget(listId, committed.value);

  const settled: StoredOrder = {
    ...current,
    status: 'settled',
    settlement: settlement.value,
    settlementKey,
  };
  store.putOrder(settled);
  return ok({ order: settled, idempotentReplay: false });
}

function settlementMessage(failure: MerchantFailure): string {
  return `Payment ${failure.code}: ${failure.message}`;
}

/** Human-readable summary of what approving an order would cost. */
export function describeSpend(store: Store, order: StoredOrder): string {
  const budget = store.getBudget(order.listId);
  if (budget === undefined) return format(order.total);
  const remaining = availableOf(budget);
  return `${format(order.total)} of ${format(remaining)} remaining`;
}

/** Recompute totals without touching the store. Used by the console. */
export function totalsFor(
  store: Store,
  order: StoredOrder,
): ReturnType<typeof orderTotals> | undefined {
  const list = store.getList(order.listId);
  if (list === undefined) return undefined;
  return orderTotals({ id: order.id, listId: order.listId, lines: order.lines }, list);
}
