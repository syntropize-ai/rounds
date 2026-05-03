# Approvals Multi-Team Scope

Status: **Draft for sign-off**
Owner: TBD
Last updated: 2026-05-03

End-to-end goal: in B2B installs of OpenObs, multiple teams share one org but
operate against distinct namespaces and clusters. Today every Viewer sees
every cluster-operation approval request — too broad for a multi-team
deployment, and a real customer-facing problem when "prod operations" must
not be visible to "dev team."

This doc is the source of truth for the work breakdown. Each task has a
goal, an explicit file domain, acceptance criteria, and dependencies.
Phases are ordered for shipping; tasks inside a phase parallelize unless a
dependency is called out.

## 1. Status quo

| Action | Today's grant | Result |
|---|---|---|
| `GET /api/approvals` | `ApprovalsRead on approvals:*` (every Viewer) | Anyone in the org sees every approval |
| `GET /api/approvals/:id` | `ApprovalsRead on approvals:uid:<id>` | Same — Viewer's `:*` grant covers any uid |
| `POST /:id/approve` | `ApprovalsApprove on approvals:*` (Editor+) | Any Editor approves anything |
| `POST /:id/override` | `ApprovalsOverride on approvals:*` (Admin) | Any Admin overrides anything |

**The `approvals` resource has no per-row attributes** — `connectorId`,
`namespace`, `teamId` are not stored on the row. So even if we wanted to
write a finer-grained grant, the resolver has nothing to match against.

## 2. Goals / non-goals

**Goals**
1. Multi-team within one org: Team A reads/approves their own; Team B reads/approves theirs.
2. Per-cluster gating: `prod-eks` approvals only the prod approver group sees.
3. Team-scoped audit: "show me MY team's pending approvals."
4. **Backwards-compat**: existing single-team installs see no behaviour change. Viewer still sees everything; Editor still approves everything. Multi-team is opt-in via fixed-role grants.

**Non-goals (v1)**
- Cross-org sharing.
- Per-step namespace tagging when one plan spans multiple namespaces. v1 records a single `target_namespace` per approval; cluster-scoped plans store `NULL`.
- On-call rotation / mute timings (separate concern; tracked elsewhere).
- Custom approval workflows beyond the existing single-approver model.

## 3. Design

### 3.1 Scope grammar (additive)

```
approvals:*                              ── (existing) all approvals in org
approvals:uid:<id>                       ── (existing) one approval row
approvals:connector:<connId>             ── NEW: any approval with ops_connector_id = connId
approvals:namespace:<connId>:<ns>        ── NEW: ops_connector_id = connId AND target_namespace = ns
approvals:team:<teamId>                  ── NEW: requester_team_id = teamId
```

**Resolver semantics**: a user matches a row if **any** of their grants
matches it (UNION of grants — most permissive wins). This mirrors how
`folders:uid:*` is treated today.

**Why two-segment `connector:<id>:namespace:<ns>` vs. nested grant?**
A single key keeps the scope a flat string and the index simple. `<connId>`
is the cluster identifier, `<ns>` is the kubernetes namespace. The grant
`approvals:namespace:prod-eks:platform` reads as "prod-eks cluster, platform
namespace."

### 3.2 Schema

Add to `approval_request` table (sqlite + postgres + drizzle):

```sql
ALTER TABLE approval_request ADD COLUMN ops_connector_id  TEXT NULL;
ALTER TABLE approval_request ADD COLUMN target_namespace  TEXT NULL;
ALTER TABLE approval_request ADD COLUMN requester_team_id TEXT NULL;

CREATE INDEX idx_approval_request_connector ON approval_request(ops_connector_id);
CREATE INDEX idx_approval_request_namespace ON approval_request(ops_connector_id, target_namespace);
CREATE INDEX idx_approval_request_team      ON approval_request(requester_team_id);
```

**NULL semantics:**
- `ops_connector_id IS NULL` — non-ops approval (alert-rule write, rescue plan without ops, etc.). Matched only by `approvals:*` and `approvals:uid:<id>` grants. Connector-scoped grants do NOT match NULL rows.
- `target_namespace IS NULL` — cluster-scoped plan (kubectl on cluster-level resources). Matched by `approvals:connector:<id>` grants but NOT by `approvals:namespace:<id>:<ns>` grants (no namespace pin can pretend to gate cluster-wide writes).
- `requester_team_id IS NULL` — auto-investigation SA or pre-multi-team approval. Matched only by `approvals:*`.

Existing rows backfill with `NULL` everywhere. Viewer's existing
`approvals:*` covers them, so nothing breaks the day this lands.

### 3.3 Per-row filter

