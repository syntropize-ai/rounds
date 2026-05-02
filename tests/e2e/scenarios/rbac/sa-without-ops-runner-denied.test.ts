/**
 * Stripping the fixed `ops.commands:runner` role from a service account
 * should make agent-driven ops_run_command tool calls deny (Ref PR
 * #125).
 *
 * Skipped: like the other ops scenarios, no HTTP entrypoint exists for
 * ops_run_command, so we can't deterministically drive a denied vs.
 * allowed run from a test. Permission-gate coverage at the route layer
 * is exercised in unit tests; the scenario shape is documented here so
 * it can be flipped on once the entrypoint exists.
 */
import { describe, it } from 'vitest';

describe.skip('rbac/sa-without-ops-runner-denied (Ref PR #125)', () => {
  it('SA without fixed:ops.commands:runner is denied ops_run_command', () => {
    // Recipe:
    //   1. mintSaToken(); list current roles via GET /api/access-control/users/:saId/roles
    //   2. removeRole(saId, 'fixed:ops.commands:runner')
    //   3. Trigger an investigation that calls ops_run_command using that SA
    //   4. assert decision === 'denied'
    //   5. afterAll: assignRole(saId, 'fixed:ops.commands:runner') to restore
  });
});
