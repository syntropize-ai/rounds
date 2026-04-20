# openobs Config Architecture

**Status:** target state after Waves W1–W4 of the 2026-04 tech-debt cleanup.
**Audience:** operators running openobs and engineers working on the config
plane. Read alongside [tech-debt-audit-plan.md](./tech-debt-audit-plan.md) for
historical context on *why* each decision was made.

All file references below point at the repository layout as of `fcf48c1`.

---

## 1. One source of truth: SQLite

Before W2, instance config lived in a flat `<DATA_DIR>/setup-config.json`
file sitting next to `openobs.db`. Two endpoints mutated it with two
different auth models. That file is gone.

Everything config-shaped now lives in SQLite, schema in
`packages/data-layer/src/migrations/019_instance_settings.sql`:

| Table | Purpose |
| --- | --- |
| `instance_llm_config` | Single-row (`id = 'singleton'`) active LLM provider. |
| `instance_datasources` | Prometheus / Loki / Tempo / etc. connection rows. `org_id NULL` = instance-global (current v1 default). |
| `notification_channels` | Slack / PagerDuty / email. `config` is JSON with per-field encrypted secrets. |
| `instance_settings` | KV bag. Reserved keys: `bootstrapped_at`, `configured_at`. |

Transactional writes, audit hooks, at-rest encryption — all for free once
config is in SQLite. No more half-written JSON after a crash.

## 2. The gatekeeper: `SetupConfigService`

Every route that reads or writes instance config goes through
`packages/api-gateway/src/services/setup-config-service.ts`. It owns the
three repositories (instance-config, datasources, notification-channels),
emits `AuditAction.*` events on mutations, and hosts the
`isBootstrapped()` predicate every middleware checks.

Design notes baked into the service:

- No caching. `better-sqlite3` is synchronous and fast enough; an
  in-memory layer would add complexity for no measurable win and risk
  serving stale config after a write.
- Encryption at rest happens in the repository layer; the service deals
  in plaintext. Callers pass `{ masked: true }` if they need the
  mask-before-response path.
- Audit writes are fire-and-forget via `AuditWriter`.

## 3. Bootstrap-aware middleware

`packages/api-gateway/src/middleware/bootstrap-aware.ts` is the auth model
for the config plane. It answers "does this request need to be
authenticated?" with a single source: the `bootstrapped_at` marker.

- **Pre-bootstrap** (marker unset): let unauthenticated requests through.
  The setup wizard needs to save the first LLM config *before* a first
  admin exists.
- **Post-bootstrap** (marker set): require auth, then walk the supplied
  `postAuthChain` (typically `orgContext` + `requirePermission(...)`).

The marker is durable: it survives a users-table DELETE or a restore from
a clean backup. Contrast with the old "does the users table have any
rows?" check in `requireSetupAccess`, which would silently re-open the
gate after accidental data loss.

`POST /api/setup/admin` in `routes/setup.ts:415` writes the marker on
first-admin creation; after that, every `bootstrapAware()` middleware
behaves identically to the auth chain.

## 4. Credential encryption at rest

- Cipher: AES-256-GCM.
- Wire format: `iv:ct:tag` hex triplet — IV is random per write, so
  repeated writes of the same plaintext produce different ciphertexts.
- Key source: `SECRET_KEY` env var, resolved via
  `packages/common/src/crypto/secret-box.ts:resolveSecretKey()`. No dev
  fallback — `SECRET_KEY` missing fails the boot with a pointer at
  `bootstrap-secrets.ts`.
- Helpers: `encrypt(plaintext, key)` / `decrypt(ciphertext, key)` from
  `@agentic-obs/common/crypto`.
- Repository layer encrypts on write and decrypts on read. Routes and
  services never touch ciphertext directly.

Which columns are encrypted:
- `instance_llm_config.api_key`
- `instance_datasources.api_key`, `instance_datasources.password`
- `notification_channels.config` — per-field: the JSON stays JSON, but
  secret fields inside it (slack webhook URL, pagerduty integration key,
  smtp password) are encrypted individually so non-secret fields stay
  debuggable on read.

## 5. Route surface

