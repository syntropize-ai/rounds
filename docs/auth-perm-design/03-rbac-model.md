# 03 — RBAC Model

**Applies to:** T3.1–T3.5
**Grafana reference (mandatory reading):**
- `pkg/services/accesscontrol/` (root) — [github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/accesscontrol)
- `pkg/services/accesscontrol/acimpl/service.go` — service wiring
- `pkg/services/accesscontrol/resolvers/` — scope resolvers
- `pkg/services/accesscontrol/roles.go` — built-in role definitions (**the canonical action catalog**)
- `pkg/services/accesscontrol/models.go` — types: Permission, Scope, Evaluator
- `pkg/services/accesscontrol/database/database.go` — storage
- `pkg/services/accesscontrol/evaluator.go` — evaluation semantics

If you're implementing T3.1 or T3.3 and haven't read `evaluator.go` in full, stop.

## Model overview

Three layers:

1. **Actions** — what operations exist. Immutable catalog. e.g., `dashboards:read`, `folders:create`, `users:write`.
2. **Scopes** — what resources an action can apply to. Grammar: `kind:attribute:identifier`, e.g., `dashboards:uid:abc123`, `folders:uid:*`.
3. **Roles** — named sets of (action, scope) tuples. Assigned to users, teams, or built-in pseudo-roles.

Built-in roles are seeded at startup. Custom roles are user-created via API/UI.

## Action catalog (full list — not a subset)

Match `pkg/services/accesscontrol/roles.go` exactly. Source file is the canonical list; below is the catalog as of v11.3.0 adapted to openobs's resource set.

### Dashboards (`dashboards:*`)
- `dashboards:read`
- `dashboards:write`
- `dashboards:create`
- `dashboards:delete`
- `dashboards.permissions:read`
- `dashboards.permissions:write`

### Folders (`folders:*`)
- `folders:read`
- `folders:write`
- `folders:create`
- `folders:delete`
- `folders.permissions:read`
- `folders.permissions:write`

### Datasources (`datasources:*`)
- `datasources:read`
- `datasources:write`
- `datasources:create`
- `datasources:delete`
- `datasources:query`
- `datasources:explore`
- `datasources.id:read`
- `datasources.permissions:read`
- `datasources.permissions:write`

### Alert rules (`alert.rules:*`)
- `alert.rules:read`
- `alert.rules:write`
- `alert.rules:create`
- `alert.rules:delete`
- `alert.notifications:read`
- `alert.notifications:write`
- `alert.instances:read`
- `alert.instances.external:read`
- `alert.instances.external:write`
- `alert.silences:read`
- `alert.silences:create`
- `alert.silences:write`
- `alert.provisioning:read`
- `alert.provisioning:write`

### Users (`users:*`, server-admin scope)
- `users:read`
- `users:write`
- `users:create`
- `users:delete`
- `users:disable`
- `users.authtoken:read`
- `users.authtoken:update`
- `users.password:update`
- `users.permissions:read`
- `users.permissions:write`
- `users.quotas:list`
- `users.quotas:update`

### Org users (`org.users:*`, within an org)
- `org.users:read`
- `org.users:add`
- `org.users:write`
- `org.users:remove`

### Orgs (`orgs:*`)
- `orgs:read`
- `orgs:write`
- `orgs:create`
- `orgs:delete`
- `orgs.preferences:read`
- `orgs.preferences:write`
- `orgs.quotas:read`
- `orgs.quotas:write`

### Teams (`teams:*`)
- `teams:read`
- `teams:write`
- `teams:create`
- `teams:delete`
- `teams.permissions:read`
- `teams.permissions:write`

### Service accounts (`serviceaccounts:*`)
- `serviceaccounts:read`
- `serviceaccounts:write`
- `serviceaccounts:create`
- `serviceaccounts:delete`
- `serviceaccounts.permissions:read`
- `serviceaccounts.permissions:write`

### API keys (legacy; Grafana keeps for compat)
- `apikeys:read`
- `apikeys:create`
- `apikeys:delete`

### Roles (`roles:*`)
- `roles:read`
- `roles:write`
- `roles:delete`

### Server-level (`server:*`)
- `server.stats:read`
- `server.usagestats.report:read`

