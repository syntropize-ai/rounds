// InMemoryCacheProvider - Map-backed cache with per-entry TTL.
// Intended for testing and local development; not suitable for multi-process deployments.
export class InMemoryCacheProvider {
    store = new Map();
    async get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }
    async set(key, value, ttlSeconds) {
        const expiresAt = ttlSeconds !== undefined && ttlSeconds > 0
            ? Date.now() + ttlSeconds * 1000
            : null;
        this.store.set(key, { value, expiresAt });
    }
    async del(key) {
        this.store.delete(key);
    }
    async exists(key) {
        const val = await this.get(key);
        return val !== null;
    }
    async ttl(key) {
        const entry = this.store.get(key);
        if (!entry)
            return -1;
        if (entry.expiresAt === null)
            return null;
        const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
        if (remaining <= 0) {
            this.store.delete(key);
            return -1;
        }
        return remaining;
    }
    /** Test helper - remove all entries. */
    clear() {
        this.store.clear();
    }
    /** Test helper - current number of live entries (unexpired). */
    get size() {
        return this.store.size;
    }
}
//# sourceMappingURL=in-memory.js.map