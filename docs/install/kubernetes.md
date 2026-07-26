# Kubernetes with Helm

Rounds includes a first-party Helm chart in this repository at `helm/rounds`.

## Basic install

```bash
helm upgrade --install rounds oci://ghcr.io/syntropize-ai/charts/rounds \
  --namespace observability \
  --create-namespace
```

This installs a private `ClusterIP` service, which is reachable from inside the
cluster. For local evaluation, use `kubectl port-forward`; for shared access,
configure Ingress or a load balancer.

## Accessing Rounds

### Local cluster / private ClusterIP

The default service type is `ClusterIP`. This is intentionally private to the
cluster, so a local kind/minikube install needs a tunnel:

```bash
kubectl -n observability port-forward svc/rounds 3000:80
```

Then open `http://127.0.0.1:3000`.

This is the same pattern many Helm charts use for quick local verification:
install privately by default, then port-forward from your workstation. For
shared access, use one of the options below instead.

### LoadBalancer

Use this when your Kubernetes environment can provision external load balancers:

```bash
helm upgrade --install rounds oci://ghcr.io/syntropize-ai/charts/rounds \
  --namespace observability \
  --create-namespace \
  --set service.type=LoadBalancer
```

Wait for an external address:

```bash
kubectl -n observability get svc rounds --watch
```

### Ingress

Use this when your cluster already has an Ingress controller such as nginx,
Traefik, or a cloud provider ingress controller:

```bash
helm upgrade --install rounds oci://ghcr.io/syntropize-ai/charts/rounds \
  --namespace observability \
  --create-namespace \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.hosts[0].host=rounds.example.com \
  --set env.CORS_ORIGINS=https://rounds.example.com
```

Point DNS for `rounds.example.com` at your Ingress controller.

## Storage

The Helm chart can run with either local SQLite or external Postgres.

SQLite is the default for evaluation and small single-pod installs. The database
file lives at `/var/lib/rounds/rounds.db` inside the container and is stored on
the chart's persistent volume claim when `persistence.enabled=true`. Do not run
multiple Rounds replicas against the SQLite PVC.

For production Kubernetes and any multi-replica deployment, use Postgres. Set
`secretEnv.DATABASE_URL` before the first Rounds pod starts:

```bash
helm install rounds oci://ghcr.io/syntropize-ai/charts/rounds \
  --namespace observability --create-namespace \
  --set secretEnv.DATABASE_URL='postgresql://rounds:password@postgres.example.com:5432/rounds' \
  --set env.DATABASE_SSL=true
```

When `DATABASE_URL` starts with `postgres://` or `postgresql://`, Rounds uses
Postgres for the full repository layer: auth, RBAC, settings, datasources,
dashboards, investigations, alerts, notifications, chat, and feed data. Choose
the backend at install time. The setup wizard stores application settings such
as the LLM provider, but it cannot switch the database because the database must
exist before the app can boot.

SQLite and Postgres are the supported backends today. The repository layer is
abstracted so more SQL databases can be added later without changing the setup
flow.

## Common overrides

- `secretEnv.JWT_SECRET`: explicit JWT secret
- `secretEnv.DATABASE_URL`: Postgres connection string; enables the full Postgres repository backend
- `secretEnv.REDIS_URL`: enable Redis-backed features
- `persistence.enabled`: keep local state on a PVC
- `ingress.enabled`: expose the app through an Ingress controller
- `service.type`: set to `LoadBalancer` or `NodePort` when your cluster supports it

LLM credentials are configured in the web setup flow after first login.

## Health probes

The chart wires three endpoints. They answer different questions, and only one
of them can take a pod out of rotation.

| Probe | Path | Asks | On failure |
|---|---|---|---|
| startup | `/api/health/startup` | has the process finished booting? | 30 × 5s before the pod is declared failed |
| readiness | `/api/health/ready` | can this pod serve requests? | pod leaves the Service endpoints |
| liveness | `/api/health/live` | is the process alive? | pod is restarted |

Readiness runs a real query against the configured database and returns **503**
when it does not answer within two seconds. Kubernetes then removes the pod
from the Service until it recovers.

This is worth knowing when upgrading: previously the endpoint reported the
database as "not configured" and returned 200 unconditionally, so a pod with an
unreachable database kept receiving traffic. If pods start leaving the Service
after an upgrade, the probe is not the fault — it is reporting a database
problem that was already there.

`GET /api/health/ready` returns the detail:

```json
{
  "status": "healthy",
  "checks": {
    "db": { "status": "ok" },
    "redis": { "status": "skip", "message": "No Redis configured" },
    "proactive": { "status": "ok" }
  },
  "timestamp": "2026-07-26T14:03:38.075Z"
}
```

- `status: "unhealthy"` — the database check failed. HTTP 503.
- `status: "degraded"` — the product still serves, but something is off: the
  background pipeline is not running, or the database could not be checked at
  all. HTTP 200, because taking the pod out of rotation would turn a
  background-job problem into an outage.
- `status: "healthy"` — everything checked passed. HTTP 200.
