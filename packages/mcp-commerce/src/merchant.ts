import { err, ok, type Result } from '@quartermaster/shared';
import { format, type Money } from '@quartermaster/domain';

/**
 * The settlement seam.
 *
 * Quartermaster never completes a purchase at a live retailer. Defeating
 * anti-bot systems is neither interesting nor demonstrable, and a demo that
 * depends on it is a demo that fails on stage. Instead settlement goes through
 * this interface, and what sits behind it is either a mock or Stripe running in
 * test mode.
 *
 * Keeping it an interface also means the test suite never touches a network,
 * which is what lets us assert things like "a declined card releases the
 * reservation" deterministically.
 */

export interface SettlementRequest {
  readonly orderId: string;
  readonly amount: Money;
  readonly description: string;
  /**
   * Caller-supplied key that makes settlement safe to retry.
   *
   * The same key must never produce a second charge. This is the difference
   * between a dropped response costing nothing and costing the user twice.
   */
  readonly idempotencyKey: string;
}

export interface Settlement {
  /** Provider-side reference, for reconciliation. */
  readonly reference: string;
  readonly amount: Money;
  readonly settledAt: string;
  readonly provider: string;
}

export type MerchantFailureCode = 'declined' | 'provider_error' | 'amount_mismatch';

export interface MerchantFailure {
  readonly code: MerchantFailureCode;
  readonly message: string;
}

export interface Merchant {
  readonly name: string;
  settle(request: SettlementRequest): Promise<Result<Settlement, MerchantFailure>>;
}

export interface MockMerchantOptions {
  /**
   * Force the next settlements to fail. Used to prove the reservation is
   * released and the order returns to draft when a payment is declined.
   */
  readonly failWith?: MerchantFailure;
  /** Fixed timestamp so assertions do not depend on the clock. */
  readonly now?: () => string;
}

/**
 * Deterministic in-process merchant.
 *
 * The reference is derived from the idempotency key, so a retry with the same
 * key yields the same reference — the mock enforces the same contract we would
 * expect from a real provider rather than being permissive about it.
 */
export class MockMerchant implements Merchant {
  readonly name = 'mock';
  readonly #settled = new Map<string, Settlement>();
  #failWith: MerchantFailure | undefined;
  readonly #now: () => string;

  /** Every settlement attempt, including retries. Lets tests count charges. */
  readonly attempts: SettlementRequest[] = [];

  constructor(options: MockMerchantOptions = {}) {
    this.#failWith = options.failWith;
    this.#now = options.now ?? ((): string => new Date().toISOString());
  }

  /** Make subsequent settlements fail, or pass `undefined` to stop failing. */
  failNext(failure: MerchantFailure | undefined): void {
    this.#failWith = failure;
  }

  settle(request: SettlementRequest): Promise<Result<Settlement, MerchantFailure>> {
    this.attempts.push(request);

    const existing = this.#settled.get(request.idempotencyKey);
    if (existing !== undefined) {
      // A real provider returns the original charge rather than making a new
      // one. Mirroring that here is the point of the mock.
      return Promise.resolve(ok(existing));
    }

    if (this.#failWith !== undefined) {
      return Promise.resolve(err(this.#failWith));
    }

    const settlement: Settlement = {
      reference: `mock_${request.idempotencyKey}`,
      amount: request.amount,
      settledAt: this.#now(),
      provider: this.name,
    };
    this.#settled.set(request.idempotencyKey, settlement);
    return Promise.resolve(ok(settlement));
  }
}

/**
 * Stripe test-mode merchant.
 *
 * UNVERIFIED: written against the documented PaymentIntents API but not yet
 * exercised against a live endpoint, because no Stripe key was available when
 * this landed. `MockMerchant` remains the default for that reason. Before using
 * this in the demo, run it once with a real `sk_test_` key and confirm the
 * reference comes back.
 *
 * Deliberately uses `fetch` rather than the Stripe SDK: one HTTP call does not
 * justify the dependency, and the SDK would pull in a large surface we do not
 * otherwise touch.
 */
export class StripeTestMerchant implements Merchant {
  readonly name = 'stripe-test';

  constructor(private readonly secretKey: string) {
    if (!secretKey.startsWith('sk_test_')) {
      // A live key here would mean real money. Refuse at construction rather
      // than discovering it at settlement time.
      throw new Error(
        'StripeTestMerchant requires a test-mode key beginning with sk_test_. ' +
          'Quartermaster must never settle against live keys.',
      );
    }
  }

  async settle(request: SettlementRequest): Promise<Result<Settlement, MerchantFailure>> {
    const body = new URLSearchParams({
      amount: String(request.amount.minorUnits),
      currency: request.amount.currency.toLowerCase(),
      description: request.description,
      confirm: 'true',
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      'payment_method_data[type]': 'card',
      // Stripe's canonical always-succeeds test token.
      'payment_method_data[card][token]': 'tok_visa',
    });

    let response: Response;
    try {
      response = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.secretKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          // Stripe's own idempotency mechanism, same key we were handed.
          'idempotency-key': request.idempotencyKey,
        },
        body,
      });
    } catch (error) {
      return err({
        code: 'provider_error',
        message: `Could not reach Stripe: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const payload = (await response.json()) as {
      id?: string;
      status?: string;
      amount?: number;
      error?: { message?: string };
    };

    if (!response.ok) {
      return err({
        code: 'declined',
        message: payload.error?.message ?? `Stripe returned ${String(response.status)}.`,
      });
    }

    if (payload.status !== 'succeeded' || payload.id === undefined) {
      return err({
        code: 'declined',
        message: `Payment intent status was ${payload.status ?? 'unknown'}, not succeeded.`,
      });
    }

    // Guard against settling a different amount than we authorised.
    if (payload.amount !== undefined && payload.amount !== request.amount.minorUnits) {
      return err({
        code: 'amount_mismatch',
        message:
          `Stripe settled ${String(payload.amount)} but the order was ` +
          `${format(request.amount)} (${String(request.amount.minorUnits)} minor units).`,
      });
    }

    return ok({
      reference: payload.id,
      amount: request.amount,
      settledAt: new Date().toISOString(),
      provider: this.name,
    });
  }
}
