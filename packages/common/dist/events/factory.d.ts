import type { IEventBus } from './interface.js';
import type { RedisEventBusOptions } from './redis.js';
export type EventBusBackend = 'memory' | 'redis';
export interface EventBusConfig {
    backend: EventBusBackend;
    redis?: RedisEventBusOptions;
}
export declare function createEventBus(config?: EventBusConfig): IEventBus;
/**
 * Convenience factory that reads REDIS_URL from the environment.
 * Falls back to InMemoryEventBus when REDIS_URL is not set.
 */
export declare function createEventBusFromEnv(): IEventBus;
//# sourceMappingURL=factory.d.ts.map