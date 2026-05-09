# Investigations

Ask OpenObs to figure out what's wrong. The investigation agent collects evidence, evaluates hypotheses, checks configured telemetry and Kubernetes context, and writes a structured report you can share with the rest of the team.

## What you can do

- **Trigger from a symptom** — "Investigate the spike in 5xx errors at 14:30 UTC" or "Why is checkout latency up?"
- **Auto-correlate with deployment events** — the agent pulls `changes.list_recent` to check whether anything shipped near the incident window.
- **Multi-signal evidence** — agent queries metrics, logs, recent changes, and Kubernetes state when configured; cites every datapoint in the report.
- **Cited evidence** — every claim in the report is anchored to a specific query, log line, or change event so reviewers can verify it. The provenance header on each AI-written section names the model, prompt version, and evidence set used.
- **Recommend fixes** — if the likely cause is environmental, the agent can propose a remediation. Today this is a Kubernetes plan; planned integrations (GitHub PR, CI/CD rollback, Argo / Flux re-sync) will let the same loop produce non-K8s remediations.
- **Approval-gated remediation** — interactive runs surface mutating steps inline as **Run / Confirm / Apply**. Background-agent runs (auto-investigation off a firing alert) emit a `RemediationPlan` with **Approve / Reject / Modify** controls and notify the owning team / on-call. See [Auto-remediation](/operations/auto-remediation) for the background flow.
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
5. Kubernetes inspection tools to check pods, events, rollouts, and resource pressure when a cluster connector is configured
6. `investigation.add_section` repeatedly as evidence accumulates
7. `investigation.complete` when the analysis converges

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
| `Why are pods restarting after the deploy?` | Checks restart metrics, pod events, rollout status, logs, and resource limits |
| `Compare today's traffic with last week's same time` | Range queries with offset, deltas plotted per handler |

## Limits

- The investigation agent has the same `allowedTools` as the orchestrator plus investigation-specific ones. Read-only inspection is allowed when permitted; mutating infrastructure actions require approval.
- Time windows default to ±2h around the prompt's time reference. Specify explicitly for longer ranges: "investigate the last 24 hours of error rate spikes".
- Logs queries are limited to your datasource's native limits (Loki: 5000 lines per query by default).
- The agent stops when it has a confident conclusion or after a token budget; you can always ask "what else could it be?" to push further.

## Related

- [Datasources](/features/datasources) — connecting metrics + logs backends
- [Alert rules](/features/alerts) — start an investigation from a firing alert; automatic investigation is the next product loop
- [Permissions](/auth#built-in-roles-permission-summary) — `investigations:read` and `chat:use` for viewer access
