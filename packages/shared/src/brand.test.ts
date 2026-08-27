import { describe, expect, it } from 'vitest';
import { asId } from './brand.js';
import type { OrderId, SessionId } from './brand.js';

describe('asId', () => {
  it('returns the underlying string value', () => {
    const id = asId<OrderId>('ord_123');
    expect(id).toBe('ord_123');
  });

  it('rejects an empty identifier', () => {
    expect(() => asId<SessionId>('')).toThrow(TypeError);
  });

  it('keeps branded ids distinct at the type level', () => {
    const order = asId<OrderId>('ord_123');
    const session = asId<SessionId>('ses_123');
    // @ts-expect-error an OrderId must not be assignable to a SessionId
    const wrong: SessionId = order;
    expect(wrong).not.toBe(session);
  });
});
