# Dashboards

Dashboards are where you inspect metrics after Rounds creates, edits, or opens them for you. You can work from the dashboard list, a folder, the dashboard workspace, or chat.

## Common tasks

- Create a dashboard from chat: `Create a dashboard for HTTP latency`.
- Open an existing dashboard: `Open the ingress gateway dashboard`.
- Edit a dashboard from chat: add, remove, retitle, rearrange, or explain panels.
- Use folders to group team, service, personal, or temporary dashboards.
- Search dashboards, folders, panel titles, descriptions, and PromQL.
- Manage permissions on folders and dashboards when your role allows it.

## Dashboard list

Open **Dashboards** from the sidebar. The page shows folders and dashboards together, similar to a file browser.

- Use search when you know the dashboard, panel, folder, or query text.
- Open folders in place to browse nested resources.
- Create folders for team-owned or personal work.
- Use the dashboard row to open the workspace.

Alerts can live in folders too. A folder is a shared permission boundary for observability resources, not only a dashboard container.

## Dashboard workspace

Open a dashboard to view panels, change the time range, refresh manually, or enable auto-refresh.

Use the dashboard chat for scoped edits. The agent already knows which dashboard is open, so prompts can be short:

> Add p95 and p99 latency by route.

> Remove panels that return no data.

> Add a service variable and wire it into the queries.

## Chat-generated dashboards

When you ask for a new dashboard, Rounds discovers connectors, samples real metrics, validates PromQL, creates panels, and opens the result. The visible activity trace shows what the agent checked.

## Limits

- Metric support is strongest for Prometheus-compatible connectors.
- Very high-cardinality labels may be truncated or require a narrower prompt.
- Some advanced Grafana behaviors, such as full import/export parity and dashboard version restore, are product areas under active development.
