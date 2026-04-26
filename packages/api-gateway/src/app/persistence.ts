/**
 * Persistence wiring extracted from `server.ts::createApp()`.
 *
 * Returns the configured SqliteRepositories bundle plus the underlying
 * SqliteClient (the auth, RBAC, folder, and instance-config repos all
 * need direct DB access). Two backends:
 *
 *   - SQLite (default) — single-file DB under DATA_DIR / SQLITE_PATH.
 *   - Postgres-hybrid — `DATABASE_URL=postgres(ql)://...` swaps the W2
 *     instance-config repos (LLM, datasources, notification channels) to
 *     Postgres while everything else stays on SQLite. Postgres migrations
 *     run via `applyPostgresInstanceMigrations`; we await them now (was
 *     fire-and-forget) so the gateway never serves a request against an
 *     unmigrated schema.
 *
 * Any non-Postgres `DATABASE_URL` value is logged at warn and ignored —
 * historically that env var gated an in-memory mode that W2 deleted.
 */

import {
  createSqliteClient,
  createSqliteRepositories,
  ensureSchema,
  applyNamedMigrations,
  createDbClient,
  PostgresInstanceConfigRepository,
  PostgresDatasourceRepository,
  PostgresNotificationChannelRepository,
  applyPostgresInstanceMigrations,
} from '@agentic-obs/data-layer';
import type { SqliteRepositories } from '@agentic-obs/data-layer';
import { createLogger } from '@agentic-obs/common/logging';
import { dbPath } from '../paths.js';

const log = createLogger('persistence');

export type SqliteClient = ReturnType<typeof createSqliteClient>;

export interface Persistence {
  repos: SqliteRepositories;
  sqliteDb: SqliteClient;
}

function isPostgresUrl(
  url: string | undefined,
): url is `postgres://${string}` | `postgresql://${string}` {
  return (
    typeof url === 'string' &&
    (url.startsWith('postgres://') || url.startsWith('postgresql://'))
  );
}

function buildSqlite(): { repos: SqliteRepositories; sqliteDb: SqliteClient } {
  const sqliteDb = createSqliteClient({ path: dbPath() });
  ensureSchema(sqliteDb);
  applyNamedMigrations(sqliteDb);
  return { repos: createSqliteRepositories(sqliteDb), sqliteDb };
}

async function buildPostgresHybrid(
  url: string,
): Promise<{ repos: SqliteRepositories; sqliteDb: SqliteClient }> {
  const base = buildSqlite();
  const pg = createDbClient({ url });
  // Awaited (was fire-and-forget) — boot must not race instance-config
  // queries against an unmigrated schema.
  await applyPostgresInstanceMigrations(pg);
  return {
    sqliteDb: base.sqliteDb,
    repos: {
      ...base.repos,
      instanceConfig: new PostgresInstanceConfigRepository(pg),
      datasources: new PostgresDatasourceRepository(pg),
      notificationChannels: new PostgresNotificationChannelRepository(pg),
    },
  };
}

export interface PersistenceConfig {
  /** Read from `process.env.DATABASE_URL` when undefined. */
  databaseUrl?: string | undefined;
}

export async function createPersistence(
  config: PersistenceConfig = {},
): Promise<Persistence> {
  const dbUrl = config.databaseUrl ?? process.env['DATABASE_URL'];

  if (dbUrl && !isPostgresUrl(dbUrl)) {
    log.warn(
      { dbUrl: dbUrl.slice(0, 12) },
      'DATABASE_URL is set but does not start with postgres://; falling back to SQLite',
    );
  }

  if (isPostgresUrl(dbUrl)) {
    return buildPostgresHybrid(dbUrl);
  }
  return buildSqlite();
}
