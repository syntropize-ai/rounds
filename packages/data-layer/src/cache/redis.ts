// RedisCacheProvider - ioredis-backed distributed cache.
//
// Accepts any ioredis-compatible client so callers can inject real or mock
// instances without hard-coupling to the ioredis package at the call site.

import type { CacheProvider } from './types.js';

/**
 * Minimal interface for the ioredis methods we use.
 * Satisfied by `new Redis(...)` from ioredis, and easy to mock in tests.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exFlag: 'EX', seconds: number): Promise<'OK' | null>;
  set(key: string, value: string): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  ttl(key: string): Promise<number>;
  quit(): Promise<'OK'>;
}

export class RedisCacheProvider implements CacheProvider {
  constructor(private readonly client: RedisClient) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const serialized = JSON.stringify(value);
    if (ttlSeconds !== undefined && ttlSeconds > 0) {
      await this.client.set(key, serialized, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const count = await this.client.exists(key);
    return count > 0;
  }

  async ttl(key: string): Promise<number | null> {
    const seconds = await this.client.ttl(key);
    // ioredis returns -1 for no expiry, -2 for missing key
    if (seconds === -2) return -1; // normalized missing
    if (seconds === -1) return null; // no expiry
    return seconds;
  }

  /** Gracefully close the underlying Redis connection. */
  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}

/**
 * Factory - creates a RedisCacheProvider from a connection URL.
 * Uses a dynamic import so the ioredis package is only loaded when this
 * function is called (not at module load time), keeping tests fast.
 */
export async function createRedisCacheProvider(
  url: string = process.env['REDIS_URL'] ?? 'redis://localhost:6379',
): Promise<RedisCacheProvider> {
  // Dynamic import keeps ioredis optional at module-load time
  const { default: Redis } = (await import('ioredis')) as unknown as { default: new (url: string) => RedisClient };
  const client = new Redis(url);
  return new RedisCacheProvider(client);
}
