# Configuration

Infrastructure settings — ports, database, secrets, worker toggles — come from
environment variables. Application settings — the LLM provider, connectors,
users, roles — live in the database and are managed in the setup wizard and the
admin UI. This page lists the environment variables the server actually reads.

## Core settings

| Variable | Required | Description |
| --- | --- | --- |
| `JWT_SECRET` | In production | Signing key for sessions. Minimum 32 characters. Outside `NODE_ENV=production` it is generated on first boot and persisted to `<DATA_DIR>/secrets.json`. |
| `SECRET_KEY` | In production | AES-GCM key used to encrypt credentials at rest (connector auth, OAuth tokens, LLM keys). Minimum 32 characters; same first-boot generation rule as `JWT_SECRET`. |
| `PORT` | No | API server port. Default `3000`. |
| `NODE_ENV` | No | `production` disables dev conveniences: secrets are never auto-generated and CORS must be configured explicitly. |
| `CORS_ORIGINS` | In production | Comma-separated list of allowed origins. With `NODE_ENV=production` the server refuses to start if this is empty or `*`. |
| `API_KEYS` | No | Legacy static API keys, format `name:key,name2:key2`. Prefer service accounts and user tokens created in the UI. |
| `ROUNDS_BASE_URL` | No | Public base URL of this instance, used to build GitHub App callback URLs. `APP_BASE_URL` is accepted as a fallback name. |
| `OPENOBS_ALLOW_PRIVATE_URLS` | No | Allow connectors and LLM base URLs to resolve to private / loopback addresses. Blocked by default — see [Network security settings](#network-security-settings). |
| `OPENOBS_RATE_LIMIT_MAX` | No | Per-IP request ceiling per 60s window. Default `600`. |
| `OPENOBS_USER_RATE_LIMIT_MAX` | No | Per-user request ceiling per 60s window. Default `600`. |
| `OPENOBS_PASSWORD_MIN_LENGTH` | No | Minimum local-account password length. Default `12`. |
| `PERMISSION_ESCALATION_CONTACT` | No | Contact string the agent shows when it needs a permission it does not have. |
| `LOG_LEVEL` | No | pino level (`trace`…`fatal`). Default `info`. Log output is always JSON. |

## LLM settings

The provider, model, and API key are configured in the setup wizard (or
Settings → LLM) and stored encrypted in the database. There is no environment
variable for them.

| Variable | Required | Description |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | No | Used **only** by the setup wizard's "Test connection" probe for Anthropic when no key has been saved yet. |
| `GEMINI_API_KEY` | No | Same, for Gemini. |
| `OPENOBS_THINKING_EFFORT` | No | Extended-thinking budget: `low`, `medium` (default), or `high`. |
| `DASHBOARD_VERIFY_GATE` | No | Set to `0` to accept dashboard writes that fail the verification gate. |

## Network security settings

| Variable | Required | Description |
| --- | --- | --- |
| `OPENOBS_ALLOW_PRIVATE_URLS` | No | Set to `true` to allow outbound requests to private, loopback and link-local addresses. Blocked by default. |

Every URL Rounds fetches on the server's behalf — connectors, webhook
subscriptions, notification senders, OAuth endpoints, self-hosted LLM endpoints —
is checked before the request goes out. By default Rounds refuses hosts that
resolve to loopback (`127.0.0.0/8`, `::1`), RFC1918 ranges, link-local
(`169.254.0.0/16`, including the cloud metadata endpoint `169.254.169.254`),
IPv6 ULA/link-local, and the IPv4-mapped IPv6 spelling of any of those
(`::ffff:10.0.0.1`). Hostnames are also re-checked against their resolved
address, so a public name pointing at an internal IP is rejected too.

Set `OPENOBS_ALLOW_PRIVATE_URLS=true` when Rounds is meant to reach services on
its own network — an in-cluster `http://prometheus.monitoring:9090`, or a
`http://localhost:9090` on a single-host install. The Helm chart ships with it
set to `true` for exactly this reason (`env.OPENOBS_ALLOW_PRIVATE_URLS` in
`helm/rounds/values.yaml`); set it to `false` there for multi-tenant or
public-facing deployments, where any user who can add a connector could
otherwise pivot through Rounds into your internal network.

## Storage settings

| Variable | Required | Description |
| --- | --- | --- |
| `DATABASE_URL` | No | Database connection string. Use `postgres://` or `postgresql://` for Postgres. Leave unset for local SQLite mode. |
| `DATABASE_POOL_SIZE` | No | Pool size for Postgres. Default `10`. |
| `DATABASE_SSL` | No | Enable Postgres SSL (`true` / `1`). |
| `DB_SSL_REJECT_UNAUTHORIZED` | No | Set to `false` to accept self-signed Postgres certificates. |
| `REDIS_URL` | No | Redis connection string. Backs the event bus, job queues, and cache; required for multi-replica deployments. |
| `DATA_DIR` | No | Directory holding `rounds.db` and `secrets.json`. Defaults to `<cwd>/.rounds`; the `rounds` CLI defaults it to `~/.rounds`. |
| `SQLITE_PATH` | No | Explicit SQLite file path. Overrides `DATA_DIR`. |

Rounds selects its database before the server starts. The setup wizard writes
application settings into the active backend; it does not switch databases.

Supported backends:

| Backend | How to enable | Best for |
| --- | --- | --- |
| SQLite | Leave `DATABASE_URL` unset | Local development, npm installs, single-process evaluation |
| Postgres | Set `DATABASE_URL=postgresql://...` before first start | Production, Kubernetes, multi-replica deployments |

By default, Rounds uses SQLite:

- npm: `~/.rounds/rounds.db` (the `rounds` CLI sets `DATA_DIR` to `~/.rounds`)
- Helm/container: `${DATA_DIR}/rounds.db`, and the chart sets `DATA_DIR` to `/var/lib/rounds`

When `DATABASE_URL` starts with `postgres://` or `postgresql://`, Rounds uses
Postgres for the full repository layer: auth, RBAC, settings, datasources,
dashboards, investigations, alerts, notifications, chat, and feed data. The
repository boundary is database-agnostic so additional SQL backends can be added
without changing product flows, but SQLite and Postgres are the supported
backends today.

Choose the database backend before first startup. The setup wizard can store
application settings such as the LLM provider, but it cannot switch databases
because Rounds must connect to its database before the wizard can load. Changing
`DATABASE_URL` later starts Rounds against a different empty or pre-existing
database; it does not migrate data from SQLite to Postgres.

## Admin bootstrap

Seeding runs only while the user table is still empty — it is a way to skip the
wizard's first step on unattended installs, not a way to manage users.

| Variable | Required | Description |
| --- | --- | --- |
| `SEED_ADMIN_EMAIL` | No | Email of the admin to create on first boot. Required together with `SEED_ADMIN_PASSWORD` for seeding to happen. |
| `SEED_ADMIN_PASSWORD` | No | Password for that admin. Must satisfy `OPENOBS_PASSWORD_MIN_LENGTH` or the seed is skipped. |
| `SEED_ADMIN_LOGIN` | No | Login name. Default `admin`. |
| `SEED_ADMIN_NAME` | No | Display name. Default `Server Admin`. |

## Background workers

| Variable | Required | Description |
| --- | --- | --- |
| `ALERT_EVALUATOR_ENABLED` | No | Periodic alert-rule evaluation. Default on. |
| `ALERT_EVALUATOR_REFRESH_MS` | No | Evaluation interval. Default `60000`. |
| `ALERT_EVALUATOR_HA` | No | Take a leader lock so only one replica evaluates. Requires a database. Default off. |
| `ALERT_EVALUATOR_LEADER_TTL_MS` | No | Leader-lock TTL. Default `30000`. |
| `AUTO_INVESTIGATION_ENABLED` | No | Run a background investigation when an alert fires. Default on. |
| `PLAN_EXPIRY_SWEEP_MS` | No | Remediation-plan expiry sweep interval. Default `60000`. |
| `PENDING_CHANGES_SWEEP_MS` | No | Pending-change expiry sweep interval. Default `3600000`. |

Authentication providers (OAuth, SAML, LDAP) have their own environment
variables — see [Authentication](/auth#authentication-methods).

## Docs note

The canonical environment template lives in the repository root as `.env.example`.
Keep that file and this page in sync when configuration changes.
