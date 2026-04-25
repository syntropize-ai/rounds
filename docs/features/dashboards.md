# Dashboards

Build observability dashboards by describing what you want in plain language. OpenObs discovers your metrics, picks visualizations, validates the queries, and ships a working dashboard grounded in real values.

## What you can do

- **Generate from a prompt** — "create a dashboard for HTTP latency" → ~5 panels with grounded p50/p95/p99, request rate, error rate.
- **Iterate by chat** — "add a panel showing 5xx errors by handler", "split the latency panel by method", "remove the request-rate panel".
- **Manage layout** — rearrange, resize, retitle panels via chat or drag-and-drop.
- **Add variables** — "add a `service` dropdown" creates a template variable backed by a label query.
- **List & open** — `dashboard.list` returns dashboards filtered by folder/tag; click-through to open in the workspace.

## How to use it

### Create a new dashboard

In the chat panel:

> Create a dashboard for HTTP latency

OpenObs runs the orchestrator agent through a multi-step plan:

1. `datasources.list` — find available metrics backends
2. `metrics.metric_names` + `web.search` — discover relevant metric names + best practices
3. `metrics.metadata` / `metrics.labels` — understand the schema
4. `metrics.query` (parallel) — sample real values for grounding
5. `metrics.validate` — confirm each query parses and returns data
6. `dashboard.create` + `dashboard.add_panels` — build it
7. `navigate` — open the new dashboard for you

You'll see the streaming step trace as it runs.

### Edit an existing dashboard

Open a dashboard, then in the chat:

> Add a panel showing the 5xx error rate per handler

Or use direct UI controls — click the panel menu to edit/duplicate/remove. Both paths use the same underlying tools (`dashboard.add_panels`, `dashboard.modify_panel`, `dashboard.remove_panels`).

### Add a template variable

> Add a `service` variable populated from the `service` label

Generates a `metrics.label_values` query and wires the variable into all panel queries that use that label.

## Examples

| Prompt | Result |
|---|---|
| `Create a dashboard for Redis health` | Connections, ops/sec, memory, evictions, hit rate |
| `Add p50/p95/p99 latency panels grouped by route` | 3 stat panels + 1 timeseries panel |
| `Split the requests panel by status code class` | Modifies existing panel to add `status_code_class` legend |
| `Remove all panels with zero data` | Iterates panels, queries each, deletes empty ones |

## Limits

- Generation is grounded in your **current** metrics. Cardinality bombs (label combos with millions of series) are filtered out automatically — limit 20 series per query result.
- The model picks panel types heuristically. You can override with prompts like "use a heatmap for that latency panel".
- Variable queries with high cardinality (`>1000` values) get truncated; use `regex` filters to narrow.
- Dashboards are JSON-compatible with the Grafana schema; you can export / import between systems.

## Related

- [Datasources](/features/datasources) — what metric backends are supported
- [Chat & agents](/features/chat) — how the dashboard agent is wired
- [Permissions](/auth#resource-permissions-folders-dashboards-datasources-alert-rules) — folder-scoped grants for who can view/edit
