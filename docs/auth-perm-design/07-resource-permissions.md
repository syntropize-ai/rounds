# 07 — Resource Permissions

**Applies to:** T7.1–T7.6
**Grafana reference:**
- `pkg/services/folder/` — folder service + hierarchy
- `pkg/services/dashboards/` — dashboards + ACL
- `pkg/services/accesscontrol/resourcepermissions/` — generic resource permission service
- `pkg/services/datasources/` — datasources + permissions
- `pkg/services/ngalert/` — alert rules + permissions
- `pkg/api/dashboard_permissions.go`, `pkg/api/folder_permissions.go`, `pkg/api/datasource_permissions.go`

## Concept

Each resource kind (folder, dashboard, datasource, alert rule) supports per-resource permissions:

- A resource has a set of **permission rows**.
- Each permission row grants a **permission level** (View / Edit / Admin) to a **principal** (user, team, or built-in role).
- Permissions cascade from folders down to their contents unless explicitly overridden.

Two storage mechanisms coexist in Grafana:

1. **Legacy ACL** (`dashboard_acl` table) — older, pre-RBAC system. Still supported for backward compat.
2. **RBAC** (`permission` + `role` + `user_role`/`team_role`) — current. Per-resource permissions are implemented as generated roles.

openobs implements both — legacy ACL kept so operators migrating from Grafana can reuse their existing model, but RBAC is the primary evaluation path.

## Permission levels

```ts
export const Permission = {
  View:  1,
  Edit:  2,
  Admin: 4,
} as const
export type Permission = typeof Permission[keyof typeof Permission]
```

Hierarchy: `Admin > Edit > View`. Admin implies Edit implies View.

Mapping to RBAC actions:

| Level | Dashboards | Folders | Datasources | Alert rules |
|---|---|---|---|---|
| View | `dashboards:read` | `folders:read` | `datasources:query` | `alert.rules:read` |
| Edit | + `dashboards:write`, `dashboards:delete` | + `folders:write`, `folders:delete`, `dashboards:create` inside folder | + `datasources:write` | + `alert.rules:write`, `alert.rules:create`, `alert.rules:delete` |
| Admin | + `dashboards.permissions:read`, `dashboards.permissions:write` | + `folders.permissions:read`, `folders.permissions:write` | + `datasources.permissions:*` | + `alert.rules.permissions:*` |

## Folders (T7.1)

File: `packages/api-gateway/src/services/folder-service.ts`.

### Entity

```ts
interface Folder {
  id: string
  uid: string
  orgId: string
  title: string
  description?: string
  parentUid?: string    // null = root
  createdBy?: string
  updatedBy?: string
  created: number
  updated: number
  // Computed on response
  url?: string          // '/dashboards/f/<uid>'
  canEdit?: boolean
  canAdmin?: boolean
  canDelete?: boolean
  canSave?: boolean
  accessControl?: Record<string, boolean>  // per-action grants for current user
  parents?: Folder[]    // ancestor chain for breadcrumbs
}
```

### Hierarchy rules

- Max depth: **8** levels (match Grafana constant `folder.MaxNestedFolderDepth`).
- Cycle prevention: when moving a folder, verify the new parent is not a descendant.
- Root folders: `parent_uid IS NULL`.
- "General" folder concept (Grafana uses `uid='general'`): an openobs synthetic folder with `uid='general'`, always exists per org, not a real DB row; handled in service layer when returning permissions (it inherits org-level only).

### CRUD

```ts
interface IFolderService {
  create(orgId: string, input: { uid?: string; title: string; parentUid?: string }, userId: string): Promise<Folder>
  getByUid(orgId: string, uid: string): Promise<Folder | null>
  list(orgId: string, opts?: { parentUid?: string; query?: string; limit?: number }): Promise<Folder[]>
  update(orgId: string, uid: string, patch: { title?: string; description?: string; parentUid?: string }, userId: string): Promise<Folder>
  delete(orgId: string, uid: string, opts: { forceDeleteRules: boolean }): Promise<void>
  getParents(orgId: string, uid: string): Promise<Folder[]>
  getChildren(orgId: string, uid: string): Promise<Folder[]>
}
```

### Move semantics

