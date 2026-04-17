# 06 — Service Accounts

**Applies to:** T6.1–T6.4
**Grafana reference:**
- `pkg/services/serviceaccounts/` — service + model
- `pkg/services/serviceaccounts/manager/service.go` — SA CRUD
- `pkg/services/apikey/` — token storage and validation
- `pkg/api/serviceaccounts.go`, `pkg/api/apikey.go` — HTTP handlers
- `pkg/services/authn/clients/api_key.go` — authn client for token

## Model

A **service account** is a non-human identity within an org. In Grafana, it's represented as a row in the `user` table with `is_service_account=1`. Same in openobs.

A service account:
- Has a login (`sa-<slug>`), name, and org membership (exactly one org — SAs aren't multi-org).
- Has an org role (Admin/Editor/Viewer) like human users.
- Can have role assignments via `user_role` for fine-grained permissions.
- Issues API tokens (`api_key` rows where `service_account_id` points to it).
- Can be disabled.
- Cannot log in interactively (no password, no OAuth binding).

**Parity rule:** SAs are users. Every table that joins against `user` works for SAs unchanged. Permission resolution works unchanged. We do NOT create a separate `service_account` table.

## API surface

See [08-api-surface.md](08-api-surface.md) §service-accounts. Summary:

- `POST   /api/serviceaccounts` — create
- `GET    /api/serviceaccounts/search?query=&perpage=&page=` — list in current org
- `GET    /api/serviceaccounts/:id`
- `PATCH  /api/serviceaccounts/:id` — update name/role/isDisabled
- `DELETE /api/serviceaccounts/:id`
- `POST   /api/serviceaccounts/:id/tokens` — issue token
- `GET    /api/serviceaccounts/:id/tokens` — list tokens
- `DELETE /api/serviceaccounts/:id/tokens/:tokenId` — revoke token
- `POST   /api/serviceaccounts/migrate` — bulk-migrate orphan api_keys to SAs (Grafana migration endpoint)

Mirror `pkg/api/serviceaccounts.go` routes.

## SA service

File: `packages/api-gateway/src/services/serviceaccount-service.ts`.

```ts
interface IServiceAccountService {
  create(orgId: string, input: { name: string; role: OrgRole; isDisabled?: boolean }): Promise<ServiceAccount>
  getById(orgId: string, id: string): Promise<ServiceAccount | null>
  list(orgId: string, opts?: { query?: string; limit?: number; offset?: number; disabled?: boolean }): Promise<{ items: ServiceAccount[]; total: number }>
  update(orgId: string, id: string, patch: Partial<{ name: string; role: OrgRole; isDisabled: boolean }>): Promise<ServiceAccount>
  delete(orgId: string, id: string): Promise<void>
}
```

### Create SA

1. Generate login: `sa-<slugified-name>` (e.g., `sa-grafana-prom-scraper`). If collision, append counter.
2. Insert `user` row: `is_service_account=1, is_admin=0, login=sa-<...>, name=<input.name>, org_id=<orgId>`.
3. Insert `org_user`: `org_id, user_id, role=<input.role>`.
4. Audit: `serviceaccount.created`.

### Delete SA

1. Revoke all `api_key` rows where `service_account_id = id` (hard delete; tokens are gone forever).
2. Delete `user_role`, `team_member`, `org_user` rows.
3. Delete `user` row.
4. Audit: `serviceaccount.deleted`.

### Quota

`quota.target='service_accounts'` per org. Create fails with 403 if current count >= limit. Default limit in config: unlimited.

## Token service (T6.2, T6.4)

File: `packages/api-gateway/src/services/apikey-service.ts`. Manages both SA tokens and personal access tokens.

### Issue token

```ts
async issueServiceAccountToken(orgId: string, serviceAccountId: string, input: { name: string; expiresSec?: number }): Promise<{ id: string; key: string }>
async issuePersonalAccessToken(orgId: string, userId: string, input: { name: string; expiresSec?: number; role?: OrgRole }): Promise<{ id: string; key: string }>
```

Token generation (matches `pkg/components/apikeygen/apikeygen.go`):

1. Generate 32 random bytes.
2. Encode as URL-safe base64.
3. Token format: `openobs_pat_<base64>` (for PAT) or `openobs_sa_<base64>` (for SA).
4. Store `SHA-256(token)` as `api_key.key`.
5. Return plaintext once. Never persisted in plaintext; never re-retrievable.

Response body (matching Grafana):
```json
{
  "id": "apikey_abc",
  "name": "prometheus-scraper",
  "key": "openobs_sa_<base64>"
}
```

Plaintext `key` is present in response exactly once. Client MUST store it; server cannot recover.

### Validate token (middleware T6.3)

File: `packages/api-gateway/src/middleware/auth.ts::apiKeyAuth`.

Flow:
1. Extract token from `Authorization: Bearer <token>` or `X-Api-Key: <token>` header.
2. Hash with SHA-256.
3. `SELECT * FROM api_key WHERE key = ? AND is_revoked = 0 AND (expires IS NULL OR expires > ?)`.
4. If not found → 401.
5. Load the service account or personal user: `SELECT * FROM user WHERE id = (key.service_account_id OR owner_user_id)`.
6. Populate `req.auth`:
   ```
   userId: <sa or user id>
   orgId: <api_key.org_id>
   orgRole: <api_key.role>   // and load row from org_user as authoritative
   isServerAdmin: user.is_admin
   authenticatedBy: 'api_key'
   serviceAccountId: key.service_account_id  // null for PAT
   sessionId: null
   ```
7. Update `api_key.last_used_at = now` (async, fire-and-forget).
8. Audit: `apikey.used` — rate-limited to once per minute per key to avoid flooding.

### Revoke token

`DELETE /api/serviceaccounts/:id/tokens/:tokenId` → `UPDATE api_key SET is_revoked = 1 WHERE id = ?`. Any subsequent request with that token returns 401. Grafana also supports hard delete; we keep the row for audit (soft-delete).

### Expiry

Tokens can have an absolute expiry (`expires` epoch ms) or none. Daily cron prunes expired tokens (hard delete), retaining only revoked-recently rows for audit.

## Personal Access Tokens (PAT)

Not Grafana-standard — Grafana deprecated PATs in favor of SAs. But openobs keeps PATs for CLI/scripts scoped to a specific user with that user's permissions. Issued from Profile page (`/api/user/auth-tokens`).

Parity note: this is an openobs-extension. Agents mark with `[openobs-extension]`.

PATs have the same `api_key` row, but `service_account_id=NULL` and `role` is null (permissions come from the owning user's org role + assignments).

Owner column: **we add `owner_user_id` to `api_key` table** — wait, we didn't in schema. Let me fix below.

### Schema adjustment

Add to `api_key`:
```sql
ALTER TABLE api_key ADD COLUMN owner_user_id TEXT NULL;
-- FK: FOREIGN KEY (owner_user_id) REFERENCES user(id) ON DELETE CASCADE
-- For PATs, owner_user_id is the user; for SA tokens, service_account_id is the SA
-- Exactly one is set.
```

(This supersedes [01-database-schema.md](01-database-schema.md) §api_key — the schema doc gets updated during T1.1 to include this column. Agent responsibility: update the schema doc alongside writing the migration.)

## Bulk migrate endpoint

`POST /api/serviceaccounts/migrate` — moves legacy keys (from env-var `API_KEYS`, if any) into SA-owned keys. For each legacy key:

1. Create an SA named "Migrated <key-name>" with role Viewer.
2. Issue a new token owned by that SA.
3. Return mapping `{ oldKey: opaque, newToken: ..., serviceAccount: {...} }`.

Only needed during T9.1 cutover; may be no-op if no legacy keys exist.

## Audit events

- `serviceaccount.created`
- `serviceaccount.updated`
- `serviceaccount.deleted`
- `serviceaccount.token_created`
- `serviceaccount.token_revoked`
- `apikey.created` (PAT)
- `apikey.revoked` (PAT)
- `apikey.used` (rate-limited)

## Test scenarios (MUST be implemented)

1. Create SA → user row with `is_service_account=1`, org_user row.
2. Issue token → plaintext returned once, hash stored.
3. Token plaintext is never recoverable: second `GET /api/serviceaccounts/:id/tokens` returns rows without `key`.
4. Authenticate request with SA token → `req.auth.serviceAccountId` set, orgRole respected.
5. Revoke token → subsequent request returns 401.
6. Token expiry honored: set `expires` in past → 401.
7. Delete SA → all SA's tokens revoked (or hard-deleted).
8. Permission check: SA with Viewer role cannot `dashboards:write` → 403.
9. SA with custom role grant → has those fine-grained permissions.
10. Login attempt with SA's login → 403 (SAs cannot log in via password).
11. Quota: create N+1 SAs when quota is N → last one fails with 403.
12. PAT: user issues PAT → can use it to hit /api/dashboards with their permissions.
13. PAT owner deleted → PAT rows cascade-delete.
14. Bulk migrate endpoint: given legacy keys in config, creates SAs and returns mapping.

## File scope for T6 agents

- `packages/common/src/models/service-account.ts` — new
- `packages/common/src/models/api-key.ts` — new
- `packages/api-gateway/src/services/serviceaccount-service.ts` — new
- `packages/api-gateway/src/services/apikey-service.ts` — new (replaces env-var logic)
- `packages/api-gateway/src/routes/serviceaccounts.ts` — new
- `packages/api-gateway/src/routes/user-tokens.ts` — new (PAT endpoints)
- `packages/api-gateway/src/middleware/auth.ts` — update apiKeyAuth branch
- `packages/data-layer/src/repositories/api-key-repository.ts` — new
- Migration `008_api_key.sql` — include `owner_user_id` column
