# openobs Tech-Debt Audit + Long-Term Fix Plan

**Date:** 2026-04-19
**Scope:** Full codebase audit across 4 dimensions — dead code / legacy, module
boundaries, route + persistence architecture, security. Below is the
consolidated findings list and a wave-based execution plan.

The top-line smell is **config persistence** — `setup-config.json` is a flat
file sitting next to `openobs.db`, two different endpoints mutate it with two
different auth models, and duplicate types fan out through the frontend. That
drives ~30% of the findings. Fixing it is Wave 2.

---

## Consolidated findings

### CRITICAL — security

1. **SSRF coverage gaps** — every LLM test/listModels and webhook fetch is
   unprotected. Attacker-supplied `baseUrl` in `/api/setup/llm` and
   `/api/setup/llm/models` bypasses `ensureSafeUrl()`:
   - `routes/setup.ts:192` (corporate-gateway), `:220` (anthropic), `:240`
     (openai/deepseek), `:252` (ollama), `:265` (gemini), `:352` (DeepSeek
     models endpoint).
   - `routes/webhooks.ts:123` — webhook delivery fetches user-controlled URL
     with no SSRF check.
   - `auth/oauth/generic.ts:104` — SAML/OIDC discovery fetch is unvalidated.

2. **Insecure crypto dev fallback still live** — `common/src/crypto/secret-box.ts:88`
   prints a warning and uses a hard-coded key when `SECRET_KEY` is unset. The
   `bootstrap-secrets.ts` path auto-generates a key on first boot, so the
   fallback is now dead-but-armed. Must be removed so a misconfigured prod
   never silently uses the dev key.

### HIGH — security + correctness

3. **Bootstrap gate re-opens on DB reset** — `requireSetupAccess` (routes/setup.ts:431)
   allows unauth access when `!configured || !hasAnyUser()`. If the users
   table is cleared (accidental DELETE, restore from bad backup), the gate
   re-opens. Need a persistent marker (`instance_settings.bootstrapped_at`)
   independent of the user table.

4. **Login endpoint has only generic rate limit** — `/api/login` is covered by
   the default 100/min limiter. Local-provider has an internal 5/5min
   per-(ip,login) limit but doesn't surface `Retry-After` or lockout state via
   HTTP. Need explicit `loginRateLimiter` + proper 429 semantics.

5. **Setup-config JSON is source of truth for datasources/LLM/notifications** —
   `routes/setup.ts:91-146`. Flat file, no schema versioning, no transactions,
   no audit trail. Two endpoints mutate it with conflicting auth:
   - `POST /api/setup/datasource` — bootstrap gate (can run unauth during wizard)
   - `POST/PUT/DELETE /api/datasources/*` — authed with `requirePermission`.
   Result: the duplicate-rows bug the user just hit, plus no way to track
   who changed what.

6. **Silent error swallows that hide data loss** —
   - `routes/setup.ts:144` — config save failure logs at **debug** level only.
     User thinks they saved; disk write actually failed.
   - `llm-gateway/src/router/smart-router.ts:124` — LLM JSON parse fails →
     returns `{}` silently, no log, caller proceeds on empty input.

### MEDIUM