Moving a folder to a new parent:
- Re-writes `parent_uid`.
- Descendants (dashboards, sub-folders) follow automatically — they only reference the parent via the folder's `parent_uid`.
- Permissions: existing permissions on the folder stay; the folder's permissions continue to cascade to descendants. Moving under a new parent doesn't add/remove permissions — permissions are additive across ancestors.

## Resource permission service (T7.2)

Generic service for (user|team|role) × action × scope grants. Mirrors `pkg/services/accesscontrol/resourcepermissions/service.go`.

```ts
interface IResourcePermissionService {
  list(orgId: string, resource: 'folders' | 'dashboards' | 'datasources' | 'alert.rules', uid: string): Promise<ResourcePermissionEntry[]>
  setUserPermission(orgId: string, resource: string, uid: string, userId: string, level: Permission | null): Promise<void>
  setTeamPermission(orgId: string, resource: string, uid: string, teamId: string, level: Permission | null): Promise<void>
  setBuiltInRolePermission(orgId: string, resource: string, uid: string, role: 'Admin' | 'Editor' | 'Viewer', level: Permission | null): Promise<void>
  // null level = remove the grant
}
```

Under the hood: each (resource, uid) has **one managed role** per principal. Grant level = Edit on resource X ⇒ a `role` row named e.g. `managed:users:<userId>:permissions` gets a `permission` row `(action='dashboards:write', scope='dashboards:uid:<uid>')`. Matches Grafana's managed-role pattern.

### Managed role naming

```
managed:users:<userId>:permissions       # for a user's resource permissions, one role per user
managed:teams:<teamId>:permissions       # for a team
managed:builtins:<role>:permissions      # for built-ins (Admin/Editor/Viewer)
```

All are org-scoped.

### list return shape

```ts
interface ResourcePermissionEntry {
  id: string                       // permission row id
  roleName: string                 // managed role name
  isManaged: boolean               // true for managed: prefix, false for regular roles
  isInherited: boolean             // true if from an ancestor folder
  inheritedFrom?: { type: 'folder'; uid: string; title: string }
  userId?: string
  userLogin?: string
  userEmail?: string
  teamId?: string
  teamName?: string
  builtInRole?: 'Admin' | 'Editor' | 'Viewer'
  permission: Permission           // highest level applicable
  actions: string[]                // all action strings this grants
}
```

Cascade resolution: when listing permissions for dashboard X:
- Start with direct permissions on X.
- Walk ancestor folders; add each ancestor's permissions with `isInherited=true`.
- Deduplicate by (principal, resource); keep the highest level.

## Dashboard permissions (T7.3)

Dashboards inherit permissions from their folder. Direct dashboard permissions override (in the sense of adding).

- Dashboards without a folder (root): permission derived from org role (Viewer can read, Editor can edit).
- Dashboards in a folder: inherit folder permissions unless dashboard itself has explicit permissions.
- Dashboards can have their own permissions beyond the folder's — additive.

### Evaluator for "can user X edit dashboard Y":

```
allowed if any of:
  - user is Server Admin
  - user has role granting `dashboards:write` on `dashboards:uid:Y`
  - user has role granting `dashboards:write` on `dashboards:*`
  - user has role granting `dashboards:write` on `folders:uid:<Y.folderUid>` (cascade)
  - user has role granting `dashboards:write` on `folders:uid:*`
```

Implemented via scope resolver that expands `dashboards:uid:Y` → `[dashboards:uid:Y, folders:uid:<parent>, folders:uid:<grandparent>, ..., folders:uid:*, dashboards:*]`. The evaluator then checks any match.

Match `pkg/services/accesscontrol/resolvers/folder.go`.

## Datasource permissions (T7.4)

Similar to dashboards but without folder cascade (datasources are flat).

Permission levels:
- **Query** (View semantically): `datasources:query` — can run queries through this datasource.
- **Edit**: `datasources:write` — can change config.
- **Admin**: `datasources.permissions:write` — can change permissions.

Legacy: `data_source_permissions` table (Grafana Enterprise). We use RBAC only — no legacy table.

## Alert rule permissions (T7.5)

Alert rules live in folders. Permissions cascade from the folder (same as dashboards).

Actions:
- `alert.rules:read`, `alert.rules:write`, `alert.rules:create`, `alert.rules:delete`

Scope: `folders:uid:<folder_uid>` cascades to rules within.

Notification policies (alertmanager) and contact points have separate action tree under `alert.notifications:*` and `alert.silences:*`. See action catalog in [03-rbac-model.md](03-rbac-model.md).

