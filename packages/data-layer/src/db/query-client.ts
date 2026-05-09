import type { SQL } from 'drizzle-orm';
import { CasingCache } from 'drizzle-orm/casing';

export interface QueryClient {
  all<T>(query: SQL): T[] | Promise<T[]>;
  run(query: SQL): unknown | Promise<unknown>;
  /**
   * Run `fn` inside a database transaction. The runner passed to `fn` is
   * pinned to a single connection (Postgres uses `pool.connect()`, SQLite
   * is single-connection by definition). Throwing from `fn` rolls back.
   */
  withTransaction<T>(fn: (tx: QueryClient) => Promise<T>): Promise<T>;
}

export function renderSql(query: SQL): { text: string; params: unknown[] } {
  const rendered = query.toQuery({
    casing: new CasingCache(),
    escapeName: (name) => `"${name}"`,
    escapeParam: (num) => `$${num + 1}`,
    escapeString: (str) => `'${str.replace(/'/g, "''")}'`,
  });
  return { text: rendered.sql, params: rendered.params };
}
