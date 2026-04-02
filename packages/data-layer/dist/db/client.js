import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';
export function createDbClient(opts) {
  const pool = new Pool({
    connectionString: opts.url,
    max: opts.poolSize ?? 10,
    ssl: opts.ssl ? { rejectUnauthorized: process.env['DB_SSL_REJECT_UNAUTHORIZED'] !== 'false' } : undefined,
  });
  return drizzle(pool, { schema });
}
//# sourceMappingURL=client.js.map
