/**
 * Policy resolution for the chat-side `ops_run_command` / `ops_cluster_shell`
 * runner.
 *
 * The plan-executor path has its own gate (`capabilityForKubectlArgv` in
 * `plan-executor-service.ts`) because it operates on a parsed argv array.
 * The chat-side runner instead receives an opaque shell command string
 * (with pipes, `&&`, `$(...)`, etc.), so we extract the primary capability
 * directly from the string here.
 */

import {
  getConnectorTemplate,
  KUBERNETES_DEFAULT_POLICIES,
  type ConnectorHumanPolicy,
  type ConnectorType,
} from '@agentic-obs/common';
import type { IConnectorRepository } from '@agentic-obs/data-layer';

export type PolicyDecision = ConnectorHumanPolicy | 'no-policy';

/**
 * Map a kubectl verb to its policy capability key. Mirrors
 * `capabilityForKubectlArgv` in plan-executor-service.ts but covers the
 * broader set of read verbs that the chat-side runner accepts.
 */
function kubectlVerbToCapability(verb: string): string | null {
  switch (verb) {
    case 'get':
      return 'runtime.get';
    case 'list':
      return 'runtime.list';
    case 'describe':
      return 'runtime.describe';
    case 'logs':
      return 'runtime.logs';
    case 'events':
      return 'runtime.events';
    case 'top':
      return 'runtime.top';
    case 'version':
    case 'api-resources':
    case 'api-versions':
    case 'cluster-info':
    case 'explain':
    case 'auth':
    case 'config':
      // Read-shaped verbs not individually represented in the template
      // capability list collapse to `runtime.get` (matches the user's
      // mental model: "reading something").
      return 'runtime.get';
    case 'apply':
      return 'runtime.apply';
    case 'create':
      return 'runtime.create';
    case 'patch':
    case 'edit':
    case 'replace':
      return 'runtime.patch';
    case 'delete':
      return 'runtime.delete';
    case 'scale':
      return 'runtime.scale';
    case 'restart':
      return 'runtime.restart';
    case 'rollout':
      return 'runtime.rollout';
    case 'exec':
      return 'runtime.exec';
    case 'cp':
    case 'port-forward':
      return 'runtime.port_forward';
    case 'drain':
      return 'runtime.drain';
    case 'cordon':
      return 'runtime.cordon';
    case 'uncordon':
      return 'runtime.uncordon';
    default:
      return null;
  }
}

const KUBECTL_VERB_RE = /\bkubectl\s+([a-z][a-z-]*)\b/;

/**
 * Extract the primary capability key from a shell command string. The
 * runner accepts pipes / chains, but for policy purposes we care about the
 * first `kubectl <verb>` (most commands are `kubectl ... | grep ...` etc.).
 * Anything that doesn't contain a recognized kubectl verb falls back to
 * `runtime.exec` — the "arbitrary code" bucket.
 */
export function capabilityForShellCommand(command: string): string {
  const m = KUBECTL_VERB_RE.exec(command);
  if (!m) return 'runtime.exec';
  const cap = kubectlVerbToCapability(m[1]!);
  return cap ?? 'runtime.exec';
}

/**
 * Resolve the effective human policy for a given (connector, capability,
 * caller) triple.
 *
 * Precedence (deny-wins within a tier):
 *   1. Any team-scope row whose subjectId is one of the caller's teams.
 *      Across multiple matching teams: block > ask > allow.
 *   2. The org-scope row (subjectType='org', subjectId=orgId).
 *   3. 'no-policy' (caller falls back to template default).
 */
export async function resolveConnectorPolicy(args: {
  connectorRepo: IConnectorRepository;
  connectorId: string;
  capability: string;
  orgId: string;
  userTeamIds: readonly string[];
}): Promise<PolicyDecision> {
  const { connectorRepo, connectorId, capability, orgId, userTeamIds } = args;
  const rows = await connectorRepo.listPolicies({ connectorId });
  const matching = rows.filter((r) => r.capability === capability);

  const teamHits = matching
    .filter((r) => r.subjectType === 'team' && userTeamIds.includes(r.subjectId))
    .map((r) => r.humanPolicy);

  if (teamHits.length > 0) {
    if (teamHits.includes('block')) return 'block';
    if (teamHits.includes('ask')) return 'ask';
    if (teamHits.includes('allow')) return 'allow';
  }

  const orgRow = matching.find(
    (r) => r.subjectType === 'org' && r.subjectId === orgId,
  );
  if (orgRow) return orgRow.humanPolicy;

  return 'no-policy';
}

/**
 * Fallback lookup: when no explicit policy row exists, return the seed
 * default from the connector template (or null if the capability isn't in
 * the seed).
 */
export function templateDefaultPolicy(
  connectorType: string,
  capability: string,
): ConnectorHumanPolicy | null {
  // Only kubernetes ships a default policy table today.
  if (connectorType !== 'kubernetes') {
    try {
      // Touch the template registry so the call site stays generic for
      // future types. No-op for non-kubernetes — keeps the typecheck honest.
      getConnectorTemplate(connectorType as ConnectorType);
    } catch {
      // unknown type — fall through
    }
    return null;
  }
  const seed = KUBERNETES_DEFAULT_POLICIES.find((p) => p.capability === capability);
  return seed?.humanPolicy ?? null;
}