Replace the route-level pre-gate with a per-row resolver, mirroring the
dashboards list pattern.

`GET /api/approvals` (list):
1. Pull the user's `ApprovalsRead` grants.
2. If any grant resolves to `approvals:*` → return all rows for the org. (Fast path; no SQL join needed.)
3. Otherwise compose a WHERE clause from the user's specific grants:
   ```sql
   WHERE org_id = ?
     AND (
       id IN (:uid_set)
       OR ops_connector_id IN (:connector_set)
       OR (ops_connector_id, target_namespace) IN (:ns_pair_set)
       OR requester_team_id IN (:team_set)
     )
   ```
4. Return matched rows.

`GET /api/approvals/:id` (detail):
1. Load the row first (so we can check it against scope).
2. Build the candidate scopes for this row: `approvals:uid:<id>`, `approvals:connector:<conn>` if non-null, `approvals:namespace:<conn>:<ns>` if both non-null, `approvals:team:<tid>` if non-null, plus `approvals:*`.
3. Pass them to `ac.evalAny(...)` (any one match → allow). If none → 404 (NOT 403; emit 404 to avoid leaking the row's existence to a user who has no business knowing).

The same pattern applies to `:id/approve` / `:id/reject` / `:id/cancel` /
`:id/override` — each uses the row's specific scopes.

### 3.4 Fail-closed invariant

**The detail-route check MUST NOT fall back to `approvals:*` when no other
scope matches.** Concretely: if the row has `ops_connector_id = 'prod-eks'`
and the user has `approvals:read on approvals:connector:prod-eks`, allow. If
the user has only `approvals:read on approvals:connector:dev-eks`, deny.
Mistakenly broadening to `approvals:*` would expose every prod approval to
every dev-only user.

Tests pin this explicitly (T3 acceptance).

### 3.5 New fixed roles

Add to `packages/common/src/rbac/fixed-roles-def.ts`:

| UID | Name | Permissions | Bound to |
|---|---|---|---|
| `fixed:approvals:cluster_approver` | "Cluster approver" | `approvals:read + approve on approvals:connector:<connId>` | (connId resolved at grant binding) |
| `fixed:approvals:namespace_approver` | "Namespace approver" | `approvals:read + approve on approvals:namespace:<connId>:<ns>` | (both resolved at grant binding) |
| `fixed:approvals:team_viewer` | "Team approval viewer" | `approvals:read on approvals:team:<teamId>` | (teamId resolved at grant binding) |

The default `Editor` and `Viewer` roles **keep** their existing `approvals:*`
grants — single-team customers see no change. Multi-team customers revoke
the default and grant fixed roles per team.

### 3.6 Write-path enrichment

Whoever creates an approval row must populate the three new columns. The
sources:

- `ops_connector_id`: the `connectorId` of the first `ops_run_command` step in the plan. NULL when no ops step.
- `target_namespace`: the `namespace` argument of that first step. NULL when cluster-scoped (e.g., `kubectl get nodes`).
- `requester_team_id`: the team that owns the originating investigation's alert rule (via `alert_rule.folder_uid → folder.team_id`). NULL when auto-investigation SA or no associated team.

Producers to update (all in `packages/api-gateway/src/services/`):
- `plan-executor-service.ts` — when a plan transitions to `pending_approval`.
- `auto-investigation-dispatcher.ts` — when an auto-investigation produces a plan.
- The alert-rules `:id/investigate` route — the manual Investigate button.

### 3.7 Approval routing (downstream of #152's NotificationConsumer)

When the approval row is created, publish an `approval.created` event on the
existing IEventBus with `(connectorId, namespace, teamId, approvalId)`. The
NotificationConsumer added in #152 picks it up and:
1. Looks up users with an `approvals:approve` grant matching the scope. (Reuses the same scope resolver from §3.3.)
2. For each, looks up their notification subscriptions. (Out of scope: how a user opts into approval notifications; v1 = "any contact point on a `team:<id>` policy node.")
3. Fans out via the senders we already have.

"Visibility" and "notification" are then the same primitive: who can read
the row → who gets pinged. No second source of truth.

## 4. Migration & defaults

| Stage | Action |
|---|---|
| **Day 0** (PR merges) | Schema columns added, all NULL. Resolver supports new grants. New fixed roles published but unbound by default. Single-team installs see zero behaviour change. |
| **Day 1+** (multi-team customer enables) | Admin revokes `Editor`'s `approvals:*` grant. Admin grants `fixed:approvals:cluster_approver` (or `:namespace_approver`) to per-team groups, parameterized at grant time. |
| **Day N** (existing approvals) | Old rows have NULL columns → only `approvals:*` matches. Multi-team customers may run a one-time backfill SQL to populate columns from joined plan + investigation metadata. The migration tool ships in `scripts/`. |

## 5. UI

| Surface | Change |
|---|---|
| `/admin/approvals` list | Add filter chips: connector, namespace, team. Default = "all I can see" (post-filter). Empty state per filter. |
| Team detail page (`/admin/teams/:id`) | New section: "Pending approvals from this team" → links to filtered list. |
| Role binding UI | New fixed roles appear in the role picker; admin selects connector / namespace / team at bind time. (Already supported by Grafana-style folder-scoped roles.) |

No new admin UI for granting — reuses the existing role-binding flow.

## 6. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | `evalAny` over-permissive — one stray grant exposes all rows | Detail route does NOT add `approvals:*` to the candidate set unless the user actually has it. Tests pin this. |
| R2 | NULL semantics confuse operators ("why doesn't `connector:prod` see this row?") | Document explicitly in admin docs + error messages: "approval has no connector tag — only `approvals:*` covers it". Optionally surface a warning when an admin grants a connector-scoped role to a team but legacy NULL rows exist. |
| R3 | Backfill drift — old approval rows stay NULL forever | Provide a backfill script. Note clearly that NULL rows are visible only to `approvals:*` holders. |
| R4 | Scope grammar bloat — adding `connector:` and `namespace:` and `team:` to one resource encourages others to follow suit | Document the grammar shape in `docs/design/rbac-scope-grammar.md` (separate small doc) so future resources follow the same pattern. |

## 7. Tasks

Each task is independent enough to land as its own PR. Tasks within a
phase parallelize.

### Phase 1: Foundation

**T1.1 — Schema + repo + scope grammar**
- Files: `data-layer/src/db/sqlite-schema.sql`, `data-layer/src/repository/{sqlite,postgres}/approval-request.ts`, `data-layer/src/repository/{sqlite,postgres}/schema.ts`, `common/src/rbac/scope.ts` (or wherever scope parsing lives)
- Adds: 3 columns + 3 indexes; `IApprovalRequestRepository.list({ scopeFilter })` accepts the new shape and emits the right SQL; scope grammar parser knows the new dimensions
- Acceptance: 8+ tests covering each grant kind matching/not-matching the right rows, NULL row semantics, and the fast-path `*` short-circuit
- Dependencies: none

### Phase 2: Producers + RBAC (parallel after T1.1)

**T2.1 — Approval write-path enrichment**
- Files: `services/plan-executor-service.ts`, `services/auto-investigation-dispatcher.ts`, `routes/alert-rules.ts` (manual investigate path), repository's `create()`
- Resolves `connectorId / namespace / teamId` from plan + investigation context and writes to the row
- Acceptance: 4 tests, one per producer, asserting the right values land on the row; NULL when sources are absent
- Dependencies: T1.1

**T2.2 — RBAC fixed roles + per-row filter**
- Files: `common/src/rbac/fixed-roles-def.ts`, `routes/approval.ts`, scope expansion helper
- Adds 3 fixed roles, switches `GET /:id` and the action routes to per-row scope resolution, list route to post-filter, deny → 404 (not 403)
- Acceptance: 6+ tests including the fail-closed invariant (R1)
- Dependencies: T1.1

### Phase 3: Notify + UI (parallel after T2.x)

**T3.1 — Approval routing through NotificationConsumer**
- Files: `services/notification-consumer.ts` (extend to subscribe to `approval.created`), new `services/approval-router.ts`, publisher in T2.1's create site
- Computes "users with matching approve grant" from scope + dispatches to their subscribed contact points (group/repeat windows from #152 reused)
- Acceptance: 3 tests — single-team route, multi-team route (different namespaces → different recipients), zero-recipient logging
- Dependencies: T1.1, T2.1, T2.2, plus #152 already in main

**T3.2 — UI filters**
- Files: `web/src/pages/admin/Approvals.tsx`, team detail page
- Filter chips, empty states, team-detail "pending approvals" section
- Acceptance: vitest component tests + manual screenshot
- Dependencies: T1.1, T2.2

## 8. Acceptance (release gate)

The feature is shippable when:
1. Single-team install (existing default) — fresh `npm run start`, fire an alert, observe Viewer still sees the approval, Editor approves, no behaviour change. Tests pin this.
2. Multi-team setup — admin runs the documented setup (revoke default, grant fixed roles per team), fires alerts in two namespaces, observes Team A's approver sees only Team A's approval and vice versa.
3. Migration — running on a DB with legacy NULL rows, both Viewers and the new fixed-role holders see what they should (Viewers see everything; fixed-role holders see new rows that match + nothing else).
4. The fail-closed invariant has automated coverage (T2.2).
