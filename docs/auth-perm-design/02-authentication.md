# 02 — Authentication

**Applies to:** T2.1–T2.7
**Grafana reference (mandatory reading):**
- `pkg/services/authn/` — overall authn service
- `pkg/services/authn/clients/` — one file per auth method
- `pkg/services/auth/authimpl/user_auth_token.go` — session tokens
- `pkg/services/login/` — legacy login, user_auth linking
- `pkg/services/ldap/` — LDAP
- `pkg/services/auth/jwt/` — JWT verification

## Identity model recap

An **identity** is the authenticated principal on a request. After authn middleware runs:

```ts
interface Identity {
  userId: string            // user.id or service account user.id
  orgId: string             // current org for this request
  orgRole: OrgRole          // 'Admin' | 'Editor' | 'Viewer' | 'None'
  isServerAdmin: boolean
  authenticatedBy: 'password' | 'oauth' | 'saml' | 'ldap' | 'api_key' | 'session'
  permissions?: ResolvedPermission[]  // populated by accesscontrol if needed
  sessionId?: string        // user_auth_token.id; NULL for api_key auth
  serviceAccountId?: string // NULL for human users
}
```

Middleware order on every authenticated route:
1. `authn` — turns request into `req.auth: Identity` or 401.
2. `orgContext` — resolves current org, validates membership, fills `req.auth.orgRole`.
3. `accesscontrol` — lazy loads permissions when a handler requires them.

## Session tokens (T2.2)

### Lifecycle

1. **Issue** — user logs in successfully. Server generates an opaque 32-byte token `T`, stores SHA-256(T) in `user_auth_token.auth_token`, returns T to client as HTTP-only, Secure, SameSite=Lax cookie `openobs_session`.
2. **Verify** — on each request, server reads cookie, hashes, looks up row. Row exists + `revoked_at IS NULL` + `created_at + max_lifetime > now` ⇒ valid.
3. **Rotate** — if `rotated_at + rotation_interval < now`, issue new token T', move current hash to `prev_auth_token`, store SHA-256(T') as `auth_token`, update `rotated_at`, set `Set-Cookie` on response.
4. **Grace window** — if client presents token matching `prev_auth_token`, accept for grace window (30s) — client might have concurrent requests that were in-flight during rotation.
5. **Revoke** — `UPDATE user_auth_token SET revoked_at = now() WHERE ...`. Subsequent lookups fail.

### Constants (match Grafana defaults)

```ts
export const SESSION_MAX_LIFETIME_MS       = 30 * 24 * 60 * 60 * 1000   // 30 days
export const SESSION_IDLE_TIMEOUT_MS       = 7  * 24 * 60 * 60 * 1000   // 7 days
export const SESSION_ROTATION_INTERVAL_MS  = 10 * 60 * 1000              // 10 min
export const SESSION_ROTATION_GRACE_MS     = 30 * 1000                   // 30 s
```

Configurable via env vars with same names.

### Cookie attributes

```
Set-Cookie: openobs_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<SESSION_IDLE_TIMEOUT_SEC>
```

In dev, `Secure` is dropped when serving over http://localhost.

### Service: `SessionService`

File: `packages/api-gateway/src/auth/session-service.ts`. Replaces in-memory `SessionStore`.

```ts
class SessionService {
  async create(userId: string, userAgent: string, clientIp: string): Promise<{ token: string; row: UserAuthToken }>
  async lookupByToken(rawToken: string): Promise<UserAuthToken | null>   // checks both auth_token & prev_auth_token
  async rotate(id: string): Promise<{ token: string; row: UserAuthToken }>
  async markSeen(id: string, at: number): Promise<void>                  // updates seen_at, auth_token_seen=1
  async revoke(id: string): Promise<void>
  async revokeAllForUser(userId: string): Promise<void>
  async pruneExpired(): Promise<number>                                   // cron job
}
```

Behavior mirrors `pkg/services/auth/authimpl/user_auth_token.go`:
- `LookupToken` → `lookupByToken`
- `TryRotateToken` → `rotate`
- `RevokeToken` → `revoke`
- `RevokeAllUserTokens` → `revokeAllForUser`

Invariant: `lookupByToken` returns null if row is revoked OR idle-timeout exceeded OR max-lifetime exceeded. Match Grafana's check order precisely (see `user_auth_token.go:188-210`).

## Local password provider (T2.3)

### Password hashing

Scrypt with parameters matching Grafana (`N=16384, r=8, p=1, dkLen=64`). Format stored: `"<salt_hex>:<hash_hex>"` in `user.password` column (Grafana uses distinct `password` and `salt` cols; we combine — already noted deviation in schema).

Ref: `pkg/services/login/authinfoimpl/store.go::HashPassword`.

### Login flow

```
POST /api/login
Content-Type: application/json
{ "user": "alice", "password": "..." }
```

1. Look up user by login (`findByLogin`) or email.
2. If user disabled or not found, return 401 with `{ message: "invalid username or password" }` (do NOT disclose which).
3. `timingSafeEqual(hash, scrypt(password, salt))`.
4. On success: create session, return cookie, respond with user DTO + default org.
5. Audit log: `user.login` success or failure.

