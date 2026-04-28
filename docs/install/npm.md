# Install with npm

The fastest way to try OpenObs on a single machine. Good for laptops, evaluation, and small self-hosted setups.

## Requirements

- Node.js 20 or later

## Run instantly with npx

No install — every invocation pulls the latest published version:

```bash
npx openobs
```

The first run downloads the package, then starts the API on `http://localhost:3000` and the web UI on `http://localhost:5173`. Open the web URL in your browser; the setup wizard walks you through:

1. Creating the first administrator account
2. Configuring your LLM provider key
3. Adding at least one datasource (Prometheus, VictoriaMetrics, etc.)

## Install globally

If you'll run OpenObs more than once, install it once and call it directly:

```bash
npm install -g openobs
openobs
```

Upgrade with the same command — `npm install -g openobs` re-fetches the latest.

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
openobs
```

See [Configuration](/configuration) for the complete environment variable reference.

## Where data lives

By default OpenObs uses an embedded SQLite database stored in:

- macOS / Linux: `~/.openobs/openobs.db`
- Windows: `%USERPROFILE%\.openobs\openobs.db`

Override with `DATA_DIR=/path/to/dir` or `SQLITE_PATH=/path/to/openobs.db`.

The npm package is intended for a single local OpenObs process. For
multi-instance deployments, use Kubernetes and an external database once full
Postgres persistence is enabled. See [Configuration → Storage settings](/configuration#storage-settings).

## Upgrading

```bash
npm install -g openobs@latest
openobs
```

OpenObs runs database migrations automatically on start. Back up `openobs.db` (or your Postgres database) before a major version bump.

## Uninstalling

```bash
npm uninstall -g openobs
rm -rf ~/.openobs        # delete the data directory if you want a clean wipe
```
