import { describe, expect, it } from 'vitest';
import type { TrueForgeApi } from '@truefoundry/trueforge-sdk';
import {
  classifyRequiredAction,
  isAwaitingHuman,
  isToolApprovalRequired,
  pendingActionsOf,
} from './pending.js';

/**
 * These fixtures are a compile-time contract against the TrueForge SDK, not
 * just test data. They are annotated with the SDK's own interfaces, so if a
 * future release renames a field — `toolCalls` to `tool_calls`, say — this file
 * stops compiling and CI fails immediately, rather than the approval gate
 * breaking silently in the demo.
 *
 * Pinned against @truefoundry/trueforge-sdk 0.1.3.
 */

const approvalRequired: TrueForgeApi.ToolApprovalRequiredEvent = {
  type: 'tool.approval_required',
  id: 'evt_approval',
  threadId: 'thr_1',
  createdAt: '2026-08-27T00:00:00.000Z',
  toolCalls: [{ id: 'call_checkout', sourceEventId: 'evt_model_msg' }],
};

const responseRequired: TrueForgeApi.ToolResponseRequiredEvent = {
  type: 'tool.response_required',
  id: 'evt_question',
  threadId: 'thr_1',
  createdAt: '2026-08-27T00:00:01.000Z',
  toolCalls: [{ id: 'call_ask', sourceEventId: 'evt_model_msg' }],
};

const mcpAuthRequired: TrueForgeApi.McpAuthRequiredEvent = {
  type: 'mcp.auth_required',
  id: 'evt_mcp_auth',
  // Run-level event: the SDK types this as nullable, unlike the other two.
  threadId: null,
  createdAt: '2026-08-27T00:00:02.000Z',
  mcpServers: [{ id: 'srv_1', name: 'bright-data', authUrl: 'https://example.test/oauth' }],
};

describe('required-action classification', () => {
  it('recognises a tool approval gate', () => {
    expect(classifyRequiredAction(approvalRequired)).toEqual({
      kind: 'approval',
      event: approvalRequired,
    });
  });

  it('recognises an ask-user-question pause', () => {
    expect(classifyRequiredAction(responseRequired)).toEqual({
      kind: 'question',
      event: responseRequired,
    });
  });

  it('recognises an MCP OAuth pause', () => {
    expect(classifyRequiredAction(mcpAuthRequired)).toEqual({
      kind: 'mcp-auth',
      event: mcpAuthRequired,
    });
  });

  it('throws rather than silently stalling on an unknown pause reason', () => {
    const rogue = { type: 'tool.something_new' } as unknown as TrueForgeApi.ActionRequiredEvent;
    expect(() => classifyRequiredAction(rogue)).toThrow(/Unhandled required action/);
  });

  it('narrows correctly with the type guard', () => {
    expect(isToolApprovalRequired(approvalRequired)).toBe(true);
    expect(isToolApprovalRequired(responseRequired)).toBe(false);
  });
});

describe('pendingActionsOf', () => {
  it('returns nothing for a running turn', () => {
    expect(pendingActionsOf({ status: 'running' })).toEqual([]);
  });

  it('returns nothing for a done turn that truly finished', () => {
    const finished: TrueForgeApi.TurnState = {
      status: 'done',
      completedAt: '2026-08-27T00:00:03.000Z',
      output: null,
      requiredActions: [],
    };
    expect(pendingActionsOf(finished)).toEqual([]);
    expect(isAwaitingHuman(finished)).toBe(false);
  });

  it('surfaces every pending action on a paused turn', () => {
    const paused: TrueForgeApi.TurnState = {
      status: 'done',
      completedAt: '2026-08-27T00:00:04.000Z',
      output: null,
      requiredActions: [approvalRequired, responseRequired],
    };
    expect(pendingActionsOf(paused).map((a) => a.kind)).toEqual(['approval', 'question']);
  });

  it('treats a paused turn as awaiting a human, not as complete', () => {
    // A pause and a completion are both status "done". Confusing the two would
    // drop a pending purchase on the floor.
    const paused: TrueForgeApi.TurnState = {
      status: 'done',
      completedAt: '2026-08-27T00:00:05.000Z',
      output: null,
      requiredActions: [approvalRequired],
    };
    expect(isAwaitingHuman(paused)).toBe(true);
  });
});
