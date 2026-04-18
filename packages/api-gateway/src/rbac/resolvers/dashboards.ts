/**
 * Dashboards scope resolver — expands `dashboards:uid:<uid>` to include
 * the dashboard itself + its folder chain + the all-dashboards/all-folders
 * wildcards.
 *
 * Folder cascade: when a lookup function is provided via `deps.dashboardFolderUid`,
 * the resolver uses it to discover the dashboard's folder UID and then walks
 * the folder ancestry (via FolderRepository) to produce every folder UID in
 * the chain. Grant on any ancestor folder covers the dashboard.
 *
 * Grafana reference (read for semantics only):
 *   pkg/services/accesscontrol/resolvers/folder.go
 */

import { parseScope } from '@agentic-obs/common';
import type { ScopeResolver, ResolverDeps } from './index.js';

export function buildDashboardsResolver(deps: ResolverDeps): ScopeResolver {
  return async (scope: string) => {
    const parsed = parseScope(scope);
    if (parsed.kind !== 'dashboards') return [scope];

    const expanded = new Set<string>();
    expanded.add(scope);
    expanded.add('dashboards:*');
    expanded.add('dashboards:uid:*');

    // For a concrete uid, walk the folder cascade so grants on any ancestor
    // folder cover the dashboard.
    if (parsed.attribute === 'uid' && parsed.identifier !== '*') {
      const uid = parsed.identifier;
      if (deps.dashboardFolderUid && deps.folders) {
        try {
          const folderUid = await deps.dashboardFolderUid(deps.orgId, uid);
          if (folderUid) {
            expanded.add(`folders:uid:${folderUid}`);
            const ancestors = await deps.folders.listAncestors(
              deps.orgId,
              folderUid,
            );
            for (const a of ancestors) {
              expanded.add(`folders:uid:${a.uid}`);
            }
          }
        } catch {
          // lookup failed — fall back to direct wildcards only
        }
      }
      // folders:* is always a valid coverage path for dashboards per design.
      expanded.add('folders:*');
      expanded.add('folders:uid:*');
    }
    return [...expanded];
  };
}
