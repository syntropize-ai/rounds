/**
 * Stable hash for an inferred dashboard variable set.
 *
 * Wave 2 / Step 4 — used by both the frontend (to look up an existing ack)
 * and the backend (to persist one). Same vars → same hash regardless of
 * insertion order; one value changed → different hash. Keys with empty-
 * string values are dropped so URLs like `?_inf_service=foo&_inf_namespace=`
 * don't produce a different hash than `?_inf_service=foo`.
 *
 * The hash itself is a hex-encoded FNV-1a of the canonical JSON. FNV-1a is
 * not cryptographic — we only need a stable, short, collision-resistant-
 * enough identifier for a per-user-per-dashboard cache lookup. Avoiding
 * `node:crypto` keeps this module importable from the web bundle (see the
 * BOUNDARY RULE in packages/common/src/index.ts).
 */

/**
 * Build the canonical string form of a variable set:
 *   `{"k1":"v1","k2":"v2"}` with keys sorted lexicographically and entries
 *   with empty string values removed.
 *
 * Exported for tests; production code should call `hashVariables` instead.
 */
export function canonicalizeVariables(vars: Record<string, string>): string {
  const entries = Object.entries(vars)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => [k, v] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // Hand-built JSON to avoid any platform variance in object key ordering.
  const parts = entries.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  return `{${parts.join(',')}}`;
}

export function hashVariables(vars: Record<string, string>): string {
  const canon = canonicalizeVariables(vars);
  // FNV-1a 32-bit. Sufficient for cache-key use; not for security.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    hash ^= canon.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Convert to unsigned then hex.
  return (hash >>> 0).toString(16).padStart(8, '0');
}
