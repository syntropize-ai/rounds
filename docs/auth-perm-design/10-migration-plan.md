# 10 — Migration Plan

**Applies to:** T9.1–T9.6 (cutover + cleanup)

## Context

At the start of this project, openobs auth state lives in:

- In-memory `UserStore` (`packages/api-gateway/src/auth/user-store.ts`)
- In-memory `SessionStore`
- In-memory audit ring buffer
- Seeded from `SEED_ADMIN_*` env vars on startup

Workspace concept in `packages/common/src/models/workspace.ts` + a `workspace` table (partially populated; resources carry `tenantId` which is workspace-scoped).

After this project:

- All identity/session/audit data in SQLite via repositories
- `org` is the tenancy concept (workspace renamed)
- RBAC fully populated with built-in + fixed roles
- Frontend pulls permissions from server

The cutover must be safe: one atomic deployment boundary, predictable rollback.

## Strategy: additive → cutover → cleanup

Three phases:

1. **Additive (Waves 1–5)**: All new tables/services/endpoints added alongside existing code. No breaking changes yet. Existing in-memory store keeps working. New SQLite-backed repos run in parallel (dual-write).

2. **Cutover (Wave 6 / T9.1–T9.2)**: Atomic switch. The in-memory stores are deleted. All read/write paths use SQLite. Workspace → Org rename applied.

3. **Cleanup (T9.6)**: Remove deprecated code paths, shims, workspace-aliases, old middleware. Final form.

## T9.1 — Data migration script

File: `packages/api-gateway/src/migrations/auth-to-db.ts`. One-shot script executed at startup during the cutover release. Idempotent — if already run (marker in `settings` table), no-op.

Steps:

1. Default org: ensure `org_main` exists (created by migration 001).
2. Seed built-in roles for `org_main` (+ all existing workspaces).
3. Transform current `SEED_ADMIN_*` env-var admin into a `user` row:
   - Create user with `is_admin=1`.
   - Hash the seed password with our scrypt helper.
   - Create `org_user(org_main, user, role='Admin')`.
4. Walk existing workspaces → create `org` rows.
5. For each workspace, walk `WorkspaceMember`s → create `org_user` rows with role mapping:
   - `owner` / `admin` → `Admin`
   - `editor` → `Editor`
   - `viewer` → `Viewer`
6. Update resource tables: `UPDATE <t> SET org_id = workspace_id WHERE org_id IS NULL OR org_id = ''`.
7. Mark `settings` table `auth_migrated_v1 = true`.

Dry-run mode: `--dry-run` flag prints planned changes without writing. Used in pre-flight.

## T9.2 — Workspace → Org rename

Atomic PR touching:

- File renames (lowercase): `workspace.ts` → `org.ts`, `workspaces/` → `orgs/`
- Symbol renames: `Workspace` → `Org`, `WorkspaceMember` → `OrgUser`, `workspaceId` → `orgId`, `tenantId` → `orgId`
- Endpoint renames: `/api/workspaces` → `/api/orgs`
- Shim endpoints at old paths redirect (301) to new paths for 2 releases, then removed in T9.6
- DB: table `workspace` → `org` (actually a new migration that CREATE TABLE org with data FROM workspace, then DROP workspace). Requires downtime window or a feature-flag safe ordering:
  - Run migration during maintenance window (~30s for typical DB).
  - After migration, both `org` and `workspace` exist; `workspace` is an empty shell removed in T9.6.

For existing deployments, the migration steps are:

```
-- Phase 1 (deploy N): add org, keep workspace read-write. Both populated (dual-write).
-- Phase 2 (deploy N+1): stop writing workspace; reads from org only.
-- Phase 3 (deploy N+2 / T9.6): drop workspace table.
```

For first-time users (fresh install), no dual-write — schema starts clean.

## T9.3 — Quota enforcement

Enable quota checks in:

- `POST /api/admin/users` — check `users` quota per server or per org
- `POST /api/serviceaccounts` — check `service_accounts` quota
- `POST /api/dashboards` — check `dashboards` quota
- `POST /api/datasources` — check `datasources` quota
- `POST /api/serviceaccounts/:id/tokens` — check `api_keys` quota

Each check: `quotaService.check(orgId, target)` → throws `QuotaExceededError` → handler returns 403 with `{ message: "Quota exceeded for target=..." }`.

Defaults (config):

| Target | Default | Configurable via |
|---|---|---|
| `users` per org | unlimited (-1) | `QUOTA_USERS_PER_ORG` |
| `service_accounts` per org | 10 | `QUOTA_SA_PER_ORG` |
| `dashboards` per org | unlimited | `QUOTA_DASHBOARDS_PER_ORG` |
| `datasources` per org | 10 | `QUOTA_DATASOURCES_PER_ORG` |
| `api_keys` per user | 10 | `QUOTA_APIKEYS_PER_USER` |
| `folders` per org | unlimited | `QUOTA_FOLDERS_PER_ORG` |
| `alert_rules` per org | unlimited | `QUOTA_ALERT_RULES_PER_ORG` |

Match Grafana defaults where applicable.

## T9.4 — Setup wizard first-admin

Current SetupWizard has no admin creation step. Add as the first step:

