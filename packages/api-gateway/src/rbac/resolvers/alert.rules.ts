/**
 * Alert rule scope resolver — alert rules inherit permissions from their
 * containing folder. When a lookup function for rule->folder uid is provided
 * (deps.alertRuleFolderUid), the resolver walks the folder chain and emits
 * every `folders:uid:<ancestor>` that would cover the rule.
 *
 * Grafana reference (read for semantics only):
 *   pkg/services/ngalert/accesscontrol/scopes.go
 */

import { parseScope } from '@agentic-obs/common';
import type { ScopeResolver, ResolverDeps } from './index.js';

export function buildAlertRulesResolver(deps: ResolverDeps): ScopeResolver {
  return async (scope: string) => {
    const parsed = parseScope(scope);
    if (parsed.kind !== 'alert.rules') return [scope];

    const expanded = new Set<string>();
    expanded.add(scope);
    expanded.add('alert.rules:*');
    expanded.add('alert.rules:uid:*');
    expanded.add('folders:*');
    expanded.add('folders:uid:*');

    if (parsed.attribute === 'uid' && parsed.identifier !== '*') {
      const uid = parsed.identifier;
      if (deps.alertRuleFolderUid && deps.folders) {
        try {
          const folderUid = await deps.alertRuleFolderUid(deps.orgId, uid);
          if (folderUid) {
            expanded.add(`folders:uid:${folderUid}`);
            const ancestors = await deps.folders.listAncestors(
              deps.orgId,
              folderUid,
            );
            for (const a of ancestors) expanded.add(`folders:uid:${a.uid}`);
          }
        } catch {
          // lookup failed — literal + wildcards still cover the common case
        }
      }
    }
    return [...expanded];
  };
}
