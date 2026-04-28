# Kubernetes with Helm

OpenObs includes a first-party Helm chart in this repository at `helm/openobs`.

## Basic install

```bash
helm upgrade --install openobs oci://ghcr.io/openobs/charts/openobs \
  --namespace observability \
  --create-namespace
```

This installs a private `ClusterIP` service, which is reachable from inside the
cluster. For local evaluation, use `kubectl port-forward`; for shared access,
configure Ingress or a load balancer.

## Accessing OpenObs

### Local cluster / private ClusterIP

The default service type is `ClusterIP`. This is intentionally private to the
cluster, so a local kind/minikube install needs a tunnel:

```bash
kubectl -n observability port-forward svc/openobs 3000:80
```

Then open `http://127.0.0.1:3000`.

This is the same pattern many Helm charts use for quick local verification:
install privately by default, then port-forward from your workstation. For
shared access, use one of the options below instead.

### LoadBalancer

Use this when your Kubernetes environment can provision external load balancers:

```bash
helm upgrade --install openobs oci://ghcr.io/openobs/charts/openobs \
  --namespace observability \
  --create-namespace \
  --set service.type=LoadBalancer
```

Wait for an external address:

```bash
kubectl -n observability get svc openobs --watch
```

### Ingress

Use this when your cluster already has an Ingress controller such as nginx,
Traefik, or a cloud provider ingress controller:

```bash
helm upgrade --install openobs oci://ghcr.io/openobs/charts/openobs \
  --namespace observability \
  --create-namespace \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set ingress.hosts[0].host=openobs.example.com \
  --set env.CORS_ORIGINS=https://openobs.example.com
```

Point DNS for `openobs.example.com` at your Ingress controller.

## Storage

The Helm chart currently defaults to local SQLite persistence. The database file
lives at `/var/lib/openobs/openobs.db` inside the container and is stored on the
chart's persistent volume claim when `persistence.enabled=true`.

This is fine for a single replica, evaluation, and small self-hosted installs.
For production Kubernetes and any multi-replica deployment, prefer an external
Postgres database once full Postgres persistence is enabled. SQLite on a
ReadWriteOnce PVC should not be shared by multiple OpenObs pods.

Today, `secretEnv.DATABASE_URL` enables the existing Postgres-backed
instance-configuration repositories, but it does not yet move every OpenObs
table off SQLite. Keep `replicaCount=1` unless you are running a build with full
Postgres persistence.

## Common overrides

- `secretEnv.JWT_SECRET`: explicit JWT secret
- `secretEnv.DATABASE_URL`: Postgres connection string for supported Postgres-backed tables
- `secretEnv.REDIS_URL`: enable Redis-backed features
- `persistence.enabled`: keep local state on a PVC
- `ingress.enabled`: expose the app through an Ingress controller
- `service.type`: set to `LoadBalancer` or `NodePort` when your cluster supports it

LLM credentials are configured in the web setup flow after first login.
