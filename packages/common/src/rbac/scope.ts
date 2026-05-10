/**
 * Scope grammar + coverage check.
 *
 * Grafana reference (read for semantics only):
 *   pkg/services/accesscontrol/models.go (Scope parsing).
 *   pkg/services/accesscontrol/evaluator.go (wildcard coverage).
 *
 * Grammar: `kind[:attribute[:identifier]]`. `*` is a wildcard at any segment.
 * An empty string means "unrestricted for the action's kind".
 *
 * See docs/auth-perm-design/03-rbac-model.md §scope-grammar.
 */

import { parseScope, type ParsedScope } from '../models/rbac.js';

export { parseScope };
export type { ParsedScope };

/** Well-known scope kinds used across the catalog. */
export const SCOPE_KINDS = [
  'dashboards',
  'folders',
  'datasources',
  'users',
  'teams',
  'serviceaccounts',
  'orgs',
  'roles',
  'alert.rules',
  'alert.notifications',
  'alert.instances',
  'alert.silences',
  'alert.provisioning',
  'annotations',
  'server',
  'apikeys',
  // openobs-specific kinds — same wildcard semantics.
  'investigations',
  'approvals',
  'chat',
  'agents.config',
  'connectors',
] as const;

export type ScopeKind = (typeof SCOPE_KINDS)[number];

/**
 * Build a scope string from parts. Missing parts default to '*'.
 *
 * Examples:
 *   buildScope('dashboards', 'uid', 'abc') => 'dashboards:uid:abc'
 *   buildScope('dashboards')               => 'dashboards:*:*'
 *   buildScope('dashboards', '*')          => 'dashboards:*:*'
 */
export function buildScope(
  kind: string,
  attribute: string = '*',
  identifier: string = '*',
): string {
  return `${kind}:${attribute}:${identifier}`;
}

/**
 * True iff `parent` covers `child` — i.e., a permission with scope `parent`
 * is sufficient for a request targeting scope `child`.
 *
 * Rules (mirror Grafana's evaluator wildcard semantics):
 *   - `parent === ''`  → covers every `child` (unrestricted within action kind).
 *   - Exact string equality → covers.
 *   - Any segment `*` in parent acts as a wildcard. A `*` segment covers
 *     every concrete value of the child at the same position and implicitly
 *     covers missing (trailing) segments in the child.
 *   - Kind segment must match (except when parent is empty / all wildcards).
 *
 * Does NOT expand scopes via the folder cascade — that's the resolver's job.
 * This function only evaluates a single (parent, child) pair literally.
 */
export function scopeCovers(parent: string, child: string): boolean {
  // Unrestricted parent covers anything.
  if (parent === '' || parent === '*') return true;
  // Exact match.
  if (parent === child) return true;

  const p = parseScope(parent);
  const c = parseScope(child);

  // Each segment: parent '*' is a wildcard; otherwise must match literally.
  const matches = (parentSeg: string, childSeg: string): boolean =>
    parentSeg === '*' || parentSeg === childSeg;

  return (
    matches(p.kind, c.kind) &&
    matches(p.attribute, c.attribute) &&
    matches(p.identifier, c.identifier)
  );
}

/**
 * Normalize a scope for storage — returns '' for undefined/null inputs,
 * otherwise returns the scope verbatim (callers should parse, not canonicalize,
 * to preserve operator-typed strings for audit trails).
 */
export function normalizeScope(scope: string | null | undefined): string {
  return scope == null ? '' : scope;
}

/**
 * Approvals scope grammar (extends the base `kind:attribute:identifier`):
 *
 *   approvals:*                              — all approvals in org
 *   approvals:uid:<id>                       — one approval row
 *   approvals:connector:<connId>             — any approval with ops_connector_id = connId
 *   approvals:namespace:<connId>:<ns>        — connector + namespace pin
 *   approvals:team:<teamId>                  — any approval with requester_team_id = teamId
 *
 * See docs/design/approvals-multi-team-scope.md §3.1.
 */
export type ApprovalScope =
  | { kind: 'wildcard' }
  | { kind: 'uid'; id: string }
  | { kind: 'connector'; connectorId: string }
  | { kind: 'namespace'; connectorId: string; ns: string }
  | { kind: 'team'; teamId: string };

/**
 * Parse an approvals scope into a typed shape, or return `null` if malformed.
 *
 * Rejects (returns null):
 *   - non-`approvals:` scopes
 *   - `approvals:namespace:<connId>` (missing `<ns>`)
 *   - empty identifiers (e.g. `approvals:uid:`)
 *   - unknown attributes (e.g. `approvals:cluster:foo`)
 *
 * Wildcard segments inside specific shapes are NOT accepted — callers that
 * want "any" use `approvals:*` (the explicit wildcard shape).
 */
export function parseApprovalScope(scope: string): ApprovalScope | null {
  if (scope === 'approvals:*' || scope === 'approvals:*:*') {
    return { kind: 'wildcard' };
  }
  const parts = scope.split(':');
  if (parts[0] !== 'approvals') return null;
  const attr = parts[1];
  if (attr === 'uid') {
    if (parts.length !== 3) return null;
    const id = parts[2];
    if (!id) return null;
    return { kind: 'uid', id };
  }
  if (attr === 'connector') {
    if (parts.length !== 3) return null;
    const connectorId = parts[2];
    if (!connectorId) return null;
    return { kind: 'connector', connectorId };
  }
  if (attr === 'namespace') {
    // Two-segment id: connector + namespace. Both required, both non-empty.
    if (parts.length !== 4) return null;
    const connectorId = parts[2];
    const ns = parts[3];
    if (!connectorId || !ns) return null;
    return { kind: 'namespace', connectorId, ns };
  }
  if (attr === 'team') {
    if (parts.length !== 3) return null;
    const teamId = parts[2];
    if (!teamId) return null;
    return { kind: 'team', teamId };
  }
  return null;
}

/**
 * True iff the scope is a well-formed approvals scope.
 *
 * Use to validate operator-supplied or grant-binding-supplied scope strings
 * before they're stored or used in lookups. Malformed scopes must NOT fall
 * back to wildcard — see fail-closed invariant in approvals-multi-team-scope §3.4.
 */
export function isValidApprovalScope(scope: string): boolean {
  return parseApprovalScope(scope) !== null;
}

/**
 * Build the per-row candidate scopes for a single approval row.
 *
 * The detail-route check passes these to `ac.evalAny` — any match → allow.
 *
 * Note: deliberately does NOT include `approvals:*`. The detail route MUST
 * add it ONLY when the user actually holds the wildcard grant. See the
 * fail-closed invariant in approvals-multi-team-scope §3.4 / R1.
 */
export function approvalRowScopes(row: {
  id: string;
  opsConnectorId?: string | null;
  targetNamespace?: string | null;
  requesterTeamId?: string | null;
}): string[] {
  const out: string[] = [`approvals:uid:${row.id}`];
  if (row.opsConnectorId) {
    out.push(`approvals:connector:${row.opsConnectorId}`);
    if (row.targetNamespace) {
      out.push(`approvals:namespace:${row.opsConnectorId}:${row.targetNamespace}`);
    }
  }
  if (row.requesterTeamId) {
    out.push(`approvals:team:${row.requesterTeamId}`);
  }
  return out;
}