## Legacy dashboard_acl (T7.6)

Kept as a read-time source. When evaluating permissions for a dashboard, also query `dashboard_acl`:

```sql
SELECT permission FROM dashboard_acl
WHERE org_id = ? AND (dashboard_id = ? OR folder_id IN (ancestor folder ids))
  AND (user_id = ? OR team_id IN (user's teams) OR role = ?)
```

If any row returns `permission >= required_level`, allow.

Write path: `dashboard_acl` is **not** populated by new UI. Only preserved for:
- Old dashboards migrated from a Grafana export
- Tests verifying back-compat

Service method:
```ts
interface IDashboardAclService {
  getForDashboard(orgId: string, dashboardId: string): Promise<DashboardAclEntry[]>
  // No set/update methods — write path is RBAC only.
}
```

## API

See [08-api-surface.md](08-api-surface.md) §permissions. Summary:

### Folders
- `GET    /api/folders` — list root + direct children
- `POST   /api/folders` — create
- `GET    /api/folders/:uid`
- `PUT    /api/folders/:uid`
- `DELETE /api/folders/:uid?forceDeleteRules=true`
- `GET    /api/folders/:uid/permissions` — listPermissions
- `POST   /api/folders/:uid/permissions` — bulk update: `{ items: [{userId|teamId|role, permission}] }`

### Dashboards
- (existing CRUD) + `GET/POST /api/dashboards/uid/:uid/permissions`

### Datasources
- `GET    /api/datasources/:uid/permissions`
- `POST   /api/datasources/:uid/permissions`

### Alert rules
- `GET    /api/access-control/alert.rules/:folderUid/permissions`

## Frontend

See [09-frontend.md](09-frontend.md) §permissions-dialog.

Single reusable `<PermissionsDialog resource={kind} uid={uid}>` component for all four kinds. Shows:
- Inherited section (read-only) with "from Folder: X" labels
- Direct section (add/edit/remove)
- Add principal selector (user | team | built-in role)
- Level selector (View / Edit / Admin)

## Test scenarios (MUST be implemented)

1. Create folder, dashboard inside it. Grant team T "Edit" on folder. User in T can edit dashboard.
2. Grant user U "Edit" on dashboard directly. U can edit regardless of folder permissions.
3. Nested folders: grant at root folder → both sub-folder and grandchild dashboard inherit.
4. Move dashboard to new folder → permissions from new folder's ancestors apply; old folder's permissions no longer apply.
5. Remove folder permission → user who only had access via that folder loses access.
6. Built-in role grant: grant Viewer "Edit" on folder F → every Viewer-role user in org can edit F.
7. Higher direct permission overrides lower inherited: user has View from folder, Edit direct on dashboard → Edit wins.
8. Delete folder with `forceDeleteRules=false` and folder contains alert rules → 400.
9. Delete folder with `forceDeleteRules=true` → folder + all rules deleted.
10. Datasource: team with `datasources:query` on `datasources:uid:prom-prod` can run queries against that DS only.
11. Datasource: team without explicit grant but with Editor org role → query allowed per built-in Editor permissions (Editor has `datasources:query` on `datasources:*` via built-in role).
12. Legacy dashboard_acl row with team grants Edit → user in that team can edit dashboard. RBAC tables don't need matching grant.
13. Cycle prevention: move folder F under its own descendant → 400.
14. Max depth: 8-level-deep folder creation fine; 9-level → 400.

## File scope for T7 agents

- `packages/common/src/models/folder.ts`
- `packages/common/src/models/permission.ts`
- `packages/api-gateway/src/services/folder-service.ts`
- `packages/api-gateway/src/services/resource-permission-service.ts`
- `packages/api-gateway/src/services/dashboard-acl-service.ts`
- `packages/api-gateway/src/rbac/resolvers/folder.ts` — scope resolver
- `packages/api-gateway/src/routes/folders.ts`
- `packages/api-gateway/src/routes/dashboard-permissions.ts`
- `packages/api-gateway/src/routes/datasource-permissions.ts`
- `packages/data-layer/src/repositories/folder-repository.ts`
- `packages/data-layer/src/repositories/dashboard-acl-repository.ts`
- Migration 010, 011
- Update dashboards table to add `folder_uid` column
- Update alert_rules table to add `folder_uid` column
