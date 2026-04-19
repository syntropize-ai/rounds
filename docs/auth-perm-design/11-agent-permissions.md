# 11 — Agent Permission Propagation

**Applies to:** Wave 7 / Tasks T10.1 – T10.9
**Grafana reference:** N/A — Grafana has no agent layer. This is openobs-native design.

## Problem

Waves 1–6 built Grafana-parity RBAC on the **HTTP boundary**. Any request that
hits `/api/dashboards` or `/api/alert-rules` is checked against the caller's
permissions.

openobs adds a second execution path: the **agent**. A user chats with the
orchestrator; the orchestrator's ReActLoop decides which tools to call (e.g.
`dashboard.create`, `prometheus.query`); each tool is a function that — today —
runs with whatever privileges the server process has, i.e. effectively
server-admin.

This defeats the RBAC model on its own terms. A Viewer user cannot `POST
/api/dashboards`, but can ask the agent to create one and succeed. A user with
no access to datasource `prom-prod` cannot query it directly, but the agent
can, and can surface the results in chat.

This document designs **agent permission propagation** — a three-layer gate on
every tool invocation so the agent operates strictly within the caller's
authority.

## Principle

> An agent is the user's hands, nothing more. Whatever the user cannot do
> themselves, the agent cannot do for them.

Background tasks that have no human caller run under a **service account** —
explicit identity, explicit scope, no exceptions.

## Three-layer model

Every tool invocation must satisfy **all three** of these. Intersection, not
union. Any single layer returning "no" terminates the call with a
`permission_denied` observation.

```
┌────────────────────────────────────────────────────┐
│ Layer 1 — Agent-type capability ceiling            │
│   AgentDef.allowedTools must include the tool name │
│   (already implemented in agent-registry.ts)        │
├────────────────────────────────────────────────────┤
│ Layer 2 — Agent behavior mode                       │
│   AgentDef.permissionMode ∈                         │
│     { read_only, artifact_mutation,                 │
│       approval_required, propose_only }             │
│   (already implemented in orchestrator-agent.ts)    │
├────────────────────────────────────────────────────┤
│ Layer 3 — Caller's RBAC (NEW, this wave)            │
│   accessControl.evaluate(identity, evaluator)       │
│   where evaluator is built from TOOL_PERMS[tool]    │
│   applied to the tool call's args                   │
└────────────────────────────────────────────────────┘
```

Layers 1 and 2 already exist. **This wave adds Layer 3** and plumbs Identity
through the agent core so Layer 3 has the data it needs.

## Design decisions

### D0 — Prompt design: principles, not case lists

Every prompt change in this wave follows one rule: **declare
principles, don't enumerate cases.** An LLM given a principle
generalizes; the same LLM given a numbered case list pattern-matches
against the list and freezes on unlisted situations.

Bad:

> When the user asks X, respond Y. When they ask A, respond B.
> When they ask C, respond D. ...

Good:

> When tool observations indicate permission denial, surface what
> you've learned, state the denial concretely, and propose a next
> step. Do not retry denied calls. Do not fabricate results.

Identity context in prompts is factual, not prescriptive:

- ✓ "You are acting on behalf of Alice (Viewer in Platform)."
- ✗ "You are acting on behalf of Alice, who has limited permissions
  — be careful and do not attempt writes."

The first lets the LLM reason normally; the second primes it to
self-censor unpredictably, which produces worse output even inside
the permission boundary.

This applies to every prompt addition below. If a reviewer sees a
case-by-case instruction sneaking in, it should be rewritten as a
principle before landing.

### D1 — Identity flows via `ActionContext`

`ActionContext` (defined in `packages/agent-core/src/agent/orchestrator-action-handlers.ts`)
is already threaded into every handler. We add an `identity: Identity` field to
it. Every handler can read `ctx.identity`. No async-local state, no global
mutable.

### D2 — Enforcement is primarily declarative, with per-handler refinement

A single table `TOOL_PERMS` in `packages/agent-core/src/agent/tool-permissions.ts`
maps every tool name to a function `(args) => Evaluator`:

