# 04 — Organizations

**Applies to:** T4.1–T4.5
**Grafana reference (mandatory reading):**
- `pkg/services/org/` — service + model
- `pkg/services/org/orgimpl/` — implementation
- `pkg/api/org.go`, `pkg/api/org_users.go` — HTTP handlers
- `pkg/middleware/org_redirect.go` — org context middleware
- `pkg/models/roles.go::RoleType` — OrgRole enum

## Concept

An **org** is a tenancy boundary. All resources (dashboards, datasources, teams, api keys, investigations, alert rules, ...) belong to exactly one org. A user can be a member of multiple orgs with different roles in each.

openobs already has a partial concept called "workspace" (see `packages/common/src/models/workspace.ts`). T4.5 renames workspace→org atomically.

## OrgRole enum

```ts
export const OrgRole = {
  Admin:  'Admin',
  Editor: 'Editor',
  Viewer: 'Viewer',
  None:   'None',
} as const
export type OrgRole = typeof OrgRole[keyof typeof OrgRole]
```

- **Admin** — org-level admin; can invite users, manage teams, manage roles within org, manage org settings.
- **Editor** — can create/edit dashboards, folders, alert rules within org.
- **Viewer** — read-only in org.
- **None** — member of org but zero permissions; used for federated scenarios where org membership is tracked but permissions are granted solely via role assignments.

Match Grafana's `RoleType` values exactly.

## Entity: Org

```ts
interface Org {
  id: string
  name: string
  address1?: string
  address2?: string
  city?: string
  state?: string
  zipCode?: string
  country?: string
  billingEmail?: string
  version: number
  created: number  // epoch ms
  updated: number
}
```

## Entity: OrgUser

```ts
interface OrgUser {
  id: string
  orgId: string
  userId: string
  role: OrgRole
  created: number
  updated: number
}
```

Derived view for UI (`org_user` joined with `user`):

```ts
interface OrgUserDTO {
  orgId: string
  userId: string
  email: string
  name: string
  login: string
  avatarUrl?: string
  role: OrgRole
  lastSeenAt?: number
  lastSeenAtAge?: string   // "3 days ago" computed server-side
  authLabels?: string[]    // ['OAuth GitHub'] from user_auth
  isDisabled: boolean
  isExternallySynced?: boolean
}
```

## CRUD service

File: `packages/api-gateway/src/services/org-service.ts`.

```ts
interface IOrgService {
  create(input: { name: string; createdBy: string }): Promise<Org>
  getById(id: string): Promise<Org | null>
  getByName(name: string): Promise<Org | null>
  list(opts?: { query?: string; limit?: number; offset?: number }): Promise<{ items: Org[]; total: number }>
  update(id: string, patch: Partial<Org>): Promise<Org>
  delete(id: string): Promise<void>   // cascades via FKs to all org-scoped resources

  // Membership
  listUsers(orgId: string, opts?: { query?: string; limit?: number; offset?: number }): Promise<{ items: OrgUserDTO[]; total: number }>
  addUser(orgId: string, userId: string, role: OrgRole): Promise<OrgUser>
  updateUserRole(orgId: string, userId: string, role: OrgRole): Promise<OrgUser>
  removeUser(orgId: string, userId: string): Promise<void>
}
```

### Create org side-effects

1. Insert `org` row.
2. Seed built-in roles for this org (`basic:viewer`, `basic:editor`, `basic:admin` role rows + their permission rows). See [03-rbac-model.md](03-rbac-model.md) §seed.
3. Seed fixed roles for this org.
4. Add `createdBy` user as org Admin (`org_user` row with `role='Admin'`).
5. Initialize quotas: default `dashboards=-1`, `users=-1`, `datasources=-1`, `api_keys=-1`.
6. Audit: `org.created`.

### Delete org side-effects

1. Cascade via FKs: dashboards, folders, datasources, teams, api_keys, roles (scoped to org), investigations, alert rules, chat sessions, audit rows scoped to org.
2. Every user whose `user.org_id = deleted_org` has their `user.org_id` reassigned to their first other org membership, or to the server's default org.
3. All sessions of users whose default org changed are NOT revoked (they stay logged in; just switch orgs).
4. Audit: `org.deleted`.

**Note:** org with only one server admin as member is still deletable, but server admins always have access to other orgs or can create new.

## Org context middleware (T4.3)

File: `packages/api-gateway/src/middleware/org-context.ts`.

Runs after `authn`, before `accesscontrol`.

### Resolution order for current org

1. **Explicit header**: `X-Openobs-Org-Id: <orgId>` — if present and valid (user is member of that org), use it.
2. **Query param**: `?orgId=<orgId>` — same check.
3. **User's default org**: `user.org_id`.
4. **If user has no org membership**: 403 with `{ message: "user is not a member of any org" }`. Exception: server admin endpoints that don't need org (`/api/admin/*`, `/api/orgs`, `/api/users`).

After resolution, `req.auth.orgId` and `req.auth.orgRole` are populated.

### Switching default org

User can change their default org via:

```
POST /api/user/using/:orgId
```

Updates `user.org_id` = `:orgId` after verifying membership. Response: 200 `{ message: "active organization changed" }`.

Frontend org switcher (T8.2) calls this after the user picks a new org from the dropdown, then refetches `/api/user` + `/api/user/permissions`.

### Cross-org server-admin operations

Certain endpoints are cross-org by design (not scoped to `req.auth.orgId`):

