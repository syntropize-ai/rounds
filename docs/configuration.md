# Configuration

Rounds is configured through environment variables.

## Core settings

| Variable | Required | Description |
| --- | --- | --- |
| `JWT_SECRET` | Yes | Secret for signing auth tokens. Minimum 32 characters. |
| `PORT` | No | API server port. |
| `HOST` | No | API bind host. |
| `CORS_ORIGINS` | No | Comma-separated list of allowed origins. |
| `API_KEYS` | No | Comma-separated service API keys. |

## LLM settings

| Variable | Required | Description |
| --- | --- | --- |
| `LLM_PROVIDER` | No | Default provider. |
| `LLM_API_KEY` | No | Primary provider API key. |
| `LLM_MODEL` | No | Default model name. |
| `LLM_FALLBACK_PROVIDER` | No | Optional fallback provider. |

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
| `DATABASE_POOL_SIZE` | No | Pool size for Postgres. |
| `DATABASE_SSL` | No | Enable Postgres SSL. |
| `REDIS_URL` | No | Redis connection string. |
| `REDIS_PREFIX` | No | Redis key prefix. |
| `DATA_DIR` | No | Local data directory for containerized or SQLite mode. |
| `SQLITE_PATH` | No | Explicit SQLite file path. Overrides `DATA_DIR`. |

Rounds selects its database before the server starts. The setup wizard writes
application settings into the active backend; it does not switch databases.

Supported backends:

| Backend | How to enable | Best for |
| --- | --- | --- |
| SQLite | Leave `DATABASE_URL` unset | Local development, npm installs, single-process evaluation |
| Postgres | Set `DATABASE_URL=postgresql://...` before first start | Production, Kubernetes, multi-replica deployments |

By default, Rounds uses SQLite:

- npm: `~/.syntropize/rounds.db`
- Helm/container: `${DATA_DIR}/rounds.db`, which defaults to `/var/lib/syntropize/rounds.db`

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

## Docs note

The canonical environment template lives in the repository root as `.env.example`.
Keep that file and this page in sync when configuration changes.
