# tests/e2e/scenarios

End-to-end scenarios that exercise openobs through real LLM rounds
against the kind cluster brought up by `tests/e2e/kit.sh`.

## What runs

| Scenario | Asserts |
| -------- | ------- |
| `alert-fires.test.ts` | Generated alert rule transitions `normal -> pending -> firing` within 90s after the watched workload is scaled to 0. |
| `investigation-completes.test.ts` | The dispatcher links an `Investigation` onto the firing rule and that investigation reaches `status='completed'` within 120s. |
| `plan-proposed.test.ts` | A `RemediationPlan` lands in `pending_approval`, linked to the investigation, with at least one `kubectl scale ... replicas=...` step. |
| `plan-approve-and-execute.test.ts` | Marquee. Approving the plan executes it, all steps end `status='done'`, web-api comes back, and the alert resolves. |

The last three skip when `OPENOBS_TEST_LLM_API_KEY` is unset — without
LLM credit there's no plan to assert against.

## How they're wired

- Scenarios are TypeScript and run under `vitest.e2e.config.ts` (owned
  by sibling agent A). Each `it` has a 180s timeout.
- `beforeAll` resets the workload to its baseline (3 replicas) so
  re-runs don't observe stale state from a previous run.
- `afterAll` is best-effort: deletes the rule it created and scales the
  workload back. Failures inside cleanup do not mask test failures.
- Every wait uses `pollUntil` from `helpers/wait.ts`. No bare
  `setTimeout`.

## Required state

All scenarios assume `tests/e2e/lib/seed.sh` has run successfully so
`tests/e2e/.state/sa-token` exists. `helpers/api-client.ts` reads it
once on import; missing/empty token fails the run with a clear message.

## Debugging a flaky scenario

```sh
# Bring the cluster up but don't tear it down on exit.
OPENOBS_TEST_KEEP=1 \
OPENOBS_TEST_LLM_PROVIDER=anthropic \
OPENOBS_TEST_LLM_API_KEY=$ANTHROPIC_API_KEY \
OPENOBS_TEST_LLM_MODEL=claude-haiku-4-5 \
tests/e2e/kit.sh up

# Re-run a single scenario directly.
npx vitest run tests/e2e/scenarios/plan-approve-and-execute.test.ts \
  -c vitest.e2e.config.ts

# Inspect cluster state with the same kubeconfig kit.sh provisioned.
kubectl -n openobs-e2e get pods,deploy
kubectl -n openobs-e2e logs deploy/openobs --tail=200
kubectl -n openobs-e2e logs deploy/web-api --tail=200

# Tail the openobs API directly with the seeded SA token.
TOKEN=$(cat tests/e2e/.state/sa-token)
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/alert-rules
curl -H "authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/plans

# Tear down when done.
tests/e2e/kit.sh down
```

A common cause of "flake" here is the LLM round taking longer than
the per-step timeout. Bump `timeoutMs` on the relevant `pollUntil`
locally to confirm before declaring an actual bug.
