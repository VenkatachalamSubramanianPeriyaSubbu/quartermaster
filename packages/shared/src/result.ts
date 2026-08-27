/**
 * A discriminated result.
 *
 * Quartermaster distinguishes two kinds of failure. Programming errors — a
 * currency mismatch, a non-integer amount — throw, because they mean the code
 * is wrong. Expected failures — over budget, out of stock, price moved — are
 * values, because the MCP tool has to hand them back to the agent as something
 * it can read and act on. An exception crossing the tool boundary just becomes
 * an opaque error string; a `Result` becomes a structured reason the model can
 * actually respond to.
 */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(
  result: Result<T, E>,
): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(
  result: Result<T, E>,
): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/**
 * Extract the value, throwing if the result is an error.
 *
 * For tests and for call sites that have already checked. Never use this to
 * paper over a failure that could legitimately happen at runtime.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw new Error(`Called unwrap on an error result: ${JSON.stringify(result.error)}`);
}

/** Transform the success value, leaving an error untouched. */
export function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/**
 * Collect many results into one.
 *
 * Returns every error rather than short-circuiting on the first, because a
 * rejected order should tell the agent everything that is wrong with it in a
 * single turn instead of one problem at a time.
 */
export function collect<T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return errors.length > 0 ? err(errors) : ok(values);
}
