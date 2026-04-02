// InMemoryCacheProvider - Map-backed cache with per-entry TTL.
// Intended for testing and local development; not suitable for multi-process deployments.

import type { CacheProvider } from './types.js';

interface Entry {
  value: unknown;
  /** UNIX timestamp (ms) when this entry expires, or null for no expiry. */
  expiresAt: number | null;
}

export class InMemoryCacheProvider implements CacheProvider {
  private readonly store = new Map<string, Entry>();

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const expiresAt =
      ttlSeconds !== undefined && ttlSeconds > 0
        ? Date.now() + ttlSeconds * 1000
        : null;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== null;
  }

  async ttl(key: string): Promise<number | null> {
    const entry = this.store.get(key);
    if (!entry) return -1;
    if (entry.expiresAt === null) return null;
    const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
    if (remaining <= 0) {
      this.store.delete(key);
      return -1;
    }
    return remaining;
  }

  /** Test helper - remove all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Test helper - current number of live entries (unexpired). */
  get size(): number {
    return this.store.size;
  }
}