7. **LDAP filter injection risk** — `auth/ldap/client.ts:127` substitutes
   `input.login` into the search filter via bare `.replace(/%s/g, …)`. No
   escaping of LDAP meta-chars (`*`, `(`, `)`, `\`, NUL). If login is
   user-supplied, this is direct filter injection.

8. **Duplicate metadata tables in frontend** —
   - `packages/web/src/pages/setup/types.ts:119-133` defines `DATASOURCE_TYPES`;
     `packages/web/src/pages/Settings.tsx:43-52` defines `DS_TYPES` (same thing,
     different shape, different `supported` semantics).
   - Same pattern for `LLM_PROVIDERS` (setup/types.ts:48 vs Settings.tsx:30).
   - Same pattern for `LlmConfig`/`DatasourceConfig` types — once in
     `setup.ts:35` on the backend, once in `web/src/pages/setup/types.ts`,
     once again inline in `Settings.tsx`.

9. **Error envelope inconsistency** — auth/setup routes return
   `{ message }` (e.g. routes/setup.ts:437, 488, 514); most other routes
   return `{ error: { code, message } }`. Middleware error-handler expects
   the second shape. Frontend has to handle both.

10. **`configured` boolean is too thin** — `POST /api/setup/complete` flips
    the flag without verifying LLM/datasources are actually set. Should be
    derived from the DB state, not a standalone flag.

11. **Save-vs-test endpoint inconsistency** — `POST /api/setup/llm` with
    `body.test=true` **and** a separate `POST /api/setup/llm/test` both
    exist and do the same thing. Pick one.

12. **ApiKeyServiceError duplicates AppError hierarchy** —
    `services/apikey-service.ts:44-56` has its own error class with `kind` +
    `statusCode`. Not caught by the error-handler middleware the same way
    `AppError` subclasses are. Migrate to `AppError`.

13. **Silent swallows in adapters / api-client** —
    - `web/src/api/client.ts:35-50` — `authHeaders()` catches localStorage
      parse failures, returns `{}`; silent auth loss.
    - `adapters/src/prometheus/metrics-adapter.ts:71,80,95` — HTTP failures
      return `[]` silently; caller sees "no data" vs "failed fetch".
    - `data-layer/src/cache/redis.ts:30-31` — `JSON.parse` fails → `null`,
      no log.

### LOW

14. **Legacy path dregs** — `paths.ts:33-34` hardcodes legacy dir names
    (`.agentic-obs`, `.uname-data`); `routes/setup.ts:87` redefines
    `legacyHomeConfigPath()` already exported from `paths.ts:77`; the
    `~/.agentic-obs/config.json` migration in `setup.ts:115-136` is a
    one-shot that should be deleted after one release.

15. **Closure-based DI for bootstrap deps** — `setBootstrapHasUsers` and
    `setSetupAdminDeps` (setup.ts:399, 418). Module-level setters with
    silent fallback ("always allow" when unset). Should be constructor
    args to a `createSetupRouter(deps)` factory.

16. **Module-level mutable state in routes/setup.ts** —
    `inMemoryConfig` + exported getter/setter. Dashboard query and
    variable resolver import it directly (`routes/dashboard/query.ts:9`,
    `variable-resolver.ts:4`), making setup config a de-facto public API
    for the whole gateway.

17. **Empty-catch idioms** — `listModels()` on every LLM provider returns
    `[]` on error without logging. Fine in isolation, but the wizard's
    "Could not fetch models" message has no way to tell you **why**.

---

## Execution plan — 5 waves, 18 tasks

Each task fits in one agent run. Dependencies noted. Waves labelled W1–W5.

### W1 — Security (critical; can run fully parallel)

- **T1.1** Wire `ensureSafeUrl()` into every outbound fetch in
  `routes/setup.ts` (LLM test + model-list), `routes/webhooks.ts`,
  `auth/oauth/generic.ts`. One helper: "if URL came from user/tenant
  config, validate before fetch; if it's a baked-in literal, skip."
- **T1.2** Delete the `SECRET_KEY` dev fallback in
  `common/src/crypto/secret-box.ts`. Rely on `bootstrap-secrets.ts` to
  auto-generate in dev. Fail loud if unset in any env.
- **T1.3** Add a dedicated `loginRateLimiter` (5/min per IP, per-account
  lockout). Surface `Retry-After`. Write an integration test.
- **T1.4** LDAP filter input escaping in `auth/ldap/client.ts:127`.
  Escape `*`, `(`, `)`, `\`, NUL per RFC 4515. Unit-test with known
  injection payloads.

### W2 — Config persistence re-architecture (the core cleanup)

Sequential chain; this is the big one.

- **T2.1** Schema + migration `019_instance_settings.sql`:
  - `instance_llm_config` (one row): provider, api_key (encrypted),
    model, base_url, auth_type, region, updated_at, updated_by.
  - `instance_datasources`: id, type, name, url, environment, cluster,
    is_default, api_key (encrypted), username, password (encrypted),
    created_at, updated_at, updated_by.
  - `notification_channels`: id, org_id FK, type, name, config (JSON,
    encrypted secrets), created_at, updated_by.
  - `instance_settings` KV for misc (bootstrapped_at, configured_at, etc.).
- **T2.2** Repositories in `data-layer`: `InstanceConfigRepository`,
  `DatasourceRepository`, `NotificationChannelRepository`. Use drizzle.
- **T2.3** One-shot migration `migrateSetupConfigToDbIfNeeded()`: read
  `setup-config.json` if present, upsert into new tables, write
  `bootstrapped_at`, rename file to `setup-config.json.migrated`. Wire
  into `server.ts` after auth migration.
- **T2.4** `SetupConfigService` — owns reads/writes, encapsulates
  encryption, emits audit events. Replaces `inMemoryConfig` + exported
  getters/setters.
- **T2.5** Route consolidation:
  - Delete `POST /api/setup/datasource`, `DELETE /api/setup/datasource/:id`.
    Wizard uses `/api/datasources` via a bootstrap-aware middleware that
    allows unauth when no users exist, same as admin bootstrap.
  - Unify `/api/setup/llm` — `POST /api/setup/llm/test` for test only;
    `PUT /api/system/llm` (authed, `admin:write`) for save.
  - `/api/setup/notifications` → `PUT /api/system/notifications` (authed).
  - Remove `body.test` flag patterns everywhere.
- **T2.6** Replace `configured` boolean — derive from DB: "has admin AND
  has LLM AND (has ≥1 datasource OR user explicitly skipped)". Expose
  via `GET /api/setup/status`.
- **T2.7** Bootstrap marker — `instance_settings.bootstrapped_at` set
  once on first admin creation. `requireSetupAccess` checks the marker,
  not the users table.

### W3 — Frontend dedup + type unification (parallel, independent from W1/W2)

- **T3.1** Single source of truth for datasource type metadata — move
  `DS_TYPES` and `DATASOURCE_TYPES` into one exported const. Delete the
  `Settings.tsx` local copy. Keep icon/color metadata on one shape only.
- **T3.2** Same for `LLM_PROVIDERS` — setup/types.ts is canonical;
  `Settings.tsx` imports.
- **T3.3** Share `LlmConfig`, `DatasourceConfig`, `NotificationConfig`
  between frontend and backend — move into `@agentic-obs/common/config-types`
  (frontend-safe, no Node deps). Both setup.ts and the web types.ts
  re-export from there.

### W4 — Error + abstraction cleanup (parallel, independent)

- **T4.1** Unify error envelope — every route either throws `AppError`
  (caught by error-handler middleware) or returns `{ error: { code,
  message } }`. Kill `{ message }`-shaped responses. Migrate
  `ApiKeyServiceError` to `AppError` subclasses.
- **T4.2** Remove silent error swallows —
  `llm-gateway/src/router/smart-router.ts:124` (throw or return
  `{ ok: false }`), `routes/setup.ts:144` (fail loud on config save
  failure), `web/src/api/client.ts:35` (log + surface).
- **T4.3** Legacy path cleanup — delete `.agentic-obs` / `.uname-data`
  fallbacks in `paths.ts`, delete duplicate `legacyHomeConfigPath()` in
  `setup.ts`, delete `~/.agentic-obs/config.json` migration branch (T2.3
  replaces it). `persistence.ts` `legacyStoresPath()` removed.
- **T4.4** Dead code sweep — re-export fallout from the barrel split;
  `models/index.ts:14` comment referring to the deleted workspace model;
  any stale adapter stubs; `common/src/rbac/actions.ts:112` legacy API
  keys comment.

### W5 — Verify

- **T5.1** Full typecheck across all packages (`tsc --build`).
- **T5.2** Run every existing test; fix anything broken by the route
  consolidation.
- **T5.3** Start the server on a clean `DATA_DIR`, run through setup
  wizard end-to-end, log in, add/edit/delete a datasource, confirm no
  `setup-config.json` is created.
- **T5.4** Write `docs/config-architecture.md` describing the final
  target state (one-source-of-truth SQLite, bootstrap flow, migration
  path for existing installs).

---

## Parallelization

- W1 (T1.1–T1.4) — 4 agents in parallel.
- W2 — sequential chain (T2.1 → T2.2 → T2.3 → T2.4 → T2.5 → T2.6 → T2.7).
- W3 (T3.1–T3.3) — 3 agents in parallel, start once T2.4 lands so types
  are stable.
- W4 (T4.1–T4.4) — 4 agents in parallel, T4.3 after T2.3.
- W5 — sequential, last.

Rough estimate: W1 + W2 are the bulk of the work; W3/W4 are cleanup.

---

## Open questions for the user

1. **Organization scope for config.** Grafana puts datasources under
   orgs (one set of Prometheus per org). Right now openobs keeps them
   instance-global. Do we want instance-global for v1 and per-org later,
   or do we want to put `org_id` on `instance_datasources` from the
   start (null = instance-global)?
2. **Credential encryption.** Should encrypted creds use the existing
   `SECRET_KEY` (via `common/crypto/secret-box.ts`) or should
   datasource/notification creds be isolated under a separate key? The
   separate-key approach matches Grafana Enterprise's `datasource_encryption`
   feature but adds operator complexity.
3. **Feature flags / deprecation window.** Any installed users we have
   now will have `setup-config.json`. T2.3 migrates it once and
   sidelines the file. Do we want a deprecation warning that hangs
   around for one minor release, or one-shot silent migration?
