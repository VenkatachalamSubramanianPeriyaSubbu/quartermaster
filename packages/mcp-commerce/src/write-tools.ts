import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  asId,
  type CandidateId,
  type ItemId,
  type ListId,
  type OrderId,
} from '@quartermaster/shared';
import { money, type OrderLine } from '@quartermaster/domain';
import type { Merchant } from './merchant.js';
import { StoreError, type Store, type StoredOrder } from './store.js';
import { cancelOrder, checkout, createDraft, reserveFunds, type OrderFailure } from './orders.js';
import { wireBudget, wireMoney } from './wire.js';

/**
 * The money side of the commerce server.
 *
 * `checkout_order` and `reserve_funds` are the tools the agent spec gates:
 *
 *   requireApprovalForTools: ['checkout_order', 'reserve_funds']
 *
 * The gate is declared in the harness, not here, which is the point — our UI
 * cannot be talked past, because our UI is not what enforces it. What *this*
 * module guarantees is that even an approved order cannot exceed the budget,
 * because the ceiling is arithmetic in the domain rather than an instruction in
 * a prompt.
 *
 * Annotations matter for the same reason they did on the read side: TrueForge's
 * `@write` and `@destructive` selectors key off them, so they are asserted in
 * the tests rather than assumed.
 */

function reply(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function failure(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): CallToolResult {
  const payload = { error: code, message, ...extra };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

/** Render an order failure, including every violation so one turn fixes all of them. */
function orderFailure(error: OrderFailure): CallToolResult {
  return failure(
    error.code,
    error.message,
    error.violations === undefined ? {} : { violations: error.violations },
  );
}

function wireOrder(order: StoredOrder): Record<string, unknown> {
  return {
    id: order.id,
    listId: order.listId,
    status: order.status,
    total: wireMoney(order.total),
    lines: order.lines.map((line) => ({
      itemId: line.itemId,
      candidateId: line.candidateId,
      quantity: line.quantity,
      unitPrice: wireMoney(line.unitPrice),
      shipping: wireMoney(line.shipping),
    })),
    settlement:
      order.settlement === undefined
        ? null
        : {
            reference: order.settlement.reference,
            provider: order.settlement.provider,
            settledAt: order.settlement.settledAt,
            amount: wireMoney(order.settlement.amount),
          },
  };
}

function withStoreErrors(fn: () => CallToolResult): CallToolResult {
  try {
    return fn();
  } catch (error) {
    if (error instanceof StoreError) return failure(error.code, error.message);
    throw error;
  }
}

const listIdSchema = z.string().min(1).describe('Identifier of the shopping list.');
const orderIdSchema = z.string().min(1).describe('Identifier of the order.');

export function registerWriteTools(server: McpServer, store: Store, merchant: Merchant): void {
  server.registerTool(
    'create_order_draft',
    {
      title: 'Create an order draft',
      description:
        'Propose an order from candidates already recorded for the list. Every line is ' +
        'checked against the recorded candidate: the unit price and shipping you supply must ' +
        'match what was recorded, quantities must match the list, and required items must all ' +
        'be present. No money moves and no budget is held. If the draft is rejected you will ' +
        'receive every problem at once — fix them all before retrying.',
      inputSchema: {
        listId: listIdSchema,
        orderId: orderIdSchema,
        lines: z
          .array(
            z.object({
              itemId: z.string().min(1),
              candidateId: z.string().min(1),
              quantity: z.number().int().positive(),
              unitPriceMinorUnits: z
                .number()
                .int()
                .nonnegative()
                .describe('Must equal the recorded candidate price.'),
              shippingMinorUnits: z
                .number()
                .int()
                .nonnegative()
                .describe('Must equal the recorded candidate shipping.'),
            }),
          )
          .min(1)
          .describe('One line per item. Do not put the same item on two lines.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ listId, orderId, lines }) =>
      withStoreErrors(() => {
        const list = store.getList(asId<ListId>(listId));
        if (list === undefined) return failure('list_not_found', `List ${listId} not found.`);

        const orderLines: OrderLine[] = lines.map((line) => ({
          itemId: asId<ItemId>(line.itemId),
          candidateId: asId<CandidateId>(line.candidateId),
          quantity: line.quantity,
          unitPrice: money(line.unitPriceMinorUnits, list.currency),
          shipping: money(line.shippingMinorUnits, list.currency),
        }));

        const result = createDraft(store, {
          listId: asId<ListId>(listId),
          orderId: asId<OrderId>(orderId),
          lines: orderLines,
        });
        if (!result.ok) return orderFailure(result.error);
        return reply({ order: wireOrder(result.value) });
      }),
  );

  server.registerTool(
    'reserve_funds',
    {
      title: 'Reserve funds for a draft order',
      description:
        'Hold the budget for a draft order so a competing order cannot spend it. No money ' +
        'moves and the hold can be released by cancelling. Requires human approval.',
      inputSchema: { listId: listIdSchema, orderId: orderIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    ({ listId, orderId }) =>
      withStoreErrors(() => {
        const result = reserveFunds(store, {
          listId: asId<ListId>(listId),
          orderId: asId<OrderId>(orderId),
        });
        if (!result.ok) return orderFailure(result.error);
        const budget = store.getBudget(asId<ListId>(listId));
        return reply({
          order: wireOrder(result.value),
          budget: budget === undefined ? null : wireBudget(budget),
        });
      }),
  );

  server.registerTool(
    'cancel_order',
    {
      title: 'Cancel an order',
      description:
        'Abandon a draft or reserved order and release any funds it was holding. Use this ' +
        'when a purchase is declined or a better candidate is found. A settled order cannot ' +
        'be cancelled.',
      inputSchema: { listId: listIdSchema, orderId: orderIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    ({ listId, orderId }) =>
      withStoreErrors(() => {
        const result = cancelOrder(store, {
          listId: asId<ListId>(listId),
          orderId: asId<OrderId>(orderId),
        });
        if (!result.ok) return orderFailure(result.error);
        const budget = store.getBudget(asId<ListId>(listId));
        return reply({
          order: wireOrder(result.value),
          budget: budget === undefined ? null : wireBudget(budget),
        });
      }),
  );

  server.registerTool(
    'checkout_order',
    {
      title: 'Check out an order',
      description:
        'Settle an order and spend the money. THIS IS IRREVERSIBLE and requires human ' +
        'approval. The order is re-validated immediately beforehand, so a price that has ' +
        'moved since the draft was created will cause a rejection rather than an unexpected ' +
        'charge. Supply a stable settlementKey: calling again with the same key returns the ' +
        'original receipt instead of charging twice.',
      inputSchema: {
        listId: listIdSchema,
        orderId: orderIdSchema,
        settlementKey: z
          .string()
          .min(8)
          .describe(
            'A stable, unique key for this settlement attempt. Reuse the same key when ' +
              'retrying the same purchase; never reuse it for a different purchase.',
          ),
      },
      // The one genuinely destructive tool in the system.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ listId, orderId, settlementKey }) => {
      try {
        const result = await checkout(store, merchant, {
          listId: asId<ListId>(listId),
          orderId: asId<OrderId>(orderId),
          settlementKey,
        });
        if (!result.ok) return orderFailure(result.error);

        const budget = store.getBudget(asId<ListId>(listId));
        return reply({
          order: wireOrder(result.value.order),
          idempotentReplay: result.value.idempotentReplay,
          budget: budget === undefined ? null : wireBudget(budget),
        });
      } catch (error) {
        if (error instanceof StoreError) return failure(error.code, error.message);
        throw error;
      }
    },
  );
}

/** Tool names the agent spec must gate. Exported so the spec cannot drift from reality. */
export const TOOLS_REQUIRING_APPROVAL = ['reserve_funds', 'checkout_order'] as const;
