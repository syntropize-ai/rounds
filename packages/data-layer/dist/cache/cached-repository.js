// CachedRepository - read-through cache wrapper for IRepository<T>.
//
// Pattern:
//   findById -> cache hit -> return cached value
//            -> cache miss -> query DB -> cache result -> return
//
//   create / update / delete -> execute on DB -> invalidate / update cache entry
export class CachedRepository {
    repo;
    cache;
    ttlSeconds;
    prefix;
    constructor(repo, cache, config) {
        this.repo = repo;
        this.cache = cache;
        this.ttlSeconds = config.ttlSeconds;
        this.prefix = config.cacheKeyPrefix;
    }
    // Read-through
    async findById(id) {
        const key = this.key(id);
        const cached = await this.cache.get(key);
        if (cached !== null)
            return cached;
        const entity = await this.repo.findById(id);
        if (entity !== undefined) {
            await this.cache.set(key, entity, this.ttlSeconds);
        }
        return entity;
    }
    /** Collection queries bypass the cache - too variable to cache safely. */
    async findAll(opts) {
        return this.repo.findAll(opts);
    }
    async count() {
        return this.repo.count();
    }
    // Write-through (cache invalidation)
    async create(data) {
        const entity = await this.repo.create(data);
        await this.cache.set(this.key(entity.id), entity, this.ttlSeconds);
        return entity;
    }
    async update(id, patch) {
        const entity = await this.repo.update(id, patch);
        if (entity !== undefined) {
            // Refresh cache with the updated entity
            await this.cache.set(this.key(id), entity, this.ttlSeconds);
        }
        else {
            // Entity was not found (or deleted concurrently) - remove stale entry
            await this.cache.del(this.key(id));
        }
        return entity;
    }
    async delete(id) {
        const result = await this.repo.delete(id);
        await this.cache.del(this.key(id));
        return result;
    }
    // Helpers
    key(id) {
        return `${this.prefix}:${id}`;
    }
}
//# sourceMappingURL=cached-repository.js.map