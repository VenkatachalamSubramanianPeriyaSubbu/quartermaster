declare const brand: unique symbol;

/**
 * Nominal typing helper. Two `string` aliases are interchangeable to the
 * compiler; two branded strings are not. Quartermaster passes a lot of opaque
 * identifiers between the harness, the ledger, and the merchant, and mixing an
 * order id with a session id is exactly the class of bug that only shows up
 * once real money is in play.
 */
export type Brand<T, TBrand extends string> = T & { readonly [brand]: TBrand };

export type SessionId = Brand<string, 'SessionId'>;
export type ListId = Brand<string, 'ListId'>;
export type ItemId = Brand<string, 'ItemId'>;
export type CandidateId = Brand<string, 'CandidateId'>;
export type OrderId = Brand<string, 'OrderId'>;

/**
 * Assert that an untrusted string is a branded id of a given kind.
 *
 * The brand is a compile-time fiction, so this only checks the shape every id
 * in the system shares. It exists so the cast happens in exactly one place
 * rather than being scattered across call sites.
 */
// `TId` appears only in the return position by design: this is the single
// sanctioned cast from an untrusted string into a branded id. Widening the
// signature to satisfy the rule would defeat the purpose of the helper.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function asId<TId extends Brand<string, string>>(value: string): TId {
  if (value.length === 0) {
    throw new TypeError('Identifier must be a non-empty string');
  }
  return value as TId;
}
