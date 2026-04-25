# Investigations

Ask OpenObs to figure out what's wrong. The investigation agent collects evidence, evaluates hypotheses, and writes a structured report you can share with the rest of the team.

## What you can do

- **Trigger from a symptom** — "Investigate the spike in 5xx errors at 14:30 UTC" or "Why is checkout latency up?"
- **Auto-correlate with deployment events** — the agent pulls `changes.list_recent` to check whether anything shipped near the incident window.
- **Multi-signal evidence** — agent queries metrics, logs, and recent changes; cites every datapoint in the report.
- **Read the report** — sectioned write-up: Summary → Symptoms → Hypotheses → Evidence → Conclusion → Recommended actions.
- **Continue the conversation** — ask follow-up questions inside the investigation thread; the agent has the full evidence loaded.

## How to use it

### Start an investigation

In the chat panel:

> Investigate why the order-service p99 latency jumped at 09:15

The agent runs `investigation.create` with a title + description, then iterates:

1. `metrics.range_query` to plot the symptom and find when it started
2. `metrics.label_values` to find related dimensions (handler, region, instance)
3. `logs.query` for error patterns in the affected window
4. `changes.list_recent` to look for deploys / config changes
5. `investigation.add_section` repeatedly as evidence accumulates
6. `investigation.complete` when the analysis converges

### Read the report

Open the investigation from the sidebar. Each section is rendered with:
- Markdown narrative
- Embedded panels (live-querying the same data)
- Links to the underlying datasource + query

### Continue investigating

Type a follow-up in the same thread:

> Did this also affect the EU region?

The agent reuses the loaded evidence and runs additional queries scoped to the new question.

### List past investigations

Sidebar → Investigations. Filter by date, status, or tag. `investigation.list` is also exposed via API for dashboards or external tools.

## Examples

| Prompt | Investigation focus |
|---|---|
| `Why did the alert "high-error-rate" fire at 03:14?` | Pulls alert evaluation logs, queries the alert's metric, correlates with change events |
| `What's causing the slow queries on the API last hour?` | Range queries on duration histogram, log search for slow-query patterns, deploy diff |
| `Compare today's traffic with last week's same time` | Range queries with offset, deltas plotted per handler |

## Limits

- The investigation agent has the same `allowedTools` as the orchestrator plus investigation-specific ones. Read-only by default — investigations don't mutate dashboards or alerts.
- Time windows default to ±2h around the prompt's time reference. Specify explicitly for longer ranges: "investigate the last 24 hours of error rate spikes".
- Logs queries are limited to your datasource's native limits (Loki: 5000 lines per query by default).
- The agent stops when it has a confident conclusion or after a token budget; you can always ask "what else could it be?" to push further.

## Related

- [Datasources](/features/datasources) — connecting metrics + logs backends
- [Alert rules](/features/alerts) — auto-trigger an investigation when an alert fires (planned)
- [Permissions](/auth#built-in-roles-permission-summary) — `investigations:read` and `chat:use` for viewer access