Rate limit: 5 failed attempts per IP per 5 minutes → 429. `pkg/middleware/ratelimit` equivalent in our stack.

### Password rules (new)

- Min length: 12 (match Grafana env `GF_SECURITY_USER_PASSWORD_MIN_LENGTH`).
- No max length (bcrypt/scrypt truncation not an issue).
- No complexity rules by default (match Grafana).
- Admin-forced reset: on first login after admin sets password, user must change.

## OAuth providers (T2.4)

Files: `packages/api-gateway/src/auth/oauth/{github,google,generic}.ts`.

Flow per provider mirrors `pkg/services/authn/clients/oauth.go`:

1. `GET /api/login/{provider}` — generate `state` cookie, redirect to provider authorize URL.
2. Provider redirects to `GET /api/login/{provider}/callback?code=...&state=...`.
3. Validate `state` cookie matches.
4. Exchange `code` → `access_token`, `id_token`, `refresh_token`.
5. Fetch userinfo (`/user` for GitHub, `/userinfo` for OIDC, etc.).
6. Map provider fields → openobs user fields via `UserInfoMapping`:
   - `sub` / `id` → `user_auth.auth_id`
   - `email` → `user.email`
   - `name` or `login` → `user.name`, `user.login`
   - `groups` → synced teams (T5.2)
7. Look up existing identity: `user_auth WHERE auth_module=? AND auth_id=?`.
   - Found → use that user's id.
   - Not found → look up by email. If found, link (insert `user_auth` row). If not found, create user + `user_auth` row (only if allow-signup is enabled; configurable per provider).
8. Update `user_auth.o_auth_*` tokens (encrypted).
9. Create session, set cookie, redirect to `?redirect=<path>` or `/`.

### Per-provider quirks (match Grafana exactly)

- **GitHub**: `/user/emails` returns array; take primary verified. GitHub `id` is numeric; store as string.
- **Google**: OIDC standard. `email_verified` must be true; otherwise deny.
- **Generic OIDC**: configurable auth URL, token URL, userinfo URL, scopes. Mirror `pkg/services/authn/clients/oauth_generic.go`.

### Team sync via groups claim

If provider returns `groups` in ID token or userinfo, and `team_sync.enabled` is true for that provider:
- For each group, look up team by `team.external=1 AND team.name=<mapped_name>`.
- Add `team_member` row if missing, remove stale memberships (full replace).

Detailed spec in [05-teams.md](05-teams.md) §external-sync.

## SAML (T2.7)

Provider: `packages/api-gateway/src/auth/saml/`. Uses `samlify` or `@node-saml/node-saml` (pick one — same-tier libraries).

Mirror `pkg/services/authn/clients/saml.go` conceptually:

1. `GET /api/saml/metadata` — serve IdP-consumable SP metadata XML.
2. `POST /api/saml/acs` — Assertion Consumer Service; IdP POSTs SAMLResponse here.
3. `GET /api/saml/slo` — Single Logout service.

Configuration in `config/saml.json`:
- `idp.metadata_url` or `idp.metadata_xml`
- `sp.certificate`, `sp.private_key`
- `assertion.name_id_format`
- `attribute_mapping.{login,email,name,groups}`

SAML response validation (signed, not expired, correct audience) MUST happen before any downstream processing. Use library-provided validator, don't roll our own.

## LDAP (T2.6)

Provider: `packages/api-gateway/src/auth/ldap/`.

