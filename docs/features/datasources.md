# Datasources & connectors

OpenObs reads metrics, logs, and change events from your existing infrastructure, and talks to ops systems (Kubernetes today, more planned) through **connectors**. Every dashboard panel, alert rule, and investigation query talks to a configured datasource — there's no second copy of the data.

Datasources can be added through the setup wizard, the Settings page, the REST API, **or by chatting with the agent** (e.g. "connect my prod Prometheus at http://..."). The agent uses the AI-first config tools to validate the URL, test connectivity, and save under your RBAC.

## Supported backends

### Metrics

| Backend | Compatibility | Notes |
|---|---|---|
| **Prometheus** | Native | PromQL via `/api/v1/query` and `/api/v1/query_range` |
| **VictoriaMetrics** | Native | Use MetricsQL extensions where supported |
| **Mimir** | Via Prometheus protocol | Set the tenant ID via `X-Scope-OrgID` header in datasource config |
| **Thanos** | Via Prometheus protocol | Querier endpoint works as-is |
| **Cortex** | Via Prometheus protocol | Same as Mimir |

Any backend exposing the Prometheus HTTP API works.

### Logs

| Backend | Compatibility | Notes |
|---|---|---|
| **Loki** | Native | LogQL via `/loki/api/v1/query` and `/query_range` |

### Change events

| Source | Status | Notes |
|---|---|---|
| **Manual entry** | Available | UI for recording deploys, config flips, infra changes |
| **GitHub releases** | Planned | Auto-import from release events |
| **ArgoCD / Flux** | Planned | Watch for sync events |
| **CI/CD systems** | Planned | Build / deploy webhooks |

### Ops connectors

Ops connectors let OpenObs read state and (with approval) act on the systems running your workloads.

| Connector | Status | Used for |
|---|---|---|
| **Kubernetes** (kubectl, allowlisted) | Available | Investigation reads + plan execution. See [Auto-remediation](/operations/auto-remediation). |
| **GitHub PRs** | Planned | Open remediations as PRs instead of direct kubectl writes |
| **Jira / PagerDuty / Opsgenie** | Planned | Incident sync + on-call routing |
| **Database read connectors** | Planned | Slow-query logs, schema state |
| **Distributed tracing** | Planned | Trace-aware investigation |

## How to use it

### Add a datasource

UI: Admin → Datasources → **+ New datasource** → pick the type → fill in URL + auth.

Or via API:

```bash
curl -X POST https://your-openobs/api/datasources \
  -H "Authorization: Bearer openobs_sa_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prod-prometheus",
    "type": "prometheus",
    "url": "http://prometheus.monitoring.svc:9090",
    "access": "proxy",
    "isDefault": true
  }'
```

### Test connectivity

After adding, click **Save & test** in the UI. OpenObs hits `GET /api/v1/labels` (Prometheus) or `GET /loki/api/v1/labels` (Loki) and shows the response.

### Use it in chat

Once a datasource is configured, the agent automatically discovers it via `datasources.list`. No prompt change needed:

> Show me memory usage across all hosts

The agent picks the appropriate metrics datasource and runs queries.

### Multiple datasources

You can have many. The agent will:
- Filter by `signalType` (`metrics` / `logs` / `changes`) when relevant
- Pick the default datasource for each signal type unless you specify ("query the staging Prometheus instead")
- Suggest specifying when ambiguous

### Datasource permissions

By default, all org members can query all datasources (their org role determines write access). For sensitive sources:

UI: Admin → Datasources → click datasource → **Permissions** tab → Add → pick user/team/role → level (View / Edit / Admin) → Save.

`View` = `datasources:query` (read data). `Edit` = modify config. `Admin` = manage permissions on this datasource.

## Examples

### Connect a dev Prometheus + a prod Mimir

```bash
# Dev — local prometheus
curl -X POST .../api/datasources -d '{
  "name": "dev-prometheus",
  "type": "prometheus",
  "url": "http://localhost:9090"
}'

# Prod — Mimir with tenant
curl -X POST .../api/datasources -d '{
  "name": "prod-mimir",
  "type": "prometheus",
  "url": "https://mimir.prod.example.com/prometheus",
  "jsonData": { "httpHeaderName1": "X-Scope-OrgID" },
  "secureJsonData": { "httpHeaderValue1": "tenant-foo" }
}'
```

### Connect Loki for log search

```bash
curl -X POST .../api/datasources -d '{
  "name": "logs",
  "type": "loki",
  "url": "http://loki.monitoring.svc:3100"
}'
```

After this, the agent picks it up and you can ask: "Search logs for OOM kills in the last hour".

## Limits

- Auth methods supported: bearer token, basic auth, custom headers, mTLS (via cert + key in `secureJsonData`).
- The agent caps result-set size at 20 series per metric query to keep the conversation snappy. Override per-call if needed.
- No write-back to datasources — OpenObs reads only. Recording rules and alerting rules live in OpenObs's own database.
- Datasource configs are stored encrypted (`SECRET_KEY` for credentials). Datasource definitions are org-scoped — separate orgs cannot see each other's connections.

## Related

- [Configuration](/configuration) — `DEFAULT_METRICS_URL` etc. for bootstrap
- [Permissions](/auth#datasource-permissions) — per-datasource ACLs
- [Dashboards](/features/dashboards) — uses the configured datasources
