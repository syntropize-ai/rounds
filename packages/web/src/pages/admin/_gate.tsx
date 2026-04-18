/**
 * Permission-gate helpers used by the admin tabs. Delegates to the canonical
 * `<PermissionGate>` / `hasPermission(action, scope?)` primitives shipped
 * from `contexts/AuthContext.tsx` (T8.8 — Agent A).
 *
 * Kept as a thin wrapper so the admin pages import from a single local module
 * and the shape of `useIsServerAdmin()` can evolve without touching every
 * tab.
 */

import { useAuth } from '../../contexts/AuthContext.js';

export { PermissionGate } from '../../contexts/AuthContext.js';

/**
 * Return a stable `(action, scope?) => boolean` checker bound to the current
 * auth context.
 */
export function useHasPermission(): (action: string, scope?: string) => boolean {
  const { hasPermission } = useAuth();
  return hasPermission;
}

/**
 * True iff the authenticated user is a server admin. Server admins always
 * bypass org-level permission checks for admin surfaces (matches Grafana's
 * `isServerAdmin` short-circuit in pkg/middleware/middleware.go).
 */
export function useIsServerAdmin(): boolean {
  const { isServerAdmin } = useAuth();
  return isServerAdmin === true;
}
