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
export declare class RedisCacheProvider implements CacheProvider {
    private readonly client;
    constructor(client: RedisClient);
    get<T>(key: string): Promise<T | null>;
    set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
    del(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    ttl(key: string): Promise<number | null>;
    /** Gracefully close the underlying Redis connection. */
    disconnect(): Promise<void>;
}
/**
 * Factory - creates a RedisCacheProvider from a connection URL.
 * Uses a dynamic import so the ioredis package is only loaded when this
 * function is called (not at module load time), keeping tests fast.
 */
export declare function createRedisCacheProvider(url?: string): Promise<RedisCacheProvider>;
//# sourceMappingURL=redis.d.ts.map