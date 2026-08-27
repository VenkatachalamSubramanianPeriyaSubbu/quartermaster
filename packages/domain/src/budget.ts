import { err, ok, type Result } from '@quartermaster/shared';
import {
  add,
  atLeast,
  format,
  isNegative,
  subtract,
  zero,
  type Currency,
  type Money,
} from './money.js';
import type { Budget } from './types.js';

/**
 * The budget ledger.
 *
 * This module is the reason Quartermaster cannot overspend. The ceiling is not
 * a line in the system prompt that a persuasive turn can argue past — it is
 * arithmetic performed here, and `checkout_order` refuses when it fails. The
 * model is free to propose anything; it just cannot make this function say yes.
 */

export type BudgetViolationCode =
  'currency_mismatch' | 'negative_amount' | 'exceeds_available' | 'insufficient_reserved';

export interface BudgetViolation {
  readonly code: BudgetViolationCode;
  /** Phrased for the agent to read and act on, not for a stack trace. */
  readonly message: string;
  readonly requested?: Money;
  readonly available?: Money;
}

export function createBudget(ceiling: Money): Budget {
  if (isNegative(ceiling)) {
    throw new RangeError(`Budget ceiling cannot be negative: ${format(ceiling)}`);
  }
  return { ceiling, committed: zero(ceiling.currency), reserved: zero(ceiling.currency) };
}

export function budgetCurrency(budget: Budget): Currency {
  return budget.ceiling.currency;
}

/** Ceiling minus everything already spent or held. */
export function availableOf(budget: Budget): Money {
  return subtract(budget.ceiling, add(budget.committed, budget.reserved));
}

/** Spent plus held — what the ceiling is measured against. */
export function encumberedOf(budget: Budget): Money {
  return add(budget.committed, budget.reserved);
}

function guardAmount(budget: Budget, amount: Money): BudgetViolation | undefined {
  if (amount.currency !== budget.ceiling.currency) {
    return {
      code: 'currency_mismatch',
      message: `Amount is in ${amount.currency} but the budget is in ${budget.ceiling.currency}.`,
      requested: amount,
    };
  }
  if (isNegative(amount)) {
    return {
      code: 'negative_amount',
      message: `Amount cannot be negative: ${format(amount)}.`,
      requested: amount,
    };
  }
  return undefined;
}

/**
 * Can this amount be spent right now?
 *
 * Returns the remaining headroom on success so callers can report it without
 * recomputing, which is what the approval console shows next to the button.
 */
export function canAfford(budget: Budget, amount: Money): Result<Money, BudgetViolation> {
  const invalid = guardAmount(budget, amount);
  if (invalid !== undefined) return err(invalid);

  const available = availableOf(budget);
  if (!atLeast(available, amount)) {
    return err({
      code: 'exceeds_available',
      message: `${format(amount)} exceeds the remaining budget of ${format(available)}.`,
      requested: amount,
      available,
    });
  }
  return ok(subtract(available, amount));
}

/**
 * Hold funds against a pending order.
 *
 * Reserving before the purchase — rather than checking at settlement — is what
 * makes two orders in flight at once safe. The second one sees headroom the
 * first has already taken.
 */
export function reserve(budget: Budget, amount: Money): Result<Budget, BudgetViolation> {
  const affordable = canAfford(budget, amount);
  if (!affordable.ok) return err(affordable.error);
  return ok({ ...budget, reserved: add(budget.reserved, amount) });
}

/** Give held funds back, e.g. when the human denies the purchase. */
export function release(budget: Budget, amount: Money): Result<Budget, BudgetViolation> {
  const invalid = guardAmount(budget, amount);
  if (invalid !== undefined) return err(invalid);

  if (!atLeast(budget.reserved, amount)) {
    return err({
      code: 'insufficient_reserved',
      message: `Cannot release ${format(amount)}; only ${format(budget.reserved)} is reserved.`,
      requested: amount,
      available: budget.reserved,
    });
  }
  return ok({ ...budget, reserved: subtract(budget.reserved, amount) });
}

/**
 * Convert a reservation into a completed spend.
 *
 * Moves the amount from reserved to committed, leaving the total encumbered
 * unchanged — settling must never create headroom that did not exist a moment
 * earlier.
 */
export function settle(budget: Budget, amount: Money): Result<Budget, BudgetViolation> {
  const released = release(budget, amount);
  if (!released.ok) return released;
  return ok({
    ...released.value,
    committed: add(released.value.committed, amount),
  });
}
