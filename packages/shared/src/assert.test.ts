import { describe, expect, it } from 'vitest';
import { assertNever, invariant } from './assert.js';

describe('invariant', () => {
  it('passes through when the condition holds', () => {
    expect(() => {
      invariant(true, 'should not throw');
    }).not.toThrow();
  });

  it('throws with the supplied message', () => {
    expect(() => {
      invariant(false, 'budget ceiling missing');
    }).toThrow('Invariant failed: budget ceiling missing');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(() => {
      // Passing non-boolean falsy values is the whole point of this case.
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
      invariant(value, 'falsy');
    }).toThrow(/Invariant failed/);
  });

  it('narrows the type for callers', () => {
    const maybe: string | undefined = 'present';
    invariant(maybe, 'value required');
    // If the assertion signature regressed this line would not compile.
    expect(maybe.length).toBe(7);
  });
});

describe('assertNever', () => {
  it('throws describing the unhandled value', () => {
    expect(() => assertNever('surprise' as never)).toThrow(/Unhandled union member/);
  });

  it('prefers an explicit message when given one', () => {
    expect(() => assertNever('surprise' as never, 'unknown tool state')).toThrow(
      'unknown tool state',
    );
  });
});
