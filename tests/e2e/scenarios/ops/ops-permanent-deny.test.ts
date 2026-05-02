/**
 * Hard-deny commands like `kubectl exec` and `kubectl get secret` are
 * rejected at the policy layer regardless of caller permissions.
 *
 * Skipped: same reason as the other ops scenarios — no HTTP entrypoint.
 * The hard-deny list is exhaustively unit-tested in
 * `packages/adapters/src/execution/kubectl-allowlist.test.ts`.
 */
import { describe, it } from 'vitest';

describe.skip('ops/ops-permanent-deny', () => {
  it('kubectl exec / get secret are denied even for admins', () => {
    // Recipe: invoke ops_run_command with `kubectl exec ...` or
    // `kubectl get secret ...`; assert decision === 'denied' regardless
    // of role.
  });
});
