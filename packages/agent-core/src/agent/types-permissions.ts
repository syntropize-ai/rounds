/**
 * Agent-core permission types (Wave 7).
 *
 * The permission gate sits between the ReAct loop and action handlers. Every
 * tool invocation is checked against the caller's RBAC before dispatch. The
 * types below describe:
 *
 *   - `ToolPermissionBuilder`     — maps a tool's args to an RBAC evaluator.
 *   - `IAccessControlService`     — the minimal surface the gate needs to
 *                                   evaluate an Identity against an evaluator.
 *                                   api-gateway's AccessControlService conforms.
 *   - `PermissionGateResult`      — discriminated union returned by the gate.
 *
 * See docs/auth-perm-design/11-agent-permissions.md §D2, §D7, §D10.
 */

import type { Evaluator, Identity } from '@agentic-obs/common';
import type { ActionContext } from './orchestrator-action-handlers.js';

/**
 * Builder that turns a tool call's args into an evaluator. Single signature —
 * builders that don't need the context simply ignore the second parameter;
 * builders that need a DB lookup return a promise.
 *
 * Returning `null` means the tool is not permission-gated (reserved for pure
 * UI actions). See §D2, §D7.
 */
export type ToolPermissionBuilder = (
  args: Record<string, unknown>,
  ctx: ActionContext,
) => Evaluator | null | Promise<Evaluator | null>;

/**
 * Minimal access-control surface the agent-core gate depends on. api-gateway's
 * `AccessControlService` implements this directly; tests can provide a stub.
 *
 * Keeping the surface small avoids dragging the full service (and its
 * repository chain) into agent-core's build graph.
 */
export interface IAccessControlService {
  /** Return true iff the identity's resolved permissions satisfy the evaluator. */
  evaluate(identity: Identity, evaluator: Evaluator): Promise<boolean>;
  /**
   * Post-filter a list of items to those the identity has permission on.
   * Each item's evaluator is produced by the provided builder.
   */
  filterByPermission<T>(
    identity: Identity,
    items: readonly T[],
    buildEvaluator: (item: T) => Evaluator,
  ): Promise<T[]>;
}

/**
 * Minimal audit-writer surface used by the gate. The api-gateway's
 * `AuditWriter` class conforms directly; tests can pass a vi.fn() collector.
 */
export interface IAuditWriter {
  log(entry: {
    action: string;
    actorType: 'user' | 'service_account' | 'system';
    actorId?: string | null;
    actorName?: string | null;
    orgId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    targetName?: string | null;
    outcome: 'success' | 'failure';
    metadata?: unknown;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void>;
}

export type PermissionDenyReason =
  | 'allowedTools'
  | 'permissionMode'
  | 'rbac';

/** Outcome of a three-layer permission check. */
export interface PermissionGateResult {
  ok: boolean;
  /** Populated when `ok === false`. */
  reason?: PermissionDenyReason;
  /** Canonical action string, e.g. `dashboards:create`. Populated on deny. */
  action?: string;
  /** Canonical scope string, e.g. `folders:uid:prod`. Populated on deny. */
  scope?: string;
}
