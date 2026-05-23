/**
 * Pure helpers behind PermissionsSection's mutations. Extracted so the
 * "what request gets sent for click X" contract can be unit-tested in the
 * web package's node-only test env (no jsdom).
 */
import type {
  ConnectorHumanPolicy,
  ConnectorPolicy,
  ConnectorSubjectType,
} from '@agentic-obs/common';
import type { PolicyUpsertBody } from './policies-api.js';

export interface ScopeContext {
  connectorId: string;
  subjectType: ConnectorSubjectType;
  subjectId: string;
}

/** Body of a single PUT /connectors/:id/policies call. */
export function buildUpsertBody(
  ctx: ScopeContext,
  capability: string,
  humanPolicy: ConnectorHumanPolicy,
): PolicyUpsertBody {
  return {
    subjectType: ctx.subjectType,
    subjectId: ctx.subjectId,
    capability,
    humanPolicy,
  };
}

/** Bodies for a batch (apply to all) operation — one per capability. */
export function buildBatchBodies(
  ctx: ScopeContext,
  capabilities: readonly string[],
  humanPolicy: ConnectorHumanPolicy,
): PolicyUpsertBody[] {
  return capabilities.map((cap) => buildUpsertBody(ctx, cap, humanPolicy));
}

/** Optimistic in-memory update: replace (or insert) the row for `capability`. */
export function applyOptimistic(
  rows: readonly ConnectorPolicy[],
  ctx: ScopeContext,
  capability: string,
  humanPolicy: ConnectorHumanPolicy,
): ConnectorPolicy[] {
  const next: ConnectorPolicy = {
    connectorId: ctx.connectorId,
    subjectType: ctx.subjectType,
    subjectId: ctx.subjectId,
    capability,
    scope: null,
    humanPolicy,
  };
  return [...rows.filter((r) => r.capability !== capability), next];
}

/** Optimistic in-memory reset (delete a team-level row). */
export function applyReset(
  rows: readonly ConnectorPolicy[],
  capability: string,
): ConnectorPolicy[] {
  return rows.filter((r) => r.capability !== capability);
}
