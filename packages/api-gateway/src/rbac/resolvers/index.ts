/**
 * Scope resolvers — expand a requested scope string into the set of scopes
 * any of which, if granted, should authorize the request.
 *
 * Example: a request to read `dashboards:uid:abc` is also authorized by
 * `folders:uid:<parent>` (the dashboard's folder). The dashboard resolver
 * walks the folder ancestry and returns every scope that covers the resource.
 *
 * Grafana reference (read for semantics only):
 *   pkg/services/accesscontrol/resolvers/resolvers.go.
 *
 * Each resolver is a pure function: `(scope) => string[]`. If the underlying
 * data (e.g. folder chain) isn't available yet (Wave 2: folders aren't wired
 * up to dashboards), the resolver returns the scope unchanged. Integration
 * tests exercising cascade live in T7 per design doc.
 */

import type { IFolderRepository } from '@agentic-obs/common';
import { buildDashboardsResolver } from './dashboards.js';
import { buildFoldersResolver } from './folders.js';
import { buildDatasourcesResolver } from './datasources.js';
import { buildUsersResolver } from './users.js';
import { buildTeamsResolver } from './teams.js';
import { buildServiceAccountsResolver } from './serviceaccounts.js';
import { buildAlertRulesResolver } from './alert.rules.js';

export type ScopeResolver = (scope: string) => Promise<string[]> | string[];

/**
 * Lookup table keyed by scope kind → resolver. The evaluator calls
 * `resolverFor(kind)` and uses the result to expand a request scope.
 */
export interface ResolverRegistry {
  resolve(scope: string): Promise<string[]>;
}

export interface ResolverDeps {
  folders?: IFolderRepository;
  /** org context — resolvers that query by org_id use this. */
  orgId: string;
  /**
   * Lookup the folder UID of a given dashboard — used by the dashboards
   * resolver to emit `folders:uid:<parent>` cascade scopes. Optional; when
   * absent, the resolver emits only direct + wildcard scopes.
   */
  dashboardFolderUid?: (orgId: string, dashboardUid: string) => Promise<string | null>;
  /**
   * Lookup the folder UID of a given alert rule — analogous hook for the
   * alert.rules resolver.
   */
  alertRuleFolderUid?: (orgId: string, ruleUid: string) => Promise<string | null>;
}

/**
 * Build a composite resolver that dispatches to per-kind resolvers. Returns
 * an empty-cascade identity resolver for unknown kinds (scope passed through
 * verbatim).
 */
export function createResolverRegistry(deps: ResolverDeps): ResolverRegistry {
  const dashboards = buildDashboardsResolver(deps);
  const folders = buildFoldersResolver(deps);
  const datasources = buildDatasourcesResolver(deps);
  const users = buildUsersResolver(deps);
  const teams = buildTeamsResolver(deps);
  const sa = buildServiceAccountsResolver(deps);
  const alertRules = buildAlertRulesResolver(deps);

  const byKind: Record<string, ScopeResolver> = {
    dashboards,
    folders,
    datasources,
    users,
    teams,
    serviceaccounts: sa,
    'alert.rules': alertRules,
  };

  return {
    async resolve(scope: string): Promise<string[]> {
      if (scope === '' || scope === '*') return [scope];
      const colon = scope.indexOf(':');
      const kind = colon === -1 ? scope : scope.slice(0, colon);
      const fn = byKind[kind];
      if (!fn) return [scope];
      const result = fn(scope);
      return Array.isArray(result) ? result : await result;
    },
  };
}

export {
  buildDashboardsResolver,
  buildFoldersResolver,
  buildDatasourcesResolver,
  buildUsersResolver,
  buildTeamsResolver,
  buildServiceAccountsResolver,
  buildAlertRulesResolver,
};
