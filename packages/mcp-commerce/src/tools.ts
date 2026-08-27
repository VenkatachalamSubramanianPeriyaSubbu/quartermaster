import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { asId, type CandidateId, type ItemId, type ListId } from '@quartermaster/shared';
import { AVAILABILITY, money, type Currency } from '@quartermaster/domain';
import { StoreError, type Store } from './store.js';
import { wireBudget, wireCandidate, wireList } from './wire.js';

/**
 * The read side of the commerce server.
 *
 * Every tool here is annotated `readOnlyHint: true` except `record_candidate`,
 * which writes but cannot move money. The annotations are not decoration —
 * TrueForge's `@read-only` tool selector keys off them, so getting them wrong
 * would either hide these tools from the agent or quietly include a writer in a
 * set the agent was told was safe.
 *
 * The money-moving tools live in PR #5 and are gated separately.
 */

/** Structured payload plus a text mirror, since not every client reads both. */
function reply(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/**
 * Turn a failure into something the model can act on.
 *
 * `isError` matters: without it the model reads a failure as a successful
 * result whose content happens to mention a problem, and carries on.
 */
function failure(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }, null, 2) }],
    structuredContent: { error: code, message },
    isError: true,
  };
}

function handle(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (error) {
    if (error instanceof StoreError) return failure(error.code, error.message);
    throw error;
  }
}

const listIdSchema = z.string().min(1).describe('Identifier of the shopping list.');

export function registerReadTools(server: McpServer, store: Store): void {
  server.registerTool(
    'get_shopping_list',
    {
      title: 'Get shopping list',
      description:
        'Return a shopping list with every item on it, including quantities, whether each ' +
        'item is required, and any per-unit price cap. Call this before sourcing so you ' +
        'know what you are shopping for.',
      inputSchema: { listId: listIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ listId }) =>
      handle(() => {
        const list = store.getList(asId<ListId>(listId));
        if (list === undefined) return failure('list_not_found', `List ${listId} not found.`);
        return reply(wireList(list));
      }),
  );

  server.registerTool(
    'get_budget_status',
    {
      title: 'Get budget status',
      description:
        'Return the budget for a list: the ceiling, what has been committed, what is ' +
        'currently reserved against pending orders, and what remains available. Check this ' +
        'before proposing a purchase — `available` is the figure that matters, not `ceiling`.',
      inputSchema: { listId: listIdSchema },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ listId }) =>
      handle(() => {
        const budget = store.getBudget(asId<ListId>(listId));
        if (budget === undefined) return failure('list_not_found', `List ${listId} not found.`);
        return reply(wireBudget(budget));
      }),
  );

  server.registerTool(
    'list_candidates',
    {
      title: 'List recorded candidates',
      description:
        'Return the products already recorded for a list, optionally narrowed to one item. ' +
        'Only candidates recorded here can appear on an order, and their recorded prices are ' +
        'what the order is validated against.',
      inputSchema: {
        listId: listIdSchema,
        itemId: z.string().min(1).optional().describe('Narrow results to a single item.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ listId, itemId }) =>
      handle(() => {
        const candidates = store.listCandidates(
          asId<ListId>(listId),
          itemId === undefined ? undefined : asId<ItemId>(itemId),
        );
        return reply({ candidates: candidates.map(wireCandidate), count: candidates.length });
      }),
  );

  server.registerTool(
    'record_candidate',
    {
      title: 'Record a product candidate',
      description:
        'Record a product you found as a candidate for an item. Prices are in minor units ' +
        '(cents), never decimals — $42.00 is 4200. Record the price exactly as listed; the ' +
        'figure stored here is what any later order is checked against, so an inaccurate ' +
        'entry will cause the order to be rejected rather than quietly accepted.',
      inputSchema: {
        listId: listIdSchema,
        candidateId: z
          .string()
          .min(1)
          .describe('A stable identifier you choose for this candidate.'),
        itemId: z.string().min(1).describe('The item on the list this product is a candidate for.'),
        source: z.string().min(1).describe('Where it was found, e.g. "bright-data:serp".'),
        title: z.string().min(1).describe('Product title as listed.'),
        url: z.url().describe('Direct link to the product page.'),
        unitPriceMinorUnits: z.number().int().nonnegative().describe('Unit price in minor units.'),
        shippingMinorUnits: z
          .number()
          .int()
          .nonnegative()
          .describe('Shipping cost in minor units.'),
        availability: z
          .enum(AVAILABILITY)
          .describe('Use "unknown" if the listing does not say; do not guess "in_stock".'),
      },
      // Writes, but adds rather than replaces, and moves no money.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (input) =>
      handle(() => {
        const listId = asId<ListId>(input.listId);
        const list = store.getList(listId);
        if (list === undefined) return failure('list_not_found', `List ${input.listId} not found.`);

        const currency: Currency = list.currency;
        const recorded = store.recordCandidate(listId, {
          id: asId<CandidateId>(input.candidateId),
          itemId: asId<ItemId>(input.itemId),
          source: input.source,
          title: input.title,
          url: input.url,
          unitPrice: money(input.unitPriceMinorUnits, currency),
          shipping: money(input.shippingMinorUnits, currency),
          // z.enum(AVAILABILITY) already narrows this to the literal union.
          availability: input.availability,
        });
        return reply({ recorded: wireCandidate(recorded) });
      }),
  );
}