### Annotations (`annotations:*`)
- `annotations:read`
- `annotations:write`
- `annotations:create`
- `annotations:delete`

### openobs-specific additions

These don't exist in Grafana; we add them, following the same naming convention.

- `investigations:read`
- `investigations:write`
- `investigations:create`
- `investigations:delete`
- `approvals:read`
- `approvals:approve`
- `approvals:override`
- `chat:use`
- `agents.config:read`
- `agents.config:write`

`[openobs-extension]` — every addition is commented in code as such.

**Total action count:** ~85 built-in Grafana actions + ~10 openobs-specific = ~95 actions. Every one must be registered in the action catalog loaded at startup.

### Catalog registration

Single source of truth: `packages/common/src/rbac/actions.ts`:

```ts
export const ACTIONS = {
  DashboardsRead:        'dashboards:read',
  DashboardsWrite:       'dashboards:write',
  // ... all of the above
} as const

export type Action = typeof ACTIONS[keyof typeof ACTIONS]

export const ALL_ACTIONS: readonly Action[] = Object.values(ACTIONS)
```

Used by middleware, role seeding, tests.

## Scope grammar

Format: `kind[:attribute[:identifier]]`. Parsed into 3 parts and stored denormalized in the `permission` table.

| Example | kind | attribute | identifier |
|---|---|---|---|
| `dashboards:*` | `dashboards` | `*` | `*` |
| `dashboards:uid:abc123` | `dashboards` | `uid` | `abc123` |
| `folders:uid:folder-xyz` | `folders` | `uid` | `folder-xyz` |
| `datasources:uid:prod-prom` | `datasources` | `uid` | `prod-prom` |
| `users:id:u_42` | `users` | `id` | `u_42` |
| `teams:id:*` | `teams` | `id` | `*` |
| `` (empty) | `*` | `*` | `*` |

`*` means wildcard for that position. An empty scope means "no resource restriction, applies globally within the action's kind."

### Scope resolvers

For a resource with attributes that can refer to it different ways (Grafana supports both numeric `id` and UID for dashboards), scope resolvers translate between them. Mirror `pkg/services/accesscontrol/resolvers/`.

For openobs (UUID-only ids), resolvers mostly are identity but still required for the evaluator:

- `dashboards:uid:<uid>` ↔ `dashboards:id:<id>` (we use UID == ID, but resolver exists)
- Wildcards expand: `dashboards:uid:*` matches any UID.

Implemented as `packages/api-gateway/src/rbac/resolvers/*.ts`, one per kind.

## Evaluator

File: `packages/api-gateway/src/rbac/evaluator.ts`. Implementation follows `pkg/services/accesscontrol/evaluator.go`.

### Interface

```ts
export interface Evaluator {
  evaluate(permissions: ResolvedPermission[]): boolean
  string(): string     // human-readable representation for error messages
  mutate(resolveScope: (scope: string) => string[]): Evaluator
}

export const ac = {
  eval(action: string, scope?: string | string[]): Evaluator,
  all(...evals: Evaluator[]): Evaluator,
  any(...evals: Evaluator[]): Evaluator,
}
```

Example usage in a handler:

```ts
const evaluator = ac.all(
  ac.eval('dashboards:write', `dashboards:uid:${uid}`),
  ac.eval('folders:read',     `folders:uid:${folderUid}`),
)
await requirePermission(req, evaluator)
```

### Evaluation semantics

A user's permissions is the union of:
- Built-in role permissions for their org role (Admin / Editor / Viewer)
- Custom role assignments via `user_role`
- Role assignments via `team_role` for all teams the user is in
- Server Admin adds ALL permissions

For a single `ac.eval(action, scope)`:
- Collect user permissions where `p.action === action`.
- For each, check if `p.scope` covers the requested scope. Coverage:
  - `p.scope === scope` (exact match)
  - `p.scope` has wildcard that subsumes `scope` (see resolver)
  - `p.scope === ''` (unrestricted on kind = global-within-action)
- If any permission covers, return true.

For `ac.all(...)`: all children must return true.
For `ac.any(...)`: any child returning true is sufficient.

Match the exact short-circuit and error-string conventions of `evaluator.go`.

## Built-in roles

### Pseudo-roles (mapped via `builtin_role` table)

