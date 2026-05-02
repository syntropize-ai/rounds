/**
 * Write commands (eg `kubectl scale --replicas=2`) requested with
 * intent=propose must create an ApprovalRequest and NOT execute.
 *
 * Skipped for the same reason as `ops-read-allowed.test.ts`: there is
 * no HTTP entrypoint for `ops_run_command`. Coverage lives at the
 * service layer.
 */
import { describe, it } from 'vitest';

describe.skip('ops/ops-write-needs-approval', () => {
  it('propose intent for a write command creates approval, does not execute', () => {
    // Recipe: invoke ops_run_command via a chat tool call with intent=propose;
    // assert /api/approvals returns a row with type=ops.run_command and the
    // workload is unchanged.
  });
});
