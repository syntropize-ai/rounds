// RedisCacheProvider — ioredis-backed distributed cache.
// Accepts any ioredis-compatible client so callers can inject real or mock
// instances without hard-coupling to the ioredis package at the call site.
export class RedisCacheProvider {
  client;
  constructor(client) {
    this.client = client;
  }
  async get(key) {
    const raw = await this.client.get(key);
    if (raw === null)
      return null;
    try {
      return JSON.parse(raw);
    }
    catch {
      return null;
    }
  }
  async set(key, value, ttlSeconds) {
    const serialized = JSON.stringify(value);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.client.set(key, serialized, 'EX', ttlSeconds);
    }
    else {
      await this.client.set(key, serialized);
    }
  }
  async del(key) {
    await this.client.del(key);
  }
  async exists(key) {
    const count = await this.client.exists(key);
    return count > 0;
  }
  async ttl(key) {
    const seconds = await this.client.ttl(key);
    // ioredis returns -1 for no expiry, -2 for missing key
    if (seconds === -2)
      return -1; // normalise missing → -1
    if (seconds === -1)
      return null; // no expiry
    return seconds;
  }
  /** Gracefully close the underlying Redis connection. */
  async disconnect() {
    await this.client.quit();
  }
}
/**
 * Factory — creates a RedisCacheProvider from a connection URL.
 * Uses a dynamic import so the ioredis package is only loaded when this
 * function is called (not at module load time), keeping tests fast.
 */
export async function createRedisCacheProvider(url = process.env['REDIS_URL'] ?? 'redis://localhost:6379') {
  // Dynamic import keeps ioredis optional at module-load time
  const { default: Redis } = await import('ioredis');
  const client = new Redis(url);
  return new RedisCacheProvider(client);
}
//# sourceMappingURL=redis.js.map