Single LDAP config file `config/ldap.toml` (match Grafana's schema — see `conf/ldap.toml` in Grafana repo).

Flow on login:
1. User submits `{user, password}` to `/api/login` with `auth_method=ldap` hint or LDAP is primary.
2. LDAP client binds as admin, searches for user by `search_filter`.
3. Rebinds as the user's DN with submitted password. Success = authenticated.
4. Map attributes per `[[servers.attributes]]` config (`username`, `email`, `name`, `member_of`).
5. Resolve groups → teams: `[[servers.group_mappings]]` maps `group_dn` → `org_id`, `org_role`, or `grafana_admin` flag.
6. Upsert user, set org memberships and teams per mapping.
7. Issue session.

Library: `ldapjs`.

## `user_auth` linking

Whenever a user authenticates via an external method, a row exists in `user_auth` linking them. This is the source of truth for "which external account does this user have."

Rules:
- One user can have multiple rows (github + google + saml at once).
- Unique constraint `(auth_module, auth_id)` prevents two users claiming the same external identity.
- Deleting a user cascade-deletes `user_auth` rows (FK).
- OAuth tokens (`o_auth_access_token`, etc.) stored encrypted, rotated on refresh.

API (exposed for user profile UI):
```
GET /api/user/auth-tokens           # list external logins linked to current user
DELETE /api/user/auth-tokens/:id   # unlink (requires local password to still be valid, or another auth method)
```

## Audit writer (T2.5)

File: `packages/api-gateway/src/auth/audit-writer.ts`. Writes to `audit_log` table.

```ts
class AuditWriter {
  async log(entry: AuditLogEntry): Promise<void>
}

interface AuditLogEntry {
  action: string                    // 'user.login' | 'user.role_changed' | ...
  actorType: 'user' | 'service_account' | 'system'
  actorId?: string
  actorName?: string
  orgId?: string
  targetType?: string
  targetId?: string
  targetName?: string
  outcome: 'success' | 'failure'
  metadata?: Record<string, unknown>
  ip?: string
  userAgent?: string
}
```

Called from:
- login handler (both success and failure)
- logout
- admin user/team/role changes
- permission grant/revoke
- session revocation
- service account token issued/revoked

Audit rows never block the primary operation — writes are fire-and-forget with error logging. If the audit table is down, the action still succeeds.

### Audit action vocabulary (must be finite)

Enumeration in `packages/common/src/audit/actions.ts`. Examples:

- `user.login`, `user.logout`, `user.login_failed`
- `user.created`, `user.updated`, `user.disabled`, `user.enabled`, `user.deleted`
- `user.role_changed`, `user.password_changed`
- `user_auth.linked`, `user_auth.unlinked`
- `session.revoked`, `session.rotated`
- `org.created`, `org.updated`, `org.deleted`
- `org.user_added`, `org.user_removed`, `org.user_role_changed`
- `team.created`, `team.updated`, `team.deleted`
- `team.member_added`, `team.member_removed`
- `role.created`, `role.updated`, `role.deleted`
- `role.user_assigned`, `role.user_unassigned`
- `role.team_assigned`, `role.team_unassigned`
- `serviceaccount.created`, `serviceaccount.deleted`, `serviceaccount.token_created`, `serviceaccount.token_revoked`
- `apikey.created`, `apikey.revoked`, `apikey.used` (rate-limited, not on every request)
- `permission.granted`, `permission.revoked` (per dashboard/folder/ds)

**Not** audited: read operations. Grafana audits writes and auth events; parity there.

## Retry semantics

- Failed password login does NOT rotate the session cookie if the user was previously logged in (attacker can't degrade your session by trying bad passwords).
- Successful login on already-authenticated user creates a new session alongside the old one (old continues until explicitly logged out or expired).
- Logout revokes only the current session; `logoutAll` revokes every session for the user.

Match `pkg/services/authn/authnimpl/authn_impl.go` for the exact interleaving.

## Frontend integration

`AuthContext` refactor (T8.8):
- No more `ROLE_PERMISSIONS` map.
- After login → `/api/user` returns user + orgs + current orgRole + permissions.
- `hasPermission(action, scope?)` uses cached permissions.
- Permission cache invalidates on org switch, logout, role change event.

Login page changes (T8.1):
- Show enabled providers as buttons (fetched from `/api/login/providers`).
- Local username+password form always visible unless explicitly disabled.
- On submit, POST to `/api/login`, receive cookie + user DTO, navigate to `redirect` param or `/`.

## Test scenarios (MUST be implemented)

1. Login with correct password → session cookie set, `/api/user` returns user.
2. Login with wrong password → 401, no cookie, rate-limit counter increments.
3. Login to disabled user → 401.
4. Session rotates after `SESSION_ROTATION_INTERVAL_MS`, old token still accepted within grace window, rejected after.
5. Session revoked on password change (`revokeAllForUser`).
6. Session revoked when user's role changes via admin.
7. OAuth GitHub first-login creates user + user_auth row.
8. OAuth GitHub subsequent login finds existing user_auth, issues session for same user.
9. OAuth email collision: email already registered locally → link instead of creating duplicate (if `auto_link` enabled).
10. SAML ACS with valid signed response → session issued.
11. SAML ACS with expired assertion → 401.
12. LDAP login happy path with group → user in mapped teams.
13. Logout current session only.
14. Logout all sessions: admin disables user → all sessions gone.
15. Concurrent logins from two browsers — both sessions valid independently.
16. Audit log: each flow above produces exactly one expected `audit_log` row with correct `action`, `outcome`.

## File scope for T2 agents

- `packages/api-gateway/src/auth/auth-manager.ts` — refactor
- `packages/api-gateway/src/auth/session-service.ts` — new
- `packages/api-gateway/src/auth/local-provider.ts` — refactor
- `packages/api-gateway/src/auth/oauth/*.ts` — new dir
- `packages/api-gateway/src/auth/saml/*.ts` — new dir
- `packages/api-gateway/src/auth/ldap/*.ts` — new dir
- `packages/api-gateway/src/auth/audit-writer.ts` — new
- `packages/api-gateway/src/middleware/auth.ts` — rewrite
- `packages/api-gateway/src/middleware/org-context.ts` — new
- `packages/api-gateway/src/routes/auth.ts` — refactor per endpoints in [08-api-surface.md](08-api-surface.md)
- `packages/common/src/auth/*.ts` — shared types (Identity, Session, Audit)

Agents MUST NOT touch dashboard/investigation/alert handlers during T2. Org-scoping those is T4.4.
