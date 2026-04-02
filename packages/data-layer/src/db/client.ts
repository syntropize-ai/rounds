import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type DbClient = ReturnType<typeof createDbClient>;

export interface DbClientOptions {
  url: string;
  poolSize?: number;
  ssl?: boolean;
}

export function createDbClient(opts: DbClientOptions): ReturnType<typeof drizzle<typeof schema>> {
  const pool = new Pool({
    connectionString: opts.url,
    max: opts.poolSize ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: process.env['DB_SSL_REJECT_UNAUTHORIZED'] !== 'false' } : undefined,
  });

  return drizzle(pool, { schema });
}