```
Step 1: Create administrator  ← NEW
Step 2: Configure LLM
Step 3: Configure Datasources
Step 4: Configure Notifications
```

Form fields:
- Email (required, valid format)
- Full name (required)
- Login (autofilled from email local-part)
- Password (required, min 12 chars, confirm match)

Endpoint used: `POST /api/setup/admin` (new, public, one-shot: errors 409 if any user exists).

After submit:
- Creates user with `is_admin=1`.
- Seeds them into `org_main` as Admin.
- Auto-logs in (issues session cookie).
- Stored-state `setup.admin_created=true`.

Subsequent visits to `/setup` skip step 1 if already done.

## T9.5 — Docs

Two documents delivered in this task:

### Operator guide: `docs/auth.md`

Sections:
- Overview of the model (links to 00-overview.md technical doc)
- Configuring authentication providers (env vars, OAuth apps)
- Configuring LDAP / SAML
- Bootstrapping first admin
- Role reference (built-ins with permission tables)
- Service account lifecycle
- Audit log access and retention
- Troubleshooting (common 401/403 causes)

### API reference: `docs/api-reference.md`

Generated from the handlers (OpenAPI spec via `zod-to-openapi` or manual). For every endpoint in [08-api-surface.md](08-api-surface.md):
- Path, method
- Request body schema
- Response body schema
- Example curl
- Possible errors

## T9.6 — Cleanup

Delete:

- `packages/api-gateway/src/auth/user-store.ts` (in-memory)
- `packages/api-gateway/src/auth/session-store.ts` (in-memory)
- In-memory audit ring buffer
- Workspace model, routes, migrations (after Phase 3 above)
- Env-var `API_KEYS` parsing
- Frontend `ROLE_PERMISSIONS` hardcode (already removed in T8.8)
- Dual-write logic from auth-manager
- Legacy `SEED_ADMIN_*` env vars (or keep as one-shot bootstrap only for headless installs)

Search patterns to sweep:

```
grep -r "UserStore" packages/api-gateway/src
grep -r "SessionStore" packages/api-gateway/src
grep -r "workspace" packages/ --include="*.ts" | grep -v node_modules | grep -v dist
grep -r "tenantId" packages/ --include="*.ts"
grep -r "ROLE_PERMISSIONS" packages/web/src
grep -r "API_KEYS" packages/api-gateway/src
```

Each hit must be either refactored to new code or explicitly kept (with a comment citing why).

## Rollback plan

If cutover release needs reverting:

1. **Fresh install case** (no existing production data): trivial — just deploy prior version. Schema unused.
2. **Migrated production case**: harder because `org` rename is structural.
   - If bug is found within first deployment window: `git revert` the cutover PR, redeploy. Requires schema migration to also have a reversal (rare in this design — most are additive and safe). Document which migrations are reversible.
   - If bug is found after Phase 3 cleanup: can't roll back; forward-fix only. This is why we stage Phase 1 → 2 → 3 across multiple releases.

Pre-production `--dry-run` on a staging DB is mandatory before each phase.

## Test matrix for migration

1. Fresh install with empty DB → default org created, built-ins seeded, SetupWizard admin flow completes, admin can log in.
2. Dev env upgrade with in-memory data → on restart, dev admin env vars create user in DB, existing sessions lost (acceptable in dev).
3. Dev env with some workspace data → workspaces become orgs, members copied, resources scoped, permissions evaluable.
4. Migration script `--dry-run` produces plan matching actual run.
5. Migration script twice (already-migrated flag) → no-op.
6. Rollback from Phase 2 back to Phase 1 by re-enabling dual-write in config → no data loss.
7. Quota enforcement: set `QUOTA_SA_PER_ORG=2`, create 2 SAs → OK. Create 3rd → 403.

## Risk register

- **Risk**: Env-var seed admin has weak password, gets persisted. **Mitigation**: T9.4 setup wizard forces proper password. Env seed is for first-boot only and we log a warning if used.
- **Risk**: Workspace → Org rename touches many files, merge conflicts. **Mitigation**: T4.5 is its own PR with mechanical renames; fix conflicts before adding logic.
- **Risk**: Migration mislabels owner/admin roles when converting workspaces. **Mitigation**: unit test covers every input combination.
- **Risk**: Existing resources lose org_id in edge cases. **Mitigation**: migration has a post-run assertion that counts rows where `org_id IS NULL` and fails if any.
- **Risk**: RBAC seed regression breaks login. **Mitigation**: integration test boots fresh DB, seeds, logs in as Viewer, reads one dashboard.

## File scope for T9 agents

- `packages/api-gateway/src/migrations/auth-to-db.ts` — migration script
- `packages/api-gateway/src/migrations/workspace-to-org.ts` — rename
- `packages/api-gateway/src/migrations/*.sql` — SQL parts
- `packages/api-gateway/src/routes/setup.ts` — setup admin endpoint
- `packages/web/src/pages/SetupWizard.tsx` + `pages/setup/StepAdmin.tsx` — new UI step
- `docs/auth.md` — operator docs
- `docs/api-reference.md` — API docs
- Delete files listed in §T9.6 cleanup
