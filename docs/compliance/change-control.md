# Change control for an AI that touches production

If an agent can restart a deployment at 3am, your change-management process has
a new participant that does not file tickets, does not attend CAB, and does not
remember to write things down. Auditors have started asking about exactly this:
what authorised the change, who approved it, what evidence says it worked, and
how it gets undone.

This page maps those questions to the mechanisms in Rounds, points at the code,
and is explicit about what is *not* covered. It is written to be handed to an
auditor — including the last section, which lists the gaps.

> **Not a compliance certification.** Rounds is software, not an attestation.
> Nothing here means your organisation passes anything. It means the evidence
> an assessor asks for exists and can be exported.

## The four questions

### 1. What authorised this change?

A production change originates as a **remediation plan** — an ordered list of
steps with a stated target object and a validation method, created only after
an investigation that passed the evidence gate.

That last clause is the load-bearing one. The gate (`evidence-gate.ts`) refuses
to mark a root cause as verified unless:

- at least two recorded checks are referenced, across **two independent signal
  types** — a single metric query is never enough;
- at least one competing explanation was tested and recorded as `ruled_out`
  (and a source that was missing or empty counts as `inconclusive`, not
  ruled out);
- at least one referenced check carries an explicit time window or affected
  scope;
- a validation method is stated.

Fail any of these and the investigation is stored as `unresolved`, and
`validateRemediationPlanEvidence` refuses to let it back a plan. The plan's
`targetObject` must also correspond to the proven root cause — you cannot
investigate one service and propose a change to another.

**Where:** `packages/agent-core/src/agent/evidence-gate.ts`,
`packages/agent-core/src/agent/handlers/remediation-plan.ts`

### 2. Who approved it?

Every plan raises an **approval request**. Approval is a human action by an
identified principal holding the relevant RBAC permission, and the identity and
roles at the moment of approval are persisted — not just "approved: true".

```sql
-- approvals
resolved_by        TEXT   -- who
resolved_by_roles  TEXT   -- what authority they held at that moment
```

Storing the roles matters for an audit window: an assessor asking "was this
person entitled to approve this in March?" gets an answer from the row, not
from today's role assignments.

Background agents have no ambient authority. The ReAct loop refuses to start
without a bound identity, so an autonomous investigation runs as a named
service account and its actions attribute to it.

**Where:** `packages/data-layer/src/db/sqlite-schema.sql` (`approvals`),
`packages/common/src/rbac/`, `packages/agent-core/src/agent/react-loop.ts`

### 3. What evidence says it worked?

Two layers.

**Per-step audit rows.** Each executed step writes one row with actor, target,
outcome and timestamp:

```sql
-- audit_log
timestamp, action, actor_type, actor_id, actor_name,
org_id, target_type, target_id, target_name, outcome, metadata, ip, user_agent
```

`actor_type` distinguishes a human from a service account, so "which of these
changes were made by the AI" is a query, not an archaeology project.

**Post-execution verification.** After a plan is applied, the plan verification
service re-checks the signal that triggered the incident and records the
outcome on the plan itself:

```sql
-- remediation_plans
verification_status  TEXT NOT NULL DEFAULT 'not_started'
   -- not_started | waiting | passed | failed | inconclusive
approval_request_id  TEXT      -- links the change back to its authorisation
```

`failed` is a real outcome: the plan ran, and the alert did not recover. An
assessor sampling changes can see which ones were verified to have worked
rather than merely executed.

**Where:** `packages/api-gateway/src/services/plan-verification-service.ts`,
`packages/data-layer/src/repository/auth/audit-log-repository.ts`

### 4. How does it get undone?

Plans can carry a paired **rescue plan** — a rollback proposed at the same time
as the change and subject to the same evidence requirements, invoked on demand
from the UI if the primary plan makes things worse.

**Where:** `packages/agent-core/src/agent/tool-schema-registry.ts`
(`remediation_plan_create_rescue`)

Read the limits on this in the next section before relying on it.

## Exporting the evidence

Assessors generally want the whole audit window, not screenshots. Audit rows
are queryable by time range, actor and action; plans and approvals carry
timestamps and stable ids. On SQLite deployments the database file is a single
artifact; on Postgres the tables are `audit_log`, `approvals`, and
`remediation_plans`.

Retention defaults to 90 days and is configurable — set it to cover your audit
window before you need it, not after.

**Where:** `packages/api-gateway/src/auth/audit-writer.ts` (`AUDIT_RETENTION_DAYS`)

## Gaps — read this part

Stating these plainly is cheaper than having an assessor find them.

**Rollback is a proposal, not a guarantee.** The execution adapters report
`rollbackable: false` across the board — there is no adapter-level atomic undo.
A rescue plan is a *second LLM-authored plan* that also requires approval. It
is a documented rollback procedure, which is what most frameworks ask for, but
it is not a transactional revert and should not be described as one.

*Verify:* `grep -rn "rollbackable" packages/adapters/src/execution/`

**Command risk classification is pattern-based.** The gate that decides whether
a command needs confirmation, and how it is classified, works partly by
matching command text. Two bypasses have been found and fixed (shell wrapping,
and `kubectl cp` carrying its namespace in an operand); the honest position is
that pattern matching cannot be proven complete. The connector capability
policy and the approval step are the controls to rely on — not the classifier.

**Background agents can auto-approve read-shaped commands.** `readOnlyAgentBypass`
skips the confirmation card for commands judged read-safe, and that judgement
uses the same pattern-matching. If your control environment requires a human
decision for every agent-initiated command, disable it.

**Cluster shell is off by default, and should stay off unless needed.**
Enabling `clusterShell` binds a ServiceAccount to `cluster-admin` so the agent
can install charts and operators. That grant exists from install time. Leave it
disabled unless you specifically want that capability, and scope
`clusterShell.clusterRole` to something tighter if you do.

**Prompt injection is an open surface.** Content retrieved from your own
observability backends enters the model's context, and the model can propose
commands. The approval step is the control that stands between a poisoned log
line and a production change — which is a reason to keep approvals human for
anything that writes.

## What this is not

- Not a substitute for your own change-management policy — it produces evidence
  for one, it does not define one.
- Not an access-review or segregation-of-duties control. Nothing prevents the
  same person from requesting and approving, if your RBAC grants both.
- Not tamper-evident. Audit rows live in the same database as everything else;
  an operator with database access can alter them. Ship them to your SIEM if
  you need immutability.

## Related

- [Auto-remediation operations guide](../operations/auto-remediation.md) — the
  full pipeline from alert to verified change
- [A real investigation, start to finish](../investigations/bookinfo-reviews-v2.md) —
  what the evidence trail looks like in practice
- [Authentication and RBAC](../auth.md)
