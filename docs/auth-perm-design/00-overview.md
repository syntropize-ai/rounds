# Auth / Permissions — Grafana-Parity Design

**Status:** design, not yet implemented
**Reference version:** Grafana `v11.3.0` (pin commit: https://github.com/grafana/grafana/tree/v11.3.0)
**Owner:** @shiqi
**Last updated:** 2026-04-17

## Goal

Bring openobs identity/auth/permissions to **full parity** with Grafana's model. Not a simplified subset — every entity, relationship, and permission check in this document maps directly to something in Grafana's code, cited by path.

If the implementation is tempted to skip a table, collapse two roles, or defer a join — that's the failure mode this design exists to prevent.

## Why "full version"

openobs today has a toy auth system: in-memory users, frontend-mirrored role map, declared-but-unused teams, no service accounts, resource-level ACL non-existent. Before production we need:

- Persisted identity that survives restart and scales past one replica
- Multi-org tenancy so one openobs deployment can host multiple engineering teams
- The same RBAC model operators already know from Grafana (Admin / Editor / Viewer + fine-grained permissions)
- Service accounts as first-class non-human identities
- Folder / dashboard / datasource / alert-rule permission cascade
- Audit trail that actually persists

None of these are optional for an observability product. Operators expect Grafana-compatible mental models.

## Scope in one picture

```
Server Admin (cross-org, "Grafana Admin")
  └─ Organization (openobs already calls this "workspace" — we rename to "org")
       ├─ Members: User × OrgRole{Admin|Editor|Viewer|None}
       ├─ Members: ServiceAccount × OrgRole{Admin|Editor|Viewer}
       ├─ Teams  (members: users only; teams are principals on ACLs)
       ├─ Folders (hierarchical)
       │    └─ Dashboards, AlertRules  (inherit folder perms unless overridden)
       ├─ Datasources  (per-instance permissions)
       └─ API Tokens (issued to service accounts; personal access tokens per user)

Cross-cutting:
  - Authentication methods: local / OAuth (GitHub, Google, Generic OIDC) / SAML / LDAP
  - user_auth table: one user can link N external identities
  - user_auth_token: session tokens with rotation
  - Fine-grained RBAC: (action, scope) tuples assigned to built-in roles, custom
    roles, users, teams; checked on every permission-gated operation.
  - Audit log: persistent, queryable, retention-configurable.
  - Quotas: per-org limits on users, dashboards, datasources, etc.
```

## Phases and task list

Work is grouped into 9 phases. Phases have dependency order; within a phase, tasks marked "parallel" can run concurrently.

### Phase 1 — Foundation (sequential)

| Task | File | Owner | Depends on |
|---|---|---|---|
| **T1.1** Schema: migrations for all new tables | [01-database-schema.md](01-database-schema.md) | DB agent | — |
| **T1.2** Repository layer: one `*Repository` class per entity | same | DB agent | T1.1 |
| **T1.3** Seed & fixture utilities for tests | same | DB agent | T1.2 |

### Phase 2 — Auth core (parallel after P1)

| Task | File | Depends on |
|---|---|---|
| **T2.1** Migrate `UserStore` → `UserRepository` | [02-authentication.md](02-authentication.md) | T1 |
| **T2.2** Migrate `SessionStore` → `user_auth_token` persisted | 02 | T1 |
| **T2.3** Local-password provider: rewrite against repo | 02 | T1, T2.1 |
| **T2.4** OAuth providers (GitHub/Google/OIDC) use `user_auth` linking | 02 | T1, T2.1 |
| **T2.5** Audit log persistence (`audit_log` table + writer) | 02 | T1 |
| **T2.6** LDAP provider (new) | 02 | T1, T2.1 |
| **T2.7** SAML provider (new) | 02 | T1, T2.1 |

### Phase 3 — RBAC model (parallel after P1)

| Task | File | Depends on |
|---|---|---|
| **T3.1** Action catalog + built-in roles | [03-rbac-model.md](03-rbac-model.md) | T1 |
| **T3.2** Custom roles CRUD + permission tables populated | 03 | T1, T3.1 |
| **T3.3** `requirePermission(action, scope)` middleware | 03 | T1, T3.1 |
| **T3.4** `/api/user/permissions` endpoint (replaces frontend hardcode) | 03 | T3.1, T3.2 |
| **T3.5** `accesscontrol.Evaluate` helper for in-handler checks | 03 | T3.3 |

### Phase 4 — Multi-org (sequential, after P2+P3)

| Task | File | Depends on |
|---|---|---|
| **T4.1** `org` table + CRUD API | [04-organizations.md](04-organizations.md) | T1 |
| **T4.2** `org_user` membership with `OrgRole` | 04 | T1, T4.1 |
| **T4.3** Org context middleware (default org + `x-openobs-org-id` header) | 04 | T4.1, T4.2 |
| **T4.4** Resource queries filter by `org_id` everywhere | 04 | T4.1, T4.3 |
| **T4.5** Workspace → Org rename (one atomic PR) | 04 | T4.1..T4.4 |

### Phase 5 — Teams (parallel after P4)

| Task | File | Depends on |
|---|---|---|
| **T5.1** `team`, `team_member`, `team_role` tables + CRUD | [05-teams.md](05-teams.md) | T4 |
| **T5.2** Team external sync interface (for LDAP/OIDC group mapping) | 05 | T5.1, T2.6 |
| **T5.3** Team permission resolution in `accesscontrol.Evaluate` | 05 | T3.5, T5.1 |

### Phase 6 — Service accounts (parallel after P4)

| Task | File | Depends on |
|---|---|---|
| **T6.1** `service_account` entity (user row with `is_service_account=true`) | [06-service-accounts.md](06-service-accounts.md) | T4 |
| **T6.2** `api_key` table replaces env-var API_KEYS | 06 | T6.1 |
| **T6.3** SA token auth middleware (Bearer + x-api-key paths) | 06 | T6.2 |
| **T6.4** Token issuance/rotation/revocation endpoints | 06 | T6.2 |

### Phase 7 — Resource permissions (after P3+P4+P5)

| Task | File | Depends on |
|---|---|---|
| **T7.1** `folder` entity + hierarchical folders | [07-resource-permissions.md](07-resource-permissions.md) | T4 |
| **T7.2** `permission` rows for (user|team|role) × (action) × (scope) | 07 | T3, T5 |
| **T7.3** Dashboard permissions: inherit from folder unless overridden | 07 | T7.1, T7.2 |
| **T7.4** Datasource permissions | 07 | T7.2 |
| **T7.5** Alert rule permissions | 07 | T7.2 |
| **T7.6** Legacy `dashboard_acl` back-compat shim (read-only) | 07 | T7.3 |

### Phase 8 — Frontend (parallel)

| Task | File | Depends on |
|---|---|---|
| **T8.1** Login page: provider selector + redirect flow | [09-frontend.md](09-frontend.md) | T2 |
| **T8.2** Org switcher in Navigation | 09 | T4 |
| **T8.3** Admin page: Users tab (with SA tab, roles, disable) | 09 | T2, T6 |
| **T8.4** Admin page: Teams tab | 09 | T5 |
| **T8.5** Admin page: Roles tab (built-in + custom) | 09 | T3.2 |
| **T8.6** Admin page: Orgs tab (server admin only) | 09 | T4 |
| **T8.7** Per-resource Permissions dialog (folder / dashboard / datasource) | 09 | T7 |
| **T8.8** Frontend auth: remove hardcoded ROLE_PERMISSIONS, use server | 09 | T3.4 |

### Phase 9 — Cutover and cleanup

| Task | Depends on |
|---|---|
| **T9.1** Migration script: env-seed admin → DB | T2.1 |
| **T9.2** Migration script: existing workspaces → orgs | T4.5 |
| **T9.3** Quota enforcement (org-level limits) | T4 |
| **T9.4** Setup wizard: first-admin bootstrap step | T4, T8.3 |
| **T9.5** Docs: operator guide, API reference | All |
| **T9.6** Delete deprecated code paths | All prior phases |

## Wave plan (how agents are dispatched)

- **Wave 0 — Design review** (this document set). No code.
- **Wave 1 — T1.1..T1.3** (foundation): 1 agent, serial.
- **Wave 2 — T2.1..T2.7 + T3.1..T3.5**: 2 agents in parallel (auth-core, rbac).
- **Wave 3 — T4.1..T4.5** (orgs): 1 agent, serial, high-risk rename touching many files.
- **Wave 4 — T5 + T6 + T7**: 3 agents parallel (teams, service-accounts, resource-perms).
- **Wave 5 — T8.1..T8.8**: 3 agents parallel grouped by page.
- **Wave 6 — T9**: 1 agent, serial cleanup.

Each wave is only dispatched after the previous completes and integration-tests pass.

## Design documents

| # | File | Contents |
|---|---|---|
| 00 | [00-overview.md](00-overview.md) | This document. Phases, task list, waves. |
| 01 | [01-database-schema.md](01-database-schema.md) | All table DDL, indexes, FKs, migration sequence. |
| 02 | [02-authentication.md](02-authentication.md) | Providers, user_auth linking, session tokens, password hashing, OAuth/SAML/LDAP flows. |
| 03 | [03-rbac-model.md](03-rbac-model.md) | Action catalog, built-in roles, custom roles, scope syntax, evaluator. |
| 04 | [04-organizations.md](04-organizations.md) | Org model, org_user, org context, quota. |
| 05 | [05-teams.md](05-teams.md) | Team CRUD, team_member, external sync, team roles. |
| 06 | [06-service-accounts.md](06-service-accounts.md) | SA as user, api_key table, token lifecycle. |
| 07 | [07-resource-permissions.md](07-resource-permissions.md) | Folders, dashboard/datasource/alert-rule permissions, inheritance. |
| 08 | [08-api-surface.md](08-api-surface.md) | All REST endpoints with method/path/body/response, mirroring Grafana's HTTP API. |
| 09 | [09-frontend.md](09-frontend.md) | React page designs: Login, Admin, Org switcher, Permissions dialog. |
| 10 | [10-migration-plan.md](10-migration-plan.md) | Data migration from current in-memory / seed-admin to persisted DB. |
| 99 | [99-implementation-rules.md](99-implementation-rules.md) | **Required reading for every implementing agent.** Rules that prevent scope creep / simplification. |

## Acceptance — "parity" means

The implementation is considered parity-complete when:

1. Every table in [01-database-schema.md](01-database-schema.md) exists with the columns listed, and integration tests CRUD each entity.
2. Every endpoint in [08-api-surface.md](08-api-surface.md) returns the documented shape.
3. Every built-in Grafana role's permission list in [03-rbac-model.md](03-rbac-model.md) is exactly reproduced — not a subset.
4. An operator familiar with Grafana can run openobs and do the following without reading docs:
   - Create an org, invite users, assign org roles
   - Create a team, add members, grant the team Viewer on a folder
   - Create a service account, issue a token, use the token to read dashboards
   - Create a custom role from UI, grant it a specific action, assign it to a user
   - Search audit log for a specific user's login events
   - Disable a user and confirm all their sessions are revoked
5. Data survives restart.
6. Two openobs replicas share the same DB and present consistent auth state (sessions valid across replicas).

## Grafana source-of-truth paths (v11.3.0)

Agents implementing any phase MUST reference these paths. Discrepancies between our implementation and these files are a review bug unless explicitly justified in the relevant sub-design doc.

- User service: `pkg/services/user/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/user))
- Org service: `pkg/services/org/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/org))
- Team service: `pkg/services/team/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/team))
- Access control (RBAC): `pkg/services/accesscontrol/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/accesscontrol))
- Authentication (authn): `pkg/services/authn/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/authn))
- User auth tokens: `pkg/services/auth/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/auth))
- Service accounts: `pkg/services/serviceaccounts/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/serviceaccounts))
- API keys: `pkg/services/apikey/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/apikey))
- Folders: `pkg/services/folder/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/folder))
- Dashboards + ACL: `pkg/services/dashboards/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/dashboards))
- Datasources: `pkg/services/datasources/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/datasources))
- Quotas: `pkg/services/quota/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/quota))
- SQL migrations: `pkg/services/sqlstore/migrations/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/sqlstore/migrations))
- HTTP API handlers: `pkg/api/` ([github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/api))

## Open questions

These are deferred to doc-level discussion below, but flagged here so they don't get forgotten:

1. **OrgRole=None**: Grafana has a 4th org role for "user is a member but has no role". Do we support it? Recommendation: **yes**, mirror Grafana exactly.
2. **Data source mixed permissions**: Grafana permits a data source to grant specific teams query-only while another team has edit. Do we implement? Recommendation: **yes**, this is P7.4.
3. **Team external sync**: complexity is non-trivial. Recommend scoping to P5.2 as optional; if time-constrained, defer to post-parity.
4. **Anonymous access**: Grafana allows anonymous org assignment. Do we enable? Recommendation: **no**, openobs is not a public-facing product.
5. **Basic auth over API**: Grafana allows username+password on every request. Recommendation: **no**, require token for API; username+password only on `/login`.
