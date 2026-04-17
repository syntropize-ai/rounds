# 09 — Frontend

**Applies to:** T8.1–T8.8
**Grafana reference:**
- `public/app/features/admin/` — admin pages
- `public/app/features/org/` — org pages
- `public/app/features/serviceaccounts/` — SA pages
- `public/app/features/folders/permissions/` — permissions dialog
- `public/app/core/components/NavBar/` — nav + org switcher

## Pages inventory

Replace or extend these files in `packages/web/src`:

| Page/component | File | Task |
|---|---|---|
| Login | `pages/Login.tsx` | T8.1 |
| Admin (users) | `pages/Admin.tsx` → `pages/admin/Users.tsx` + subpages | T8.3 |
| Admin teams | `pages/admin/Teams.tsx` | T8.4 |
| Admin SAs | `pages/admin/ServiceAccounts.tsx` | T8.3 |
| Admin roles | `pages/admin/Roles.tsx` | T8.5 |
| Admin orgs (server admin) | `pages/admin/Orgs.tsx` | T8.6 |
| Audit log | `pages/admin/AuditLog.tsx` | T8.3 |
| User profile | `pages/Profile.tsx` (new) | T8.3 |
| Permissions dialog (reusable) | `components/permissions/PermissionsDialog.tsx` (new) | T8.7 |
| Org switcher | `components/OrgSwitcher.tsx` (new) | T8.2 |
| AuthContext refactor | `contexts/AuthContext.tsx` | T8.8 |

## T8.1 — Login page

### Provider selector

Fetch `/api/login/providers` on mount. Render:

```tsx
<div className="space-y-3">
  {providers.map(p => p.id === 'local' ? null : (
    <a key={p.id} href={p.url} className="button button-secondary w-full">
      Sign in with {p.name}
    </a>
  ))}
  {localProvider.enabled && (
    <>
      <Divider>or</Divider>
      <LocalPasswordForm />
    </>
  )}
</div>
```

### Local password form

```tsx
<form onSubmit={handleSubmit}>
  <Input name="user" placeholder="Email or username" required />
  <Input name="password" type="password" required />
  {error && <Alert variant="error">{error.message}</Alert>}
  <Button type="submit" loading={submitting}>Log in</Button>
  <Link to="/forgot-password">Forgot password?</Link>
</form>
```

On success: `/api/login` sets cookie, redirect to `?redirect=<path>` or `/`.

### Error handling

- 401 → "Invalid email/username or password" (do not disclose which)
- 429 → "Too many attempts. Try again in X minutes."
- 5xx → "Unable to log in right now."

## T8.2 — Org switcher

