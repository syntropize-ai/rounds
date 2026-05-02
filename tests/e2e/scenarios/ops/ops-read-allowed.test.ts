/**
 * Agent-mediated ops smoke: a `read` intent kubectl command on an
 * allow-listed namespace should succeed via the in-cluster connector.
 *
 * Skipped: there's no public HTTP endpoint for `ops_run_command`; it is
 * invoked through the agent (chat / investigation flows). Driving this
 * end-to-end requires staging a chat session and asserting on the
 * resulting tool-call observation, which is outside the harness's
 * deterministic surface today. The unit-level coverage for the
 * read/propose/deny matrix lives in
 * `packages/api-gateway/src/services/ops-command-runner-service.test.ts`.
 */
import { describe, it } from 'vitest';

describe.skip('ops/ops-read-allowed', () => {
  it('read intent on allow-listed namespace succeeds (agent-mediated)', () => {
    // Recipe: open a chat session scoped to the e2e workspace, prompt
    //   "kubectl get deploy/web-api -n openobs-e2e (read-only)" and
    //   inspect the agent's ops_run_command tool call.
  });
});
