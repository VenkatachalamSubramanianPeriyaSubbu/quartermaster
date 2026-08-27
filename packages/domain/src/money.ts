/**
 * Money as integer minor units.
 *
 * There are no floating-point amounts anywhere in Quartermaster. `0.1 + 0.2`
 * is not `0.3`, and an agent that spends a fraction of a cent more than the
 * ceiling on every line eventually spends real money it was not authorised to
 * spend. Every amount here is an integer count of the currency's smallest unit
 * — cents, pence — and arithmetic that cannot be represented exactly throws
 * rather than rounding silently.
 */

export const CURRENCIES = ['USD', 'EUR', 'GBP'] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface Money {
  /** Integer count of the currency's smallest unit. 1234 USD = $12.34. */
  readonly minorUnits: number;
  readonly currency: Currency;
}

/** Minor units per major unit. All three supported currencies use 100. */
const MINOR_UNITS_PER_MAJOR = 100;

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: Currency,
    readonly right: Currency,
  ) {
    super(`Cannot combine ${left} with ${right}`);
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * Construct an amount.
 *
 * Throws on non-integer or unsafe input: a fractional minor unit is always a
 * bug at the call site, not a value to round away.
 */
export function money(minorUnits: number, currency: Currency): Money {
  if (!Number.isInteger(minorUnits)) {
    throw new TypeError(`Money requires integer minor units, received ${String(minorUnits)}`);
  }
  if (!Number.isSafeInteger(minorUnits)) {
    throw new RangeError(`Money amount exceeds safe integer range: ${String(minorUnits)}`);
  }
  return { minorUnits, currency };
}

/** Convenience for literals in tests and fixtures: `fromMajor(12.34, 'USD')`. */
export function fromMajor(majorUnits: number, currency: Currency): Money {
  const scaled = majorUnits * MINOR_UNITS_PER_MAJOR;
  // Guard the float that got us here before it reaches anything that matters.
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new TypeError(`${String(majorUnits)} ${currency} does not divide into whole minor units`);
  }
  return money(rounded, currency);
}

export function zero(currency: Currency): Money {
  return { minorUnits: 0, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minorUnits + b.minorUnits, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minorUnits - b.minorUnits, a.currency);
}

/** Multiply by a whole quantity. Fractional quantities are not a thing we buy. */
export function multiply(amount: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new TypeError(`Quantity must be an integer, received ${String(quantity)}`);
  }
  return money(amount.minorUnits * quantity, amount.currency);
}

/**
 * Take a percentage expressed in basis points, rounding half away from zero.
 *
 * Basis points rather than percent so tax rates like 8.25% stay integers
 * (825 bp) and never introduce a float. Rounding is explicit because tax
 * always has to land on a whole minor unit somehow.
 */
export function percentOf(amount: Money, basisPoints: number): Money {
  if (!Number.isInteger(basisPoints)) {
    throw new TypeError(`Basis points must be an integer, received ${String(basisPoints)}`);
  }
  const exact = (amount.minorUnits * basisPoints) / 10_000;
  const rounded = exact < 0 ? -Math.round(-exact) : Math.round(exact);
  return money(rounded, amount.currency);
}

export function sum(amounts: readonly Money[], currency: Currency): Money {
  return amounts.reduce<Money>((total, amount) => add(total, amount), zero(currency));
}

/** -1 when a < b, 0 when equal, 1 when a > b. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minorUnits < b.minorUnits) return -1;
  if (a.minorUnits > b.minorUnits) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minorUnits === b.minorUnits;
}

export function greaterThan(a: Money, b: Money): boolean {
  return compare(a, b) === 1;
}

export function lessThan(a: Money, b: Money): boolean {
  return compare(a, b) === -1;
}

export function atLeast(a: Money, b: Money): boolean {
  return compare(a, b) >= 0;
}

export function isNegative(amount: Money): boolean {
  return amount.minorUnits < 0;
}

export function isZero(amount: Money): boolean {
  return amount.minorUnits === 0;
}

export function max(a: Money, b: Money): Money {
  return greaterThan(a, b) ? a : b;
}

const SYMBOLS: Record<Currency, string> = { USD: '$', EUR: '€', GBP: '£' };

/** Human-readable form for the approval console and log lines. */
export function format(amount: Money): string {
  const negative = amount.minorUnits < 0;
  const absolute = Math.abs(amount.minorUnits);
  const major = Math.floor(absolute / MINOR_UNITS_PER_MAJOR);
  const minor = absolute % MINOR_UNITS_PER_MAJOR;
  const body = `${SYMBOLS[amount.currency]}${String(major)}.${String(minor).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}
