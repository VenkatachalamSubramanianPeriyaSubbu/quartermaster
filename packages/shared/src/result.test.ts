import { describe, expect, it } from 'vitest';
import { collect, err, isErr, isOk, mapResult, ok, unwrap } from './result.js';

describe('Result', () => {
  it('carries a success value', () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(unwrap(result)).toBe(42);
  });

  it('carries an error value', () => {
    const result = err('over budget');
    expect(isErr(result)).toBe(true);
    expect(() => unwrap(result)).toThrow(/Called unwrap on an error result/);
  });

  it('narrows to the value branch', () => {
    const result = ok<number>(7);
    if (result.ok) {
      // Would not compile if the discriminant were not narrowing.
      expect(result.value + 1).toBe(8);
    }
  });

  it('maps over success only', () => {
    expect(unwrap(mapResult(ok(2), (n) => n * 3))).toBe(6);
    const mapped = mapResult(err<string>('boom'), (n: number) => n * 3);
    expect(isErr(mapped)).toBe(true);
  });
});

describe('collect', () => {
  it('gathers all values when everything succeeds', () => {
    expect(unwrap(collect([ok(1), ok(2), ok(3)]))).toEqual([1, 2, 3]);
  });

  it('reports every error rather than only the first', () => {
    // An order with three problems should tell the agent all three at once,
    // not force three round trips.
    const result = collect([ok(1), err('a'), ok(2), err('b')]);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toEqual(['a', 'b']);
  });

  it('treats an empty list as success', () => {
    expect(unwrap(collect<number, string>([]))).toEqual([]);
  });
});