Grafana has three pseudo-roles per org that every user falls into via their `org_user.role`:

- **Viewer** (`role.name='basic:viewer'`) — default read access
- **Editor** (`role.name='basic:editor'`) — Viewer + write/create dashboards/folders
- **Admin** (`role.name='basic:admin'`) — Editor + org admin (users, teams, roles)

Plus one global:

- **Server Admin** (`role.name='basic:grafana_admin'`, we rename to `basic:server_admin`) — all actions, all scopes. Does NOT automatically grant org-level permissions; a server admin still needs to be in an org to access that org's resources. Grafana exception: server admin can always CRUD orgs and users.

### Fixed roles (pre-defined bundles)

Grafana has ~80 fixed roles of form `fixed:<kind>:<role>`, e.g.:

- `fixed:dashboards:writer`
- `fixed:dashboards:reader`
- `fixed:folders:creator`
- `fixed:datasources:reader`
- `fixed:datasources:explorer`
- `fixed:users:writer`
- `fixed:users:reader`
- `fixed:teams:writer`
- ... (full list in `pkg/services/accesscontrol/roles.go`)

Each fixed role maps to a specific bundle of (action, scope) tuples. **All fixed roles in the Grafana v11.3.0 file must be seeded.** Missing even one is a parity bug.

### Role grants to built-ins (what basic roles include)

Mirror `pkg/services/accesscontrol/roles.go::BasicRolesDefinitions`.

**basic:viewer** (partial example — full list in seeding migration):
- `dashboards:read` on `dashboards:*`
- `folders:read` on `folders:*`
- `datasources:explore` on `datasources:*` (if explore enabled)
- `orgs.preferences:read`
- `teams:read` on `teams:*`
- ... (~30 actions total)

**basic:editor** = basic:viewer ∪:
- `dashboards:create`, `dashboards:write`, `dashboards:delete` on `dashboards:*`
- `folders:create`, `folders:write`, `folders:delete` on `folders:*`
- `annotations:create`, `annotations:write`, `annotations:delete`
- `alert.rules:*`
- ... (~45 actions total)

**basic:admin** = basic:editor ∪:
- `users:read`, `users:write` on `users:*` (within org)
- `teams:*`
- `serviceaccounts:*`
- `roles:*`
- `org.users:*`
- `orgs:read`, `orgs:write`, `orgs.quotas:read`, `orgs.quotas:write`
- ... (~70 actions total)

**basic:server_admin** = all actions on all scopes (unrestricted).

### Seed migration (009_rbac.sql + a TS seeder)

The SQL migration creates tables only. Seeding happens in a TS script invoked on startup after migrations if built-in role rows don't exist. Similar pattern to Grafana's `pkg/services/accesscontrol/acimpl/service.go::declareRoles`.

Seeder: `packages/data-layer/src/seed/rbac-seed.ts`. Called once per org (default org and any new orgs).

## Custom roles (T3.2)

Operators can create custom roles via API/UI, either:
- **Global** (visible across all orgs, with `org_id=''`) — requires Server Admin.
- **Org-scoped** (only usable within one org, `org_id=<org>`) — requires Org Admin.

API endpoints (full list in [08-api-surface.md](08-api-surface.md)):
- `POST /api/access-control/roles` — create
- `GET /api/access-control/roles` — list
- `GET /api/access-control/roles/:uid` — get
- `PUT /api/access-control/roles/:uid` — update (bumps `version`)
- `DELETE /api/access-control/roles/:uid` — delete
- `POST /api/access-control/user/:userId/roles` — assign role to user
- `DELETE /api/access-control/user/:userId/roles/:roleUid` — unassign
- `POST /api/access-control/team/:teamId/roles` — assign to team
- `DELETE /api/access-control/team/:teamId/roles/:roleUid` — unassign

Mirror `pkg/api/accesscontrol.go` handler set.

## Permission evaluation on a request (T3.3)

Middleware: `requirePermission(evaluator: Evaluator)`. Used as Express middleware factory.

```ts
router.post('/dashboards',
  requirePermission(ac.eval('dashboards:create', 'folders:uid:*')),
  handler.createDashboard,
)

router.get('/dashboards/:uid',
  requirePermission((req) => ac.eval('dashboards:read', `dashboards:uid:${req.params.uid}`)),
  handler.getDashboard,
)
```

