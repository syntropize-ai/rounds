import type { IRepository, FindAllOptions } from '../repository/interfaces.js';
import type { CacheProvider } from './types.js';
export interface CachedRepositoryConfig {
    /** TTL in seconds for cached entries. */
    ttlSeconds: number;
    /**
     * Prefix for all cache keys managed by this wrapper.
     * Should be unique per entity type, e.g. "inv", "incident", "case".
     */
    cacheKeyPrefix: string;
}
export declare class CachedRepository<T extends {
    id: string;
}> implements IRepository<T> {
    private readonly repo;
    private readonly cache;
    private readonly ttlSeconds;
    private readonly prefix;
    constructor(repo: IRepository<T>, cache: CacheProvider, config: CachedRepositoryConfig);
    findById(id: string): Promise<T | undefined>;
    /** Collection queries bypass the cache - too variable to cache safely. */
    findAll(opts?: FindAllOptions<T>): Promise<T[]>;
    count(): Promise<number>;
    create(data: Omit<T, 'id' | 'createdAt'> & {
        id?: string;
    }): Promise<T>;
    update(id: string, patch: Partial<Omit<T, 'id'>>): Promise<T | undefined>;
    delete(id: string): Promise<boolean>;
    private key;
}
//# sourceMappingURL=cached-repository.d.ts.map