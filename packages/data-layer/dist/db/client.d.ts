import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
export type DbClient = ReturnType<typeof createDbClient>;
export interface DbClientOptions {
    url: string;
    poolSize?: number;
    ssl?: boolean;
}
export declare function createDbClient(opts: DbClientOptions): ReturnType<typeof drizzle<typeof schema>>;
//# sourceMappingURL=client.d.ts.map