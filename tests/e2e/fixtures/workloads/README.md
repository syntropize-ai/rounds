# e2e workload fixtures

Manifests for the workloads the e2e testkit asserts against. All resources live
in the `openobs-e2e` namespace, alongside openobs itself.

## Files

- **`prometheus.yaml`** — single-replica Prometheus with pod-role service
  discovery scoped to `openobs-e2e`. Picks up any pod with the
  `prometheus.io/scrape=true` annotation. Service exposes `:9090` ClusterIP.
- **`web-api.yaml`** — `prometheus-example-app` (3 replicas) on `:8080`. The
  primary scrape target; killing it is what drives the "metric drops to zero"
  scenarios. Service exposes `:8080` ClusterIP.
- **`load.yaml`** — two curl-loop deployments:
  - `load-200` hits `/` on web-api (200s, drives baseline RPS)
  - `load-500` hits `/err` on web-api (5xx, drives error rate)

## Apply order

`prometheus.yaml` → `web-api.yaml` → `load.yaml`. The load generators reach
`web-api` by service DNS, so apply web-api first. Prometheus tolerates targets
appearing later, but applying it first means it begins scraping immediately
once web-api is up.

## Namespace

These manifests do **not** create the `openobs-e2e` namespace — `kit.sh`
handles namespace creation (sibling agent A's `deploy.sh`). For ad-hoc use:

```bash
kubectl create namespace openobs-e2e
kubectl apply -f tests/e2e/fixtures/workloads/
```

`kit.sh` applies them automatically as part of `kit.sh up`. The manifests stay
plain `kubectl apply`-friendly so they are debuggable in isolation.
