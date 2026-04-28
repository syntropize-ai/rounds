# Configuration

OpenObs is configured through environment variables.

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
| `DATABASE_URL` | No | Postgres connection string for supported Postgres-backed tables. Leave unset for local SQLite mode. |
| `DATABASE_POOL_SIZE` | No | Pool size for Postgres. |
| `DATABASE_SSL` | No | Enable Postgres SSL. |
| `REDIS_URL` | No | Redis connection string. |
| `REDIS_PREFIX` | No | Redis key prefix. |
| `DATA_DIR` | No | Local data directory for containerized or SQLite mode. |
| `SQLITE_PATH` | No | Explicit SQLite file path. Overrides `DATA_DIR`. |

By default, OpenObs uses SQLite:

- npm: `~/.openobs/openobs.db`
- Helm/container: `${DATA_DIR}/openobs.db`, which defaults to `/var/lib/openobs/openobs.db`

`DATABASE_URL` currently enables Postgres-backed instance configuration tables
such as LLM provider settings, datasources, and notification channels. It does
not yet move every table off SQLite, so keep Kubernetes deployments at one
replica unless you are running a build with full Postgres persistence.

## Docs note

The canonical environment template lives in the repository root as `.env.example`.
Keep that file and this page in sync when configuration changes.
