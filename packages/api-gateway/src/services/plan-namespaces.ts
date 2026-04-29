/**
 * Extract the set of Kubernetes namespaces a RemediationPlan touches.
 *
 * Used by the approve route to gate `plans:auto_edit` per-namespace
 * (design-doc §6 O2): an operator can be granted auto-edit for some
 * namespaces (e.g. `app`) without granting it cluster-wide.
 *
 * Pure function — no I/O. Walks each step's `paramsJson.argv` and
 * pulls out the value of `-n` / `--namespace` / `--namespace=`. A
 * step without a namespace flag is "cluster-scoped" and we surface
 * that explicitly; plans with cluster-scoped writes can't be
 * narrowed by namespace and require the `plans:*` (cluster-wide)
 * grant.
 */

import type { RemediationPlan } from '@agentic-obs/data-layer';

export interface PlanNamespaceSummary {
  /** Distinct namespaces named explicitly across all steps, sorted. */
  namespaces: string[];
  /**
   * True when at least one step has no `--namespace` flag. Such a step
   * may be a cluster-scoped read (e.g. `kubectl get nodes`) — in that
   * case namespace narrowing doesn't apply and the caller needs the
   * cluster-wide `plans:*` grant for auto-edit.
   */
  hasClusterScoped: boolean;
}

export function extractPlanNamespaces(plan: RemediationPlan): PlanNamespaceSummary {
  const namespaces = new Set<string>();
  let hasClusterScoped = false;
  for (const step of plan.steps) {
    if (step.kind !== 'ops.run_command') continue;
    const argv = step.paramsJson['argv'];
    if (!Array.isArray(argv)) {
      // Malformed step paramsJson — treat as cluster-scoped (most
      // restrictive). The plan creation path validates step shapes,
      // so this branch is defensive.
      hasClusterScoped = true;
      continue;
    }
    const ns = readNamespaceFromArgv(argv as string[]);
    if (ns === null) {
      hasClusterScoped = true;
    } else {
      namespaces.add(ns);
    }
  }
  return { namespaces: [...namespaces].sort(), hasClusterScoped };
}

function readNamespaceFromArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (tok === '-n' || tok === '--namespace') {
      const val = argv[i + 1];
      return typeof val === 'string' && val.length > 0 ? val : null;
    }
    if (tok.startsWith('--namespace=')) {
      const val = tok.slice('--namespace='.length);
      return val.length > 0 ? val : null;
    }
  }
  return null;
}
