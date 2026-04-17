# 08 — API Surface

**Applies to:** all backend tasks
**Grafana reference:** `pkg/api/` — [github](https://github.com/grafana/grafana/tree/v11.3.0/pkg/api)

Complete list of auth/permission-related endpoints. Every one must be implemented; every one must match Grafana's response shape. Divergence must be marked `[openobs-deviation]` with justification in the handler file.

## Conventions

- Base path: `/api/` (match Grafana).
- Auth: all endpoints require authentication unless listed in "Public" below.
- Org context: `X-Openobs-Org-Id` header or default org.
- Error response shape:
  ```json
  { "message": "...", "traceID": "..." }
  ```
- List endpoints paginate via `?perpage=<N>&page=<N>` (Grafana convention; page is 1-based).
- Successful responses use `200 OK` (reads) or `201 Created` (create) or `204 No Content` (delete without body).

## Public endpoints (no auth)

- `GET  /api/health` — liveness
- `GET  /api/healthz` — alternative
- `POST /api/login` — password login
- `GET  /api/login/:provider` — OAuth start (github/google/generic)
- `GET  /api/login/:provider/callback` — OAuth callback
- `POST /api/saml/acs` — SAML assertion
- `GET  /api/saml/metadata` — SP metadata
- `POST /api/user/password/send-reset-email` — forgot password
- `POST /api/user/password/reset` — reset via token

## `/api/login` (T2.3)

```
POST /api/login
Body: { "user": "<login or email>", "password": "..." }

200 { "message": "Logged in", "redirectUrl": "/..." }
Cookie: openobs_session=<token>; HttpOnly; Secure; SameSite=Lax

401 { "message": "invalid username or password" }
429 { "message": "too many login attempts" }
```

## `/api/logout`

```
POST /api/logout
-> revokes current session, clears cookie.

GET /api/logout  # used by browser navigation for SSO logout redirects
```

## `/api/user` — current user (T8.8)

```
GET /api/user
-> {
  "id":             "u_abc",
  "email":          "...",
  "login":          "...",
  "name":           "...",
  "theme":          "dark",
  "orgId":          "org_main",
  "isGrafanaAdmin": false,          // openobs: isServerAdmin — kept key name for Grafana-compat clients
  "orgs": [
    { "orgId": "org_main", "name": "Main", "role": "Admin" },
    ...
  ],
  "authLabels":     ["OAuth GitHub"],
  "isDisabled":     false,
  "isExternal":     false,
  "avatarUrl":      "..."
}
```

```
PUT /api/user
Body: { "name": "...", "email": "...", "login": "..." }
```

```
PUT /api/user/password
Body: { "oldPassword": "...", "newPassword": "..." }
```

```
GET  /api/user/preferences
PUT  /api/user/preferences
Body: { "homeDashboardUid": "...", "timezone": "browser", "theme": "light" }
```

```
GET /api/user/permissions            # replaces frontend ROLE_PERMISSIONS
-> { "dashboards:read": ["dashboards:*"], "folders:write": ["folders:uid:f1"], ... }
```

```
POST /api/user/using/:orgId          # switch default org
-> 200 { "message": "active organization changed" }
```

```
GET    /api/user/auth-tokens        # external login links (OAuth, SAML, LDAP)
DELETE /api/user/auth-tokens/:id    # unlink
GET    /api/user/tokens             # sessions (user_auth_token rows)
POST   /api/user/revoke-auth-token
Body: { "authTokenId": "..." }
```

```
POST   /api/user/quota              # TODO? Grafana exposes GET /api/user/quotas
GET    /api/user/quotas
```

## `/api/signup` — disabled by default

```
POST /api/signup
-> 403 unless openobs_allow_signup=true in config
```

Match Grafana.

## `/api/login/providers` (new)

```
GET /api/login/providers
-> [
  { "id": "local",   "name": "Username / password", "enabled": true },
  { "id": "github",  "name": "GitHub",              "enabled": true, "url": "/api/login/github" },
  { "id": "google",  "name": "Google",              "enabled": false },
  { "id": "generic", "name": "My OIDC IdP",         "enabled": true, "url": "/api/login/generic" },
  { "id": "saml",    "name": "SAML",                "enabled": false }
]
```

Used by frontend Login page to render provider buttons.

## `/api/orgs` (T4.1, server admin)

```
GET    /api/orgs?query=&perpage=&page=
POST   /api/orgs                       body: { name: "..." }
GET    /api/orgs/:id
GET    /api/orgs/name/:name
PUT    /api/orgs/:id                   body: { name, address1, ..., billingEmail }
DELETE /api/orgs/:id
```

```
GET    /api/orgs/:id/users?query=&perpage=&page=
POST   /api/orgs/:id/users             body: { loginOrEmail, role }
PATCH  /api/orgs/:id/users/:userId     body: { role }
DELETE /api/orgs/:id/users/:userId
```

## `/api/org` — current org (non-admin)

```
GET    /api/org
PUT    /api/org                        body: { name, address* }
GET    /api/org/users?query=&perpage=&page=
POST   /api/org/users                  body: { loginOrEmail, role }    # invite
PATCH  /api/org/users/:userId          body: { role }
DELETE /api/org/users/:userId
GET    /api/org/preferences
PUT    /api/org/preferences
```

## `/api/admin/*` — server admin

```
GET    /api/admin/users?query=&perpage=&page=&filter=
POST   /api/admin/users                # create local user
                                       # body: { name, login, email, password }
GET    /api/admin/users/:userId
PUT    /api/admin/users/:userId        # update name/email/login (server admin only)
DELETE /api/admin/users/:userId
POST   /api/admin/users/:userId/password            # force reset
POST   /api/admin/users/:userId/permissions         # toggle isServerAdmin
POST   /api/admin/users/:userId/disable
POST   /api/admin/users/:userId/enable
POST   /api/admin/users/:userId/logout              # revoke all sessions
GET    /api/admin/users/:userId/auth-tokens
POST   /api/admin/users/:userId/revoke-auth-token   body: { authTokenId }
POST   /api/admin/users/:userId/quotas              body: { target, limit }
GET    /api/admin/users/:userId/quotas
GET    /api/admin/stats
GET    /api/admin/settings                          # read runtime settings
POST   /api/admin/provisioning/reload/:what         # future; match grafana endpoint
```

## `/api/teams` (T5.1)

```
GET    /api/teams/search?query=&perpage=&page=
POST   /api/teams                      body: { name, email? }
GET    /api/teams/:id
PUT    /api/teams/:id                  body: { name, email? }
DELETE /api/teams/:id
GET    /api/teams/:id/members
POST   /api/teams/:id/members          body: { userId }
PUT    /api/teams/:id/members/:userId  body: { permission: 0|4 }
DELETE /api/teams/:id/members/:userId
GET    /api/teams/:id/preferences
PUT    /api/teams/:id/preferences
```

## `/api/serviceaccounts` (T6.1, T6.4)

```
GET    /api/serviceaccounts/search?query=&perpage=&page=&disabled=
POST   /api/serviceaccounts           body: { name, role, isDisabled? }
GET    /api/serviceaccounts/:id
PATCH  /api/serviceaccounts/:id       body: { name?, role?, isDisabled? }
DELETE /api/serviceaccounts/:id
GET    /api/serviceaccounts/:id/tokens
POST   /api/serviceaccounts/:id/tokens
Body: { name, secondsToLive? }
-> 201 { id, name, key }           # plaintext key, ONCE
DELETE /api/serviceaccounts/:id/tokens/:tokenId
POST   /api/serviceaccounts/migrate                    # bulk-migrate legacy
```

## `/api/auth/keys` — legacy API keys

```
GET    /api/auth/keys
POST   /api/auth/keys                  body: { name, role, secondsToLive? }
DELETE /api/auth/keys/:id
```

Match `pkg/api/apikey.go`. New code should use SA tokens, but this endpoint is kept for back-compat.

## `/api/access-control/*` (T3.2)

### Roles

```
GET    /api/access-control/roles?includeHidden=&delegatable=
POST   /api/access-control/roles                       body: Role JSON
GET    /api/access-control/roles/:roleUid
PUT    /api/access-control/roles/:roleUid              body: Role JSON, must match version
DELETE /api/access-control/roles/:roleUid
```

### Role assignments to users/teams

```
GET    /api/access-control/users/:userId/roles
POST   /api/access-control/users/:userId/roles        body: { roleUid, orgId, global? }
DELETE /api/access-control/users/:userId/roles/:roleUid
PUT    /api/access-control/users/:userId/roles       # bulk replace; body: { roleUids: [...] }

GET    /api/access-control/teams/:teamId/roles
POST   /api/access-control/teams/:teamId/roles       body: { roleUid }
DELETE /api/access-control/teams/:teamId/roles/:roleUid
PUT    /api/access-control/teams/:teamId/roles       # bulk replace
```

### User permissions inspect

```
GET /api/access-control/users/:userId/permissions     # full resolved perms for a user
GET /api/access-control/users/permissions/search      # bulk query
```

### Server-level

```
GET  /api/access-control/status         -> { enabled: true, rbacEnabled: true }
POST /api/access-control/seed           -> server admin only; re-runs built-in role seeding
```

## `/api/folders` (T7.1)

```
GET    /api/folders?parentUid=&limit=&page=
POST   /api/folders                                   body: { uid?, title, parentUid? }
GET    /api/folders/:uid
GET    /api/folders/:uid/counts                        # number of dashboards/subfolders
PUT    /api/folders/:uid                               body: { title?, description?, parentUid? }
DELETE /api/folders/:uid?forceDeleteRules=
GET    /api/folders/:uid/permissions
POST   /api/folders/:uid/permissions
Body: {
  items: [
    { userId?: string, teamId?: string, role?: 'Admin'|'Editor'|'Viewer', permission: 1|2|4 }
  ]
}
```

Match `pkg/api/folder.go`, `pkg/api/folder_permissions.go`.

## Dashboard permissions

```
GET /api/dashboards/uid/:uid/permissions
POST /api/dashboards/uid/:uid/permissions       body: same shape as folders
```

## Datasource permissions

```
GET /api/datasources/:uid/permissions
POST /api/datasources/:uid/permissions
```

## Alert rule permissions (via folder)

```
GET /api/access-control/alert.rules/:folderUid/permissions
POST /api/access-control/alert.rules/:folderUid/permissions
```

## `/api/audit-log` — server admin + `server.audit:read`

```
GET /api/audit-log?from=&to=&action=&actorId=&targetId=&outcome=&page=&perpage=
-> {
  items: AuditLogEntry[],
  total: number,
  page: number,
  perpage: number
}
```

## `/api/quota`

```
GET  /api/orgs/:orgId/quotas
PUT  /api/orgs/:orgId/quotas/:target        body: { limit: number }  # -1 = unlimited
GET  /api/user/quotas
POST /api/admin/users/:userId/quotas        body: { target, limit }
```

Quota targets: `users`, `dashboards`, `datasources`, `api_keys`, `service_accounts`, `alert_rules`, `folders`.

## Response DTO reference

For every entity, DTOs are in `packages/common/src/api/dtos/<entity>.ts`. Each matches Grafana's `pkg/api/dtos/*.go`. Rule: if Grafana returns field `isAdmin`, we return `isAdmin` (not `is_admin` or `server_admin`).

Example — `UserDTO`:

```ts
interface UserDTO {
  id: string
  email: string
  name: string
  login: string
  theme: string | ''
  orgId: string
  isGrafanaAdmin: boolean       // openobs sends this field for compat; semantically isServerAdmin
  isDisabled: boolean
  isExternal: boolean
  avatarUrl?: string
  authLabels: string[]
  createdAt: number
  updatedAt: number
  lastSeenAt?: number
  lastSeenAtAge?: string
  isExternallySynced?: boolean
}
```

## Status codes — match Grafana exactly

| Condition | Code | Grafana ref |
|---|---|---|
| Unauthenticated | 401 | `pkg/middleware/auth.go` |
| Authenticated but unauthorized | 403 | `pkg/middleware/middleware.go::Auth` |
| Resource not found | 404 | any handler |
| Validation error | 400 | all CRUD |
| Conflict (uniqueness, optimistic lock) | 409 | `pkg/api/errors.go` |
| Quota exceeded | 403 with `message=Quota exceeded` | Grafana uses 403; some new APIs use 429; match 403 |
| Internal error | 500 with a redacted message | `pkg/web/api_error.go` |

## Test scenarios per endpoint

For EVERY endpoint: at minimum one positive + one 403 (wrong permission) + one 404 (missing resource) test. No exceptions.

Integration test file layout: `packages/api-gateway/src/routes/__integration__/<feature>.test.ts`.