- `/api/orgs` (list all orgs) — requires `orgs:read` on `orgs:*` (server admin default role includes it).
- `/api/admin/users` — cross-org user management.
- `/api/admin/stats` — server stats.

These check `isServerAdmin` OR `orgs:read`/`users:read` global permission directly; they don't require `orgId` header.

## Resource scoping (T4.4)

Every existing resource table gains `org_id TEXT NOT NULL`. Every query that fetches resources must filter by `org_id`.

Audit list (not exhaustive — agent writes migration to walk all tables):
- `dashboards`
- `panels` (via dashboard's org)
- `investigations`
- `investigation_reports`
- `alert_rules`
- `datasources`
- `chat_sessions`
- `chat_session_events`
- `approvals`
- `shares` / `share_links` (if exists)
- `conversations`

Every repository method that takes a `userId` changes to take `orgId` (or an `Identity` object). Resource ownership stays tracked via existing `userId` columns but queries always include `WHERE org_id = :orgId`.

### Migration `015_alter_resources.sql`

- For each table: `ALTER TABLE <t> ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_main';`
- Drop default after backfill: `UPDATE <t> SET org_id = 'org_main' WHERE org_id IS NULL;`
- Add index: `CREATE INDEX ix_<t>_org_id ON <t>(org_id);`

SQLite can't drop-column a NOT NULL default mid-migration cleanly; the default stays. Write applications always pass explicit `orgId`, so the default is a safety net only.

## Workspace → Org rename (T4.5)

This is one atomic PR. It touches:

- `packages/common/src/models/workspace.ts` → `org.ts` (rename + update interfaces)
- `packages/api-gateway/src/routes/workspaces.ts` → `orgs.ts`
- Endpoint paths: `/api/workspaces` → `/api/orgs`
- DB: existing `workspace_id` columns on resources (if present) dropped in favor of `org_id`. If workspaces were the source of `tenantId`, update the migration to carry `tenantId` → `org_id` first, then rename.
- Frontend: every `workspace` / `workspaceId` reference → `org` / `orgId`
- Types: `Workspace` → `Org`, `WorkspaceMember` → `OrgUser`.

**Strategy**: ship the new `org_*` tables and endpoints first (T4.1–T4.4). Keep workspace API as shims that proxy to org APIs. Then in T4.5 final cutover, remove the shims.

If the workspace model currently has different semantics than Grafana's org (e.g., `WorkspaceMember` role is `owner|admin|editor|viewer` — note `owner`), reconcile:
- `owner` → `Admin` (with additional owner-flag if Grafana distinguishes... Grafana doesn't; owner = whoever created, no special "owner" role beyond Admin)
- existing `admin|editor|viewer` → PascalCase `Admin|Editor|Viewer`
- New `None` role not backported; all existing members get their prior role as-is.

## HTTP API

See [08-api-surface.md](08-api-surface.md) for full surface. Summary:

- `POST   /api/orgs` — create (requires `orgs:create`)
- `GET    /api/orgs` — list all (requires `orgs:read` on `orgs:*`)
- `GET    /api/orgs/:id` — get
- `GET    /api/orgs/name/:name` — get by name
- `PUT    /api/orgs/:id` — update
- `DELETE /api/orgs/:id` — delete
- `GET    /api/orgs/:id/users` — list members
- `POST   /api/orgs/:id/users` — add member (body: `{ loginOrEmail, role }`)
- `PATCH  /api/orgs/:id/users/:userId` — update role
- `DELETE /api/orgs/:id/users/:userId` — remove
- `GET    /api/org` — current org (from orgContext)
- `PUT    /api/org` — update current org (name/address; requires `orgs:write`)
- `GET    /api/org/users` — current org's users (via orgContext)
- `POST   /api/org/users` — invite / add to current org
- `PATCH  /api/org/users/:userId` — change role in current org
- `DELETE /api/org/users/:userId` — remove from current org
- `POST   /api/user/using/:orgId` — switch current user's default org

Match `pkg/api/api.go::RegisterRoutes` path layout.

## Test scenarios (MUST be implemented)

1. Create org → org_user row for creator with Admin role; built-in roles seeded.
2. List orgs as server admin → all orgs.
3. List orgs as non-admin → only own.
4. Add user to org with Viewer role → org_user row exists; GET /api/orgs/:id/users returns user.
5. Update user role → old role replaced; audit log.
6. Remove user from their last org → user still exists, but no org; log attempts error with 400 if this is their default.
7. Switch default org → /api/user reflects new default; permissions change.
8. Delete org → all resources cascade-deleted; users reassigned; server admin remains able to operate.
9. Cross-org isolation: user in org A can't read dashboards from org B via any endpoint (check dashboards, investigations, alert rules, datasources).
10. Server admin without org membership can still list orgs and perform admin actions, but cannot read dashboards in an org where they have no membership.
11. Default org bootstrap: fresh DB has one org (`org_main`) created by migration `001`; first admin user has it as default.
12. Org context header `X-Openobs-Org-Id: <other>` → request scoped to other, but only if user is member; otherwise 403.

## File scope for T4 agents

- `packages/common/src/models/org.ts`
- `packages/api-gateway/src/services/org-service.ts`
- `packages/api-gateway/src/routes/orgs.ts`
- `packages/api-gateway/src/middleware/org-context.ts`
- `packages/data-layer/src/repositories/org-repository.ts`
- `packages/data-layer/src/repositories/org-user-repository.ts`
- Touch every resource repository to accept/filter `orgId`
- Touch every resource route handler to pass `req.auth.orgId` down
- DB migrations 001, 005, 015
