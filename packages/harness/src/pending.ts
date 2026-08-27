import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { assertNever } from '@quartermaster/shared';

/**
 * A turn can stop for three different reasons, not two. Alongside the tool
 * approval gate and the ask-user-question flow, the harness also pauses when an
 * MCP server needs an OAuth handshake. All three land in
 * `TurnStateDone.requiredActions`, and a caller that only handles the first two
 * will hang forever on the third.
 */
export type PendingAction =
  | { kind: 'approval'; event: TrueForgeApi.ToolApprovalRequiredEvent }
  | { kind: 'question'; event: TrueForgeApi.ToolResponseRequiredEvent }
  | { kind: 'mcp-auth'; event: TrueForgeApi.McpAuthRequiredEvent };

export function isToolApprovalRequired(
  event: TrueForgeApi.ActionRequiredEvent,
): event is TrueForgeApi.ToolApprovalRequiredEvent {
  return event.type === 'tool.approval_required';
}

export function isToolResponseRequired(
  event: TrueForgeApi.ActionRequiredEvent,
): event is TrueForgeApi.ToolResponseRequiredEvent {
  return event.type === 'tool.response_required';
}

export function isMcpAuthRequired(
  event: TrueForgeApi.ActionRequiredEvent,
): event is TrueForgeApi.McpAuthRequiredEvent {
  return event.type === 'mcp.auth_required';
}

/**
 * Classify one required action. The `assertNever` default means adding a fourth
 * pause reason to the SDK breaks the build here rather than silently stalling a
 * turn at runtime.
 */
export function classifyRequiredAction(event: TrueForgeApi.ActionRequiredEvent): PendingAction {
  if (isToolApprovalRequired(event)) return { kind: 'approval', event };
  if (isToolResponseRequired(event)) return { kind: 'question', event };
  if (isMcpAuthRequired(event)) return { kind: 'mcp-auth', event };
  return assertNever(event, `Unhandled required action: ${JSON.stringify(event)}`);
}

/**
 * Pull the pending actions out of a finished turn.
 *
 * Only a `done` turn carries `requiredActions`; running, cancelled, and errored
 * turns have nothing to respond to.
 */
export function pendingActionsOf(state: TrueForgeApi.TurnState): PendingAction[] {
  if (state.status !== 'done') return [];
  return state.requiredActions.map(classifyRequiredAction);
}

/**
 * True when the turn is waiting on a human rather than finished.
 *
 * A paused turn and a completed turn are both `status: "done"`, which is an
 * easy and expensive thing to get wrong — treating a pause as completion loses
 * the pending purchase.
 */
export function isAwaitingHuman(state: TrueForgeApi.TurnState): boolean {
  return pendingActionsOf(state).length > 0;
}
