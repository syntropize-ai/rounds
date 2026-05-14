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
Postgres for the full repository layer: auth, RBAC, settings, connectors,
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
