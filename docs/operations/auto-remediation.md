# Auto-remediation

Configure OpenObs to automatically investigate firing alerts, propose
remediation plans, and execute approved plans against a Kubernetes
cluster.

This page covers the **background-agent** approval path: the agent runs
unattended (no human in the chat) when an alert fires, so every
mutating step requires a formal **Approve / Reject / Modify** decision
delivered to the owning team / on-call. This is intentionally heavier
than the inline **Run / Confirm / Apply** flow used when you ask the
agent to do something interactively in chat — see
[Chat & agents](/features/chat) and [The OpenObs SRE loop](/features/operator-loop)
for that path.

Kubernetes is the first ops connector to ship plan execution. GitHub PR,
CI/CD, and Argo / Flux remediations are planned and will plug into the
same `RemediationPlan` + approval model.

The pipeline:

```
alert rule fires
   ↓ (AlertEvaluatorService)
auto-investigation runs as the openobs service account
   ↓ (AutoInvestigationDispatcher → background OrchestratorAgent)
investigation report saved
   ↓ (optional, only when there's an actionable in-scope fix)
RemediationPlan + plan-level ApprovalRequest
   ↓ (operator reviews at /plans/:id)
plan approved
   ↓ (PlanExecutorService)
each step runs through KubectlExecutionAdapter (allowlist + namespace gate)
   ↓
cluster updated; audit_log row per step
```

This page tells you how to turn each piece on, what env vars they read,
and what to check when something goes wrong.

## Prerequisites

- OpenObs running with persistence (SQLite default; Postgres also works).
- A Prometheus-compatible datasource configured in the setup wizard.
- At least one Kubernetes ops connector configured under
  Settings → Ops connectors. The connector needs:
  - a kubeconfig credential (inline or a `secretRef` —
    `env://`, `file://`, `vault://` are accepted)
  - one or more `allowedNamespaces` — used by the kubectl allowlist
- Server admin access to mint API tokens.

## One-time setup

### 1. Service account and API token

OpenObs seeds a service account named `openobs` on first boot. It owns
the auto-investigation runs.

1. Sign in as a server admin.
2. **Admin → Service accounts**.
3. Find the `openobs` row (display name *OpenObs Auto-Investigation*).
4. Click **Create token**.

That's it — no restart required. The dispatcher reads the live api_key
table on each fired alert, picks up the freshly minted token
automatically, and uses the SA's identity for the run. Revoking the
token causes subsequent fires to skip with a warning until you mint a
new one.

The seeded SA gets the `Editor` org role. Tokens are minted through the
existing API-key path so audit-log rows attribute the key creation to
the admin who clicked.

> **Advanced override.** A boot-time `AUTO_INVESTIGATION_SA_TOKEN` env
> var is still honoured for operators who want to pin a specific token
> rather than read the table. When set, every run validates that one
> plaintext token through `ApiKeyService.validateAndLookup`. Leave it
> unset for the standard flow.

### 2. RBAC for plan approvers

| Action | Default | Notes |
|---|---|---|
| `plans:read` | Viewer+ | List + view plans + steps |
| `plans:approve` | Editor+ | Approve / reject / cancel / retry-step |
| `plans:auto_edit` | **no default** | Required to skip per-step approvals |

Grant `plans:auto_edit` explicitly to a user or team. Two scope shapes
are supported:

- `plans:*` — auto-edit any plan (the cluster-wide grant; bundled in
  the `fixed:plans:auto_editor` role).
- `plans:namespace:<ns>` — auto-edit only plans whose every write step
  targets that namespace. Plans containing a cluster-scoped step
  (no `--namespace` flag) cannot be narrowed and require `plans:*`.

A user with `plans:approve` but no `plans:auto_edit` can still approve a
plan; the executor will pause for per-step approval at every step.

### 3. Feature flags

Three independent gates. All default to enabled except where noted.

| Env var | Default | Effect when unset / false |
|---|---|---|
| `ALERT_EVALUATOR_ENABLED` | `true` | Periodic alert evaluation does not run; alert rules sit in `normal` regardless of metric values. |
| `AUTO_INVESTIGATION_ENABLED` | `true` | Alerts still fire; nothing subscribes — no auto-investigation. Operators must investigate manually. |
| `AUTO_INVESTIGATION_SA_TOKEN` | _unset_ | Advanced override only. When set, the dispatcher uses this plaintext token for every run instead of reading the live api_key table. Leave unset for the standard flow. |
| `ALERT_EVALUATOR_REFRESH_MS` | `60000` | Periodic safety-net cadence for re-pulling the rule list. Event-driven hot-reload picks up most changes immediately; this catches missed events. |
| `PLAN_APPROVAL_TTL_MS` | `86_400_000` (24h) | TTL stamped on each plan at creation. Pending plans past TTL flip to `expired`. |
| `PLAN_EXPIRY_SWEEP_MS` | `60_000` | How often the executor runs the expiry sweeper. |

Turn on what you want; leave the rest off. Turning off the dispatcher
while leaving the evaluator on is a common state during early rollout.

## Daily operator flow

### A new plan landed

When a plan is proposed:

1. The plan-level `ApprovalRequest` shows up in:
   - **Action Center** → *Plans* tab → click the row
   - The investigation page (`/investigations/:id`) shows a banner at
     the top
2. On `/plans/:id` you see:
   - A summary line, the source investigation, and the expiry time
   - The ordered step list with the verbatim `commandText` and a
     dry-run preview
   - Risk notes per step (if the agent attached one)
3. Click **Approve**. If you have `plans:auto_edit`, the
   *Auto-edit subsequent steps* checkbox is shown — tick it only when
   you're confident in the whole plan; otherwise the executor will
   pause for explicit approval before each step.
