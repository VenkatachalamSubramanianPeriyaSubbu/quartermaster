import {
  availableOf,
  encumberedOf,
  format,
  type Budget,
  type Candidate,
  type Item,
  type Money,
  type ShoppingList,
} from '@quartermaster/domain';

/**
 * Shapes handed across the tool boundary to the model.
 *
 * Every amount is sent twice: as integer minor units, and as a preformatted
 * display string. The redundancy is deliberate. Given only `4200` a model will
 * sometimes report "$4200"; given only `"$42.00"` it will try to do decimal
 * arithmetic on the string. Sending both means it never has to convert, and
 * every figure it quotes back to a human is one we formatted ourselves.
 */
export interface WireMoney {
  readonly minorUnits: number;
  readonly currency: string;
  readonly display: string;
}

export function wireMoney(amount: Money): WireMoney {
  return { minorUnits: amount.minorUnits, currency: amount.currency, display: format(amount) };
}

export interface WireItem {
  readonly id: string;
  readonly description: string;
  readonly quantity: number;
  readonly required: boolean;
  readonly maxUnitPrice: WireMoney | null;
}

export function wireItem(item: Item): WireItem {
  return {
    id: item.id,
    description: item.description,
    quantity: item.quantity,
    required: item.required,
    maxUnitPrice: item.maxUnitPrice === undefined ? null : wireMoney(item.maxUnitPrice),
  };
}

export interface WireCandidate {
  readonly id: string;
  readonly itemId: string;
  readonly source: string;
  readonly title: string;
  readonly url: string;
  readonly unitPrice: WireMoney;
  readonly shipping: WireMoney;
  readonly availability: string;
}

export function wireCandidate(candidate: Candidate): WireCandidate {
  return {
    id: candidate.id,
    itemId: candidate.itemId,
    source: candidate.source,
    title: candidate.title,
    url: candidate.url,
    unitPrice: wireMoney(candidate.unitPrice),
    shipping: wireMoney(candidate.shipping),
    availability: candidate.availability,
  };
}

export interface WireList {
  readonly id: string;
  readonly currency: string;
  readonly items: readonly WireItem[];
}

export function wireList(list: ShoppingList): WireList {
  return { id: list.id, currency: list.currency, items: list.items.map(wireItem) };
}

export interface WireBudget {
  readonly ceiling: WireMoney;
  readonly committed: WireMoney;
  readonly reserved: WireMoney;
  readonly encumbered: WireMoney;
  readonly available: WireMoney;
}

/**
 * `available` and `encumbered` are derived, but they are sent anyway so the
 * model never has to subtract. Arithmetic it does not perform is arithmetic it
 * cannot get wrong.
 */
export function wireBudget(budget: Budget): WireBudget {
  return {
    ceiling: wireMoney(budget.ceiling),
    committed: wireMoney(budget.committed),
    reserved: wireMoney(budget.reserved),
    encumbered: wireMoney(encumberedOf(budget)),
    available: wireMoney(availableOf(budget)),
  };
}