```ts
export const TOOL_PERMS: Record<string, ToolPermissionBuilder> = {
  'dashboard.create': (args) => ac.eval(
    'dashboards:create',
    `folders:uid:${String(args.folderUid ?? '*')}`,
  ),
  'dashboard.modify_panel': (args) => ac.eval(
    'dashboards:write',
    `dashboards:uid:${String(args.dashboardId)}`,
  ),
  // ... ~30 entries
}
```

`ReActLoop` invokes the builder with the tool's `args`, hands the resulting
evaluator to `accessControl.evaluate(identity, evaluator)`. On deny, the loop
short-circuits to a synthetic observation:

```
"permission denied: identity <userId> lacks <action> on <scope>"
```

Handlers may add local checks when the pre-dispatch check can't capture
everything (e.g. list tools that must filter per-row). Those additions sit
inside the handler as normal `accessControl.evaluate` calls.

### D3 — Denial returns an observation, never aborts the loop

A denied tool behaves like a tool that reports "I couldn't do that because
of X". The LLM sees the `permission_denied` observation and decides the
reply. We do NOT throw or return HTTP 403 to the chat client — that would
bypass the LLM's ability to explain the denial in natural language.

The system prompt is extended with an explicit clause:

> "If a tool observation starts with 'permission denied:', tell the user
> exactly what permission they lack and do not attempt a workaround. Never
> pretend the action succeeded."

### D4 — Background agents require an explicit SA identity

Any code path that starts an agent run without a human caller (proactive
investigation cron, scheduled report generator, alert-triggered auto-dig)
MUST pass a `serviceAccountId` resolved to an `Identity`. The
`ReActLoop.runLoop` entry point refuses to start with an undefined
identity — there is no ambient "system" role.

Operators configure which SA a given background job uses via env or config:

```
OPENOBS_PROACTIVE_INVESTIGATOR_SA_TOKEN=openobs_sa_...
OPENOBS_ALERT_AUTOMATION_SA_TOKEN=openobs_sa_...
```

The background runner resolves the token to an SA user + its org role + its
custom-role grants, then starts the agent with that identity.

### D5 — Both read and write tools are checked

Read tools exfiltrate data on a user's behalf and must respect the same
RBAC as direct reads. `prometheus.query` with datasource uid `prom-prod`
requires `datasources:query` on `datasources:uid:prom-prod`, same as
hitting the HTTP endpoint.

