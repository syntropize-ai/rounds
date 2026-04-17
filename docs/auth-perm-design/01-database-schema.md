# 01 — Database Schema

**Applies to:** T1.1, T1.2, T1.3 (Phase 1 foundation)
**Grafana reference (mandatory reading):** `pkg/services/sqlstore/migrations/` — [github v11.3.0](https://github.com/grafana/grafana/tree/v11.3.0/pkg/services/sqlstore/migrations)

## Storage backend

openobs uses **SQLite** via `better-sqlite3` (already in use at `packages/data-layer/`). Migrations are applied at startup in a versioned sequence.

Grafana supports SQLite, PostgreSQL, and MySQL. We target SQLite-only for now but write SQL that's DDL-portable (no SQLite-specific features beyond `AUTOINCREMENT` and `INTEGER PRIMARY KEY` for rowid aliasing). Column types use the set `INTEGER`, `TEXT`, `BLOB`, `REAL`; booleans are `INTEGER 0/1`; timestamps are `INTEGER` epoch millis (Grafana uses `TIMESTAMP`, we differ — see "Types" below).

### Types — openobs conventions vs Grafana

| Concept | Grafana | openobs | Rationale |
|---|---|---|---|
| Primary key | `BIGSERIAL` int64 | `TEXT` (uuid v4) | Existing openobs convention across all repos. `[openobs-deviation]` |
| Timestamps | `TIMESTAMP` | `INTEGER` epoch ms | Existing openobs convention. `[openobs-deviation]` |
| Booleans | `BOOLEAN` | `INTEGER 0/1` | SQLite has no native bool. |
| Text | `VARCHAR(N)` | `TEXT` (unbounded) | SQLite ignores length anyway. |

Every other aspect (column names, semantics, indexes, FKs, unique constraints) must match Grafana.

## Table list

All tables new to openobs. Grafana's migrations for reference:

1. [`user`](#user) — human identity + service accounts
2. [`user_auth`](#user_auth) — external identity links (OAuth/SAML/LDAP)
3. [`user_auth_token`](#user_auth_token) — session tokens with rotation
4. [`org`](#org) — organizations (renamed from "workspace")
5. [`org_user`](#org_user) — org membership + org role
6. [`team`](#team)
7. [`team_member`](#team_member)
8. [`api_key`](#api_key) — service account tokens + personal access tokens
9. [`role`](#role) — built-in + custom roles
10. [`permission`](#permission) — action × scope rows attached to roles
11. [`builtin_role`](#builtin_role) — maps Admin/Editor/Viewer built-ins to role_id
12. [`user_role`](#user_role) — role assignment to user (for fine-grained assignments beyond org role)
13. [`team_role`](#team_role) — role assignment to team
14. [`folder`](#folder) — hierarchical folders
15. [`dashboard_acl`](#dashboard_acl) — legacy dashboard/folder ACL (kept for Grafana compat)
16. [`audit_log`](#audit_log) — persistent audit events
17. [`quota`](#quota) — per-org / per-user limits
18. [`preferences`](#preferences) — user/org/team preferences (theme, home dashboard, org)

Existing openobs tables gain `org_id TEXT NOT NULL`:
- `dashboards`, `investigations`, `alert_rules`, `datasources`, `chat_sessions`, `chat_session_events`, `approvals`, and any other resource tables.

---

## `user`

Grafana ref: `pkg/services/sqlstore/migrations/user_mig.go:addUserV1+V2` and `pkg/services/user/model.go`.

```sql
CREATE TABLE user (
  id                    TEXT PRIMARY KEY,
  version               INTEGER NOT NULL DEFAULT 0,
  email                 TEXT NOT NULL,
  name                  TEXT NOT NULL,
  login                 TEXT NOT NULL,
  password              TEXT NULL,              -- scrypt hash: "salt:hash"
  salt                  TEXT NULL,              -- kept separate per grafana, even though we store it in `password`; see below
  rands                 TEXT NULL,              -- used by grafana for session cookie; we don't use but keep column for parity
  company               TEXT NULL,
  org_id                TEXT NOT NULL,          -- default / current org
  is_admin              INTEGER NOT NULL DEFAULT 0,   -- is_server_admin, named is_admin per grafana
  email_verified        INTEGER NOT NULL DEFAULT 0,
  theme                 TEXT NULL,              -- 'light' | 'dark' | ''
  help_flags1           INTEGER NOT NULL DEFAULT 0,
  is_disabled           INTEGER NOT NULL DEFAULT 0,
  is_service_account    INTEGER NOT NULL DEFAULT 0,
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  last_seen_at          INTEGER NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX ux_user_login ON user(login);
CREATE UNIQUE INDEX ux_user_email ON user(email);
CREATE INDEX ix_user_org_id ON user(org_id);
CREATE INDEX ix_user_is_service_account ON user(is_service_account);
```

**Notes:**
- `login` is the unique identifier operators type into login form. For service accounts, it's `sa-<slug>`.
- `salt` column: Grafana stores salt separately; our scrypt format embeds salt. Column is present but unused. `[openobs-deviation]` — tolerate because dropping would diverge from ORM shape.
- `is_admin`: keep Grafana's name. Maps to "server admin" conceptually.
- Service accounts are rows in this table with `is_service_account=1`. Same FKs, same queries — the boolean gates behavior.
- `version` increments on every update (Grafana optimistic-locking pattern).

---

## `user_auth`

Grafana ref: `pkg/services/sqlstore/migrations/user_auth_mig.go`, `pkg/services/login/model.go`.

Links one user to N external identities. Enables "my google account and my github account resolve to the same user".

```sql
CREATE TABLE user_auth (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  auth_module           TEXT NOT NULL,         -- 'oauth_github' | 'oauth_google' | 'oauth_generic' | 'saml' | 'ldap'
  auth_id               TEXT NOT NULL,         -- external subject (e.g., github numeric id, oidc sub)
  created               INTEGER NOT NULL,
  o_auth_access_token   TEXT NULL,             -- encrypted with server secret
  o_auth_refresh_token  TEXT NULL,             -- encrypted
  o_auth_token_type     TEXT NULL,
  o_auth_expiry         INTEGER NULL,          -- epoch ms
  o_auth_id_token       TEXT NULL,             -- encrypted
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_user_auth_module_authid ON user_auth(auth_module, auth_id);
CREATE INDEX ix_user_auth_user_id ON user_auth(user_id);
```

**Notes:**
- `auth_module` uses the Grafana vocabulary exactly (`oauth_github` not `github_oauth`).
- OAuth tokens are encrypted at rest via `crypto.AES-256-GCM` with key from `SECRET_KEY` env var. Helper: `packages/common/src/crypto/secret-box.ts` (new).

---

## `user_auth_token`

Grafana ref: `pkg/services/sqlstore/migrations/user_auth_token_mig.go`, `pkg/services/auth/authimpl/user_auth_token.go`.

Server-side session record. Replaces current in-memory `SessionStore`.

```sql
CREATE TABLE user_auth_token (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  auth_token            TEXT NOT NULL,         -- SHA-256 hex of the unhashed opaque token
  prev_auth_token       TEXT NOT NULL,         -- previous hashed token after rotation; used for one-rotation grace window
  user_agent            TEXT NOT NULL,
  client_ip             TEXT NOT NULL,
  auth_token_seen       INTEGER NOT NULL DEFAULT 0, -- 1 once client used this token at least once
  seen_at               INTEGER NULL,          -- last-seen epoch ms
  rotated_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  revoked_at            INTEGER NULL,          -- soft-revoked (kept for audit)
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_user_auth_token_authtoken ON user_auth_token(auth_token);
CREATE INDEX ix_user_auth_token_user_id ON user_auth_token(user_id);
CREATE INDEX ix_user_auth_token_revoked_at ON user_auth_token(revoked_at);
```

**Notes:**
- Tokens are **never stored unhashed**. Client gets the plaintext once at login; we store SHA-256.
- Rotation: on every request that's in the last N seconds of token lifetime, issue a new token. Old hashed-token moves to `prev_auth_token` and stays valid for a grace window. See `02-authentication.md` §session-rotation.
- `revoked_at IS NULL` = active. Lookups always filter `WHERE revoked_at IS NULL`.

---

## `org`

Grafana ref: `pkg/services/sqlstore/migrations/org_mig.go`, `pkg/services/org/model.go`.

```sql
CREATE TABLE org (
  id                    TEXT PRIMARY KEY,
  version               INTEGER NOT NULL DEFAULT 0,
  name                  TEXT NOT NULL,
  address1              TEXT NULL,
  address2              TEXT NULL,
  city                  TEXT NULL,
  state                 TEXT NULL,
  zip_code              TEXT NULL,
  country               TEXT NULL,
  billing_email         TEXT NULL,
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_org_name ON org(name);
```

**Notes:**
- Address fields are present per Grafana even though the current product doesn't use them in UI. They're part of the data model and some API responses expose them.
- Default org `id = 'org_main'` (the singleton org created at bootstrap). Further orgs are new UUIDs.

---

## `org_user`

Grafana ref: `pkg/services/sqlstore/migrations/org_user_mig.go`, `pkg/services/org/model.go::OrgUser`.

```sql
CREATE TABLE org_user (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  role                  TEXT NOT NULL,          -- 'Admin' | 'Editor' | 'Viewer' | 'None'
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  FOREIGN KEY (org_id)  REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_org_user_org_user ON org_user(org_id, user_id);
CREATE INDEX ix_org_user_user_id ON org_user(user_id);
```

**Notes:**
- `role` enum values are **exactly** `Admin`, `Editor`, `Viewer`, `None` (PascalCase strings). Match Grafana's `RoleType` in `pkg/models/roles.go`.
- A user may be member of multiple orgs with different roles.

---

## `team`

Grafana ref: `pkg/services/sqlstore/migrations/team_mig.go`, `pkg/services/team/model.go`.

```sql
CREATE TABLE team (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  name                  TEXT NOT NULL,
  email                 TEXT NULL,
  external              INTEGER NOT NULL DEFAULT 0,   -- 1 if synced from LDAP/OIDC group
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_team_org_name ON team(org_id, name);
CREATE INDEX ix_team_org_id ON team(org_id);
```

---

## `team_member`

Grafana ref: same dir as above, `team_member_mig.go`.

```sql
CREATE TABLE team_member (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  team_id               TEXT NOT NULL,
  user_id               TEXT NOT NULL,
  external              INTEGER NOT NULL DEFAULT 0,
  permission            INTEGER NOT NULL DEFAULT 0,   -- 0=Member, 4=Admin (team admin)
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  FOREIGN KEY (org_id)  REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_team_member_team_user ON team_member(team_id, user_id);
CREATE INDEX ix_team_member_user_id ON team_member(user_id);
CREATE INDEX ix_team_member_org_id ON team_member(org_id);
```

**Note on `permission`:** integer-encoded in Grafana — `0` = Member, `4` = Admin (team admin, can edit team membership). We preserve the encoding.

---

## `api_key`

Grafana ref: `pkg/services/sqlstore/migrations/apikey_mig.go`, `pkg/services/apikey/model.go`.

```sql
CREATE TABLE api_key (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  name                  TEXT NOT NULL,
  key                   TEXT NOT NULL,          -- SHA-256 hex of token (NEVER plaintext)
  role                  TEXT NOT NULL,          -- 'Admin' | 'Editor' | 'Viewer' — mirrors org role
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  last_used_at          INTEGER NULL,
  expires               INTEGER NULL,           -- epoch ms; NULL = no expiry
  service_account_id    TEXT NULL,              -- FK to user(id) where is_service_account=1
  is_revoked            INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (org_id)            REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (service_account_id) REFERENCES user(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_api_key_key ON api_key(key);
CREATE INDEX ix_api_key_org_id ON api_key(org_id);
CREATE INDEX ix_api_key_service_account_id ON api_key(service_account_id);
```

**Notes:**
- `service_account_id` NULL = personal access token (issued to a user directly). Non-NULL = service account token.
- `role` is the legacy Grafana API-key role. With RBAC, actual permissions come from role assignments to the service-account user, not this column. Keep for compat.
- Token format is `openobs_<32byte-urlsafe-b64>`. Prefix is fixed so leaked tokens can be searched in logs.

---

## `role`

Grafana ref: `pkg/services/sqlstore/migrations/accesscontrol/role_mig.go`, `pkg/services/accesscontrol/models/role.go`.

```sql
CREATE TABLE role (
  id                    TEXT PRIMARY KEY,
  version               INTEGER NOT NULL DEFAULT 0,
  org_id                TEXT NOT NULL,           -- 0 (or '' for openobs) means global
  name                  TEXT NOT NULL,
  uid                   TEXT NOT NULL,           -- stable external identifier
  display_name          TEXT NULL,
  description           TEXT NULL,
  group_name            TEXT NULL,
  hidden                INTEGER NOT NULL DEFAULT 0,
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_role_org_name ON role(org_id, name);
CREATE UNIQUE INDEX ux_role_org_uid ON role(org_id, uid);
```

**Notes:**
- Built-in roles use `org_id = ''` (empty string) to denote "global", mirroring Grafana's `0`. `[openobs-deviation]` on storage type only.
- Role names for built-ins follow Grafana's prefix convention: `fixed:dashboards:editor`, `basic:admin`, etc. See [03-rbac-model.md](03-rbac-model.md).

---

## `permission`

Grafana ref: `pkg/services/accesscontrol/models/permission.go`.

```sql
CREATE TABLE permission (
  id                    TEXT PRIMARY KEY,
  role_id               TEXT NOT NULL,
  action                TEXT NOT NULL,          -- e.g. 'dashboards:read'
  scope                 TEXT NOT NULL,          -- e.g. 'dashboards:uid:abc' or 'dashboards:*'
  kind                  TEXT NOT NULL,          -- parsed scope kind, e.g. 'dashboards'
  attribute             TEXT NOT NULL,          -- parsed, e.g. 'uid' or '*'
  identifier            TEXT NOT NULL,          -- parsed, e.g. 'abc' or '*'
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);
CREATE INDEX ix_permission_role_id ON permission(role_id);
CREATE INDEX ix_permission_action ON permission(action);
CREATE INDEX ix_permission_kind_identifier ON permission(kind, identifier);
```

**Notes:**
- Grafana stores the parsed scope components (`kind`, `attribute`, `identifier`) alongside the raw `scope` for query efficiency. We do the same.
- Single-row action without scope = unrestricted on any resource of that kind: scope stored as empty string.

---

## `builtin_role`

Grafana ref: `pkg/services/accesscontrol/database/database.go`, `pkg/services/accesscontrol/models/builtin_role.go`.

Maps built-in role names (`Admin`, `Editor`, `Viewer`, `Grafana Admin`) to role_id.

```sql
CREATE TABLE builtin_role (
  id                    TEXT PRIMARY KEY,
  role                  TEXT NOT NULL,          -- 'Admin' | 'Editor' | 'Viewer' | 'Grafana Admin'
  role_id               TEXT NOT NULL,
  org_id                TEXT NOT NULL,          -- '' for global role
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_builtin_role_role_orgid ON builtin_role(role, org_id, role_id);
```

**Notes:**
- We use `'Server Admin'` instead of `'Grafana Admin'` to match our terminology. `[openobs-deviation]` on value only; semantics identical.

---

## `user_role` / `team_role`

Grafana ref: `pkg/services/accesscontrol/database/database.go`.

```sql
CREATE TABLE user_role (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,                   -- '' for global
  user_id     TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  created     INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_user_role ON user_role(org_id, user_id, role_id);
CREATE INDEX ix_user_role_user_id ON user_role(user_id);

CREATE TABLE team_role (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  team_id     TEXT NOT NULL,
  role_id     TEXT NOT NULL,
  created     INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE CASCADE,
  FOREIGN KEY (role_id) REFERENCES role(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_team_role ON team_role(org_id, team_id, role_id);
CREATE INDEX ix_team_role_team_id ON team_role(team_id);
```

---

## `folder`

Grafana ref: `pkg/services/sqlstore/migrations/folder.go`, `pkg/services/folder/model.go`.

```sql
CREATE TABLE folder (
  id                    TEXT PRIMARY KEY,
  uid                   TEXT NOT NULL,          -- public identifier (URL-safe)
  org_id                TEXT NOT NULL,
  title                 TEXT NOT NULL,
  description           TEXT NULL,
  parent_uid            TEXT NULL,              -- hierarchical; NULL = root
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  created_by            TEXT NULL,              -- user_id
  updated_by            TEXT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES user(id) ON DELETE SET NULL,
  FOREIGN KEY (updated_by) REFERENCES user(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX ux_folder_org_uid ON folder(org_id, uid);
CREATE INDEX ix_folder_parent_uid ON folder(org_id, parent_uid);
```

Hierarchy is enforced in application code (cycle detection, max depth = 8 per Grafana).

---

## `dashboard_acl`

Grafana ref: `pkg/services/sqlstore/migrations/dashboard_acl_mig.go`, `pkg/services/dashboards/models.go`.

Legacy ACL table. Still maintained by Grafana for back-compat; RBAC is the current model but `dashboard_acl` is a view input. We mirror this to stay compatible.

```sql
CREATE TABLE dashboard_acl (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  dashboard_id          TEXT NULL,              -- FK to dashboards, NULL if folder-level
  folder_id             TEXT NULL,
  user_id               TEXT NULL,
  team_id               TEXT NULL,
  role                  TEXT NULL,              -- 'Viewer' | 'Editor' | 'Admin' | NULL
  permission            INTEGER NOT NULL,       -- 1=View, 2=Edit, 4=Admin
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  FOREIGN KEY (org_id) REFERENCES org(id) ON DELETE CASCADE
);
CREATE INDEX ix_dashboard_acl_dashboard_id ON dashboard_acl(dashboard_id);
CREATE INDEX ix_dashboard_acl_folder_id ON dashboard_acl(folder_id);
```

**Note:** exactly one of (`user_id`, `team_id`, `role`) is non-NULL — enforced in application layer, Grafana doesn't add a check constraint either. See [07-resource-permissions.md](07-resource-permissions.md) for when RBAC `permission` rows supersede this.

---

## `audit_log`

Grafana ref: Grafana Enterprise only — we design our own schema but follow the same event shape. See `pkg/services/auditlog/` in Grafana Enterprise for conceptual alignment.

```sql
CREATE TABLE audit_log (
  id                    TEXT PRIMARY KEY,
  timestamp             INTEGER NOT NULL,
  action                TEXT NOT NULL,           -- 'user.login' | 'user.role_changed' | 'team.member_added' | ...
  actor_type            TEXT NOT NULL,           -- 'user' | 'service_account' | 'system'
  actor_id              TEXT NULL,
  actor_name            TEXT NULL,               -- denormalized so log is readable after user deletion
  org_id                TEXT NULL,
  target_type           TEXT NULL,               -- 'user' | 'team' | 'dashboard' | ...
  target_id             TEXT NULL,
  target_name           TEXT NULL,
  outcome               TEXT NOT NULL,           -- 'success' | 'failure'
  metadata              TEXT NULL,               -- JSON blob of action-specific fields
  ip                    TEXT NULL,
  user_agent            TEXT NULL
);
CREATE INDEX ix_audit_log_timestamp ON audit_log(timestamp);
CREATE INDEX ix_audit_log_actor_id ON audit_log(actor_id);
CREATE INDEX ix_audit_log_target_id ON audit_log(target_id);
CREATE INDEX ix_audit_log_action ON audit_log(action);
CREATE INDEX ix_audit_log_org_id ON audit_log(org_id);
```

**Retention:** configurable (default 90 days). Prune job runs daily, deletes rows older than retention.

---

## `quota`

Grafana ref: `pkg/services/sqlstore/migrations/quota_mig.go`, `pkg/services/quota/model.go`.

```sql
CREATE TABLE quota (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NULL,                        -- NULL if user-level
  user_id     TEXT NULL,                        -- NULL if org-level
  target      TEXT NOT NULL,                    -- 'dashboards' | 'users' | 'datasources' | 'api_keys'
  limit_val   INTEGER NOT NULL,                 -- -1 means unlimited
  created     INTEGER NOT NULL,
  updated     INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_quota_org_target ON quota(org_id, target) WHERE user_id IS NULL;
CREATE UNIQUE INDEX ux_quota_user_target ON quota(user_id, target) WHERE org_id IS NULL;
```

Defaults are set from config at startup if no row exists for that (org, target) pair.

---

## `preferences`

Grafana ref: `pkg/services/sqlstore/migrations/preferences_mig.go`.

```sql
CREATE TABLE preferences (
  id                    TEXT PRIMARY KEY,
  org_id                TEXT NOT NULL,
  user_id               TEXT NULL,              -- NULL = org-level default
  team_id               TEXT NULL,              -- NULL = org-level or user-level
  version               INTEGER NOT NULL DEFAULT 0,
  home_dashboard_uid    TEXT NULL,
  timezone              TEXT NULL,
  week_start            TEXT NULL,
  theme                 TEXT NULL,              -- 'light' | 'dark' | ''
  locale                TEXT NULL,
  json_data             TEXT NULL,              -- JSON for extensible prefs
  created               INTEGER NOT NULL,
  updated               INTEGER NOT NULL,
  FOREIGN KEY (org_id)  REFERENCES org(id)  ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES team(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ux_preferences_org_user_team
  ON preferences(org_id, COALESCE(user_id, ''), COALESCE(team_id, ''));
```

---

## Migration ordering

Migrations are numbered files in `packages/data-layer/src/migrations/`. Execute in order. Each is irreversible forward-only (Grafana is the same).

```
001_org.sql           -- CREATE TABLE org + seed 'org_main'
002_user.sql          -- CREATE TABLE user, with FK to org (satisfied by 001)
003_user_auth.sql
004_user_auth_token.sql
005_org_user.sql      -- CREATE TABLE org_user
006_team.sql
007_team_member.sql
008_api_key.sql
009_rbac.sql          -- role, permission, builtin_role, user_role, team_role in one migration
010_folder.sql
011_dashboard_acl.sql
012_preferences.sql
013_quota.sql
014_audit_log.sql

015_alter_resources.sql -- ALTER TABLE adding org_id to dashboards, investigations, alert_rules, datasources, ...
```

Each migration also inserts seed data where necessary:
- `001` inserts default org `('org_main', 'Main Org')`.
- `009` inserts built-in roles + permissions (see [03-rbac-model.md](03-rbac-model.md) §builtin-seed).
- `015` is written after the resource-rename migrations complete; backfills `org_id = 'org_main'` for all existing rows.

---

## Repository layer (T1.2)

One `<Entity>Repository` class per table, exported from `packages/data-layer/src/repositories/`. Interfaces live in `packages/common/src/repositories/`.

Shape follows existing openobs repository pattern (see `packages/data-layer/src/repositories/dashboard-repository.ts` as reference):

```ts
export interface IUserRepository {
  create(user: NewUser): Promise<User>
  findById(id: string): Promise<User | null>
  findByLogin(login: string): Promise<User | null>
  findByEmail(email: string): Promise<User | null>
  findByAuthInfo(module: string, authId: string): Promise<User | null>
  list(opts?: ListUsersOpts): Promise<{ items: User[]; total: number }>
  update(id: string, patch: UserPatch): Promise<User>
  delete(id: string): Promise<void>
  setDisabled(id: string, disabled: boolean): Promise<void>
  updateLastSeen(id: string, at: number): Promise<void>
  countServiceAccounts(orgId: string): Promise<number>
}
```

All repositories must include:
- `create`, `findById`, `list` (with pagination), `update`, `delete` baseline
- Whatever specialized lookups the entity needs (e.g., `findByLogin` on user)
- Every method covered by a unit test against an in-memory SQLite database

## Fixture utilities (T1.3)

New module `packages/data-layer/src/test-support/fixtures.ts`:

```ts
export function makeUser(overrides?: Partial<User>): User { ... }
export function makeOrg(overrides?: Partial<Org>): Org { ... }
export function makeTeam(orgId: string, overrides?: Partial<Team>): Team { ... }
export function seedDefaultOrg(db: Database): Org { ... }
export function seedServerAdmin(db: Database, email: string): User { ... }
export function seedBuiltinRoles(db: Database, orgId: string): void { ... }
```

Used by integration tests across all packages. Must cover every table with at least a `make*` builder.

---

## Open questions on schema

1. **Column encryption:** `user_auth.o_auth_*` are encrypted. Do we pre-emptively encrypt `api_key.key` too? Recommendation: **no** — `api_key.key` stores a SHA-256 hash which is already non-reversible; encrypting a hash adds no security. Matches Grafana.

2. **Version column:** Grafana uses `version` on entities with optimistic locking. We include it per schema above; actual enforcement in repositories is P1.2 responsibility — every `UPDATE` checks `version = :expected` and increments. Concurrent writes that lose the race get a retryable `StaleEntityError`.

3. **Cascade vs restrict on `org` delete:** Grafana cascade-deletes org's children. We do the same (see FKs above). Operators deleting an org accept that all dashboards/investigations/etc. in that org go away.