Post-consolidation the authoritative endpoints are:

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET  /api/setup/status` | open | DB-derived readiness view. |
| `POST /api/setup/admin` | bootstrap-aware (open pre-bootstrap) | First-admin bootstrap; writes `bootstrapped_at`. |
| `POST /api/setup/llm/test` | bootstrap-aware | Test LLM connection. No persistence. |
| `POST /api/setup/llm/models` | bootstrap-aware | List available models. |
| `GET|POST|PUT|DELETE /api/datasources/*` | bootstrap-aware + `admin:write` | Datasource CRUD. |
| `GET|PUT /api/system/llm` | authed + `admin:write` | LLM config read / write. |
| `GET|PUT /api/system/notifications` | authed + `admin:write` | Notification-channel config. |

Deleted in W2 (do not reintroduce):
`POST /api/setup/complete`, `POST /api/setup/datasource`,
`DELETE /api/setup/datasource/:id`, `POST /api/setup/notifications`,
the `body.test` flag on `POST /api/setup/llm`, and the
`inMemoryConfig` module-level getter/setter pattern.

## 6. Bootstrap flow

```
Browser / Setup Wizard             api-gateway                 SQLite
─────────────────────              ───────────                 ──────
   │                                   │                         │
   │  GET /api/setup/status            │                         │
   ├──────────────────────────────────▶│  SELECT ... FROM        │
   │                                   ├────────────────────────▶│
   │  {configured:false,hasAdmin:false}│                         │
   │◀──────────────────────────────────┤                         │
   │                                   │                         │
   │  POST /api/setup/llm/test ──▶ (tests LLM, no persistence)   │
   │  (bootstrap-aware: open; marker still unset)                │
   │                                   │                         │
   │  POST /api/datasources            │                         │
   │  (bootstrap-aware: open; marker still unset)                │
   ├──────────────────────────────────▶│  INSERT instance_ds     │
   │                                   ├────────────────────────▶│
   │                                   │                         │
   │  POST /api/setup/admin            │                         │
   │  {email, password, ...}           │                         │
   ├──────────────────────────────────▶│  INSERT user            │
   │                                   │  INSERT instance_settings(bootstrapped_at, now())
   │                                   ├────────────────────────▶│
   │  200 + session cookie             │                         │
   │◀──────────────────────────────────┤                         │
   │                                   │                         │
   │  ── From this point forward, bootstrapped_at is set. ──     │
   │  ── Every bootstrapAware() gate now requires auth. ──       │
   │                                   │                         │
   │  PUT /api/system/llm              │                         │
   │  Cookie: openobs_session=...      │                         │
   ├──────────────────────────────────▶│  auth → perm → UPSERT   │
   │                                   ├────────────────────────▶│
```

## 7. Error envelope

Every non-2xx response from the gateway has shape:

```json
{ "error": { "code": "STRING_CODE", "message": "human", "details": {...} } }
```

`packages/api-gateway/src/middleware/error-handler.ts` is the normalizer.
Routes either throw an `AppError` subclass (preferred — it carries
`statusCode` + `code` + `message` + optional `details`) or the legacy
`{ statusCode, code, isClientSafe }` shape (still supported, but new code
should use `AppError`). 5xx statuses have their message scrubbed to
"Internal server error" before being sent.

## 8. SSRF posture

Any outbound HTTP request that takes a user-controlled URL is gated by
`packages/api-gateway/src/utils/url-validator.ts:ensureSafeUrl()`. It
rejects loopback, RFC1918, link-local, unique-local, and metadata IPs
unless explicitly allowed.

Gating logic:
- `OPENOBS_ALLOW_PRIVATE_URLS=true` → permissive (local-dev mode).
- `OPENOBS_ALLOW_PRIVATE_URLS=false` → strict.
- Unset → strict when `NODE_ENV=production`, permissive otherwise.

Call sites (all W1 T1.1):
- `routes/setup.ts` LLM test + model-list fetches (all five provider
  branches).
- `routes/webhooks.ts:~116` webhook delivery.
- `auth/oauth/generic.ts:~104` OIDC discovery fetch.
- `routes/notifications.ts` channel-test delivery.
- `utils/datasource.ts` datasource connection probe.

## 9. Secret-key bootstrap

`packages/api-gateway/src/auth/bootstrap-secrets.ts` auto-generates the
two hard-required secrets on first boot:

- `JWT_SECRET` — websocket-gateway session signing (≥32 chars).
- `SECRET_KEY` — AES-GCM envelope for OAuth tokens + anything encrypted
  at rest (≥32 chars).

Storage: `<DATA_DIR>/secrets.json`, owner-only 0600 permissions. Every
subsequent boot reads the same file so sessions and encrypted rows
survive restarts.

Production (`NODE_ENV=production`) **never** auto-generates — missing
secrets are a hard boot failure. A fresh random value each boot in prod
would invalidate every session and decrypt-break every stored secret.

The `secret-box.ts` dev fallback was removed in T1.2. A missing
`SECRET_KEY` in dev now fails loud with a pointer at `bootstrap-secrets.ts`,
rather than silently using a hardcoded key.

---

## See also

- `docs/auth-perm-design/` — the auth/permission design doc tree.
- `docs/tech-debt-audit-plan.md` — the plan that produced this state.
- `docs/tech-debt-progress.md` — what actually landed and what's deferred.