For **list tools** (`dashboard.list`, `alert_rule.list`, …), the
pre-dispatch check is `dashboards:read` on `dashboards:*` (i.e., "are you
allowed to list *anything* of this kind?"). The handler then filters the
result rows: only items the identity has `dashboards:read` on their
specific uid remain. This matches Grafana's HTTP list semantics.

### D6 — Static tool list in prompt + runtime enforcement

The system prompt lists all of the agent's `allowedTools` regardless of
caller permissions. This keeps the prompt cacheable and simple. Tools the
caller cannot execute return `permission_denied` on call; the LLM adapts.

We considered dynamic prompt pruning ("don't tell Viewer about
`dashboard.create`") but rejected it: dynamic prompts defeat LLM prompt
caching (big cost hit), and a Viewer legitimately benefits from being
*told* "I can't do that, here's what's needed".

### D7 — Scope builder signatures

```ts
type ToolPermissionBuilder =
  | ((args: Record<string, unknown>) => Evaluator)       // single check
  | ((args: Record<string, unknown>, ctx: ActionContext) => Promise<Evaluator>)
  // for builders that must do a DB lookup (e.g., alert_rule.modify needs
  // to find the rule's folder to build folders:uid:<folderUid> scope)

export function buildToolEvaluator(
  tool: string,
  args: Record<string, unknown>,
  ctx: ActionContext,
): Promise<Evaluator | null>
```

A builder returning `null` means "this tool is not permission-gated"
(reserved for pure-UI tools like `navigate`). The gate treats `null` as
"allow".

### D8 — LLM honesty enforced via prompt

Per D0 (principles not cases), the prompt addition is one sentence
of principle plus factual identity context:

> You are acting on behalf of `{{ user.name }}` (`{{ user.login }}`,
> org role `{{ orgRole }}` in `{{ orgName }}`).
>
> When a tool observation starts with `permission denied:`, surface
> what you have already learned, state the denial plainly, and propose
> a next step. Do not retry denied calls. Do not fabricate results.

That's the whole addition. No case list, no "if this then that" table,
no examples. The LLM generalizes from the principle.

Template variables (`{{ user.name }}` etc.) are resolved at request
time from the bound identity before the system prompt is sent.

### D9 — Audit logging per tool call

Every dispatched tool (allowed or denied) produces an `audit_log` row:

```ts
{
  action: 'agent.tool_called' | 'agent.tool_denied',
  actor_type: 'user' | 'service_account',
  actor_id: identity.userId | identity.serviceAccountId,
  org_id: identity.orgId,
  target_type: '<inferred from tool, e.g. dashboard, folder, datasource>',
  target_id: '<from args>',
  outcome: 'success' | 'failure' | 'denied',
  metadata: {
    agent_type: 'orchestrator',
    tool: 'dashboard.create',
    required_action: 'dashboards:create',
    required_scope: 'folders:uid:prod',
    denied_by: 'rbac' | 'allowedTools' | 'permissionMode' | null,
    args_summary: '…truncated…',
  }
}
```

Rate-limited: one row per (identity, tool) pair per minute is enough for
an active chat; we don't need a row per LLM-retry within a loop.

### D10 — List tools filter results

When a handler returns a list of resources, it post-filters:

```ts
// Inside handleDashboardList
const all = await store.listDashboards(ctx.identity.orgId)
const visible = await accessControl.filterByPermission(
  ctx.identity,
  all,
  (item) => ac.eval('dashboards:read', `dashboards:uid:${item.uid}`),
)
return visible
```

`accessControl.filterByPermission` is a helper we add; runs the evaluator
per row but uses the cached permission set so N rows = O(N) scope
comparisons, not O(N) DB hits.

### D12 — Partial permissions: the agent does what it can, honestly

A tool chain will often have mixed outcomes: some tools succeed, some
return `permission denied`. The gate does not terminate the loop; the
LLM sees the mixed observations and decides how to respond.

The invariant (not a case list — per D0): **data already obtained
stays visible; denied actions are stated plainly.** Whether that
surfaces as inline stats in a chat reply, an evidence section in an
investigation report, or a recommendation that someone else be
involved, is the LLM's call given the current request's shape.

What the gate guarantees:

- Denied tools never execute.
- Denied tools produce a concrete observation (action + scope).
- The loop continues — the LLM gets to reason about the mixed state.

What the prompt guarantees (via D8): the LLM does not retry denied
calls and does not fabricate results.

Everything else — how to phrase the denial, whether to surface
partial data inline or defer to the report artifact, whether to
suggest a person to involve — is handled by the LLM's normal
reasoning against the principle in D8. We do not list cases.

### D13 — Investigations stay report-shaped

Investigation requests produce a persistent report artifact via the
`investigation.create` → `investigation.add_section` →
`investigation.complete` tool chain, regardless of the permission
outcomes encountered along the way. **The output channel does not
switch to chat prose just because some queries got denied.**

Partial permission state affects report *contents*, not the form of
the deliverable:

- Sections backed by data the agent could fetch appear normally.
- Data it couldn't fetch is acknowledged in-report, in whatever form
  the LLM decides is useful for the reader.
- The verifier agent (if used) may independently mark the report as
  `status: 'partial'` when permission gaps prevent confirming the
  top hypothesis.

No investigation-specific prompt with case-by-case structure drills.
The LLM writes the report under its normal investigation mandate plus
the single principle from D8. Report readability is the LLM's
responsibility.

The UI renders `status: 'partial'` distinctly from `completed` /
`failed` so operators can see at a glance that a report has gaps due
to permission, not due to agent failure. (UI wiring is a follow-up,
not part of this wave.)

An operator-set env — `PERMISSION_ESCALATION_CONTACT` — is available
to the prompt as a factual variable. When present, the LLM may
reference it in denials (e.g., "request access via #obs-support"); if
absent, the LLM simply states the missing permission without a
pointer. No case list of "if env set, do X; else do Y" — one template
substitution, LLM decides how to use it.

### D14 — Tool-level granularity, not metric-level

Permission scope is `datasources:uid:<id>`, not per metric or per
label selector. This is a deliberate choice that matches Grafana:

- Metric names are dynamic — operators cannot enumerate them at
  permission-grant time.
- PromQL supports arbitrary label selectors, regex, composition,
  and subqueries. Per-query rewriting to enforce label filters is a
  whole subsystem on its own (Mimir / Cortex / Thanos tenants do it
  at the upstream) — we don't own that problem.
- The right way to isolate CPU data from business data is to register
  **two datasources** in openobs pointing at either two Prometheus
  instances or two tenants of a multi-tenant Prometheus, then grant
  `datasources:query` separately.

Consequences for the agent:

- The datasource UID an agent reaches into is visible in tool args
  (`prometheus.query(datasourceId, expr)`). The permission gate checks
  against that UID.
- A user who has `prom-app` query access but not `prom-infra` can
  reach the former via the agent, and gets denied for the latter —
  same as hitting `/api/datasources/prom-infra/query` directly.
- No PromQL inspection happens in the gate. The agent does not
  second-guess what's inside the query.

Operators who need finer isolation than "per datasource" should pursue
upstream multi-tenancy:

- Mimir / Cortex: `X-Scope-OrgID` per datasource instance registered
  in openobs.
- Thanos: per-tenant stores.
- Separate Prometheus instances per team or per severity tier.

These are documented in `docs/auth.md` §"Metric-level isolation" (to
be added when any operator asks).

### D15 — Prompt carries identity context but no behavioral priming

The orchestrator prompt is injected with identity facts:

```
You are operating on behalf of user Alice (alice@example.com),
who has org role Viewer in organization "Platform". The current
date is {{ now }}.
```

It does NOT say "be careful, this user has limited permissions" or
"don't attempt writes". We want the LLM to reason normally about what
the user asked for. The gate handles enforcement; the prompt only gives
the LLM the context it needs to:

- Address the user by name when natural.
- Explain denials in context of the user's role ("as a Viewer, you
  lack...").
- Not hallucinate about *who* the user is.

This separation matters: primed LLMs self-censor unpredictably and
produce worse output. Let the LLM try, let the gate enforce, let the
denial observation steer the next step.

### D11 — Agent-type capability ceiling remains

Nothing changes at Layer 1. We already have multiple agent types in
`agent-registry.ts` (`orchestrator`, `alert-rule-builder`, `verification`).
Wave 7 introduces new specialized agents as needed:

- `readonly-analyst` — no write tools at all
- `dashboard-assistant` — dashboard + folder + prometheus tools; no alert
  or user management
- `alert-advisor` — alert + prometheus tools; no dashboard mutation
- `incident-responder` — investigation + post-mortem + alert read

Each has an `allowedTools` list. The chat UI or page-level context decides
which agent type to instantiate per user request. A Viewer opening the
chat panel on a dashboard page gets `readonly-analyst` by default.

## Tool permission catalog (complete)

Source of truth is `packages/agent-core/src/agent/tool-permissions.ts`. The
table below enumerates every tool the orchestrator currently has and its
required (action, scope).

### Dashboard tools

| Tool | Action | Scope |
|---|---|---|
| `dashboard.create` | `dashboards:create` | `folders:uid:<folderUid ?? '*'>` |
| `dashboard.list` | `dashboards:read` | `dashboards:*` (per-row filter) |
| `dashboard.add_panels` | `dashboards:write` | `dashboards:uid:<dashboardId>` |
| `dashboard.remove_panels` | `dashboards:write` | `dashboards:uid:<dashboardId>` |
| `dashboard.modify_panel` | `dashboards:write` | `dashboards:uid:<dashboardId>` |
| `dashboard.set_title` | `dashboards:write` | `dashboards:uid:<dashboardId>` |
| `dashboard.add_variable` | `dashboards:write` | `dashboards:uid:<dashboardId>` |
| `dashboard.rearrange` | `dashboards:write` | `dashboards:uid:<dashboardId>` |

### Folder tools (new agent capability)

| Tool | Action | Scope |
|---|---|---|
| `folder.create` | `folders:create` | `folders:uid:<parentUid ?? '*'>` |
| `folder.list` | `folders:read` | `folders:*` (per-row filter) |

### Investigation tools

| Tool | Action | Scope |
|---|---|---|
| `investigation.create` | `investigations:create` | *(none)* |
| `investigation.list` | `investigations:read` | `investigations:*` (per-row filter) |
| `investigation.add_section` | `investigations:write` | `investigations:uid:<id>` |
| `investigation.complete` | `investigations:write` | `investigations:uid:<id>` |

### Alert rule tools

| Tool | Action | Scope |
|---|---|---|
| `create_alert_rule` | `alert.rules:create` | `folders:uid:<folderUid ?? '*'>` |
| `modify_alert_rule` | `alert.rules:write` | `folders:uid:<ruleFolderUid>` *(async lookup by ruleId)* |
| `delete_alert_rule` | `alert.rules:delete` | `folders:uid:<ruleFolderUid>` |
| `alert_rule.list` | `alert.rules:read` | `alert.rules:*` (per-row filter) |
| `alert_rule.history` | `alert.rules:read` | `alert.rules:uid:<ruleId>` |

### Prometheus tools

| Tool | Action | Scope |
|---|---|---|
| `prometheus.query` | `datasources:query` | `datasources:uid:<datasourceId>` |
| `prometheus.range_query` | `datasources:query` | `datasources:uid:<datasourceId>` |
| `prometheus.labels` | `datasources:query` | `datasources:uid:<datasourceId>` |
| `prometheus.label_values` | `datasources:query` | `datasources:uid:<datasourceId>` |
| `prometheus.series` | `datasources:query` | `datasources:uid:<datasourceId>` |
| `prometheus.metadata` | `datasources:query` | `datasources:uid:<datasourceId>` |
| `prometheus.metric_names` | `datasources:query` | `datasources:uid:<datasourceId>` |
| `prometheus.validate` | `datasources:query` | `datasources:uid:<datasourceId>` |

### Web / knowledge tools

| Tool | Action | Scope |
|---|---|---|
| `web.search` | `chat:use` | *(none)* |

### UI-only tools (no permission gate)

| Tool | Reason |
|---|---|
| `navigate` | Pure client-side routing, no server effect |
| `finish` / `reply` / `ask_user` | Terminal actions — ReActLoop internal |

## Interfaces and file layout

### New files

- `packages/agent-core/src/agent/tool-permissions.ts` — the TOOL_PERMS table
  and `buildToolEvaluator` function.
- `packages/agent-core/src/agent/permission-gate.ts` — the three-layer gate
  that runs before each tool dispatch.
- `packages/agent-core/src/agent/identity-binder.ts` — helper to resolve
  SA tokens to Identity objects for background tasks.
- `packages/agent-core/src/agent/list-filter.ts` — post-filter helper for
  list tools.

### Modified files

- `packages/agent-core/src/agent/react-loop.ts` — accept `identity` in
  `ReActDeps`; call `permissionGate.check` before each non-terminal
  action; synthesize `permission denied:` observation on deny.
- `packages/agent-core/src/agent/orchestrator-agent.ts` — accept
  `identity` in constructor or `handleMessage`; pass to `ReActLoop`.
- `packages/agent-core/src/agent/orchestrator-action-handlers.ts` —
  `ActionContext` gains `identity: Identity` and
  `accessControl: IAccessControlService`; list handlers use
  `filterByPermission`.
- `packages/agent-core/src/agent/orchestrator-prompt.ts` — inject
  identity context into prompt (user name, org role, permission-denial
  instructions).
- `packages/agent-core/src/agent/agent-registry.ts` — register new
  specialized agent types (`readonly-analyst`, `dashboard-assistant`,
  `alert-advisor`).
- `packages/api-gateway/src/routes/dashboard/chat-handler.ts` (or wherever
  the orchestrator is instantiated from a request) — pass
  `req.auth` as the identity to the orchestrator.
- `packages/api-gateway/src/services/accesscontrol-service.ts` — add
  `filterByPermission(identity, items, evaluator)` helper.
- `packages/common/src/audit/actions.ts` — add
  `AgentToolCalled: 'agent.tool_called'` and
  `AgentToolDenied: 'agent.tool_denied'`.

## Task breakdown

### T10.1 — Types and action catalog
- Add audit actions `agent.tool_called`, `agent.tool_denied`.
- Add `Identity` import path sanity check across agent-core.
- Add `ToolPermissionBuilder` type.
- No DB changes.

### T10.2 — Thread Identity through agent-core
- `ReActDeps.identity: Identity` required.
- `OrchestratorAgent` accepts identity at construction or `handleMessage`.
- `ActionContext.identity: Identity`.
- `ActionContext.accessControl: IAccessControlService`.
- Compilation should fail everywhere the identity isn't plumbed.

### T10.3 — Declarative TOOL_PERMS table
- Complete the table in `tool-permissions.ts` per the catalog above.
- Include async builder variant for rules that need DB lookup.
- Unit-test every builder: given fixture args, produces expected evaluator.

### T10.4 — Permission gate
- `permission-gate.ts` with `check(agentDef, tool, args, ctx)` that runs
  layers 1 → 2 → 3 in order, returns `{ ok: true } | { ok: false, reason }`.
- `ReActLoop` calls it before dispatching non-terminal actions.
- On deny: synthesize `permission denied: <action> on <scope>` observation.
- Emit audit event via `ctx.auditWriter`.

### T10.5 — Per-handler refinements
- `handleDashboardList` etc. call `filterByPermission` on results.
- `handleModifyAlertRule` async builder that looks up rule.folderUid first.
- Handlers validate identity is set (defense in depth).

### T10.6 — Background task identity
- `background-runner.ts` (new) that takes an SA token and starts an agent.
- Env resolution: `OPENOBS_<JOB>_SA_TOKEN`.
- Fail fast if no token configured.

### T10.7 — Prompt updates
- `orchestrator-prompt.ts`: inject identity context + permission-denial
  instructions.
- Templates parametrized with user name / org role / org name.
- Cache key updated.

### T10.8 — Audit events
- Wire audit writes in the gate and in handler success paths.
- Rate-limit `agent.tool_called` (allow path) to one per (identity, tool)
  per 60s. Deny path always writes.

### T10.9 — New specialized agent registrations
- `readonly-analyst` — no write tools.
- `dashboard-assistant` — dashboard + folder + prometheus + web.search.
- `alert-advisor` — alert + prometheus + folder read.
- `incident-responder` — investigation + post-mortem read/write + alert
  read.
- Chat entry-point picks agent based on page context OR explicit user
  choice.

### T10.10 — Tests
- Unit: every TOOL_PERMS builder.
- Unit: permission-gate with all three layers covered (each layer
  returning no wins).
- Integration: Viewer → create dashboard → denied observation → LLM
  reply explains denial (mock LLM responses).
- Integration: Editor → create dashboard → allowed → row in DB.
- Integration: SA token with Viewer role → same behavior as Viewer user.
- Integration: cross-org — user in org A shouldn't see B's datasources
  via agent either.
- Regression: existing agent test scenarios still pass (orchestrator's
  structured-alert-followup and similar).

## Test scenarios (reference)

1. **Viewer asks to create a dashboard** → observation `permission
   denied: dashboards:create on folders:uid:prod` → LLM replies: "I
   can't create dashboards in the prod folder. You need
   `dashboards:create` permission on that folder; ask your org
   admin."
2. **Editor asks to create a dashboard** → allowed → dashboard row
   created with `org_id = identity.orgId`.
3. **User asks agent to query a datasource they can't access** →
   `permission denied: datasources:query on datasources:uid:prom-prod` →
   LLM explains.
4. **User lists dashboards** → sees only dashboards they have
   `dashboards:read` on, not all org dashboards.
5. **SA with Viewer role runs proactive investigator** → same
   behavior as Viewer user (can read, can't write).
6. **No identity at ReActLoop start** → throws, loop does not begin.
7. **Specialized `readonly-analyst` agent asked to create dashboard**
   → layer-1 denial (`dashboard.create` not in `allowedTools`) →
   observation includes `denied_by: allowedTools`.
8. **`propose_only` agent asked to create dashboard** → layer-2
   non-execute → observation includes `denied_by: permissionMode`
   + serialized proposal.
9. **Audit log**: both allow and deny rows appear with correct
   metadata.
10. **Rate limit**: 10 repeated `dashboard.list` calls produce 1
    audit row (within 60s window), not 10.
11. **Prompt injection** (`{{ user.name }}` populated) shows up in
    LLM system prompt.
12. **LLM ignores denial warning and retries** (simulate with mock) —
    retry also denied, no extra damage.

### Partial permissions (D12, D13, D14)

13. **Read allowed, write denied — data is surfaced, not dropped** —
    user has `datasources:query` on `prom-app` but no
    `dashboards:create`. Agent mock calls query (gets data), then
    `dashboard.create` (denied). Final reply MUST include the fetched
    metric values AND the denial explanation; MUST NOT fabricate a
    dashboard creation.

14. **Mixed datasource access in one investigation** — user has
    `datasources:query` on `prom-app` but not `prom-infra`.
    `investigation.add_section` allowed on an investigation they own.
    Agent mock queries both (one allow, one deny); writes up findings
    with explicit "what I examined" and "what I could not examine"
    sections per D13.

15. **Dashboard list with permission-filtered rows** — user has
    `dashboards:read` on three specific dashboard UIDs (via direct
    managed-role grants), not org-wide. `dashboard.list` tool returns
    exactly those three, not the full org list. Verify via assertion
    on returned UIDs.

16. **Datasource-level isolation holds (D14)** — two datasources
    registered (`prom-app` and `prom-infra`), user granted query on
    `prom-app` only. Agent executes `prometheus.query(datasourceId:
    'prom-app', …)` — allowed. Agent executes
    `prometheus.query(datasourceId: 'prom-infra', …)` — denied. No
    PromQL parsing; the gate checks only the datasource UID scope.

17. **Prompt does NOT prime LLM toward caution** — snapshot-test the
    generated prompt for a Viewer user. Assert it contains identity
    facts (name, role, org) but NOT strings like "be careful", "only
    try", "don't attempt". (D15.)

18. **Verifier marks partial-data investigations as 'partial' not
    'failed'** — when the investigation agent runs with permission
    denials that block confirming its top hypothesis, the verifier
    agent returns `status: 'partial'` with reasons listing the
    denied queries. UI can render "partial" differently (badge +
    grant-suggestion CTA).

## Rollout plan

Cannot ship incrementally — the gate either exists or it doesn't.
Rollout:

1. Land T10.1–T10.5 together (identity plumbed + gate active + handlers
   updated) as a single PR. Existing tests pass because identity defaults
   to server-admin in tests until test fixtures are updated.
2. Update test fixtures + integration tests in the same PR.
3. T10.6 (background tasks) as a separate PR — more isolated.
4. T10.7 prompt update can ship anytime after T10.4.
5. T10.8 audit — ideally same PR as T10.4.
6. T10.9 specialized agents in a follow-up PR.

Feature flag is *not* used. The gate is always on.

## Risks and mitigations

- **Risk**: a handler forgets to accept identity → runs as nobody →
  either crashes or (worse) bypasses. **Mitigation**: TypeScript required
  field; unit test per handler asserts identity is read.
- **Risk**: TOOL_PERMS table out of sync with tools actually registered.
  **Mitigation**: unit test enumerates `agent-registry.ts` allowed tools
  and asserts every non-terminal tool has a TOOL_PERMS entry.
- **Risk**: LLM hallucinates around denial despite prompt. **Mitigation**:
  integration test with mock LLM that tries to fabricate success — we
  assert denial observations are never edited by the orchestrator.
- **Risk**: performance — per-row permission filter on list. **Mitigation**:
  cached permission set per request; filter is in-memory not DB.
- **Risk**: legacy background jobs start without SA token. **Mitigation**:
  fail-fast at boot if a known job lacks env var; log clear error.

## Open questions

1. **Should denied tool calls count against LLM iteration budget?** Current
   MAX_ITERATIONS is 30. If a confused LLM retries the same denied tool
   20 times, we burn budget. Recommendation: yes, count them — the
   `permission denied:` observation itself should give the LLM enough to
   change direction.
2. **Should there be an "explain denial" meta-tool?** LLM could call
   `explain_permission(action, scope)` to get "here's who has this grant
   in your org, here's how to request it". Defer — nice-to-have.
3. **Do we ship an "allow_override" flag for superuser debugging?** Grafana
   Admin bypass? **No** — that reintroduces exactly the pattern we're
   closing. Admins can use direct HTTP endpoints; agent honors their
   RBAC like anyone else.
