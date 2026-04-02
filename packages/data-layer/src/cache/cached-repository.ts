// CachedRepository - read-through cache wrapper for IRepository<T>.
//
// Pattern:
//   findById -> cache hit -> return cached value
//            -> cache miss -> query DB -> cache result -> return
//
//   create / update / delete -> execute on DB -> invalidate / update cache entry

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

export class CachedRepository<T extends { id: string }> implements IRepository<T> {
  private readonly repo: IRepository<T>;
  private readonly cache: CacheProvider;
  private readonly ttlSeconds: number;
  private readonly prefix: string;

  constructor(
    repo: IRepository<T>,
    cache: CacheProvider,
    config: CachedRepositoryConfig,
  ) {
    this.repo = repo;
    this.cache = cache;
    this.ttlSeconds = config.ttlSeconds;
    this.prefix = config.cacheKeyPrefix;
  }

  // Read-through
  async findById(id: string): Promise<T | undefined> {
    const key = this.key(id);
    const cached = await this.cache.get<T>(key);
    if (cached !== null) return cached;

    const entity = await this.repo.findById(id);
    if (entity !== undefined) {
      await this.cache.set(key, entity, this.ttlSeconds);
    }
    return entity;
  }

  /** Collection queries bypass the cache - too variable to cache safely. */
  async findAll(opts?: FindAllOptions<T>): Promise<T[]> {
    return this.repo.findAll(opts);
  }

  async count(): Promise<number> {
    return this.repo.count();
  }

  // Write-through (cache invalidation)
  async create(data: Omit<T, 'id' | 'createdAt'> & { id?: string }): Promise<T> {
    const entity = await this.repo.create(data);
    await this.cache.set(this.key(entity.id), entity, this.ttlSeconds);
    return entity;
  }

  async update(id: string, patch: Partial<Omit<T, 'id'>>): Promise<T | undefined> {
    const entity = await this.repo.update(id, patch);
    if (entity !== undefined) {
      // Refresh cache with the updated entity
      await this.cache.set(this.key(id), entity, this.ttlSeconds);
    } else {
      // Entity was not found (or deleted concurrently) - remove stale entry
      await this.cache.del(this.key(id));
    }
    return entity;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.repo.delete(id);
    await this.cache.del(this.key(id));
    return result;
  }

  // Helpers
  private key(id: string): string {
    return `${this.prefix}:${id}`;
  }
}
