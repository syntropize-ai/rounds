import { parseScope } from '@agentic-obs/common';
import type { ScopeResolver, ResolverDeps } from './index.js';

/**
 * Connectors are flat resources. A concrete connector UID is covered by the
 * connector wildcards, with no folder-style ancestry.
 */
export function buildConnectorsResolver(_deps: ResolverDeps): ScopeResolver {
  return (scope: string) => {
    const parsed = parseScope(scope);
    if (parsed.kind !== 'connectors') return [scope];
    return [...new Set([scope, 'connectors:*', 'connectors:uid:*'])];
  };
}
