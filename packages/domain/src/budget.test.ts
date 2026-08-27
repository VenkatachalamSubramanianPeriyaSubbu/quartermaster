import { describe, expect, it } from 'vitest';
import { isErr, unwrap } from '@quartermaster/shared';
import {
  availableOf,
  canAfford,
  createBudget,
  encumberedOf,
  release,
  reserve,
  settle,
} from './budget.js';
import { money, zero } from './money.js';

const usd = (minorUnits: number) => money(minorUnits, 'USD');
const budget100 = createBudget(usd(10_000)); // $100.00

describe('createBudget', () => {
  it('starts with nothing spent or held', () => {
    expect(budget100.committed).toEqual(zero('USD'));
    expect(budget100.reserved).toEqual(zero('USD'));
    expect(availableOf(budget100)).toEqual(usd(10_000));
  });

  it('refuses a negative ceiling', () => {
    expect(() => createBudget(usd(-1))).toThrow(RangeError);
  });

  it('permits a zero ceiling', () => {
    expect(availableOf(createBudget(zero('USD')))).toEqual(zero('USD'));
  });
});

describe('canAfford', () => {
  it('allows a spend within the ceiling and reports the remainder', () => {
    expect(unwrap(canAfford(budget100, usd(2500)))).toEqual(usd(7500));
  });

  it('allows spending the budget down to exactly zero', () => {
    expect(unwrap(canAfford(budget100, usd(10_000)))).toEqual(zero('USD'));
  });

  it('refuses one minor unit over the ceiling', () => {
    // The boundary that matters. Off by one cent is still overspending.
    const result = canAfford(budget100, usd(10_001));
    expect(isErr(result)).toBe(true);
    if (!result.ok) {
      expect(result.error.code).toBe('exceeds_available');
      expect(result.error.message).toContain('$100.01');
      expect(result.error.message).toContain('$100.00');
    }
  });

  it('refuses a different currency', () => {
    const result = canAfford(budget100, money(100, 'EUR'));
    if (!result.ok) expect(result.error.code).toBe('currency_mismatch');
    else throw new Error('expected a currency mismatch');
  });

  it('refuses a negative amount', () => {
    // Otherwise "spending" a negative amount would inflate the budget.
    const result = canAfford(budget100, usd(-500));
    if (!result.ok) expect(result.error.code).toBe('negative_amount');
    else throw new Error('expected a negative amount rejection');
  });
});

describe('reserve', () => {
  it('holds funds and reduces what is available', () => {
    const held = unwrap(reserve(budget100, usd(3000)));
    expect(held.reserved).toEqual(usd(3000));
    expect(availableOf(held)).toEqual(usd(7000));
    expect(held.committed).toEqual(zero('USD'));
  });

  it('stops a second reservation from spending the same headroom twice', () => {
    // The concurrency case: two orders in flight must not both be approved
    // against the same $100.
    const first = unwrap(reserve(budget100, usd(6000)));
    const second = reserve(first, usd(6000));
    expect(isErr(second)).toBe(true);
    if (!second.ok) expect(second.error.available).toEqual(usd(4000));
  });

  it('permits reservations that exactly exhaust the budget', () => {
    const first = unwrap(reserve(budget100, usd(6000)));
    const second = unwrap(reserve(first, usd(4000)));
    expect(availableOf(second)).toEqual(zero('USD'));
    expect(encumberedOf(second)).toEqual(usd(10_000));
  });
});

describe('release', () => {
  it('returns held funds when a purchase is denied', () => {
    const held = unwrap(reserve(budget100, usd(3000)));
    const freed = unwrap(release(held, usd(3000)));
    expect(freed.reserved).toEqual(zero('USD'));
    expect(availableOf(freed)).toEqual(usd(10_000));
  });

  it('refuses to release more than is held', () => {
    const held = unwrap(reserve(budget100, usd(1000)));
    const result = release(held, usd(2000));
    if (!result.ok) expect(result.error.code).toBe('insufficient_reserved');
    else throw new Error('expected an insufficient reserved error');
  });
});

describe('settle', () => {
  it('moves funds from reserved to committed without changing the total', () => {
    const held = unwrap(reserve(budget100, usd(2500)));
    const settled = unwrap(settle(held, usd(2500)));
    expect(settled.reserved).toEqual(zero('USD'));
    expect(settled.committed).toEqual(usd(2500));
    // Settling must not conjure headroom that did not exist a moment earlier.
    expect(encumberedOf(settled)).toEqual(encumberedOf(held));
    expect(availableOf(settled)).toEqual(usd(7500));
  });

  it('refuses to settle what was never reserved', () => {
    const result = settle(budget100, usd(500));
    if (!result.ok) expect(result.error.code).toBe('insufficient_reserved');
    else throw new Error('expected settlement to require a reservation');
  });

  it('holds the ceiling across a long sequence of operations', () => {
    let current = createBudget(usd(10_000));
    for (let i = 0; i < 20; i += 1) {
      const held = reserve(current, usd(700));
      if (!held.ok) break;
      const settled = settle(held.value, usd(700));
      current = settled.ok ? settled.value : held.value;
      // The invariant, checked at every step.
      expect(availableOf(current).minorUnits).toBeGreaterThanOrEqual(0);
      expect(encumberedOf(current).minorUnits).toBeLessThanOrEqual(10_000);
    }
    expect(current.committed).toEqual(usd(9800));
    expect(availableOf(current)).toEqual(usd(200));
  });
});
