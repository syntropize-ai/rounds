# tests/e2e/scenarios/helpers

Shared utilities used by every scenario. Imported by relative path so
they don't need to be a separate workspace package.

| File | Purpose |
| ---- | ------- |
| `api-client.ts` | Bearer-auth `fetch` wrapper. Reads `tests/e2e/.state/sa-token` once at module load. Base URL from `OPENOBS_TEST_BASE_URL` (default `http://127.0.0.1:3000`). Throws `ApiError` with status + body excerpt on non-2xx. |
| `wait.ts` | `pollUntil(fn, { timeoutMs, intervalMs, label })`. Returns the first non-null/undefined value `fn` produces. Always prefer this over bare `setTimeout` so timeouts produce a labelled error. |
| `prom-helpers.ts` | `promQuery(promQL)` and `awaitRate(promQL, predicate, timeoutMs)`. Talks to prometheus directly via `OPENOBS_TEST_PROM_DIRECT_URL` (default `http://127.0.0.1:9090`, typically a `kit.sh` port-forward). Used for fixture-state assertions, not as a substitute for what openobs sees. |
| `scale.ts` | `scaleDeployment(ns, name, replicas)`. Shells out to `kubectl scale` and waits for the deployment to converge. Requires a working `kubectl` in `PATH` pointed at the kind cluster — `kit.sh up` does this. |

## State contract

Helpers (and scenarios) assume `tests/e2e/lib/seed.sh` has already run
and produced these files in `tests/e2e/.state/`:

```
admin-cookie               # admin session cookie jar
admin-password             # generated/persisted admin password
sa-token                   # bearer token used by api-client.ts
prometheus-datasource-id   # id of the seeded prometheus datasource
ops-connector-id           # id of the seeded in-cluster ops connector
```

If `sa-token` is missing or empty, `api-client.ts` throws a clear error
on first import and the whole vitest run fails fast.
