# Investigations

Ask Rounds what is wrong. The agent queries the telemetry you have connected,
records what each query showed, and writes a report you can hand to someone
else.

The part worth understanding before anything else is that **a report tells you
whether to act on it**. Rounds distinguishes a conclusion it can stand behind
from one it cannot, and says which you are looking at. See
[Verified or not](#verified-or-not).

## What you can do

- **Ask from a symptom** — "Investigate the spike in 5xx errors at 14:30 UTC",
  or just "why is checkout slow?"
- **Multi-signal evidence** — the agent queries metrics, logs, recent changes
  and Kubernetes state, for whichever of those you have connected.
- **Correlate with deploys** — `changes_list_recent` checks whether anything
  shipped near the incident window, when a change-event source is configured.
- **Cited evidence** — claims the agent chose to cite carry an inline chip
  linking to the query behind them. Click one to open the run log.
- **Recommend fixes** — when the cause is environmental the agent can propose a
  remediation plan. Today that is a Kubernetes plan; GitHub PRs, CI/CD rollback
  and Argo / Flux re-sync are not implemented yet.
- **Approval-gated remediation** — interactive runs surface mutating steps
  inline as **Run / Confirm / Apply**. Investigations started automatically from
  a firing alert emit a `RemediationPlan` with **Approve / Reject / Modify** and
  notify the owning team. See [Auto-remediation](/operations/auto-remediation).
- **Continue the conversation** — follow-up questions in the same thread reuse
  the evidence already loaded.

## Verified or not

Every finished report opens with one of two verdicts.

**Root cause verified.** The conclusion cleared the evidence gate. That means
at least two checks drew on genuinely different sources — metrics, logs,
Kubernetes state, change events — at least one competing explanation was tested
and eliminated, the evidence covers a stated time window or scope, and the
report names how you would confirm a fix worked. A verified root cause is the
only kind that can back a remediation plan.

**Not verified — treat as a lead.** The agent reached a best explanation but it
did not meet that bar, so the report says so instead of presenting it as fact.
The banner lists what is still missing and the next check to run. This is the
product working, not failing: an investigation that cannot prove its answer is
far more useful when it admits it than when it sounds certain.

The most common reasons a conclusion lands here:

| What the banner says | What to do |
|---|---|
| every supporting check drew on the same kind of data | connect a second source — logs or a Kubernetes connector alongside metrics |
| I did not rule out other explanations | ask "what else could it be?" in the thread |
| the evidence does not pin down when this started | re-ask with an explicit window: "in the last 6 hours" |
| I could not state how you would confirm a fix worked | usually resolves on a follow-up; the agent needs a testable claim |

An unverified report is still worth reading. It contains everything that was
checked and what each check showed — often enough for someone who knows the
system to finish the job in a minute.

## How to use it

### Start an investigation

In the chat panel:

> Investigate why the order-service p99 latency jumped at 09:15

The agent opens an investigation with `investigation_create`, then works
through some combination of:

| Tool | Purpose |
|---|---|
| `metrics_range_query` | plot the symptom and find when it started |
| `metrics_get_label_values` | find related dimensions (handler, region, instance) |
| `logs_query` | error patterns in the affected window |
| `changes_list_recent` | deploys and config changes near the window |
| `ops_run_command` | pods, events, rollouts and resource pressure, when a cluster connector is configured |
| `investigation_record_check` | after each load-bearing read: what was tested, what came back, what it means |
| `investigation_add_text` / `investigation_add_evidence` | narrative and embedded panels as evidence accumulates |
| `investigation_complete` | the structured conclusion, which is what the gate reads |

`investigation_record_check` is the one that matters for the verdict. The
verdict is computed from those recorded checks, not from the narrative — an
explanation the agent argued for in prose but never recorded as a check does
not count toward it.

### Read the report

Open the investigation from the sidebar. Above the summary you get the verdict
and the provenance header — the model, how many tool calls it made, how much
evidence it gathered, cost and latency. Below that, sections of narrative and
embedded panels that re-query the same data live.

### Continue investigating

Type a follow-up in the same thread:

> Did this also affect the EU region?

The agent reuses the loaded evidence and runs additional queries scoped to the
new question. Following up on an unverified report is the normal way to get it
over the line.

### Find past investigations

Sidebar → Investigations. Press `/` to search by title. The same list is
available at `GET /api/investigations`, and a single report at
`GET /api/investigations/{id}/report` — the saved gate result is on
`provenance.rootCauseGate`.

## Examples

| Prompt | Investigation focus |
|---|---|
| `Why did the alert "high-error-rate" fire at 03:14?` | queries the alert's metric, correlates with change events |
| `What's causing the slow queries on the API last hour?` | range queries on the duration histogram, log search, deploy diff |
| `Why are pods restarting after the deploy?` | restart metrics, pod events, rollout status, logs, resource limits |
| `Compare today's traffic with last week's same time` | range queries with offset, deltas per handler |

## Limits

- **The verdict describes the reasoning, not the truth.** A verified root cause
  means the work was done and the evidence is independent — not that the
  conclusion is certainly correct. It is why a plan derived from one still needs
  a human approval. See [the risk model](/reference/risk-model).
- The agent has the orchestrator's `allowedTools` plus investigation-specific
  ones. Read-only inspection is allowed when permitted; mutating actions require
  approval.
- Time windows default to ±2h around the prompt's time reference. Say so
  explicitly for longer: "investigate the last 24 hours".
- Log queries inherit your datasource's limits (Loki: 5000 lines per query by
  default).
- The agent stops when it converges or when it runs out of token budget. If it
  stopped early, "what else could it be?" pushes it further.

## Related

- [Datasources](/features/datasources) — connecting metrics and logs backends
- [Alert rules](/features/alerts) — start an investigation from a firing alert
- [Risk model](/reference/risk-model) — what the evidence gate does and does not prove
- [Permissions](/auth#built-in-roles-permission-summary) — `investigations:read` and `chat:use` for viewer access
