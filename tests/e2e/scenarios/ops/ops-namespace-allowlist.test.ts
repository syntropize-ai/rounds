/**
 * Connector with `allowedNamespaces=[openobs-e2e]` must deny commands
 * targeting other namespaces (eg `kube-system`).
 *
 * Skipped: agent-mediated. The classifier behavior is exercised by
 * `packages/adapters/src/execution/kubectl-allowlist.test.ts`.
 */
import { describe, it } from 'vitest';

describe.skip('ops/ops-namespace-allowlist', () => {
  it('command targeting non-allow-listed namespace is denied', () => {
    // Recipe: ensure connector.allowedNamespaces=['openobs-e2e'], invoke
    // `kubectl get pods -n kube-system` via the agent; assert decision === 'denied'.
  });
});