Flow:
1. `authMiddleware` has populated `req.auth = { userId, orgId, isServerAdmin }`.
2. `requirePermission` calls `accessControlService.evaluate(req.auth, evaluator)`.
3. Service resolves user's full permission set (built-in role + custom roles + team roles), feeds to evaluator.
4. On failure: 403 with `{ message: "User has no permission to ..." }`.
5. On success: `next()`.

Permission resolution is cached per-request (attach to `req.auth.permissions` first time).

## `/api/user/permissions` endpoint (T3.4)

Replaces frontend `ROLE_PERMISSIONS` hardcode. Returns the authenticated user's fully resolved permissions in the current org.

```
GET /api/user/permissions
Authorization: Bearer <token>
X-Openobs-Org-Id: <org-uid>   (optional; defaults to user's default org)

200 OK
{
  "dashboards:read":  ["dashboards:*"],
  "dashboards:write": ["dashboards:uid:abc", "dashboards:uid:def"],
  "folders:read":     ["folders:*"],
  ...
}
```

Response shape matches `pkg/api/dtos/user.go::UserPermissionsSearchResponse`.

Frontend caches this on login (`AuthContext`) and checks via `hasPermission(action, scope?)` hook. No more hardcoded role map.

## Evaluator helper (T3.5)

Extract `ac` (the evaluator builder) into a package shared with the frontend, so handlers and UI can construct evaluators the same way.

`packages/common/src/rbac/evaluator.ts`:
```ts
export const ac = {
  eval(action: string, scope?: string | string[]): Evaluator,
  all(...evals: Evaluator[]): Evaluator,
  any(...evals: Evaluator[]): Evaluator,
}
```

Backend: given permissions array, `.evaluate(perms)` returns boolean.
Frontend: given cached permissions from `/api/user/permissions`, same call gives boolean — used for disabling buttons, hiding menu items, etc. Same API both sides.

## Test scenarios (MUST be implemented)

Mirror `pkg/services/accesscontrol/acimpl/service_test.go` at minimum. Each scenario has a unit test.

1. **User with Viewer role can `dashboards:read`** any dashboard in their org.
2. **User with Viewer role cannot `dashboards:write`.**
3. **User with Editor role can `dashboards:write`** on any dashboard in their org.
4. **User with Admin role can everything in org.**
5. **Server Admin can everything across orgs**, including creating orgs.
6. **Server Admin without org role cannot `dashboards:read` in that org** — Grafana-specific: server admin doesn't automatically inherit org permissions. Confirm by reading `accesscontrol.go::GetUserBuiltInRoles`.
7. **User with no org role (`None`) has zero permissions in that org.**
8. **Custom role grants action on specific scope** — user with role containing `dashboards:read: dashboards:uid:abc123` can read `abc123` but not `def456`.
9. **Team role inheritance** — user in team with role → user gets team's permissions.
10. **Multiple role union** — user with two roles has union of permissions.
11. **Scope wildcard coverage** — `dashboards:*` covers `dashboards:uid:xyz`.
12. **Fixed role seeding** — after startup, all fixed roles from Grafana v11.3.0 are present.
13. **Custom role creation requires permission** — only `roles:write` can create roles.
14. **Delete role cascades to user_role/team_role** — FKs enforced.

Integration tests cover the HTTP layer:
- `GET /dashboards/:uid` returns 200 for Viewer, 200 for Editor, 403 for user with no role.
- `POST /access-control/roles` returns 403 for non-admin, 201 for admin.

## Non-parity points (explicit)

These are the only planned deviations from Grafana. Everything else: match.

1. **License-gated features**: Grafana has an `IsLicensed` guard on some fixed roles. We always-enable. `[openobs-deviation]` — documented here; agents do NOT need to re-flag.

2. **Action verbs**: Grafana occasionally uses both `dashboards.permissions:read` and `dashboards:permissions:read` forms. We always use the dot form (matches newer Grafana docs). Agents MUST use exact strings from `packages/common/src/rbac/actions.ts` — don't invent variants.

3. **Plugin actions**: Grafana has action registration for plugins. openobs has no plugin system yet; we skip plugin-action plumbing. `[openobs-extension-point]` — noted in code for future.
