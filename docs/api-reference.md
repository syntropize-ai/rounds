# API Reference

Complete list of OpenObs authentication and authorization endpoints.

## Conventions

- Base path: `/api/`
- Auth: cookie-based (`openobs_session`) OR bearer token (`Authorization:
  Bearer openobs_sa_...` / `Authorization: Bearer openobs_pat_...`) OR
  `X-Api-Key: <token>` header.
- Org context: `X-Openobs-Org-Id: <orgUid>` header (optional; defaults to
  the user's default org).
- Errors: `{ "message": "<string>" }` with appropriate HTTP status.
- List pagination: `?perpage=<N>&page=<1-based>`. Responses include
  `{ totalCount, ...items }` or equivalent.

## Legend

| Symbol | Meaning |
|---|---|
| 🔓 | Public (no auth required) |
| 🍪 | Cookie session required |
| 🔑 | API key or cookie |
| ⭐ | Server admin only |
| 🏢 | Org admin only |
| 📝 | `requirePermission(...)` gate |

---

## Public / auth flow

### 🔓 `POST /api/login`

Local password login.

**Body**: `{ "user": "<email or login>", "password": "<string>" }`
**200**: `{ "message": "Logged in", "redirectUrl": "/..." }` + `Set-Cookie: openobs_session=...`
**401**: `{ "message": "invalid username or password" }`
**429**: `{ "message": "too many login attempts" }`

### 🔓 `GET /api/login/providers`

Lists enabled authentication methods.

**200**: `[{ "id": "local" | "github" | "google" | "generic" | "saml" | "ldap", "name": "...", "enabled": boolean, "url": "/api/login/<id>" }]`

### 🔓 `GET /api/login/:provider`

Initiates OAuth flow. Redirects to the provider's authorize URL.

### 🔓 `GET /api/login/:provider/callback?code=&state=`

OAuth callback. Exchanges code, creates/links user, issues session cookie,
redirects to root.

### 🔓 `GET /api/saml/metadata`

SP metadata XML for SAML IdP configuration.

### 🔓 `POST /api/saml/acs`

SAML assertion consumer. Validates signed response, creates/links user,
issues session, redirects.

### 🔓 `GET /api/saml/slo` / `POST /api/saml/slo/callback`

Single logout initiation + callback.

### 🍪 `POST /api/logout` / `GET /api/logout`

Revokes current session; clears cookie.

---

## Current user

### 🍪 `GET /api/user`

Returns the authenticated user profile + org list.

**200**:
```json
{
  "id": "u_abc",
  "email": "...",
  "login": "...",
  "name": "...",
  "theme": "dark" | "light",
  "orgId": "org_main",
  "isGrafanaAdmin": false,
  "orgs": [{ "orgId": "...", "name": "...", "role": "Admin" }],
  "authLabels": ["OAuth GitHub"],
  "isDisabled": false,
  "avatarUrl": "..."
}
```

### 🍪 `PUT /api/user`

Update own profile.

**Body**: `{ "name"?: string, "email"?: string, "login"?: string }`

### 🍪 `PUT /api/user/password`

Change password. Revokes all other sessions on success.

**Body**: `{ "oldPassword": string, "newPassword": string }`

### 🍪 `GET /api/user/preferences` / `PUT /api/user/preferences`

Get or update preferences.

**Body (PUT)**: `{ "homeDashboardUid"?: string, "timezone"?: string, "theme"?: "light" | "dark" | "" }`

### 🍪 `GET /api/user/permissions`

Returns the user's effective permissions in the current org.

**200**: `{ "dashboards:read": ["dashboards:*"], "folders:write": ["folders:uid:f1"], ... }`

### 🍪 `POST /api/user/using/:orgId`

Switch the user's default org.

**200**: `{ "message": "active organization changed" }`

### 🍪 `GET /api/user/auth-tokens` / `DELETE /api/user/auth-tokens/:id`

List / unlink external login links (OAuth, SAML, LDAP).

### 🍪 `GET /api/user/tokens`

List active sessions for the current user.

### 🍪 `POST /api/user/revoke-auth-token`

Revoke a specific session.

**Body**: `{ "authTokenId": string }`

### 🍪 `GET /api/user/access-tokens` / `POST /api/user/access-tokens` / `DELETE /api/user/access-tokens/:id`

Personal access token lifecycle.

**Body (POST)**: `{ "name": string, "secondsToLive"?: number }`
**201**: `{ "id": string, "name": string, "key": "openobs_pat_..." }` — plaintext returned ONCE.

---

## Organizations

### ⭐ `GET /api/orgs?query=&perpage=&page=`

List all orgs.

**200**: `{ "totalCount": N, "orgs": [{ "id", "name", "...": ... }] }`

### ⭐ `POST /api/orgs`

Create org. Seeds RBAC, adds creator as Admin.

**Body**: `{ "name": string }`
**201**: `{ "id": string, "name": string, ... }`

### 🏢 `GET /api/orgs/:id` / `GET /api/orgs/name/:name`

Get org by id or name.

### 🏢 `PUT /api/orgs/:id`

Update org name / address / billing email.

### ⭐ `DELETE /api/orgs/:id`

Delete org. Cascades to all org-scoped resources.

### 🏢 `GET /api/orgs/:id/users?query=&perpage=&page=`

List org members.

### 🏢 `POST /api/orgs/:id/users`

Add a user to an org.

**Body**: `{ "loginOrEmail": string, "role": "Admin" | "Editor" | "Viewer" | "None" }`

### 🏢 `PATCH /api/orgs/:id/users/:userId`

Change a user's role in an org.

**Body**: `{ "role": "Admin" | "Editor" | "Viewer" | "None" }`

### 🏢 `DELETE /api/orgs/:id/users/:userId`

Remove user from org.

---

## Current org (scoped by `X-Openobs-Org-Id` or user default)

### 🍪 `GET /api/org` / `PUT /api/org`

Get / update the active org.

### 🍪 `GET /api/org/users?query=&perpage=&page=`

List users in current org.

### 🍪 `POST /api/org/users`

Invite user to current org. Body same as `/api/orgs/:id/users`.

### 🍪 `PATCH /api/org/users/:userId` / `DELETE /api/org/users/:userId`

Update role / remove user in current org.

### 🍪 `GET /api/org/preferences` / `PUT /api/org/preferences`

Org preferences.

---

## Admin (server admin)

### ⭐ `GET /api/admin/users?query=&perpage=&page=&filter=`

List all users across all orgs.

### ⭐ `POST /api/admin/users`

Create a local user (any org).

**Body**: `{ "name": string, "login": string, "email": string, "password": string }`

### ⭐ `PATCH /api/admin/users/:userId`

Update user name / email / login.

### ⭐ `DELETE /api/admin/users/:userId`

Delete user.

### ⭐ `POST /api/admin/users/:userId/password`

Force password reset.

**Body**: `{ "password": string }`

### ⭐ `POST /api/admin/users/:userId/permissions`

Toggle server-admin flag.

**Body**: `{ "isGrafanaAdmin": boolean }`

### ⭐ `POST /api/admin/users/:userId/disable` / `/enable`

Enable/disable a user. Disabling revokes all active sessions.

### ⭐ `POST /api/admin/users/:userId/logout`

Revoke all of the user's sessions.

### ⭐ `GET /api/admin/users/:userId/auth-tokens` / `POST /api/admin/users/:userId/revoke-auth-token`

Inspect / revoke specific user sessions.

### ⭐ `GET /api/admin/audit-log?from=&to=&action=&actorId=&outcome=&page=&perpage=`

Query the audit log.

**200**: `{ totalCount, items: [AuditLogEntry] }`

### ⭐ `GET /api/admin/stats` / `GET /api/admin/settings`

Server stats and runtime settings.

---

## Teams

### 📝 `GET /api/teams/search?query=&perpage=&page=`

List teams in current org. Permission: `teams:read`.

### 📝 `POST /api/teams`

Create team. Permission: `teams:create`.

**Body**: `{ "name": string, "email"?: string }`

### 📝 `GET /api/teams/:id` / `PUT /api/teams/:id` / `DELETE /api/teams/:id`

Get / update / delete. Permissions: `teams:read` / `:write` / `:delete`
with scope `teams:id:<id>`.

### 📝 `GET /api/teams/:id/members` / `POST /api/teams/:id/members`

List / add members. POST body: `{ "userId": string }`.

### 📝 `PUT /api/teams/:id/members/:userId` / `DELETE /api/teams/:id/members/:userId`

Update (`permission`: 0=Member, 4=Admin) / remove.

### 📝 `GET /api/teams/:id/preferences` / `PUT /api/teams/:id/preferences`

Team preferences (home dashboard, timezone, theme).

---

## Service accounts

### 📝 `GET /api/serviceaccounts/search?query=&perpage=&page=&disabled=`

List SAs in current org.

### 📝 `POST /api/serviceaccounts`

Create SA. Permission: `serviceaccounts:create`.

**Body**: `{ "name": string, "role": "Admin" | "Editor" | "Viewer", "isDisabled"?: boolean }`
**201**: `{ "id": string, "name": string, "login": "sa-...", "role": "..." }`

### 📝 `GET /api/serviceaccounts/:id` / `PATCH /api/serviceaccounts/:id` / `DELETE /api/serviceaccounts/:id`

Get / update / delete.

### 📝 `GET /api/serviceaccounts/:id/tokens`

List SA's tokens (metadata only; never plaintext).

### 📝 `POST /api/serviceaccounts/:id/tokens`

Issue a new token.

**Body**: `{ "name": string, "secondsToLive"?: number }`
**201**: `{ "id": string, "name": string, "key": "openobs_sa_..." }` — plaintext returned ONCE.

### 📝 `DELETE /api/serviceaccounts/:id/tokens/:tokenId`

Revoke token.

### ⭐ `POST /api/serviceaccounts/migrate`

Bulk-migrate legacy `API_KEYS` env-var tokens to SAs. Idempotent.

---

## Legacy API keys (compat)

### 📝 `GET /api/auth/keys` / `POST /api/auth/keys` / `DELETE /api/auth/keys/:id`

Pre-SA-era API keys. New code should use service accounts instead. Thin
shim: POST auto-provisions a hidden "legacy-<name>" SA.

---

## Access control (RBAC)

### 📝 `GET /api/access-control/roles?includeHidden=&delegatable=`

List roles in current org + global.

### 📝 `POST /api/access-control/roles`

Create custom role. Permission: `roles:write`. Name MUST start with `custom:`.

**Body**:
```json
{
  "uid": "custom:prod_monitor",
  "name": "custom:prod_monitor",
  "displayName": "Prod Monitor",
  "description": "...",
  "groupName": "monitoring",
  "permissions": [{ "action": "dashboards:read", "scope": "folders:uid:prod" }]
}
```

### 📝 `GET /api/access-control/roles/:roleUid`

Get role details including permission list.

### 📝 `PUT /api/access-control/roles/:roleUid`

Update custom role. Requires version match; 409 on optimistic-lock fail.

### 📝 `DELETE /api/access-control/roles/:roleUid`

Delete custom role. Built-in / fixed / managed roles refuse delete.

### 📝 `GET /api/access-control/users/:userId/roles` / `POST /api/access-control/users/:userId/roles` / `DELETE /api/access-control/users/:userId/roles/:roleUid` / `PUT /api/access-control/users/:userId/roles`

Inspect / assign / unassign / bulk-replace roles for a user.

POST body: `{ "roleUid": string, "global"?: boolean }`
PUT body: `{ "roleUids": string[] }`

### 📝 `GET /api/access-control/teams/:teamId/roles` / same CRUD pattern

Role assignments for a team.

### 📝 `GET /api/access-control/users/:userId/permissions`

Inspect a specific user's resolved permissions (server admin).

### 🔓 `GET /api/access-control/status`

**200**: `{ "enabled": true, "rbacEnabled": true }`

### ⭐ `POST /api/access-control/seed`

Re-run built-in + fixed role seeding for the current org. Idempotent.

---

## Folders

### 📝 `GET /api/folders?parentUid=&limit=&page=`

List root folders or children of a parent.

### 📝 `POST /api/folders`

**Body**: `{ "uid"?: string, "title": string, "parentUid"?: string }`

### 📝 `GET /api/folders/:uid` / `GET /api/folders/:uid/counts`

Folder details; counts returns dashboard + subfolder counts.

### 📝 `PUT /api/folders/:uid`

**Body**: `{ "title"?: string, "description"?: string, "parentUid"?: string }`

Moving folders validated against cycle + max-depth=8.

### 📝 `DELETE /api/folders/:uid?forceDeleteRules=`

Delete folder. If it contains alert rules and `forceDeleteRules=false`,
returns 400.

### 📝 `GET /api/folders/:uid/permissions` / `POST /api/folders/:uid/permissions`

List / set (bulk replace) folder permissions.

**Body (POST)**:
```json
{
  "items": [
    { "userId": "...", "permission": 1 | 2 | 4 },
    { "teamId": "...", "permission": 2 },
    { "role": "Viewer", "permission": 1 }
  ]
}
```

---

## Dashboard permissions

### 📝 `GET /api/dashboards/uid/:uid/permissions` / `POST /api/dashboards/uid/:uid/permissions`

Same body shape as folder permissions. Response lists direct AND
inherited-from-folder grants.

---

## Datasource permissions

### 📝 `GET /api/datasources/:uid/permissions` / `POST /api/datasources/:uid/permissions`

No folder cascade — datasources are flat.

Actions mapped: View→`datasources:query`, Edit→`datasources:write`,
Admin→`datasources.permissions:write`.

---

## Alert rule permissions

### 📝 `GET /api/access-control/alert.rules/:folderUid/permissions` / `POST ...`

Alert rules inherit from folder, so permissions are folder-scoped.

---

## Setup / bootstrap

### 🔓 `GET /api/setup/config`

Current setup state.

### 🔓 `POST /api/setup/admin`

One-shot endpoint to create the first administrator. Returns 409 if any
user already exists.

**Body**: `{ "name": string, "login"?: string, "email": string, "password": string }`
**201**: `{ "userId": string, "orgId": "org_main" }` + session cookie.

### 🔓 `POST /api/setup/config`

Save platform settings (LLM, datasources, notifications).

### 🔓 `POST /api/setup/complete`

Mark setup as complete.

---

## Quotas

### 📝 `GET /api/orgs/:orgId/quotas` / `PUT /api/orgs/:orgId/quotas/:target`

Org-level quota management. `limit=-1` means unlimited.

**Quota targets**: `users`, `dashboards`, `datasources`, `api_keys`,
`service_accounts`, `alert_rules`, `folders`.

### 📝 `GET /api/user/quotas` / `POST /api/admin/users/:userId/quotas`

User-level quotas.

---

## Audit log entry shape

```ts
interface AuditLogEntry {
  id: string
  timestamp: string       // ISO-8601
  action: string          // e.g. "user.login", "team.member_added"
  actorType: "user" | "service_account" | "system"
  actorId: string | null
  actorName: string | null
  orgId: string | null
  targetType: string | null
  targetId: string | null
  targetName: string | null
  outcome: "success" | "failure"
  metadata: Record<string, unknown> | null
  ip: string | null
  userAgent: string | null
}
```

---

## Status codes

| Code | Meaning |
|---|---|
| 200 / 201 / 204 | Success |
| 400 | Validation error |
| 401 | Unauthenticated |
| 403 | Authorization failure (permission / quota / disabled) |
| 404 | Resource not found |
| 409 | Conflict (uniqueness, optimistic-lock, SA already exists) |
| 429 | Rate limit |
| 500 | Internal error (redacted message) |
| 501 | Not implemented (reserved — all endpoints above are implemented) |

---

## Token format cheatsheet

| Token | Format | Where to use |
|---|---|---|
| Session (cookie) | opaque, HttpOnly, 30d max | Browser-driven calls |
| SA token | `openobs_sa_<base64url>` | Bot / script calls |
| PAT | `openobs_pat_<base64url>` | CLI / personal scripts |

All three authenticate via `Authorization: Bearer <token>` OR `X-Api-Key: <token>`; session cookie is also accepted automatically when present.

---

## Related docs

- [Authentication](/auth) — operator guide for users, roles, OAuth, sessions, and troubleshooting.
