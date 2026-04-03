import type { CacheProvider } from './types.js';
export declare class InMemoryCacheProvider implements CacheProvider {
    private readonly store;
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    ttl(key: string): Promise<number | null>;
    /** Test helper - remove all entries. */
    clear(): void;
    /** Test helper - current number of live entries (unexpired). */
    get size(): number;
}
//# sourceMappingURL=in-memory.d.ts.map