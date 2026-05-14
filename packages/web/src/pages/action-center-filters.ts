/**
 * Pure filter helpers for the Action Center approvals list.
 *
 * Per approval-scope design notes §5: operators filter approvals
 * by connector / namespace / team. The API already gates rows the user can see
 * (T2.2 per-row scope). These helpers only narrow the already-permitted set
 * client-side.
 *
 * The sentinel `__none__` represents the "(no <X>)" / "(cluster-scoped)" pill
 * that matches NULL on that dimension. `null` for a filter slot means "All".
 */

export const NONE_SENTINEL = '__none__';

export interface ApprovalScopeFields {
  opsConnectorId?: string | null;
  targetNamespace?: string | null;
  requesterTeamId?: string | null;
}

export interface ApprovalFilters {
  /** null = All; NONE_SENTINEL = NULL rows; otherwise specific connector id. */
  connector: string | null;
  namespace: string | null;
  team: string | null;
}

export const EMPTY_FILTERS: ApprovalFilters = {
  connector: null,
  namespace: null,
  team: null,
};

function matchesOne(value: string | null | undefined, filter: string | null): boolean {
  if (filter === null) return true;
  if (filter === NONE_SENTINEL) return value == null;
  return value === filter;
}

/** True when the row passes all three filter slots (AND across groups). */
export function matchesFilters(row: ApprovalScopeFields, f: ApprovalFilters): boolean {
  return (
    matchesOne(row.opsConnectorId ?? null, f.connector)
    && matchesOne(row.targetNamespace ?? null, f.namespace)
    && matchesOne(row.requesterTeamId ?? null, f.team)
  );
}

export function applyFilters<T extends ApprovalScopeFields>(rows: readonly T[], f: ApprovalFilters): T[] {
  return rows.filter((r) => matchesFilters(r, f));
}

/**
 * Distinct values for a given field across rows. `null`/missing collapses to
 * the NONE sentinel so the caller can render a single "(no X)" pill.
 *
 * Connector-namespace coupling: the namespace pill list is built only from
 * rows that already pass the connector filter, so e.g. picking connector A
 * doesn't show namespaces that only exist under connector B.
 */
export function distinctConnectorIds(rows: readonly ApprovalScopeFields[]): (string | typeof NONE_SENTINEL)[] {
  const seen = new Set<string | typeof NONE_SENTINEL>();
  for (const r of rows) {
    seen.add(r.opsConnectorId ?? NONE_SENTINEL);
  }
  return Array.from(seen).sort(sortNoneLast);
}

export function distinctNamespaces(
  rows: readonly ApprovalScopeFields[],
  connectorFilter: string | null,
): (string | typeof NONE_SENTINEL)[] {
  const seen = new Set<string | typeof NONE_SENTINEL>();
  for (const r of rows) {
    if (!matchesOne(r.opsConnectorId ?? null, connectorFilter)) continue;
    seen.add(r.targetNamespace ?? NONE_SENTINEL);
  }
  return Array.from(seen).sort(sortNoneLast);
}

export function distinctTeamIds(rows: readonly ApprovalScopeFields[]): (string | typeof NONE_SENTINEL)[] {
  const seen = new Set<string | typeof NONE_SENTINEL>();
  for (const r of rows) {
    seen.add(r.requesterTeamId ?? NONE_SENTINEL);
  }
  return Array.from(seen).sort(sortNoneLast);
}

function sortNoneLast(a: string, b: string): number {
  if (a === NONE_SENTINEL) return 1;
  if (b === NONE_SENTINEL) return -1;
  return a.localeCompare(b);
}

// ─── URL state ────────────────────────────────────────────────────────────

const PARAM_KEYS = {
  connector: 'connector',
  namespace: 'namespace',
  team: 'team',
} as const;

/**
 * Read filter state from URLSearchParams. Empty / missing → null (All).
 * Recognised values are returned verbatim; the chip strip will render the
 * value as "(unknown)" if it doesn't match any row, which is fine — picking
 * a different chip clears it.
 */
export function parseFiltersFromParams(params: URLSearchParams): ApprovalFilters {
  return {
    connector: params.get(PARAM_KEYS.connector) || null,
    namespace: params.get(PARAM_KEYS.namespace) || null,
    team: params.get(PARAM_KEYS.team) || null,
  };
}

/** Mutate a URLSearchParams instance to reflect the given filter state. */
export function writeFiltersToParams(params: URLSearchParams, f: ApprovalFilters): void {
  if (f.connector === null) params.delete(PARAM_KEYS.connector);
  else params.set(PARAM_KEYS.connector, f.connector);
  if (f.namespace === null) params.delete(PARAM_KEYS.namespace);
  else params.set(PARAM_KEYS.namespace, f.namespace);
  if (f.team === null) params.delete(PARAM_KEYS.team);
  else params.set(PARAM_KEYS.team, f.team);
}

export function isAnyFilterActive(f: ApprovalFilters): boolean {
  return f.connector !== null || f.namespace !== null || f.team !== null;
}
