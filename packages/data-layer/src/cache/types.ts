// Cache layer types and TTL policy constants

export interface CacheProvider {
  /** Returns the cached value, or null on miss or expiry. */
  get<T>(key: string): Promise<T | null>;

  /** Store a value. If ttlSeconds is omitted the entry persists indefinitely. */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /** Remove a key. No-op if the key does not exist. */
  del(key: string): Promise<void>;

  /** Returns true if the key exists and has not expired. */
  exists(key: string): Promise<boolean>;

  /**
   * Returns the remaining TTL in seconds, or:
   *  null  -> key exists but has no expiry
   *  -1    -> key does not exist
   */
  ttl(key: string): Promise<number | null>;
}

// TTL policy by domain entity type
export const CACHE_TTL = {
  /** Active investigations change frequently -> 5 minute window. */
  INVESTIGATION: 5 * 60,
  /** Sessions are longer-lived -> 30 minute window. */
  SESSION: 30 * 60,
  /** Incidents are queried often but change less -> 10 minute window. */
  INCIDENT: 10 * 60,
  /** Cases are relatively stable -> 15 minute window. */
  CASE: 15 * 60,
} as const;
