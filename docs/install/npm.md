# Install with npm

The fastest way to try Rounds on a single machine. Good for laptops, evaluation, and small self-hosted setups.

## Requirements

- Node.js 20 or later

## Run instantly with npx

No install — every invocation pulls the latest published version:

```bash
npx @syntropize/rounds
```

The first run downloads the package, then starts the API on `http://localhost:3000` and the web UI on `http://localhost:5173`. Open the web URL in your browser; the setup wizard walks you through:

1. Creating the first administrator account
2. Configuring your LLM provider key
3. Adding at least one metrics connector (Prometheus, VictoriaMetrics, etc.)

## Install globally

If you'll run Rounds more than once, install it once and call it directly:

```bash
npm install -g @syntropize/rounds
rounds
```

Upgrade with the same command — `npm install -g @syntropize/rounds` re-fetches the latest.

## Configure via environment variables

For unattended setups (CI, headless servers), skip the wizard by setting variables before the first start:

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
export LLM_PROVIDER=anthropic
export LLM_API_KEY=sk-ant-...
export SEED_ADMIN=true
export SEED_ADMIN_EMAIL=admin@example.com
export SEED_ADMIN_LOGIN=admin
export SEED_ADMIN_PASSWORD='at-least-12-chars'
rounds
```

See [Configuration](/configuration) for the complete environment variable reference.

## Where data lives

By default Rounds uses an embedded SQLite database stored in:

- macOS / Linux: `~/.syntropize/rounds.db`
- Windows: `%USERPROFILE%\.rounds\rounds.db`

Override with `DATA_DIR=/path/to/dir` or `SQLITE_PATH=/path/to/rounds.db`.

The npm package is intended for a single local Rounds process and defaults to
SQLite. If you want npm to use Postgres, set `DATABASE_URL` before the first
start:

```bash
export DATABASE_URL='postgresql://rounds:password@localhost:5432/rounds'
rounds
```

For multi-instance deployments, use Kubernetes and an external Postgres
database. See [Configuration → Storage settings](/configuration#storage-settings).

SQLite and Postgres are the supported database backends today. Database
selection happens before Rounds starts, not in the setup wizard.

## Upgrading

```bash
npm install -g @syntropize/rounds@latest
rounds
```

Rounds runs database migrations automatically on start. Back up `rounds.db` (or your Postgres database) before a major version bump.

## Uninstalling

```bash
npm uninstall -g @syntropize/rounds
rm -rf ~/.rounds        # delete the data directory if you want a clean wipe
```
