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
  let text = rendered.sql;
  text = text
    .replace(/\bFROM\s+user\b/gi, 'FROM "user"')
    .replace(/\bINTO\s+user\b/gi, 'INTO "user"')
    .replace(/\bUPDATE\s+user\b/gi, 'UPDATE "user"')
    .replace(/\bDELETE\s+FROM\s+user\b/gi, 'DELETE FROM "user"')
    .replace(/\bJOIN\s+user\b/gi, 'JOIN "user"');
  return { text, params: rendered.params };
}