4. **Reject** marks the plan permanently rejected and closes the
   approval. Use this when the proposed fix is wrong or unnecessary.

### A step failed

`PlanExecutor` halts the plan on first failure (default). You see:

- The failed step row with stderr inline (truncated to 64 KB).
- A **Retry this step** button — re-runs only that step. If it
  succeeds, execution continues with the next step.
- If the agent emitted a paired rescue plan, the failed plan's page
  shows an **Open rescue plan** link. Rescue plans are NEVER auto-run
  — the operator triggers them manually after evaluating the situation.

A step marked `continueOnError` does not halt the plan; it's still
visible as `failed` on the plan page but later steps run.

### What if the agent doesn't propose a plan?

Sometimes investigation finishes without an actionable plan. That's
intentional: the report is the primary deliverable, and a plan is only
emitted when there's a concrete fix in scope of an attached connector.

The investigation page still shows the report. Read it, decide if a
human action is needed, and act manually.

## What the agent is allowed to do

`KubectlExecutionAdapter` enforces three layers:

1. **Read-allowlist** (used by investigation reads): `get`, `describe`,
   `logs`, `top`, `events`, `version`, `api-resources`. Outside of
   investigation, this is also allowed in plan execution.
2. **Write-allowlist** (used by plan execution): the read list plus
   `scale`, `rollout`, `patch`, `apply`, `annotate`, `label`,
   `delete <type> <name>`. `kubectl delete` requires an explicit
   resource name — bare `kubectl delete pods -n app` is refused.
3. **Permanent-deny** (regardless of mode): `exec`, `cp`,
   `port-forward`, `proxy`, `attach`, `auth can-i --as`. Writes
   targeting `kube-system`, `kube-public`, or `kube-node-lease` are
   also blocked.

Every kubectl invocation runs through `spawn`, never a shell — argv
metacharacters cannot expand. The kubeconfig is resolved per-call,
written to an mktemp/0600 file, and unlinked in `finally` even on
throw.

## Configuration

### Alert rules

Standard PromQL rules. The evaluator pulls the default Prometheus
datasource and runs the rule's `condition.query` per `evaluationIntervalSec`.
Multi-series queries fold to the first sample — production rules
should aggregate to a scalar (`sum(...) by ()`).

### Ops connectors

Configure under **Settings → Ops connectors**. Required fields:

- A kubeconfig (paste it, or a `secretRef`: `vault://path#field`,
  `env://VAR`, or `file:///abs/path`).
- `allowedNamespaces` — the namespaces the executor is allowed to
  target. Restrict tightly; the namespace gate refuses anything outside
  this list.
- `capabilities` — informational; lists what the connector can do.

You can have multiple connectors; the agent picks one per step using
the step's `paramsJson.connectorId`.

## Troubleshooting

### "auto-investigation dispatcher NOT started"

Boot logs show this when:

- `AUTO_INVESTIGATION_ENABLED=false`, or
- The api-gateway boot didn't pass background-runner deps (regression),
  or auth repos for the SA-identity resolver.

Each is logged with a distinct line — read the log to tell which.

### "no live service-account token found for auto-investigation"

The dispatcher subscribed but the operator hasn't minted an SA token
yet, or every existing token for the `openobs` SA is revoked or expired.
Mint a new token under **Admin → Service accounts**; the next firing
alert will use it. The warning is rate-limited to once per minute.

### Alerts evaluate but never fire

- Confirm `ALERT_EVALUATOR_ENABLED` is not `false`.
- Verify the rule's `evaluationIntervalSec` and `forDurationSec`. A
  rule with a 5-minute `forDurationSec` requires the predicate to be
  true for that long before it transitions to `firing`.
- Check the gateway logs for `metric query failed` — usually a
  datasource auth or networking issue.
- The evaluator is single-process v1; if your gateway is running
  multiple replicas, only one will evaluate (the first to acquire the
  lock; see HA notes below). Multi-replica HA is intentionally bounded
  for correctness.

### Plan approved but stuck "executing"

- Open the plan page; check the step list.
- A step in `pending` with an `approvalRequestId` set means the executor
  is waiting on a per-step approval. Approve it via Action Center or
  reject it; either resolution unblocks the executor.
- A step in `executing` for an extended time is unusual — check the
  gateway logs for adapter errors. The default kubectl timeout is 60s.

### Plan approved but never executes

- Confirm the approver has `plans:approve` (Editor+ by default).
- For `auto-edit`, confirm the approver also has `plans:auto_edit` on
  the right scope. The 403 message names the missing scope.

### Audit trail

Every step execution writes one `audit_log` row:

```
action       agent.plan_step
actorType    service_account
actorId      <plan.createdBy>
orgId        <plan.orgId>
targetType   remediation_plan_step
targetId     <planId>:<ordinal>
outcome      success | failure
metadata     { planId, stepOrdinal, kind, verb, connectorId, error? }
```

Plan-level state transitions (approve / reject / cancel) are NOT
written through this path — they go through the existing approval
audit. Filter by `targetType=remediation_plan_step` to see executions.

### What's NOT supported (yet)

These are explicit non-goals for v1. Track follow-ups in the GitHub
project if you need any:

- Multi-replica HA evaluator with a leader lock — current
  implementation runs in a single api-gateway process. (Tracked.)
- Connectors other than Kubernetes.
- Step kinds other than `ops.run_command` (no `alert_rule.write` /
  `dashboard.update` inside a plan yet).
- Auto-rollback. Rescue plans exist and are operator-triggered; the
  executor does not unwind a failed plan automatically.
- Cross-cluster fan-out — one connector per step.

## Reference: design doc

The full design (state machine, file map, intentional non-goals) is in
[`docs/design/auto-remediation.md`](https://github.com/openobs/openobs/blob/main/docs/design/auto-remediation.md).