Placed in top nav bar (not sidebar — matches Grafana's top-left org dropdown).

```tsx
<OrgSwitcher>
  <OrgSwitcher.Trigger>
    <Icon name="organization" /> {currentOrg.name}
  </OrgSwitcher.Trigger>
  <OrgSwitcher.Menu>
    {user.orgs.map(org => (
      <OrgSwitcher.Item
        key={org.orgId}
        active={org.orgId === currentOrg.orgId}
        onClick={() => switchOrg(org.orgId)}
      >
        {org.name} <Badge>{org.role}</Badge>
      </OrgSwitcher.Item>
    ))}
    <Divider />
    {user.isServerAdmin && <Link to="/admin/orgs">Create organization</Link>}
  </OrgSwitcher.Menu>
</OrgSwitcher>
```

`switchOrg`:
1. `POST /api/user/using/:orgId`
2. Invalidate AuthContext caches (user, permissions).
3. Refetch `/api/user` and `/api/user/permissions`.
4. Reload current page (fresh data from new org).

Only show org switcher if `user.orgs.length > 1`.

## T8.3 — Admin Users

Layout:

```
┌──────────────────────────────────────────────┐
│ Tabs: [Users] [Teams] [Service Accounts] ... │
├──────────────────────────────────────────────┤
│ [Search] [+ New user]                        │
│ ┌────────────────────────────────────────┐   │
│ │ Login │ Email │ Auth │ Role │ Last seen │   │
│ │ alice │ ...   │ Local│ Admin│ 3 min ago │   │
│ │ bob   │ ...   │ GH   │ Edit │ 2 hr ago  │   │
│ └────────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

Row actions (dropdown):
- Edit
- Disable / Enable
- Reset password (sends reset email)
- Change org role
- Revoke all sessions
- View auth tokens
- Delete

Drawer/modal for user detail: profile, auth tokens, role assignments, permissions.

Fetches:
- `GET /api/org/users` for current org (default view)
- `GET /api/admin/users` for server-admin cross-org view (toggle)

Permission gates:
- Show page only if `users:read` in current org OR server admin
- Hide "New user" button if no `users:create`

## T8.3 — Admin Service Accounts

Same table layout as users but scoped to service accounts. Columns:
- Name, role, created, tokens (count), last-used, status.

Row actions:
- Manage tokens (drawer with token list + "Create token" button)
- Edit (name, role, disabled)
- Delete

Create token:
- Modal asks for name and expiry (never / 30d / 90d / 365d / custom).
- On submit, show **one-time plaintext token** with copy button.
- Warn: "Save it now. You won't see it again."

## T8.4 — Admin Teams

List:
- Name, members count, created, external (badge if synced).

Detail drawer:
- Members table with permission (Member/Admin) and remove button
- Add member picker (searches users in org)
- Role assignments tab (assign built-in or custom role)

External teams:
- Row edit disabled with tooltip "Managed via external sync"

## T8.5 — Admin Roles

List:
- Tabs for **Built-in**, **Fixed**, **Custom**
- Show name, version, description, # assigned

Custom role editor:
- Name, display name, description, group
- Permissions list with add-permission row: `(action, scope)` pair
- Used-by tab: shows users and teams assigned

## T8.6 — Admin Orgs (server admin only)

List:
- Name, created, user count

Actions:
- Create org (just name)
- Rename
- Delete (with confirm that shows cascade impact)

## T8.3 — Audit Log tab

```
┌──────────────────────────────────────────────────┐
│ [Filter: action] [actor] [outcome] [date range]  │
├──────────────────────────────────────────────────┤
│ Time       │ Actor │ Action        │ Target │ IP │
│ 10:23 AM   │ alice │ user.login    │        │ .. │
│ 10:21 AM   │ bob   │ user.login_f  │        │ .. │
│ ...                                              │
└──────────────────────────────────────────────────┘
```

Pagination: cursor-based (timestamp-based) or page-based; match Grafana.

Click row → drawer with full JSON of event metadata.

## T8.7 — Permissions dialog

File: `components/permissions/PermissionsDialog.tsx`.

Props:
```ts
interface Props {
  resource: 'folders' | 'dashboards' | 'datasources' | 'alert.rules'
  uid: string
  resourceName: string
  onClose: () => void
}
```

Layout:

```
┌────────────────────────────────────────────────┐
│ Permissions — <resourceName>                 × │
├────────────────────────────────────────────────┤
│ Inherited (from parent folders):               │
│ ┌────────────────────────────────────────────┐ │
│ │ Team: SRE        │ Edit  (from /Dashboards)│ │
│ │ User: alice@co   │ Admin (from /Engineering)│ │
│ └────────────────────────────────────────────┘ │
│                                                │
│ Direct:                                        │
│ [+ Add permission ▾]                           │
│ ┌────────────────────────────────────────────┐ │
│ │ Role: Viewer   │ View  │ [remove]          │ │
│ │ Team: Platform │ Edit  │ [remove]          │ │
│ └────────────────────────────────────────────┘ │
├────────────────────────────────────────────────┤
│                 [Cancel] [Save]                │
└────────────────────────────────────────────────┘
```

Add-permission flyout:
- Principal type: Role | User | Team
- Principal (user/team picker or role enum)
- Level: View / Edit / Admin

Submission: POST `/api/<resource>/:uid/permissions` with full items[] (not diff). Grafana's API is full-replace.

## T8.8 — AuthContext refactor

Current file: `packages/web/src/contexts/AuthContext.tsx`. Changes:

1. Remove `ROLE_PERMISSIONS` map.
2. After login success, fetch `/api/user` AND `/api/user/permissions`. Cache both.
3. `hasPermission(action, scope?)`:
   ```ts
   function hasPermission(action: string, scope?: string): boolean {
     const scopes = permissionsCache[action]
     if (!scopes) return false
     if (!scope) return scopes.length > 0
     return scopes.some(s => s === '' || s === scope || scopeCovers(s, scope))
   }
   ```
4. `scopeCovers` mirrors backend evaluator — supports wildcards. Shared helper in `packages/common/src/rbac/scope.ts`.

5. Expose:
   ```ts
   const { user, currentOrg, orgs, isServerAdmin, hasPermission, switchOrg, refresh } = useAuth()
   ```

6. On `switchOrg(orgId)`: POST /user/using/:orgId, refetch user+permissions, emit `AuthEvent.OrgSwitched`.

7. Permission events update cache (future: SSE from backend for role-change events; not P0).

### Component usage patterns

```tsx
// Hide if no perm
{hasPermission('dashboards:create', 'folders:uid:*') && <Button>New dashboard</Button>}

// Disable instead
<Button disabled={!hasPermission('dashboards:write', `dashboards:uid:${uid}`)}>
  Save
</Button>

// Route guard
<PermissionGate action="dashboards:read" fallback={<Forbidden />}>
  <DashboardPage />
</PermissionGate>
```

`<PermissionGate>` is a new helper component. Implementation: checks `useAuth().hasPermission`; on fail renders fallback (defaults to null).

## Navigation updates

- Keep existing sidebar structure.
- Add entries gated by permissions:
  - "Admin" link shows if `users:read` OR `orgs:read` (global).
  - "Audit Log" shows if `server.audit:read`.
- Org switcher (T8.2) goes in top bar, not sidebar.

Theme toggle (already added in previous feature) stays.

## Forms + validation

Use `react-hook-form` (already in project). For each form:
- Client-side validation mirrors Grafana's rules (min length, format).
- Server-side errors shown inline on the field (`email` error → `Email` field).

## Error / loading states

- Follow existing patterns in the codebase. No new design language.
- Permission-denied 403s from background fetches → silent (don't toast; UI element hides).
- Permission-denied 403s from user-initiated actions → toast "You don't have permission to X".

## Test scenarios (MUST be implemented — frontend)

1. Login with local password → redirect to `/`, user displayed in top nav.
2. Login with GitHub → redirect flow completes, user in nav.
3. Logout clears session, redirects to /login.
4. Org switch: from org A to org B → dashboards list refreshes with B's dashboards.
5. Viewer in org sees no "New dashboard" button.
6. Editor in org sees "New dashboard", can create.
7. Admin in org sees Admin link in nav; can access /admin.
8. Non-admin cannot access /admin (route guard).
9. Permissions dialog: add team as Editor → row appears → save → API called with correct payload.
10. Service account token creation: plaintext shown once, warning displayed, subsequent reload doesn't show plaintext.
11. Audit log: filter by actor → correct rows returned.
12. Light theme still applies on all new pages.

## File scope

- All new files under `packages/web/src/pages/admin/` and `packages/web/src/components/permissions/` and `packages/web/src/components/OrgSwitcher.tsx`
- Existing `pages/Admin.tsx` → thin wrapper that routes to tabs
- `pages/Login.tsx` — rewrite
- `contexts/AuthContext.tsx` — rewrite
- `api/client.ts` — extend for new endpoints (auth already cookie-based, no changes needed there)
- Any navigation component to add nav gating
