# The OpenObs SRE loop

OpenObs is an **AI SRE** — a chat-driven agent that runs the full observe-detect-investigate-remediate loop across your existing telemetry and operations tools.

```text
Observe -> Detect -> Investigate -> Remediate (with approval)
```

OpenObs is not a Kubernetes-only product. Kubernetes is simply the first deep production workflow we ship: an investigation can read pod state, events, rollouts, and resource pressure, and an approved remediation plan can scale, patch, or roll back a workload. Other systems are integrated as the agent learns each one's shape.

## Observe

Create and edit dashboards by asking for what you want to see:

> Create a dashboard for checkout latency and error rate

Proposed changes show up as **pending edits** — review the diff before anything is saved.

## Detect

Turn monitoring intent into alert rules:

> Alert me when checkout p95 latency is above 500ms for 10 minutes

Each rule can be **previewed and backtested** against historical data before it goes live.

## Investigate

Ask why something changed:

> Why is checkout latency high right now?

The investigation agent queries metrics, searches logs, inspects recent changes, and (when a Kubernetes connector is configured) reads cluster state. Every conclusion in the report carries a **citation** linking back to the underlying datapoint.

## Remediate

OpenObs has two distinct approval paths:

- **User-driven (chat)** — when you ask the agent to do something, low-risk steps run inline; higher-risk steps surface as **Run / Confirm / Apply** in the chat. There is no formal `ApprovalRequest` unless a permission gate or the GuardedAction risk model demands one.
- **Background-agent (auto-investigation)** — when an alert fires, the agent runs unattended and proposes a `RemediationPlan`. The plan-level **Approve / Reject / Modify** review is delivered to the owning team / on-call, with audit-logged decisions. See [Auto-remediation](/operations/auto-remediation).

## Integrations

| System | Status | Used for |
|---|---|---|
| Prometheus / VictoriaMetrics / Mimir / Thanos / Cortex | Available | Metrics |
| Loki | Available | Logs |
| Kubernetes (kubectl, allowlisted) | Available | Investigation reads + plan execution |
| Manual change events | Available | Deploy / config correlation |
| GitHub releases / Argo / Flux | **Planned** | Auto-correlate deploys with incidents |
| GitHub PRs | **Planned** | Open remediation as a PR instead of a kubectl plan |
| Jira / PagerDuty / Opsgenie | **Planned** | Incident sync, on-call routing |
| CI/CD systems | **Planned** | Trigger / verify rollbacks |
| Database read connectors | **Planned** | Query slow-query logs, schema state |
| Distributed tracing | **Planned** | Trace-aware investigation |

Items marked **Planned** are not shipping today and are listed so you can see the direction without us promising capabilities the code does not yet ship.

## Related

- [Dashboards](/features/dashboards)
- [Alert rules](/features/alerts)
- [Investigations](/features/investigations)
- [Chat & agents](/features/chat)
- [Auto-remediation](/operations/auto-remediation)
