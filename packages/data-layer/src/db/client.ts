import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
import { renderSql, type QueryClient } from './query-client.js';

export type DbClient = ReturnType<typeof createDbClient>;

export interface DbClientOptions {
  url: string;
  poolSize?: number;
  ssl?: boolean;
}

export function createDbClient(
  opts: DbClientOptions,
): ReturnType<typeof drizzle<typeof schema>> & { $pool: Pool } & QueryClient {
  const pool = new Pool({
    connectionString: opts.url,
    max: opts.poolSize ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: process.env['DB_SSL_REJECT_UNAUTHORIZED'] !== 'false' } : undefined,
  });

  return Object.assign(drizzle(pool, { schema }), {
    $pool: pool,
    async all<T>(query: Parameters<QueryClient['all']>[0]): Promise<T[]> {
      const { text, params } = renderSql(query);
      const result = await pool.query(text, params);
      return result.rows as T[];
    },
    async run(query: Parameters<QueryClient['run']>[0]): Promise<void> {
      const { text, params } = renderSql(query);
      await pool.query(text, params);
    },
    async withTransaction<T>(fn: (tx: QueryClient) => Promise<T>): Promise<T> {
      const conn = await pool.connect();
      // Pin every query in `fn` to the dedicated connection so BEGIN/COMMIT
      // bracket the same session.
      const tx: QueryClient = {
        async all<U>(query: Parameters<QueryClient['all']>[0]): Promise<U[]> {
          const { text, params } = renderSql(query);
          const result = await conn.query(text, params);
          return result.rows as U[];
        },
        async run(query: Parameters<QueryClient['run']>[0]): Promise<void> {
          const { text, params } = renderSql(query);
          await conn.query(text, params);
        },
        // Nested transactions reuse the same connection. SAVEPOINT support is
        // not required by current callers; if added later, this is the place.
        withTransaction(inner) {
          return inner(tx);
        },
      };
      try {
        await conn.query('BEGIN');
        const result = await fn(tx);
        await conn.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await conn.query('ROLLBACK');
        } catch {
          /* swallow rollback failure; surface the original error */
        }
        throw err;
      } finally {
        conn.release();
      }
    },
  });
}
