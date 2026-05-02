# chainsaw tests

Kubernetes-topology assertions for the openobs e2e testkit. These tests cover
**cluster-state shape and scrape readiness**, not application logic — the
application-level scenarios live alongside the vitest scenarios in
`tests/e2e/scenarios/`.

## What's covered

- `01-cluster-ready` — prometheus, web-api (x3), load-200, load-500, and
  openobs itself are all running; their Services have the expected endpoint
  counts.
- `02-prometheus-scrapes-web-api` — the in-cluster Prometheus is actually
  scraping web-api (`count(up{app="web-api"}==1) > 0`).
- `03-openobs-reachable` — openobs answers HTTP 200 on `/api/health/ready`
  from inside the cluster.

## Running standalone

Assumes `kit.sh up` (sibling A) has prepared the cluster and applied the
workload fixtures.

```bash
chainsaw test tests/e2e/chainsaw/tests \
  --config tests/e2e/chainsaw/.chainsaw.yaml
```

`kit.sh run` runs these alongside the vitest scenarios.

## Notes

- Tests run sequentially (`parallel: 1`) — they share the same cluster and the
  same long-lived workloads.
- Tests deliberately do **not** clean up the workloads — downstream scenarios
  rely on them being in place.
- Polling is done inside `script` steps via ephemeral `kubectl run` curl pods
  so the assertions don't depend on port-forwarding from the host.
