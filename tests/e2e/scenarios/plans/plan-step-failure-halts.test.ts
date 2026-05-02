/**
 * A failing kubectl step should halt the plan; remaining steps must stay
 * `queued`.
 *
 * Skipped because there's no HTTP endpoint to file a custom plan
 * directly — plans are produced by the agent. The orchestration test
 * for halt-on-failure lives in unit tests; an e2e equivalent needs a
 * test-only `POST /api/plans` (not currently mounted).
 */
import { describe, it } from 'vitest';

describe.skip('plans/plan-step-failure-halts', () => {
  it('plan halts and queued steps stay queued on a failing step', () => {
    // Recipe (manual): once a plan-create endpoint exists, post a plan
    // with two steps where step 1 is `kubectl get nonexistent`. Approve.
    // Poll: plan.status === 'failed', step[0].status === 'failed',
    // step[1].status === 'queued'.
  });
});
