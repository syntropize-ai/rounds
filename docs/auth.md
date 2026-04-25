# Security, Authentication & Authorization

This guide covers everything related to controlling who can do what in OpenObs — how identities work, how to wire up your SSO provider, how to scope permissions, and how to harden a production deployment.

## Quick recipes

Common tasks you'll do once and forget. Each one assumes you're logged in as an org admin.

### Add a read-only user limited to one folder

The user can view dashboards in `prod/` but nothing else.

1. Admin → Users → **Invite user** → enter email, role: `Viewer`.
2. Admin → Folders → click `prod/` → **Permissions** tab → **Add permission** → pick the user → level: `View` → Save.
3. Optional: revoke their default `Viewer` role on the org so they don't see the folder list elsewhere.

### Give the SRE team write access to a single folder

1. Admin → Teams → **+ New team** named `SRE` → add members.
2. Admin → Folders → click the target folder → **Permissions** → Add → pick team `SRE` → level: `Edit` → Save.

All dashboards and alert rules in that folder (and sub-folders) are now editable by SRE members. No per-dashboard grants needed.

### Issue a service account token for CI / automation

1. Admin → Service accounts → **+ New service account** → name `ci-bot`, role: `Viewer` (or whatever the script needs).
2. Click the SA → **Add token** → name it, optional expiry → **Generate**.
3. Copy the `openobs_sa_...` value — **shown exactly once**. Store it in your CI secret manager.
4. Use it: `curl -H "Authorization: Bearer openobs_sa_..." https://your-openobs/api/dashboards`.

### Restrict who can create alert rules

Default `Editor` role includes `alert.rules:create`. To narrow it:

1. Create a custom role `custom:alerts_disabled` with no alert permissions.
2. Or create `custom:alerts_only_in_dev` granting `alert.rules:create` scoped to `folders:uid:dev`.
3. Assign via Admin → Users → row → **Roles** → unassign `basic:editor`, assign your custom role.

### Force everyone to use SSO (disable local login)

Set in environment:

```sh
DISABLE_LOGIN_FORM=true
OAUTH_GOOGLE_CLIENT_ID=...      # or whichever provider
OAUTH_GOOGLE_CLIENT_SECRET=...
```

The login page will only show the SSO button. Existing local-password users keep their accounts but can't log in via password.

### Auto-assign new SSO users to an org

For Google / generic OIDC with `ALLOW_SIGN_UP=true`, new users join `org_main` as `Viewer` by default. To override:

```sh
OAUTH_GOOGLE_DEFAULT_ROLE=Editor
OAUTH_GOOGLE_DEFAULT_ORG_ID=org_main
```

