/**
 * Shared helpers for action handlers.
 *
 * These collapse the two patterns the audit flagged as repeated across the
 * 28 handlers in `orchestrator-action-handlers.ts`:
 *
 *   1. The `tool_call` → try/`tool_result(success: true)` / catch /
 *      `tool_result(success: false)` SSE-emit boundary that wraps every
 *      handler body.
 *
 *   2. The `workspaceId: ctx.identity.orgId` idiom that scopes new rows
 *      (dashboards, investigations, alert rules) to the caller's org so the
 *      detail/list routes can find them.
 *
 * Migration is incremental: handlers that have already moved to
 * `withToolEventBoundary` show up at a glance; the rest still emit by hand
 * and are tagged with a `TODO: migrate to withToolEventBoundary` comment.
 */

import type { Identity, DashboardSseEvent } from '@agentic-obs/common';

/**
 * Wrap a handler body in the standard tool_call/tool_result SSE boundary.
 *
 * The handler body returns the human-readable observation (or a structured
 * `{observation, summary}` if the SSE summary should differ from the
 * returned observation — most handlers want them identical).
 *
 * On throw: emits `tool_result` with `success: false` and re-throws so the
 * orchestrator's outer error handling still runs. Callers that want to
 * convert errors into observation strings (the existing pattern for
 * metrics/logs) should catch inside the body.
 */
export async function withToolEventBoundary(
  sendEvent: (event: DashboardSseEvent) => void,
  toolName: string,
  callArgs: Record<string, unknown>,
  displayText: string,
  body: () => Promise<string | { observation: string; summary?: string }>,
): Promise<string> {
  sendEvent({ type: 'tool_call', tool: toolName, args: callArgs, displayText });
  try {
    const result = await body();
    const observation = typeof result === 'string' ? result : result.observation;
    const summary =
      typeof result === 'string' ? result : (result.summary ?? result.observation);
    sendEvent({ type: 'tool_result', tool: toolName, summary, success: true });
    return observation;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendEvent({ type: 'tool_result', tool: toolName, summary: msg, success: false });
    throw err;
  }
}

/**
 * Add `workspaceId` to a payload so that detail/list routes filtered on
 * workspaceId can find the row. Centralizing this keeps the "what does
 * 'workspace' mean for the agent" decision in one place — today it's
 * `identity.orgId`, but the multi-workspace work in flight may change that.
 */
export function withWorkspaceScope<T extends object>(
  identity: Identity,
  payload: T,
): T & { workspaceId: string } {
  return { ...payload, workspaceId: identity.orgId };
}
