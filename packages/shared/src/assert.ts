/**
 * Narrow a value to `never` so the compiler fails the build when a union grows
 * a member a switch does not handle.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unhandled union member: ${JSON.stringify(value)}`);
}

/**
 * Runtime precondition. Unlike `assertNever` this survives into production, and
 * is the guard budget-critical paths use before touching the merchant.
 *
 * Standard falsy semantics: `0` and `''` fail. Callers checking a numeric
 * budget should compare explicitly (`invariant(cents >= 0, ...)`) rather than
 * relying on truthiness, since a zero balance is a legitimate state.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
  if (!condition) {
    throw new Error(`Invariant failed: ${message}`);
  }
}