Or use group-based mapping (LDAP / OIDC `groups` claim). See [LDAP](#ldap) for the example.

### Lock down an org-admin from accidentally deleting things

Org admins by default have `*:*` within their org. To remove destructive permissions while keeping management capability, build a custom role:

```sh
POST /api/access-control/roles
{
  "uid": "custom:org_admin_safe",
  "name": "custom:org_admin_safe",
  "displayName": "Org Admin (no delete)",
  "permissions": [
    { "action": "users:read", "scope": "users:*" },
    { "action": "users:write", "scope": "users:*" },
    { "action": "teams:read", "scope": "teams:*" },
    { "action": "teams:write", "scope": "teams:*" },
    { "action": "dashboards:read", "scope": "dashboards:*" },
    { "action": "dashboards:write", "scope": "dashboards:*" }
    /* note: no *:delete actions */
  ]
}
```

Assign it instead of `basic:admin`.

---

## Concepts at a glance

- **User** — a human identity. Has a login, email, password hash (if using
  local auth), and can be a member of one or more **organizations**.
- **Service account** — a non-human identity used by scripts, CI, scrapers.
  Lives in exactly one organization. Authenticates with API tokens.
- **Organization (org)** — tenancy boundary. All dashboards, folders,
  datasources, alert rules, investigations, teams belong to one org. Users
  and service accounts see only resources in their current org.
- **Team** — a named group of users within an org, used as a permission
  principal.
- **Role** — a named set of (action, scope) permissions. Three kinds:
  - **Built-in**: `basic:viewer`, `basic:editor`, `basic:admin`,
    `basic:server_admin`. Seeded automatically per org.
  - **Fixed**: narrow pre-defined bundles (e.g. `fixed:dashboards:reader`,
    `fixed:alert.rules:writer`). Seeded automatically.
  - **Custom**: operator-defined. Created via UI or API.
- **Server admin** (a.k.a. "Grafana admin" on the wire) — cross-org admin
  identity. Can create/delete orgs and manage any user. Does NOT
  automatically grant access to org-specific resources; server admin still
  needs org membership to read dashboards in that org.

## First-time bootstrap

openobs has two ways to create the first administrator:

### Option 1 — Setup wizard (recommended)

On a fresh install, visit `/` in the browser. If no users exist, openobs
auto-redirects to `/setup` and the wizard begins with the
**Create administrator** step. Fill in name, email, login, and password
(min 12 chars). After submit:

- The administrator user is created with `is_admin=1` (server admin).
- They are added to `org_main` as `Admin`.
- A session cookie is issued — you're logged in.

Subsequent visits to `/setup` skip the admin step if a user already exists.

### Option 2 — Environment variables (headless installs)

Set before first start:

```sh
export SEED_ADMIN=true
export SEED_ADMIN_EMAIL=admin@example.com
export SEED_ADMIN_LOGIN=admin
export SEED_ADMIN_PASSWORD='at-least-12-chars'
```

On boot, if the `user` table is empty and `SEED_ADMIN_PASSWORD` meets the
min-length requirement, openobs creates the user and prints
`seed admin created` to the log. Subsequent boots are no-ops.

## Authentication methods

openobs ships with five authentication clients. Each is independently
toggleable; multiple can be enabled at once. The **login page** renders one
button per enabled provider plus the local form (unless explicitly
disabled).

### Local password

- Endpoint: `POST /api/login` with `{ user, password }` (user = email or
  login).
- Hashing: `scrypt` (N=16384, r=8, p=1, dkLen=64). Salt + hash stored in
  `user.password` as `<salt_hex>:<hash_hex>`.
- Rate limit: 5 failed attempts per (ip + login) per 5 minutes. 6th
  attempt returns 429 with a `retry-after` hint.
- Disabled users and service-account logins both return 401 with the
  same message — we do not disclose *why* login failed.

### OAuth 2.0 — GitHub / Google / Generic OIDC

Environment variables per provider:

```sh
# GitHub
OAUTH_GITHUB_CLIENT_ID=...
OAUTH_GITHUB_CLIENT_SECRET=...
OAUTH_GITHUB_ALLOWED_ORGANIZATIONS=your-gh-org    # optional
OAUTH_GITHUB_ALLOW_SIGN_UP=true                   # optional
OAUTH_GITHUB_SYNC_TEAMS=false                     # optional

# Google
OAUTH_GOOGLE_CLIENT_ID=...
OAUTH_GOOGLE_CLIENT_SECRET=...
OAUTH_GOOGLE_ALLOWED_DOMAINS=example.com          # optional

# Generic OIDC (Okta, Auth0, Keycloak, …)
OAUTH_GENERIC_CLIENT_ID=...
OAUTH_GENERIC_CLIENT_SECRET=...
OAUTH_GENERIC_ISSUER_URL=https://idp.example.com  # for auto-discovery
OAUTH_GENERIC_SCOPES=openid email profile groups
OAUTH_GENERIC_EMAIL_ATTRIBUTE_NAME=email
```

Redirect URLs to register with the provider:
`https://<your-openobs>/api/login/github/callback`,
`/api/login/google/callback`, `/api/login/generic/callback`.

Identity flow:

1. User clicks "Sign in with GitHub" → `GET /api/login/github`.
2. State cookie set, browser redirected to GitHub's authorize URL.
3. GitHub redirects back with `code`. openobs validates state, exchanges
   code, fetches userinfo.
4. Lookup `user_auth WHERE auth_module='oauth_github' AND auth_id=<sub>`.
   If found, use the linked user. Otherwise: if email matches an existing
   user, auto-link; otherwise create (if `ALLOW_SIGN_UP=true`).
5. OAuth tokens (access/refresh/id) are encrypted with `SECRET_KEY`
   (AES-256-GCM) and stored in `user_auth`.
6. Session cookie issued; user redirected to `/` or `?redirect=<path>`.

### SAML

Configuration via environment:

```sh
SAML_ENABLED=true
SAML_ENTRY_POINT=https://idp.example.com/sso
SAML_ISSUER=openobs
SAML_CALLBACK_URL=https://openobs.example.com/api/saml/acs
SAML_IDP_CERT=/path/to/idp-cert.pem      # or inline PEM
SAML_PRIVATE_KEY=/path/to/sp-key.pem
SAML_WANT_ASSERTIONS_SIGNED=true
SAML_ATTRIBUTE_MAPPING_LOGIN=NameID
SAML_ATTRIBUTE_MAPPING_EMAIL=email
SAML_ATTRIBUTE_MAPPING_NAME=displayName
SAML_ATTRIBUTE_MAPPING_GROUPS=groups     # optional for team sync
```

Endpoints served:

- `GET /api/saml/metadata` — SP metadata XML (feed this to your IdP).
- `GET /api/saml/login` — initiates a login redirect to the IdP.
- `POST /api/saml/acs` — consumes the IdP's SAML response.
- `GET /api/saml/slo` / `POST /api/saml/slo/callback` — single logout.

### LDAP

Configuration file: `config/ldap.toml`:

```toml
[[servers]]
host = "ldap.example.com"
port = 389
use_ssl = false
start_tls = true
bind_dn = "cn=admin,dc=example,dc=com"
bind_password = "..."
search_base_dns = ["dc=example,dc=com"]
search_filter = "(cn=%s)"

[servers.attributes]
username = "cn"
email = "mail"
name = "displayName"
member_of = "memberOf"

[[servers.group_mappings]]
group_dn = "cn=admins,ou=groups,dc=example,dc=com"
org_id = "org_main"
org_role = "Admin"
grafana_admin = true

[[servers.group_mappings]]
group_dn = "cn=editors,ou=groups,dc=example,dc=com"
org_id = "org_main"
org_role = "Editor"
```

Enable with `OPENOBS_AUTH_LDAP_ENABLED=true` and mount the config file.

## Sessions

- Cookie: `openobs_session` (HttpOnly, Secure in production, SameSite=Lax).
- Server-side state: `user_auth_token` table. SHA-256 of the token is
  stored; plaintext is given to the client exactly once at login.
- **Max lifetime**: 30 days from creation.
- **Idle timeout**: 7 days since last request.
- **Rotation**: every 10 minutes of active use, a new token is issued. Old
  token stays valid for a 30-second grace window.
- **Revocation**: logout, password change, admin-forced revoke, or role
  change all invalidate existing sessions for that user.

All four windows are configurable via env vars:

```sh
SESSION_MAX_LIFETIME_MS=2592000000      # 30d
SESSION_IDLE_TIMEOUT_MS=604800000       # 7d
SESSION_ROTATION_INTERVAL_MS=600000     # 10min
SESSION_ROTATION_GRACE_MS=30000         # 30s
```

## Built-in roles — permission summary

Every org gets these four roles seeded automatically. Full permission
enumeration is in `packages/common/src/rbac/roles-def.ts`.

### `basic:viewer`

Read-only across the org:

- Dashboards: read
- Folders: read
- Datasources: query / explore
- Teams: read
- Annotations: read
- Alert rules: read
- Org preferences: read
- Investigations: read, chat: use

### `basic:editor`

Viewer + create/edit/delete content:

- Dashboards + folders: full CRUD (within scopes they're granted)
- Annotations: create, write, delete
- Alert rules: create, write, delete
- Alert silences: create, write
- Datasources: explore only (not write; that's admin)

### `basic:admin`

Editor + org administration:

- Users within org: read, write, add, remove
- Teams: full CRUD + team.permissions:write
- Service accounts: full CRUD + token lifecycle
- Roles: full CRUD (custom roles)
- Datasources: create, write, delete, permissions
- Folder permissions: read / write
- Dashboard permissions: read / write
- Alert.provisioning: read / write
- Org settings + preferences + quotas

### `basic:server_admin`

Every action on every scope — `*:*`. Includes cross-org actions:
create/delete orgs, server stats, manage any user.

**Note**: server admin does NOT automatically grant access to org-specific
resources. A server admin who is not a member of org X cannot read X's
dashboards without first being added to org X (with any org role).

## Fixed roles — narrow bundles

56 pre-seeded roles for fine-grained delegation. Some examples:

- `fixed:dashboards:reader` — read dashboards in org
- `fixed:dashboards:writer` — read + write + create + delete + permissions
- `fixed:folders:creator` — create folders (nothing else)
- `fixed:datasources:reader` — read datasource config
- `fixed:datasources:explorer` — query datasources (reader + query)
- `fixed:alert.rules:reader` / `:writer`
- `fixed:alert.silences:creator` — create silences only
- `fixed:users:reader` / `:writer`
- `fixed:teams:writer`
- `fixed:roles:reader` / `:writer`

The full list is in `packages/common/src/rbac/fixed-roles-def.ts`. You
assign fixed roles to users or teams via the Admin → Roles UI or the
`/api/access-control/*` API.

## Custom roles

Org Admins (and Server Admins for global custom roles) can create their
own roles via UI (Admin → Roles → Custom tab → + New custom role) or API:

```sh
POST /api/access-control/roles
{
  "uid": "custom:prod_monitor",
  "name": "custom:prod_monitor",
  "displayName": "Prod Monitor",
  "description": "Read everything in the prod folder, page oncall",
  "permissions": [
    { "action": "dashboards:read", "scope": "folders:uid:prod" },
    { "action": "alert.rules:read", "scope": "folders:uid:prod" },
    { "action": "alert.silences:create", "scope": "folders:uid:prod" }
  ]
}
```

Custom role names must start with `custom:`. Reserved prefixes (`basic:`,
`fixed:`, `managed:`) are rejected.

## Resource permissions (folders, dashboards, datasources, alert rules)

Per-resource access control on top of roles. You grant a **principal**
(user, team, or built-in role) one of three **levels** on a specific
resource:

- **View** (permission=1) — can read the resource.
- **Edit** (permission=2) — View + modify.
- **Admin** (permission=4) — Edit + manage permissions.

### Folder hierarchy + cascade

- Folders can nest up to 8 levels deep.
- Dashboards and alert rules inside a folder **inherit** the folder's
  permissions.
- Direct grants on a dashboard ADD to the inherited set (never subtract).
- Moving a folder moves its contents' effective permissions accordingly.

Example: grant team `SRE` Edit on folder `prod/`. Every dashboard inside
`prod/` (and any sub-folders) is editable by SRE team members, without
per-dashboard grants.

### Managed roles (how grants are stored)

Behind the scenes, each grant creates or updates one of:

- `managed:users:<uid>:permissions` — for user grants
- `managed:teams:<id>:permissions` — for team grants
- `managed:builtins:<role>:permissions` — for built-in role grants

These managed roles are invisible in the Roles UI but visible in
`/api/access-control/roles` when `includeHidden=true`.

### Legacy `dashboard_acl` table

For backward compatibility with Grafana exports, openobs reads the legacy
`dashboard_acl` table as a fallback during permission evaluation. Grants
recorded there still apply. Toggle off with
`LEGACY_ACL_ENABLED=false` after migrating all grants to the RBAC model.

## Service accounts and API tokens

Service accounts are non-human identities used by scripts. Create via
Admin → Service accounts → + New service account.

### Token format

- Service account tokens: `openobs_sa_<base64url-of-32-bytes>`
- Personal access tokens: `openobs_pat_<base64url-of-32-bytes>`

The `openobs_sa_` / `openobs_pat_` prefix is designed to be grep-able in
logs if a token ever leaks.

### Usage

```sh
curl -H "Authorization: Bearer openobs_sa_<token>" \
  https://openobs.example.com/api/dashboards
```

Or `X-Api-Key: <token>` for clients that don't speak Bearer.

### Lifecycle

- **Creation**: `POST /api/serviceaccounts/:id/tokens` returns the plaintext
  token **exactly once**. If you lose it, you must issue a new one — it is
  not recoverable.
- **Expiry**: Optional `secondsToLive` on issue. Expired tokens return 401.
- **Revocation**: `DELETE /api/serviceaccounts/:id/tokens/:tokenId` sets
  `is_revoked=1`. Subsequent requests with that token return 401.
- **Deletion of the SA**: hard-deletes all associated tokens.
- **Disable**: an SA with `is_disabled=1` cannot authenticate (its tokens
  are effectively frozen without deletion).

### Personal access tokens (PATs)

openobs also supports per-user PATs (openobs-extension — not a standard
Grafana concept). Users manage them via Profile → Access tokens. PATs
inherit the owning user's permissions — the SA pattern is preferred for
production, PATs are handy for CLI tools.

### Legacy `API_KEYS` env var

**Deprecated.** If you previously set `API_KEYS=<name>:<token>,...` in the
environment, migrate once via:

```sh
curl -b cookies.txt -X POST https://openobs.example.com/api/serviceaccounts/migrate
```

This creates one SA per legacy key and returns the mapping. After
migration, remove the env var. The migration endpoint is idempotent.

## Quotas

Per-org limits enforced on create. Defaults are unlimited; tighten via
env:

```sh
QUOTA_USERS_PER_ORG=50
QUOTA_SERVICE_ACCOUNTS_PER_ORG=10
QUOTA_API_KEYS_PER_SA=5
QUOTA_DASHBOARDS_PER_ORG=-1        # -1 = unlimited
QUOTA_DATASOURCES_PER_ORG=10
QUOTA_FOLDERS_PER_ORG=-1
QUOTA_ALERT_RULES_PER_ORG=-1
```

Per-org overrides via UI (Admin → Orgs → detail → Quotas) or API
(`PUT /api/orgs/:id/quotas/:target`). Violations return 403 with
`{ message: "Quota exceeded for <target>" }`.

## Audit log

Every auth-sensitive action records an entry:

- Login / logout / login_failed
- User created / updated / disabled / deleted / role_changed / password_changed
- Org / team / role / service account / API key lifecycle events
- Session revocations
- Permission grants and revokes (across all resource kinds)

Retention: configurable via `AUDIT_RETENTION_DAYS` (default 90). A daily
cron prunes older entries.

Query via Admin → Audit log or:

```
GET /api/admin/audit-log?from=&to=&action=&actorId=&outcome=&page=&perpage=
```

## Multi-org operations

Users can be members of multiple orgs. The **active org** for a request
is resolved in this order:

1. `X-Openobs-Org-Id: <orgId>` request header.
2. `?orgId=<orgId>` query parameter.
3. `user.org_id` (the user's default org).

Switch the active org via:

```
POST /api/user/using/:orgId
```

Which updates the user's default org. The frontend org switcher calls this,
then refetches `/api/user` and `/api/user/permissions`.

Resources (dashboards, investigations, alert rules, datasources, teams)
are strictly scoped to the active org — a user in org A cannot see org
B's resources via any endpoint unless they explicitly switch context.

## Server admin vs org admin

Two separate roles:

- **Server admin** (`user.is_admin=1`) — cross-org. Can create/delete orgs,
  manage users across orgs, access `/api/admin/*`, toggle user
  server-admin flag. Does not automatically see org-specific resources.
- **Org admin** (`org_user.role='Admin'`) — single-org. Can manage users,
  teams, service accounts, custom roles, quotas, and preferences within
  that org.

A user can be one, both, or neither. Most deployments have 1-2 server
admins and 1-2 org admins per org.

## Troubleshooting

### "invalid username or password" but the user exists

Check `user.is_disabled`. Disabled users get the same 401 so attackers
can't enumerate accounts. Re-enable via Admin → Users → row actions → Enable.

### "user is not a member of any org"

The authenticated user has no `org_user` row. Either add them manually:

```
POST /api/orgs/:id/users   { "loginOrEmail": "alice@example.com", "role": "Viewer" }
```

Or, if the user was synced via OAuth/SAML/LDAP, check the provider's
allow-signup setting and group mappings.

### Sessions keep expiring

Check `SESSION_IDLE_TIMEOUT_MS` — default is 7 days. Clients that don't
make a request within that window lose their session. The max lifetime
(30 days) is a hard cap regardless of activity.

### A role assignment seems ineffective

Remember the 3 filters, all must allow:

1. Agent (if the action is via chat): the agent type's `allowedTools` must
   include the tool.
2. Agent permission mode: `read_only` blocks writes regardless of RBAC.
3. RBAC: the user must have the action on the scope.

Use `GET /api/user/permissions` to dump the currently authenticated
principal's effective permissions.

### OAuth redirect loops / "state mismatch"

The `state` cookie is `SameSite=Lax` and short-lived. If your browser or
reverse proxy strips cookies across the redirect, state mismatch fires.
Common culprits: cookies blocked, `SESSION_COOKIE_SECURE` required but
serving over HTTP, or mismatched `<openobs-base-url>` vs registered
redirect URL.

## Production security checklist

Run through this list before exposing OpenObs to the public internet or production users.

### Transport & secrets

- [ ] **HTTPS only.** Terminate TLS at your Ingress / load balancer. Set `SESSION_COOKIE_SECURE=true` so the session cookie refuses HTTP.
- [ ] **Strong `JWT_SECRET`.** At least 32 characters of random data. Rotate by setting a new value and forcing a global session revoke (`POST /api/admin/users/:id/logout` per user, or restart with `INVALIDATE_ALL_SESSIONS_ON_BOOT=true` for a one-shot wipe).
- [ ] **Encrypt OAuth tokens at rest.** Set `SECRET_KEY` (32 bytes hex) before any user logs in via OAuth/SAML. OpenObs uses this key to AES-256-GCM the provider tokens stored in `user_auth`.
- [ ] **Database SSL.** If using Postgres, set `DATABASE_SSL=true` and verify CA. SQLite mode: ensure the data directory is on an encrypted volume.
- [ ] **Secrets in env, not config files.** Never commit `.env` files. Use Kubernetes secrets, AWS Secrets Manager, Vault, etc.

### Identity

- [ ] **Disable local login** if you have SSO: `DISABLE_LOGIN_FORM=true`.
- [ ] **Restrict SSO sign-up** to known domains/orgs:
  - GitHub: `OAUTH_GITHUB_ALLOWED_ORGANIZATIONS=your-org`
  - Google: `OAUTH_GOOGLE_ALLOWED_DOMAINS=yourcompany.com`
  - Generic OIDC: validate the `groups` or `email` claim via your IdP's policy.
- [ ] **No default sign-up** unless you trust everyone with email access: set `OAUTH_*_ALLOW_SIGN_UP=false` and pre-provision users.
- [ ] **Server admin count ≤ 2.** Server admins can create/delete orgs and any user. Audit periodically: `SELECT login, email FROM "user" WHERE is_admin=1`.

### Sessions

- [ ] **Tighten idle timeout** for high-sensitivity environments: `SESSION_IDLE_TIMEOUT_MS=3600000` (1h).
- [ ] **Enable session rotation** (default on). Confirm `SESSION_ROTATION_INTERVAL_MS` is set (default 10 min).
- [ ] **Force logout on disable.** OpenObs does this automatically — but verify by disabling a test account and confirming their session 401s on next request.

### Authorization

- [ ] **Audit `basic:admin` membership** quarterly. Org admins have `*:*` within the org — be deliberate about who holds it.
- [ ] **Use folder-scoped permissions** instead of global `Editor` where possible. Cuts blast radius of compromised accounts.
- [ ] **Minimum-privilege service accounts.** Each automation gets its own SA with only the actions it needs. Do not share tokens across scripts.
- [ ] **Set token expiry** when issuing SA / PAT tokens: `secondsToLive`. Never-expiring tokens should be rare and tracked.
- [ ] **Quotas per org.** Cap dashboards / users / SAs to detect runaway provisioning early.

### Network & API

- [ ] **`CORS_ORIGINS` set to your actual domain(s).** Empty / `*` allows any origin to call your API in a browser context. Set to `https://openobs.example.com`.
- [ ] **Rate-limit at the edge.** OpenObs has a built-in 5-attempt-per-5-min lockout on login. For everything else, put your CDN / WAF in front.
- [ ] **API keys via header, not query string.** Both work; the query-string form leaks into logs. Audit your reverse proxy logs to confirm tokens aren't being captured.

### Auditing

- [ ] **Audit log retention ≥ 90 days.** `AUDIT_RETENTION_DAYS=180` for regulated environments.
- [ ] **Forward audit log to SIEM.** OpenObs writes to `audit_log` table; tail and ship via your standard log pipeline. Look for `outcome=failure` spikes on `user.login`, `permission.granted`, `service_account.token_issued`.
- [ ] **Backup `audit_log` separately.** Keep it on append-only / immutable storage if compliance requires it.

### Incident response

- [ ] **Document the break-glass procedure.** What's the steps if the only org admin is locked out? (Server admin can re-add via Admin → Users → row → **Roles**.)
- [ ] **Document SA token revocation.** A leaked `openobs_sa_...` token: `DELETE /api/serviceaccounts/:id/tokens/:tokenId` then rotate dependent automations.
- [ ] **Test the audit log query** before you need it. Confirm you can filter by actor, action, time range, outcome.

---

## Further reading

- [API Reference](/api-reference) — complete endpoint reference for auth and authorization endpoints.
- [Configuration](/configuration) — every environment variable mentioned above.
