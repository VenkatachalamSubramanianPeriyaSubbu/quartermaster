import { describe, expect, it } from 'vitest';
import {
  CurrencyMismatchError,
  add,
  atLeast,
  compare,
  equals,
  format,
  fromMajor,
  greaterThan,
  isNegative,
  isZero,
  lessThan,
  max,
  money,
  multiply,
  percentOf,
  subtract,
  sum,
  zero,
} from './money.js';

describe('money construction', () => {
  it('accepts whole minor units', () => {
    expect(money(1234, 'USD')).toEqual({ minorUnits: 1234, currency: 'USD' });
  });

  it('rejects fractional minor units', () => {
    expect(() => money(10.5, 'USD')).toThrow(TypeError);
  });

  it('rejects amounts beyond safe integer range', () => {
    expect(() => money(Number.MAX_SAFE_INTEGER + 2, 'USD')).toThrow(RangeError);
  });

  it('rejects NaN and Infinity', () => {
    expect(() => money(Number.NaN, 'USD')).toThrow(TypeError);
    expect(() => money(Number.POSITIVE_INFINITY, 'USD')).toThrow(TypeError);
  });

  it('permits negative amounts, which refunds and releases need', () => {
    expect(money(-500, 'USD').minorUnits).toBe(-500);
  });
});

describe('fromMajor', () => {
  it('converts major units to minor', () => {
    expect(fromMajor(12.34, 'USD')).toEqual({ minorUnits: 1234, currency: 'USD' });
  });

  it('survives the classic float representation problem', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. The whole reason this module
    // stores integers.
    expect(fromMajor(0.1, 'USD').minorUnits + fromMajor(0.2, 'USD').minorUnits).toBe(
      fromMajor(0.3, 'USD').minorUnits,
    );
  });

  it('rejects amounts finer than a minor unit', () => {
    expect(() => fromMajor(1.005, 'USD')).toThrow(TypeError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts', () => {
    expect(add(money(1000, 'USD'), money(250, 'USD')).minorUnits).toBe(1250);
    expect(subtract(money(1000, 'USD'), money(250, 'USD')).minorUnits).toBe(750);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money(100, 'USD'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
    expect(() => subtract(money(100, 'GBP'), money(100, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => compare(money(100, 'USD'), money(100, 'EUR'))).toThrow(CurrencyMismatchError);
  });

  it('multiplies by a whole quantity', () => {
    expect(multiply(money(1999, 'USD'), 3).minorUnits).toBe(5997);
  });

  it('rejects fractional quantities', () => {
    expect(() => multiply(money(1000, 'USD'), 1.5)).toThrow(TypeError);
  });

  it('sums an empty list to zero', () => {
    expect(sum([], 'EUR')).toEqual({ minorUnits: 0, currency: 'EUR' });
  });

  it('sums a list', () => {
    expect(sum([money(100, 'USD'), money(250, 'USD'), money(5, 'USD')], 'USD').minorUnits).toBe(
      355,
    );
  });
});

describe('percentOf', () => {
  it('applies a basis-point rate', () => {
    // 8.25% sales tax on $100.00 is $8.25
    expect(percentOf(money(10_000, 'USD'), 825).minorUnits).toBe(825);
  });

  it('rounds half away from zero', () => {
    // 10.5 minor units rounds to 11, not down to 10.
    expect(percentOf(money(210, 'USD'), 500).minorUnits).toBe(11);
  });

  it('rounds negatives symmetrically', () => {
    expect(percentOf(money(-210, 'USD'), 500).minorUnits).toBe(-11);
  });

  it('rejects fractional basis points', () => {
    expect(() => percentOf(money(100, 'USD'), 8.25)).toThrow(TypeError);
  });

  it('always yields a whole minor unit', () => {
    for (const amount of [1, 7, 33, 99, 1234, 99_999]) {
      for (const bp of [1, 250, 825, 2000]) {
        expect(Number.isInteger(percentOf(money(amount, 'USD'), bp).minorUnits)).toBe(true);
      }
    }
  });
});

describe('comparison', () => {
  it('orders amounts', () => {
    expect(compare(money(1, 'USD'), money(2, 'USD'))).toBe(-1);
    expect(compare(money(2, 'USD'), money(2, 'USD'))).toBe(0);
    expect(compare(money(3, 'USD'), money(2, 'USD'))).toBe(1);
  });

  it('exposes readable predicates', () => {
    expect(greaterThan(money(3, 'USD'), money(2, 'USD'))).toBe(true);
    expect(lessThan(money(1, 'USD'), money(2, 'USD'))).toBe(true);
    expect(atLeast(money(2, 'USD'), money(2, 'USD'))).toBe(true);
    expect(isNegative(money(-1, 'USD'))).toBe(true);
    expect(isZero(zero('GBP'))).toBe(true);
    expect(max(money(5, 'USD'), money(9, 'USD')).minorUnits).toBe(9);
  });

  it('treats different currencies as unequal rather than throwing', () => {
    expect(equals(money(100, 'USD'), money(100, 'EUR'))).toBe(false);
  });
});

describe('format', () => {
  it.each([
    [money(1234, 'USD'), '$12.34'],
    [money(5, 'USD'), '$0.05'],
    [money(0, 'EUR'), '€0.00'],
    [money(100_000, 'GBP'), '£1000.00'],
    [money(-250, 'USD'), '-$2.50'],
  ])('formats %o as %s', (amount, expected) => {
    expect(format(amount)).toBe(expected);
  });
});
