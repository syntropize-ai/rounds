import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './sqlite-schema.js';
import type { QueryClient } from './query-client.js';

export type SqliteClient = ReturnType<typeof createSqliteClient>;

export interface SqliteClientOptions {
  /** Path to the SQLite database file. Use ':memory:' for in-memory. */
  path: string;
  /** Enable WAL mode for better concurrent read performance. Defaults to true. */
  wal?: boolean;
}

export function createSqliteClient(opts: SqliteClientOptions): ReturnType<typeof drizzle<typeof schema>> & {
  withTransaction<T>(fn: (tx: QueryClient) => Promise<T>): Promise<T>;
} {
  if (opts.path !== ':memory:') {
    mkdirSync(dirname(opts.path), { recursive: true });
  }
  const sqlite = new Database(opts.path);

  // Enable WAL mode for better concurrent read performance
  if (opts.wal !== false) {
    sqlite.pragma('journal_mode = WAL');
  }

  // Recommended SQLite pragmas for performance
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  // Serialises overlapping withTransaction calls on the single connection.
  let transactionQueue: Promise<void> = Promise.resolve();
  return Object.assign(db, {
    // better-sqlite3 is single-connection by design, so BEGIN/COMMIT here
    // bracket the one session. That makes overlap the hazard rather than
    // isolation: `fn` is async, so a second caller reaching BEGIN while the
    // first is awaiting throws "cannot start a transaction within a
    // transaction" on the shared connection.
    //
    // It stayed invisible while transactions came from HTTP handlers, which
    // rarely overlap. An agent turn breaks that: chat_session_event rows are
    // written continuously as the model streams, so any tool that writes in a
    // transaction — creating a connector, say — lands inside someone else's
    // BEGIN and fails. Serialising is enough; the queue is FIFO and a failed
    // transaction does not poison the ones behind it.
    //
    // Callers must not nest `withTransaction` (no sqlite repository does):
    // an inner call would wait on the outer one and deadlock.
    async withTransaction<T>(fn: (tx: QueryClient) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> => {
        sqlite.exec('BEGIN');
        try {
          const result = await fn(db as unknown as QueryClient);
          sqlite.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            sqlite.exec('ROLLBACK');
          } catch {
            /* swallow rollback failure; surface the original error */
          }
          throw err;
        }
      };
      const queued = transactionQueue.then(run, run);
      transactionQueue = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
  });
}
